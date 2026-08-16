import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { fakeAgent } from "./adapter.mjs";
import { poisonAgent, REAL_PROVIDER_DISABLED_CODE } from "./poison-adapter.mjs";

const execFileAsync = promisify(execFile);
const script = resolve("test-system/fake-agent/fake-agent.mjs");
const verifyHook = resolve("test-system/fake-agent/verification-hook.mjs");

async function git(cwd, args) {
  return execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Atelier Fake",
    "-c", "user.email=fake@atelier.invalid",
    ...args,
  ], {
    cwd,
    env: {
      HOME: cwd,
      PATH: process.env.PATH,
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-fake-agent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-q", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "Atelier Fake"]);
  await git(root, ["config", "user.email", "fake@atelier.invalid"]);
  await writeFile(join(root, "seed.txt"), "seed\n");
  await git(root, ["add", "seed.txt"]);
  await git(root, ["commit", "-qm", "seed"]);
  return root;
}

async function runScenario(root, scenario, { input, args = [] } = {}) {
  const scenarioPath = join(root, "scenario.json");
  await writeFile(scenarioPath, JSON.stringify(scenario));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, scenarioPath, ...args], {
      cwd: root,
      env: {
        HOME: root,
        PATH: process.env.PATH,
        LC_ALL: "C",
        ATELIER_TEST_CHILD_RECEIPTS: join(root, "child-pids.jsonl"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`fake agent exited ${code ?? signal}: ${stderr || stdout}`));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

test("fake agent executes write, stage, commit, amend, reset, and leave_dirty steps", async (t) => {
  const root = await fixture(t);
  const { stdout } = await runScenario(root, {
    sessionRef: "unit-session",
    steps: [
      { type: "write", path: "result.txt", content: "one\n" },
      { type: "stage", paths: ["result.txt"] },
      { type: "commit", message: "result" },
      { type: "write", path: "result.txt", content: "two\n" },
      { type: "stage", paths: ["result.txt"] },
      { type: "amend", message: "amended result" },
      { type: "write", path: "reset.txt", content: "reset\n" },
      { type: "stage", paths: ["reset.txt"] },
      { type: "commit", message: "reset target" },
      { type: "reset", mode: "mixed", ref: "HEAD~1" },
      { type: "leave_dirty", path: "dirty.txt", content: "dirty\n" }
    ]
  });
  assert.match(stdout, /"type":"fake.start"/);
  assert.match(stdout, /"type":"result"/);
  assert.equal(await readFile(join(root, "result.txt"), "utf8"), "two\n");
  assert.match((await git(root, ["status", "--short"])).stdout, /dirty\.txt/);
  assert.equal((await git(root, ["log", "-1", "--pretty=%s"])).stdout.trim(), "amended result");
});

test("fake agent blocks workspace escapes", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    runScenario(root, { steps: [{ type: "write", path: "../escape.txt", content: "no" }] }),
    /escapes the fake-agent workspace/,
  );
});

test("fake agent supports input, resume markers, usage, arbitrary events, and verifier mutation", async (t) => {
  const root = await fixture(t);
  const { stdout } = await runScenario(root, {
    sessionRef: "resume-unit",
    steps: [
      { type: "request_input", message: "answer" },
      { type: "resume_marker", sessionRef: "resume-unit" },
      { type: "report_usage", turns: 2, costUSD: 0 },
      { type: "emit", event: { type: "custom", value: 7 } },
      { type: "forge_review", result: "not-json" },
      {
        type: "mutate_during_verify",
        watcherPath: ".watcher.json",
        writes: [{ path: "verified-mutation.txt", content: "mutated\n" }]
      }
    ]
  }, { input: "continue\n" });
  assert.match(stdout, /"type":"fake.waiting"/);
  assert.match(stdout, /"type":"fake.input","line":"continue"/);
  assert.match(stdout, /"type":"fake.usage","turns":2/);
  assert.match(stdout, /"type":"custom","value":7/);
  assert.match(stdout, /"type":"fake.review","result":"not-json"/);
  await execFileAsync(process.execPath, [verifyHook, ".watcher.json"], { cwd: root });
  assert.equal(await readFile(join(root, "verified-mutation.txt"), "utf8"), "mutated\n");
  assert.deepEqual(JSON.parse(await readFile(join(root, ".fake-verify-receipt.json"))), {
    ran: true,
    exitCode: 0,
  });
});

test("fake adapter executable and scenario schema are shipped as test fixtures", async () => {
  await chmod(script, 0o755);
  const schema = JSON.parse(await readFile(resolve("test-system/fake-agent/scenario.schema.json")));
  assert.deepEqual(schema.required, ["steps"]);
  assert.ok(schema.properties.steps.items.properties.type.enum.includes("spawn_detached"));
  await assert.rejects(
    fakeAgent.preLaunchChecks({ entry: { env: {} } }),
    /ATELIER_TEST_NO_REAL_PROVIDER=1/,
  );
  assert.throws(
    () => poisonAgent("claude").start(),
    (error) => error.code === REAL_PROVIDER_DISABLED_CODE && error.status === 409,
  );
});

test("fake agent supports resume validation, sleeps, child lifetimes, and controlled crashes", async (t) => {
  const root = await fixture(t);
  const { stdout } = await runScenario(root, {
    sessionRef: "resume-real",
    steps: [
      { type: "resume_marker", sessionRef: "resume-real" },
      { type: "sleep", ms: 5 },
      { type: "spawn_child" },
      { type: "spawn_detached" },
    ],
  }, { args: ["--resume", "resume-real"] });
  assert.match(stdout, /"type":"fake.resume","expected":"resume-real","resumedSession":"resume-real"/);
  const children = stdout.trim().split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "fake.child");
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(processExists(child.pid), true);
    process.kill(child.pid, "SIGKILL");
    t.after(() => {
      if (processExists(child.pid)) process.kill(child.pid, "SIGKILL");
    });
  }
  await assert.rejects(
    runScenario(root, { steps: [{ type: "crash", code: 7 }] }),
    /fake agent exited 7/,
  );
  await assert.rejects(
    runScenario(root, {
      sessionRef: "resume-real",
      steps: [{ type: "resume_marker", sessionRef: "resume-real" }],
    }, { args: ["--resume", "wrong-session"] }),
    /resume session mismatch/,
  );
});
