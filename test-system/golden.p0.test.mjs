import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { REAL_PROVIDER_DISABLED_CODE } from "./fake-agent/poison-adapter.mjs";
import {
  createGoldenHarness,
  processExists,
  runStandaloneFake,
} from "./harness.mjs";

const execFileAsync = promisify(execFile);
const VERIFY_HOOK = resolve("test-system/fake-agent/verification-hook.mjs");
const RESULT_VERIFICATION_MISMATCH = "EATELIER_RESULT_VERIFICATION_MISMATCH";
const VERIFICATION_MUTATION = "EATELIER_VERIFICATION_MUTATED_WORKTREE";
const VERIFICATION_HEAD_MISMATCH = "EATELIER_VERIFICATION_HEAD_MISMATCH";

function committedScenario(path = "implemented.txt", content = "implemented\n") {
  return {
    sessionRef: `session-${path}`,
    steps: [
      { type: "write", path, content },
      { type: "stage", paths: [path] },
      { type: "commit", message: `implement ${path}` },
    ],
  };
}

async function git(cwd, args) {
  return execFileAsync("git", [
    "-c", "core.hooksPath=/dev/null",
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

async function fileContents(path) {
  return readFile(path, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

test("golden production path onboards, dispatches, verifies, and merges fake-agent work", async (t) => {
  const harness = await createGoldenHarness(t, { scenario: committedScenario() });
  const admitted = await harness.dispatch({ prompt: "implement the golden result" });
  const completed = await harness.waitRecord(admitted.id);
  assert.equal(completed.state, "completed");
  assert.equal(completed.verify.state, "passed");

  const merged = await harness.api(`/api/dispatch/${admitted.id}/merge`, {
    method: "POST",
    body: {},
  });
  assert.ok(merged.merged?.commit);
  await git(harness.projectPath, ["cat-file", "-e", `${merged.merged.commit}^{commit}`]);
  assert.equal(await readFile(join(harness.projectPath, "implemented.txt"), "utf8"), "implemented\n");
});

test("F1 kill switch poisons real providers and dispatch helper cannot override fake", async (t) => {
  const shimRoot = await mkdtemp(join(tmpdir(), "atelier-real-provider-shim-"));
  t.after(() => rm(shimRoot, { recursive: true, force: true }));
  const receipt = join(shimRoot, "provider-spawned");
  const shim = `#!/bin/sh\nprintf spawned >'${receipt}'\n`;
  await writeFile(join(shimRoot, "claude"), shim);
  await writeFile(join(shimRoot, "codex"), shim);
  await chmod(join(shimRoot, "claude"), 0o755);
  await chmod(join(shimRoot, "codex"), 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimRoot}:${originalPath}`;
  t.after(() => { process.env.PATH = originalPath; });

  const harness = await createGoldenHarness(t, { scenario: committedScenario("f1.txt", "f1\n") });
  await assert.rejects(
    harness.dispatch({ lane: "claude" }),
    (error) => error.code === REAL_PROVIDER_DISABLED_CODE,
  );
  const refusal = await harness.rawApi("/api/dispatch", {
    method: "POST",
    body: {
      project: harness.projectName,
      prompt: "must not reach Claude",
      lane: "claude",
    },
  });
  assert.equal(refusal.status, 409);
  assert.equal(
    refusal.value.error,
    `${REAL_PROVIDER_DISABLED_CODE}: real provider claude is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1`,
  );
  assert.equal(await fileContents(receipt), undefined, "F1 receipt shim proved a real provider spawned");
});

test("F2 golden run ignores hostile ambient git config and hooks", async (t) => {
  const hostileRoot = await mkdtemp(join(tmpdir(), "atelier-hostile-git-"));
  t.after(() => rm(hostileRoot, { recursive: true, force: true }));
  const hooks = join(hostileRoot, "hooks");
  const receipt = join(hostileRoot, "hook-ran");
  const globalConfig = join(hostileRoot, "gitconfig");
  await mkdir(hooks, { recursive: true });
  await writeFile(join(hooks, "post-commit"), `#!/bin/sh\nprintf hook >'${receipt}'\n`);
  await chmod(join(hooks, "post-commit"), 0o755);
  await writeFile(globalConfig, `[core]\n\thooksPath = ${hooks}\n`);
  const originalGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  t.after(() => {
    if (originalGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGlobal;
  });

  const harness = await createGoldenHarness(t, { scenario: committedScenario("hermetic.txt", "safe\n") });
  await git(harness.projectPath, ["config", "--local", "core.hooksPath", hooks]);
  const admitted = await harness.dispatch({ prompt: "prove hermetic git" });
  const completed = await harness.waitRecord(admitted.id);
  assert.equal(completed.verify.state, "passed");
  await harness.api(`/api/dispatch/${admitted.id}/merge`, { method: "POST", body: {} });
  assert.equal(
    await fileContents(receipt),
    undefined,
    "F2 hostile parent or repo-local hook wrote a receipt",
  );
});

test("F3 registration failure after daemon start tears down the partial harness", async (t) => {
  let daemonPid;
  await assert.rejects(
    createGoldenHarness(t, {
      forceRegistrationFailure: true,
      onDaemonSpawn(pid) { daemonPid = pid; },
    }),
    /HTTP \d+ \/api\/projects/,
  );
  assert.ok(Number.isInteger(daemonPid), "F3 fixture never reached daemon spawn");
  assert.equal(processExists(daemonPid), false, "F3 setup failure leaked the Atelier daemon");
});

test("F4 teardown kills detached fake-agent children by receipt PID", async (t) => {
  const harness = await createGoldenHarness(t, {
    scenario: { steps: [{ type: "spawn_detached" }] },
  });
  const admitted = await harness.dispatch({ prompt: "spawn a detached child" });
  await harness.waitRecord(admitted.id);
  const pids = await harness.childPids();
  assert.equal(pids.length, 1, "F4 fake agent did not write its child PID receipt");
  assert.equal(processExists(pids[0]), true, "F4 detached fixture child was not live before teardown");
  await harness.teardown();
  assert.equal(processExists(pids[0]), false, "F4 teardown left the receipt-tracked child alive");
});

test("R1 production CLI routes through daemon and direct second writer is locked out", async (t) => {
  const harness = await createGoldenHarness(t, { scenario: committedScenario("r1.txt", "r1\n") });
  const cli = await harness.runCli([
    "dispatch", harness.projectName, "--prompt", "exercise R1", "--lane", "fake", "--model", "fake", "--follow",
  ]);
  assert.equal(cli.code, 0, `R1 routed CLI failed: ${cli.stderr}`);
  const id = cli.stdout.match(/^[0-9a-f]{8}$/m)?.[0];
  assert.ok(id, `R1 routed CLI emitted no dispatch id: ${cli.stdout}`);
  harness.trackDispatch(id);
  const completed = await harness.waitRecord(id);
  const daemonRecord = await harness.api(`/api/dispatch/${id}`);
  assert.equal(daemonRecord.id, id);
  assert.equal(daemonRecord.state, completed.state);
  const events = await harness.events(id);
  const started = events
    .filter((event) => event.kind === "fake.start")
    .map((event) => JSON.parse(event.text))
    .at(-1);
  assert.equal(started?.ppid, harness.daemonPid, "R1 CLI dispatch did not execute under the daemon");

  const indexPath = join(harness.stateDir, "dispatches", "index.jsonl");
  const before = await readFile(indexPath);
  const direct = await harness.attemptDirectDispatcher();
  assert.equal(direct.code, 0, `R1 direct lock probe failed: ${direct.stderr || direct.stdout}`);
  const refusal = JSON.parse(direct.stdout.trim());
  assert.equal(refusal.code, "EATELIERLOCKED");
  assert.deepEqual(await readFile(indexPath), before, "R1 locked constructor mutated shared state");
});

test("R2 dirty intended work is never verified and then discarded by merge", async (t) => {
  const harness = await createGoldenHarness(t, {
    scenario: {
      sessionRef: "dirty-result",
      steps: [
        { type: "write", path: "partial.txt", content: "committed subset\n" },
        { type: "stage", paths: ["partial.txt"] },
        { type: "commit", message: "commit only part of the result" },
        { type: "leave_dirty", path: "dirty-intended.txt", content: "must land\n" },
      ],
    },
  });
  const admitted = await harness.dispatch({ prompt: "leave intended work dirty" });
  const completed = await harness.waitRecord(admitted.id);
  assert.equal(completed.verify.state, "passed", "R2 fixture did not reach its tested-dirty defect path");
  const testedBytes = await readFile(join(completed.worktreePath, "dirty-intended.txt"), "utf8");
  const mainBefore = (await git(harness.projectPath, ["rev-parse", "main"])).stdout.trim();
  const merge = await harness.rawApi(`/api/dispatch/${admitted.id}/merge`, {
    method: "POST",
    body: {},
  });
  const mainAfter = (await git(harness.projectPath, ["rev-parse", "main"])).stdout.trim();
  const landedBytes = await fileContents(join(harness.projectPath, "dirty-intended.txt"));
  t.diagnostic(`R2 merge HTTP=${merge.status}, main changed=${mainAfter !== mainBefore}, error=${JSON.stringify(merge.value.error || "")}`);
  if (merge.ok) {
    assert.equal(
      landedBytes,
      testedBytes,
      "R2 dirty-result-loss audit defect: merge discarded bytes from the verified dirty result",
    );
    return;
  }
  assert.equal(merge.status, 409, "R2 refusal must use the result/verification mismatch contract");
  assert.match(merge.value.error || "", new RegExp(`^${RESULT_VERIFICATION_MISMATCH}:`));
  assert.equal(mainAfter, mainBefore, "R2 refused merge still moved main");
});

test("R3 verification cannot attest mutation or a stale branch HEAD", async (t) => {
  const failures = [];

  const mutationHarness = await createGoldenHarness(t, {
    scenario: {
      sessionRef: "verifier-mutation",
      steps: [
        { type: "write", path: "agent.txt", content: "agent\n" },
        { type: "stage", paths: ["agent.txt"] },
        { type: "commit", message: "agent work" },
        {
          type: "mutate_during_verify",
          watcherPath: ".fake-verify-watcher.json",
          receiptPath: ".fake-verify-receipt.json",
          writes: [{ path: "verifier-mutated.txt", content: "mutation\n" }],
        },
      ],
    },
    verifyCommands: [`${VERIFY_HOOK} .fake-verify-watcher.json`],
    projectName: "mutation-fixture",
  });
  const mutationDispatch = await mutationHarness.dispatch({ prompt: "exercise verifier mutation" });
  const mutationRecord = await mutationHarness.waitRecord(mutationDispatch.id);
  const mutationReceipt = JSON.parse(await readFile(
    join(mutationRecord.worktreePath, ".fake-verify-receipt.json"),
    "utf8",
  ));
  assert.equal(mutationReceipt.ran, true, "R3 mutation hook did not run");
  assert.equal(mutationRecord.verify.steps[0]?.exitCode, 0, "R3 mutation verifier did not exit zero");
  if (mutationRecord.verify.state === "passed") {
    failures.push("zero-exit verifier mutation was recorded as passed");
  } else if (!new RegExp(`^${VERIFICATION_MUTATION}:`).test(mutationRecord.verify.detail || "")) {
    failures.push("verifier mutation refusal did not use the mutation contract");
  }

  const staleHarness = await createGoldenHarness(t, {
    scenario: committedScenario("verified.txt", "verified\n"),
    projectName: "stale-fixture",
  });
  const staleDispatch = await staleHarness.dispatch({ prompt: "verify before moving HEAD" });
  const verifiedRecord = await staleHarness.waitRecord(staleDispatch.id);
  assert.equal(verifiedRecord.verify.state, "passed", "R3 stale-head fixture did not first verify");
  const verifiedHead = (await git(verifiedRecord.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  const branchMoveScenario = join(staleHarness.root, "move-head.json");
  await writeFile(branchMoveScenario, JSON.stringify(committedScenario("after-verify.txt", "later\n")));
  await runStandaloneFake(verifiedRecord.worktreePath, branchMoveScenario);
  const movedHead = (await git(verifiedRecord.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  assert.notEqual(movedHead, verifiedHead, "R3 fixture did not move branch HEAD after verification");
  const mainBefore = (await git(staleHarness.projectPath, ["rev-parse", "main"])).stdout.trim();
  const staleMerge = await staleHarness.rawApi(`/api/dispatch/${staleDispatch.id}/merge`, {
    method: "POST",
    body: {},
  });
  const mainAfter = (await git(staleHarness.projectPath, ["rev-parse", "main"])).stdout.trim();
  if (staleMerge.ok) {
    failures.push("merge accepted a branch HEAD that moved after verification");
  } else if (
    staleMerge.status !== 409 ||
    !new RegExp(`^${VERIFICATION_HEAD_MISMATCH}:`).test(staleMerge.value.error || "")
  ) {
    failures.push(`stale-head refusal did not use the head-mismatch contract (HTTP ${staleMerge.status})`);
  }
  if (mainAfter !== mainBefore) failures.push("stale-head merge attempt changed main");
  t.diagnostic(`R3 mutation verify=${mutationRecord.verify?.state}, stale-head merge HTTP=${staleMerge.status}, main changed=${mainAfter !== mainBefore}`);

  assert.deepEqual(
    failures,
    [],
    `R3 verifier-mutation/stale-branch audit defect: ${failures.join("; ")}`,
  );
});
