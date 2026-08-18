import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { clientBearerToken, ensureAuthSecret } from "./lib/auth.mjs";

const execFileAsync = promisify(execFile);

async function liveFakeDaemonState(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-fake-daemon-"));
  const state = join(root, "state");
  await mkdir(state);
  await writeFile(join(state, "atelier.lock"), `${process.pid}\n`);
  // Post-ATT-005 the CLI mints its bearer from the daemon's state-dir secret,
  // so a fake live daemon must provide one exactly like the real one does.
  ensureAuthSecret(state);
  t.after(() => rm(root, { recursive: true, force: true }));
  return state;
}

// The same spelling dispatch.mjs persists, so a seeded tree member is
// identity-corroborated when the CLI's sweep classifies it.
function cliProcessStartIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return `linux-proc-start:${bootId}:${startTime}`;
}

test("atelier doctor validates a fixture registry from ATELIER_CONFIG_DIR", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: {
        concurrentDispatchCap: 1,
        dispatchProfile: {
          defaultModel: "sonnet",
          maxTurns: 5,
          allowedTools: [],
          lane: "claude",
        },
      },
      groups: [],
      projects: [
        {
          name: "fixture",
          path: projectPath,
          mainBranch: "main",
          tracker: "none",
          containerized: false,
          verifyMode: "worktree",
          verifyCommands: [],
        },
      ],
    }),
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_CONFIG_DIR: root,
        ATELIER_TEST_NO_REAL_PROVIDER: "1",
      },
    },
  );
  assert.match(stdout, /registry: ok \(1 projects\)/);
  assert.match(stdout, /git: ok/);
  assert.match(stdout, /br: ok/);
  assert.match(stdout, /claude: ok/);
  assert.match(
    stdout,
    /sandbox: ok \(linux; bwrap; bubblewrap 0\.10\.0; bubblewrap unprivileged namespace probe succeeded\)/,
  );
  assert.match(
    stdout,
    /sandbox daemon broker: ok \(unix socket; operator allowlist: \/api\/dispatches; \/api\/session and \/api\/break-glass unconditionally denied; remote provider APIs unavailable\)/,
  );
  assert.match(stdout, /codex: (?:guarded|not installed)/);

  const atelierState = join(root, "state");
  await mkdir(join(atelierState, "dispatches"), { recursive: true });
  await writeFile(
    join(atelierState, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "old-dispatch",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "completed",
      branch: null,
      worktreePath: null,
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T01:00:00.000Z",
      turns: 0,
      costUSD: 0,
      exitSummary: "done",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  // An identity-matched orphan: a process Atelier persisted as a member of this
  // dispatch's tree, in a worktree that is now gone. That is the ONLY thing the
  // sweep may signal - and `--dry-run` must still only name it (atelier-za6 round 3).
  const worktreePath = join(atelierState, "worktrees", "fixture", "gone-dispatch");
  const scriptDir = join(root, "codex", "scripts");
  await mkdir(worktreePath, { recursive: true });
  await mkdir(scriptDir, { recursive: true });
  const script = join(scriptDir, "codex-companion.mjs");
  await writeFile(script, 'console.log("ready");\nsetInterval(() => {}, 1000);\n');
  const leaked = spawn(process.execPath, [script, "task-worker", "--cwd", worktreePath], {
    cwd: worktreePath,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      process.kill(leaked.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  await once(leaked.stdout, "data");
  await appendFile(
    join(atelierState, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "orphan-dispatch",
      project: "fixture",
      ticketId: null,
      model: "codex-default",
      effort: null,
      lane: "codex",
      state: "plan_ready",
      branch: null,
      worktreePath,
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: null,
      turns: 0,
      costUSD: 0,
      exitSummary: "",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
      codexProcessTree: {
        rootPid: leaked.pid,
        capturedAt: "2026-07-30T00:00:00.000Z",
        processes: [{
          pid: leaked.pid,
          identity: cliProcessStartIdentity(leaked.pid),
          depth: 0,
          command: "node",
        }],
      },
    })}\n`,
  );
  await rm(worktreePath, { recursive: true, force: true });

  // A SECOND fixture, referenced as a record's fencing pid. Boot orphan reaping
  // would SIGTERM this the moment a Dispatcher is constructed - no sweep involved -
  // which is why --dry-run needs observer mode and not merely a suppressed sweep:
  // constructing a Dispatcher is itself an action.
  const fenced = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try {
      process.kill(-fenced.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });
  await once(fenced.stdout, "data");
  await appendFile(
    join(atelierState, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "fenced-dispatch",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "failed",
      branch: null,
      worktreePath: null,
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T01:00:00.000Z",
      turns: 0,
      costUSD: 0,
      exitSummary: "server restart",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
      childPid: fenced.pid,
      childPidIdentity: cliProcessStartIdentity(fenced.pid),
    })}\n`,
  );
  await appendFile(
    join(atelierState, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "merged-with-advisory-debt",
      project: "fixture",
      ticketId: "fixture-1",
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "completed",
      branch: "atelier/fixture-1-merged-with-advisory-debt",
      worktreePath: null,
      startedAt: "2026-06-01T00:00:00.000Z",
      endedAt: "2026-06-01T01:00:00.000Z",
      turns: 0,
      costUSD: 0,
      exitSummary: "done",
      strandedBrWrites: false,
      verify: { state: "passed", steps: [] },
      review: {
        rounds: [{
          round: 1,
          dispatchId: "review-advisory-debt",
          verdict: "fail",
          advisoryFollowUps: [{
            findingRef: "round-1:finding-1",
            reviewDispatchId: "review-advisory-debt",
            marker: "atelier-review-advisory:fixture",
            comment: "ATELIER REVIEW ADVISORY FOLLOW-UP",
            filedAt: null,
            attempts: 2,
            lastAttemptAt: "2026-07-31T00:00:00.000Z",
            lastError: "tracker unavailable",
          }],
        }],
      },
      merged: {
        commit: "abcdef1234567890",
        mergedAt: "2026-07-31T00:00:00.000Z",
        strategy: "ff",
      },
      dismissed: null,
      warnings: [],
    })}\n`,
  );

  const gc = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--gc", "--dry-run", "--older-than-days", "7"],
    {
      cwd: resolve("."),
      env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_STATE_DIR: atelierState },
    },
  );
  assert.match(gc.stdout, /would dismiss: old-dispatch/);
  assert.doesNotMatch(
    gc.stdout,
    /would dismiss: fenced-dispatch/,
    "gc previewed dismissal of a record whose runner remains fenced",
  );
  assert.match(
    gc.stdout,
    /review advisory debt: merged-with-advisory-debt round-1:finding-1 for fixture-1 \(2 attempts; last error: tracker unavailable\)/,
  );
  assert.match(gc.stdout, /gc summary: .* 0 break-glass authorizations,/);
  assert.match(gc.stdout, /gc summary: .* 1 review advisory debt,/);
  if (process.platform === "linux") {
    assert.match(gc.stdout, new RegExp(`would reap codex process: ${leaked.pid} `));
    assert.match(gc.stdout, /gc summary: 1 dispatch, .* 1 codex process reaped, /);
    assert.equal(
      existsSync(`/proc/${leaked.pid}`),
      true,
      "atelier doctor --gc --dry-run killed a process",
    );
    assert.equal(
      existsSync(`/proc/${fenced.pid}`),
      true,
      "constructing the --dry-run Dispatcher orphan-reaped a fenced worker",
    );
  } else {
    assert.match(gc.stdout, /codex process sweep unavailable on this platform/);
  }
});

test("atelier doctor reports the selected backend's specific unavailable reason", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-sandbox-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: { sandboxBackend: "podman" },
      groups: [],
      projects: [],
    }),
  );
  for (const command of ["git", "br", "claude"]) {
    const path = join(root, command);
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${command} fixture'\n`);
    await chmod(path, 0o755);
  }
  const podman = join(root, "podman");
  await writeFile(
    podman,
    "#!/bin/sh\n" +
      "if [ \"$1\" = \"--version\" ]; then printf '%s\\n' 'podman version 4.9.3'; exit 0; fi\n" +
      "printf '%s\\n' 'AppArmor denied the rootless user namespace' >&2\n" +
      "exit 1\n",
  );
  await chmod(podman, 0o755);

  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "doctor"], {
      cwd: resolve("."),
      env: {
        ...process.env,
        PATH: root,
        ATELIER_CONFIG_DIR: root,
        ATELIER_STATE_DIR: join(root, "state"),
        ATELIER_TEST_NO_REAL_PROVIDER: "1",
      },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stdout,
        /sandbox: unavailable \(linux; podman; podman version 4\.9\.3; rootless podman probe failed: AppArmor denied the rootless user namespace\)/,
      );
      return true;
    },
  );
});

test("atelier doctor validates the configured Codex binary with initialize only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-codex-doctor-"));
  const projectPath = join(root, "project");
  const binPath = join(root, "bin");
  const codexPath = join(binPath, "codex");
  const protocolLog = join(root, "protocol.ndjson");
  await mkdir(projectPath);
  await mkdir(binPath);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  await writeFile(codexPath, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
if (process.argv[2] === "--version") {
  console.log("warning line\\ncodex-cli 9.9.9\\nignored trailer");
  process.exit(0);
}
if (process.argv[2] !== "app-server") process.exit(2);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      ...(process.env.FAKE_CODEX_BAD_INIT === "1" ? {} : {
        userAgent: "fake-codex/9.9.9",
        platformFamily: "unix",
        platformOs: "linux"
      })
    } }));
  }
});
`);
  await chmod(codexPath, 0o755);
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: {
        concurrentDispatchCap: 1,
        dispatchProfile: {
          defaultModel: "codex-default",
          maxTurns: 5,
          allowedTools: [],
          lane: "codex",
        },
      },
      groups: [],
      projects: [{
        name: "fixture",
        path: projectPath,
        mainBranch: "main",
        tracker: "none",
        containerized: false,
        verifyMode: "worktree",
        verifyCommands: [],
      }],
    }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_CONFIG_DIR: root,
        ATELIER_TEST_NO_REAL_PROVIDER: "0",
        FAKE_CODEX_LOG: protocolLog,
        PATH: `${binPath}:${process.env.PATH}`,
      },
    },
  );

  assert.ok(stdout.includes(`codex binary: ${codexPath} (sha256 `));
  assert.match(stdout, /sha256 [a-f0-9]{12}\)/);
  assert.match(stdout, /codex: ok \(codex-cli 9\.9\.9, app-server ok\)/);
  const methods = (await readFile(protocolLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).method);
  assert.deepEqual(methods, ["initialize", "initialized"]);

  const guarded = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_CONFIG_DIR: root,
        ATELIER_TEST_NO_REAL_PROVIDER: "1",
        FAKE_CODEX_LOG: protocolLog,
        PATH: `${binPath}:${process.env.PATH}`,
      },
    },
  );
  assert.match(guarded.stdout, /codex: guarded \(codex-cli 9\.9\.9; app-server probe disabled/);
  assert.equal((await readFile(protocolLog, "utf8")).trim().split("\n").length, 2);

  const reachableRegistryPath = join(root, "projects.json");
  const reachableRegistry = JSON.parse(await readFile(reachableRegistryPath, "utf8"));
  reachableRegistry.defaults.dispatchProfile.lane = "claude";
  await writeFile(reachableRegistryPath, JSON.stringify(reachableRegistry));
  const reachableWithoutDefault = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_CONFIG_DIR: root,
        ATELIER_TEST_NO_REAL_PROVIDER: "1",
        FAKE_CODEX_LOG: protocolLog,
        PATH: `${binPath}:${process.env.PATH}`,
      },
    },
  );
  assert.match(reachableWithoutDefault.stdout, /codex: guarded \(codex-cli 9\.9\.9/);
  reachableRegistry.defaults.dispatchProfile.lane = "codex";
  await writeFile(reachableRegistryPath, JSON.stringify(reachableRegistry));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("bin", "atelier.mjs"), "doctor"],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          ATELIER_CONFIG_DIR: root,
          ATELIER_TEST_NO_REAL_PROVIDER: "0",
          FAKE_CODEX_BAD_INIT: "1",
          FAKE_CODEX_LOG: protocolLog,
          PATH: `${binPath}:${process.env.PATH}`,
        },
      },
    ),
    (error) => /initialize omitted userAgent server identity/.test(error.stderr),
  );
});

test("atelier doctor prints degraded persistence targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-persistence-doctor-"));
  const projectPath = join(root, "project");
  const atelierState = join(root, "state");
  await mkdir(projectPath);
  await mkdir(atelierState);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: {},
      groups: [],
      projects: [{
        name: "fixture",
        path: projectPath,
        mainBranch: "main",
        tracker: "none",
        containerized: false,
        verifyMode: "worktree",
        verifyCommands: [],
      }],
    }),
  );
  await writeFile(join(atelierState, "queue.json"), "{ broken queue state\n");

  const result = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor"],
    {
      cwd: resolve("."),
      env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_STATE_DIR: atelierState },
    },
  ).then((value) => value, (error) => error);

  assert.match(result.stdout, new RegExp(
    `persistence degraded: ${join(atelierState, "queue.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  ));
  assert.equal(
    (await readdir(atelierState)).some((name) => name.startsWith("queue.json.corrupt-")),
    false,
    "read-only doctor must not write corrupt-state evidence",
  );
});

test("atelier doctor --gc --offline-maintenance refuses while an instance lock is live", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-gc-lock-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: {
        concurrentDispatchCap: 1,
        dispatchProfile: {
          defaultModel: "sonnet",
          maxTurns: 5,
          allowedTools: [],
          lane: "claude",
        },
      },
      groups: [],
      projects: [
        {
          name: "fixture",
          path: projectPath,
          mainBranch: "main",
          tracker: "none",
          containerized: false,
          verifyMode: "worktree",
          verifyCommands: [],
        },
      ],
    }),
  );
  const atelierState = join(root, "state");
  await mkdir(atelierState, { recursive: true });
  // The lock a live server holds. This process is alive, so the owner probe finds
  // it - which is the whole point: two reapers on one state directory share no
  // single-flight, so the local one must refuse rather than race.
  await writeFile(join(atelierState, "atelier.lock"), `${process.pid}
`);

  const refused = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--gc", "--offline-maintenance"],
    {
      cwd: resolve("."),
      env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_STATE_DIR: atelierState },
    },
  ).then(
    (result) => ({ ...result, code: 0 }),
    (error) => error,
  );
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /systemctl --user stop atelier first/);
  assert.match(refused.stderr, new RegExp(`Another Atelier instance is already running \\(PID ${process.pid}\\)`));

  // --dry-run stays available: it is read-only, and observer mode means even
  // constructing its Dispatcher does nothing.
  const inspected = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--gc", "--dry-run"],
    {
      cwd: resolve("."),
      env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_STATE_DIR: atelierState },
    },
  );
  assert.match(inspected.stdout, /gc summary: /);
});

test("atelier doctor --gc passes the event log through bulk dismissals", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-gc-event-log-"));
  const projectPath = join(root, "project");
  const atelierState = join(root, "state");
  await mkdir(projectPath);
  await mkdir(join(atelierState, "dispatches"), { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "projects.json"),
    JSON.stringify({
      version: 1,
      defaults: {},
      groups: [],
      projects: [{
        name: "fixture",
        path: projectPath,
        mainBranch: "main",
        tracker: "none",
        containerized: false,
        verifyMode: "worktree",
        verifyCommands: [],
      }],
    }),
  );
  await writeFile(
    join(atelierState, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "gc-dismissed",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "completed",
      branch: null,
      worktreePath: null,
      startedAt: "2020-01-01T00:00:00.000Z",
      endedAt: "2020-01-01T01:00:00.000Z",
      turns: 1,
      costUSD: 0,
      exitSummary: "done",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  const options = {
    cwd: resolve("."),
    env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_STATE_DIR: atelierState },
  };

  const dryRun = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--gc", "--dry-run", "--older-than-days", "7"],
    options,
  );
  assert.match(dryRun.stdout, /would dismiss: gc-dismissed/);
  assert.equal(existsSync(join(atelierState, "logs", "events.jsonl")), false);

  const collected = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--gc", "--offline-maintenance", "--older-than-days", "7"],
    options,
  );
  assert.match(collected.stdout, /dismissed: gc-dismissed/);
  const { createEventLog } = await import("./lib/event-log.mjs");
  const events = createEventLog({ stateDir: atelierState }).read({ kind: "dispatch.dismiss" });
  assert.equal(events.length, 1);
  assert.equal(events[0].dispatchId, "gc-dismissed");
  assert.equal(events[0].state, "completed");
});

test("atelier doctor --safe-restart validates its flags and refuses cleanly when atelier.service is unreachable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-safe-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cwd: resolve("."),
    // An improbable, definitely-unbound port - this must never touch a real
    // running atelier.service (see AGENTS.md / the task brief for this suite).
    env: { ...process.env, ATELIER_CONFIG_DIR: root, PORT: "59321" },
  };

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("bin", "atelier.mjs"), "doctor", "--install-service", "--safe-restart"],
      options,
    ),
    (error) => {
      assert.match(error.stderr, /choose only one of --install-service, --gc, --safe-restart/);
      return true;
    },
  );

  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "doctor", "--dry-run"], options),
    (error) => {
      assert.match(
        error.stderr,
        /--dry-run requires --install-service, --gc, or --safe-restart/,
      );
      return true;
    },
  );

  const refused = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--safe-restart"],
    options,
  ).catch((error) => error);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not reachable/);

  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "doctor", "--port", "59321"], options),
    (error) => {
      assert.match(error.stderr, /--port requires --safe-restart/);
      return true;
    },
  );
  const badPort = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--safe-restart", "--port", "0"],
    options,
  ).catch((error) => error);
  assert.notEqual(badPort.code, 0);
  assert.match(badPort.stderr, /--port must be an integer between 1 and 65535/);
});

test("atelier doctor --safe-restart --port overrides PORT for the target URL (finding 7g)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-safe-restart-port-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // PORT (59321) and --port (59322) deliberately disagree - the CLI flag
  // must win, never wrongly report the PORT-env port as unreachable while
  // silently trying a different one (or vice versa).
  const result = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--safe-restart", "--port", "59322"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_CONFIG_DIR: root, PORT: "59321" } },
  ).catch((error) => error);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /127\.0\.0\.1:59322/);
  assert.doesNotMatch(result.stderr, /59321/);
});

test("atelier init writes a starter registry and refuses to overwrite it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cwd: resolve("."),
    env: { ...process.env, ATELIER_CONFIG_DIR: root },
  };

  const first = await execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "init"], options);
  assert.match(first.stdout, /Wrote Atelier registry/);
  assert.deepEqual(JSON.parse(await readFile(join(root, "projects.json"), "utf8")), {
    version: 1,
    defaults: {},
    groups: [],
    projects: [],
  });

  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "init"], options),
    (error) => {
      assert.match(error.stderr, /Refusing to overwrite existing registry/);
      return true;
    },
  );
});

test("atelier init, serve, mcp, and doctor expose side-effect-free subcommand help", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    cwd: resolve("."),
    env: { ...process.env, ATELIER_CONFIG_DIR: join(root, "config") },
  };

  const initHelp = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "init", "--help"],
    options,
  );
  const serveHelp = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "serve", "--help"],
    options,
  );
  const mcpHelp = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "mcp", "--help"],
    options,
  );
  const doctorHelp = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "doctor", "--help"],
    options,
  );

  assert.match(initHelp.stdout, /atelier init/);
  assert.match(serveHelp.stdout, /atelier serve \[--port N\]/);
  assert.match(mcpHelp.stdout, /atelier mcp \[--port N\]/);
  assert.match(doctorHelp.stdout, /--offline-maintenance/);
  assert.match(doctorHelp.stdout, /fails the service unit until it is retried/);
  await assert.rejects(readFile(join(root, "config", "projects.json"), "utf8"), /ENOENT/);
});

test("atelier serve reports port conflicts and refuses a second live instance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-serve-"));
  const config = join(root, "config");
  const state = join(root, "state");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "projects.json"),
    `${JSON.stringify({ version: 1, defaults: {}, groups: [], projects: [] })}\n`,
  );
  const occupied = createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  const port = occupied.address().port;
  t.after(async () => {
    occupied.close();
    await once(occupied, "close").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    cwd: resolve("."),
    env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_STATE_DIR: state },
  };

  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "serve", "--port", String(port)], options),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        new RegExp(
          `Another Atelier \\(or other process\\) is already listening on port ${port} - is the atelier service running\\? \\(systemctl --user status atelier\\)`,
        ),
      );
      return true;
    },
  );
  await assert.rejects(readFile(join(state, "atelier.lock"), "utf8"), /ENOENT/);

  await writeFile(join(state, "atelier.lock"), `${process.pid}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, [resolve("bin", "atelier.mjs"), "serve", "--port", "0"], options),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(`Another Atelier instance is already running \\(PID ${process.pid}\\)`));
      return true;
    },
  );
});

async function assertGracefulSignalShutdown(t, shutdownSignal) {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-shutdown-"));
  const config = join(root, "config");
  const state = join(root, "state");
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, "projects.json"),
    `${JSON.stringify({ version: 1, defaults: {}, groups: [], projects: [] })}\n`,
  );

  let child;
  t.after(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });

  child = spawn(process.execPath, [resolve("bin", "atelier.mjs"), "serve", "--port", "0"], {
    cwd: resolve("."),
    env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_STATE_DIR: state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const port = await new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error("atelier serve did not listen")), 5_000);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      rejectPromise(new Error(`atelier serve exited before listening (${code ?? signal}): ${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /Atelier listening at http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
      if (!match) return;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolvePromise(Number(match[1]));
    });
  });
  assert.equal(await readFile(join(state, "atelier.lock"), "utf8"), `${child.pid}\n`);

  const stream = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/dispatches/events",
        headers: {
          authorization: `Bearer ${clientBearerToken("cli", { directory: state })}`,
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString("utf8");
          if (body.includes(": heartbeat\n\n")) resolvePromise(response);
        });
        // A response that ends without a heartbeat (a 401, most likely) must
        // reject rather than leave this promise pending forever: the ended
        // socket goes idle, so neither the error handler nor the socket
        // timeout below would ever fire.
        response.on("end", () =>
          rejectPromise(new Error(`SSE stream closed without heartbeat (${response.statusCode}): ${body}`)),
        );
      },
    );
    request.on("error", rejectPromise);
    request.setTimeout(5_000, () => request.destroy(new Error("SSE stream did not open")));
    request.end();
  });
  const stopped = Promise.all([once(child, "exit"), once(stream, "end")]);
  let stopTimer;
  const timeout = new Promise((_, rejectPromise) => {
    stopTimer = setTimeout(
      () => rejectPromise(new Error(`atelier serve did not stop after ${shutdownSignal}`)),
      3_000,
    );
  });
  const startedAt = Date.now();
  assert.equal(child.kill(shutdownSignal), true);
  const [[code, signal]] = await Promise.race([stopped, timeout]).finally(() => {
    clearTimeout(stopTimer);
  });

  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  assert.ok(Date.now() - startedAt < 2_000, "shutdown exceeded two seconds");
  await assert.rejects(readFile(join(state, "atelier.lock"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(state, "atelier.url"), "utf8"), /ENOENT/);

  // atelier-e5x: the service lifecycle pair is what makes a restart legible later,
  // so it is asserted on the real signal path rather than assumed.
  const events = (await readFile(join(state, "logs", "events.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const start = events.find((event) => event.kind === "service.start");
  const stop = events.find((event) => event.kind === "service.stop");
  assert.equal(start?.port, port);
  assert.equal(start?.pid, child.pid);
  assert.equal(stop?.reason, shutdownSignal, "the stop event names the signal that caused it");
  assert.equal(stop?.pid, child.pid);
  assert.ok(
    events.some((event) => event.kind === "service.shutdown"),
    "the dispatcher's own shutdown is on the record too",
  );
}

for (const shutdownSignal of ["SIGTERM", "SIGINT"]) {
  test(`atelier serve flushes lifecycle events before releasing authority on ${shutdownSignal}`, (t) =>
    assertGracefulSignalShutdown(t, shutdownSignal));
}

test("atelier track previews an unregistered path locally without hand-edit guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-track-"));
  const projectPath = join(root, "New Project");
  const config = join(root, "config");
  await mkdir(projectPath);
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "--initial-branch=develop"], { cwd: projectPath });
  await writeFile(
    join(projectPath, "package.json"),
    JSON.stringify({ scripts: { test: "node --test" } }),
  );

  const options = {
    cwd: resolve("."),
    env: {
      ...process.env,
      ATELIER_CONFIG_DIR: config,
      ATELIER_STATE_DIR: join(root, "state"),
    },
  };
  const preview = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "track", projectPath],
    options,
  );
  assert.match(preview.stdout, /"name": "new-project"/);
  assert.match(preview.stdout, /"npm test"/);
  assert.match(preview.stdout, /atelier track <path> --yes/);
  assert.doesNotMatch(preview.stdout, /Edit .*projects\.json/);

  await assert.rejects(readFile(join(config, "projects.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(projectPath, ".atelier.json"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(projectPath, ".beads", "issues.jsonl"), "utf8"), /ENOENT/);
});

test("atelier reply joins text and follows new events through the loopback API", async (t) => {
  const state = await liveFakeDaemonState(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      lastEventId: request.headers["last-event-id"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (request.method === "GET" && request.url.endsWith("/events")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (request.headers["last-event-id"]) {
        response.end([
          "id: 6",
          "event: reply",
          'data: {"type":"reply","text":"please continue","dispatchId":"dispatch-1","seq":6}',
          "",
          "id: 7",
          "event: status",
          'data: {"type":"status","state":"completed","dispatchId":"dispatch-1","seq":7}',
          "",
          ": heartbeat",
          "",
        ].join("\n"));
      } else {
        response.end([
          "id: 5",
          "event: status",
          'data: {"type":"status","state":"completed","dispatchId":"dispatch-1","seq":5}',
          "",
          ": heartbeat",
          "",
        ].join("\n"));
      }
      return;
    }
    if (request.method === "POST" && request.url.endsWith("/reply")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":"dispatch-1","state":"running"}');
      return;
    }
    if (request.method === "GET" && request.url === "/api/dispatch/dispatch-1") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":"dispatch-1","state":"completed"}');
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"error":"Not found"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "reply", "dispatch-1", "please", "continue", "--follow"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_STATE_DIR: state,
        PORT: String(server.address().port),
      },
    },
  );

  assert.deepEqual(JSON.parse(requests[1].body), { text: "please continue" });
  assert.equal(requests[2].lastEventId, "5");
  assert.match(stdout, /"state":"running"/);
  assert.match(stdout, /"type":"reply"/);
  assert.match(stdout, /"state":"completed"/);
});

test("atelier --follow stops on needs_input and exits non-zero", async (t) => {
  const state = await liveFakeDaemonState(t);
  // atelier-8r6: an unfinished outcome is terminal, so `--follow` must settle on it
  // instead of waiting forever on a dispatch that is already asking a question -
  // and the exit code must not claim success.
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    if (request.method === "GET" && request.url.endsWith("/events")) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end([
        "id: 4",
        "event: status",
        'data: {"type":"status","state":"needs_input","dispatchId":"dispatch-2","seq":4,"outcome":{"kind":"needs_input","question":"Which schema?"}}',
        "",
        ": heartbeat",
        "",
      ].join("\n"));
      return;
    }
    if (request.method === "POST" && request.url.endsWith("/reply")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":"dispatch-2","state":"running"}');
      return;
    }
    if (request.method === "GET" && request.url === "/api/dispatch/dispatch-2") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"id":"dispatch-2","state":"needs_input"}');
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end('{"error":"Not found"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  const failure = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "reply", "dispatch-2", "answer", "later", "--follow"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_STATE_DIR: state,
        PORT: String(server.address().port),
      },
    },
  ).then(
    (result) => ({ code: 0, ...result }),
    (error) => error,
  );

  assert.equal(failure.code, 1);
  assert.match(failure.stdout, /"state":"needs_input"/);
  assert.match(failure.stdout, /Which schema\?/);
});

test("atelier plan sends approve or revision feedback through the loopback API", async (t) => {
  const state = await liveFakeDaemonState(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"id":"dispatch-1","state":"running"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });
  const options = {
    cwd: resolve("."),
    env: {
      ...process.env,
      ATELIER_STATE_DIR: state,
      PORT: String(server.address().port),
    },
  };

  const approved = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "plan", "dispatch-1", "--approve"],
    options,
  );
  const revised = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "plan", "dispatch-1", "--revise", "cover rollback"],
    options,
  );

  assert.match(approved.stdout, /"state":"running"/);
  assert.match(revised.stdout, /"state":"running"/);
  assert.deepEqual(requests.map((request) => ({
    method: request.method,
    path: request.path,
    contentType: request.contentType,
    body: JSON.parse(request.body),
  })), [
    {
      method: "POST",
      path: "/api/dispatch/dispatch-1/plan",
      contentType: "application/json",
      body: { action: "approve" },
    },
    {
      method: "POST",
      path: "/api/dispatch/dispatch-1/plan",
      contentType: "application/json",
      body: { action: "revise", text: "cover rollback" },
    },
  ]);
});

test("atelier merge --force prints the human break-glass mint instruction", async (t) => {
  const state = await liveFakeDaemonState(t);
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      error: "EATELIER_BREAK_GLASS_REQUIRED: force merge requires a token minted by POST /api/break-glass in the web UI",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  const failure = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "merge", "dispatch-1", "--force"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_STATE_DIR: state,
        PORT: String(server.address().port),
      },
    },
  ).then(
    (result) => ({ code: 0, ...result }),
    (error) => error,
  );

  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /EATELIER_BREAK_GLASS_REQUIRED/);
  assert.match(failure.stderr, /POST \/api\/break-glass in the web UI/);
});

test("atelier move-tracker delegates to the loopback API and prints next steps", async (t) => {
  const state = await liveFakeDaemonState(t);
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      project: { name: "fixture" },
      to: "/atelier/state/trackers/fixture",
      nextSteps: "Commit the removal of .beads yourself.",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
  });

  const { stdout } = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "move-tracker", "fixture", "--to", "external"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        ATELIER_STATE_DIR: state,
        PORT: String(server.address().port),
      },
    },
  );

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/api/projects/fixture/move-tracker",
    contentType: "application/json",
    body: JSON.stringify({ to: "external" }),
  }]);
  assert.match(stdout, /Moved fixture tracker to external/);
  assert.match(stdout, /Commit the removal of \.beads yourself/);
});

test("atelier logs prints the newest matching events, bounded by --limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createEventLog } = await import("./lib/event-log.mjs");
  const log = createEventLog({ stateDir: root });
  log.append("queue.drain", { project: "alpha", decision: "skipped", reason: "budget" });
  log.append("queue.drain", { project: "beta", decision: "picked", ticketId: "beta-1" });
  log.append("dispatch.transition", { project: "alpha", dispatchId: "d-1", to: "failed" });

  const all = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "logs"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
  );
  assert.deepEqual(
    all.stdout.trim().split("\n").map((line) => JSON.parse(line).kind),
    ["queue.drain", "queue.drain", "dispatch.transition"],
  );

  const filtered = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "logs", "--kind", "queue.drain", "--project", "beta"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
  );
  const rows = filtered.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticketId, "beta-1");

  const bounded = await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "logs", "--limit", "1"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
  );
  assert.deepEqual(
    bounded.stdout.trim().split("\n").map((line) => JSON.parse(line).kind),
    ["dispatch.transition"],
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("bin", "atelier.mjs"), "logs", "--since", "yesterday-ish"],
      { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
    ),
    /ISO-8601/,
  );
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [resolve("bin", "atelier.mjs"), "logs", "extra"],
      { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
    ),
    /does not accept positional arguments/,
  );
});

test("atelier logs formatter makes rotation loss explicit without changing ordinary JSONL", async () => {
  const { formatLogEvent } = await import("../bin/log-format.mjs");
  assert.equal(formatLogEvent({ gap: true }), "-- gap: events lost to rotation --");
  assert.equal(
    formatLogEvent({ kind: "queue.drain", gap: false }),
    '{"kind":"queue.drain","gap":false}',
  );
});

test("atelier logs --follow loses nothing across a rotation, whatever --limit says", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-follow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { createEventLog } = await import("./lib/event-log.mjs");
  // Small rotation threshold so the run below rolls the active file over while
  // the follower is attached.
  // Sized to cross a few rotations while staying INSIDE retention, so "nothing
  // was lost" is a claim about the follower rather than about the log's size cap.
  const log = createEventLog({ stateDir: root, maxBytes: 700, rotations: 5 });
  log.append("service.start", { index: -1 });
  log._flush();

  // --limit 1 bounds the BACKFILL only. The archived atelier-e5x MAJOR re-applied
  // it on every poll, so a burst larger than the window was silently lost.
  const child = spawn(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "logs", "--follow", "--limit", "1", "--kind", "queue.drain"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_STATE_DIR: root } },
  );
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });
  const seen = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) seen.push(JSON.parse(line));
    }
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  // Let the follower take its cursor before the burst starts.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  const expected = [];
  for (let index = 0; index < 15; index += 1) {
    expected.push(index);
    log.append("queue.drain", { project: "alpha", index, detail: "d".repeat(60) });
    log._flush();
  }
  assert.ok(
    log.read({ limit: 1_000, kind: "queue.drain" }).length === expected.length,
    "the fixture must keep every event it wrote inside retention",
  );
  assert.ok(
    existsSync(join(root, "logs", "events.1.jsonl")),
    "the fixture must actually rotate while the follower is attached",
  );

  const deadline = Date.now() + 15_000;
  while (seen.length < expected.length && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  child.kill("SIGTERM");
  await once(child, "close");

  assert.deepEqual(
    seen.map(({ index }) => index),
    expected,
    `follow delivered ${seen.length} of ${expected.length} events (stderr: ${stderr.join("")})`,
  );
});

test("atelier init writes no state, so a config-only command cannot touch the log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-cli-init-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const state = join(root, "state");

  await execFileAsync(
    process.execPath,
    [resolve("bin", "atelier.mjs"), "init"],
    { cwd: resolve("."), env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_STATE_DIR: state } },
  );

  assert.ok(existsSync(join(config, "projects.json")), "the registry is the record of init");
  // A CLI command that only writes config must not materialise the state
  // directory as a side effect. This is not cosmetic: `atelier init`'s own tests
  // set ATELIER_CONFIG_DIR but not ATELIER_STATE_DIR, so an event written here lands
  // in the developer's real ~/.local/state/atelier (observed, then removed).
  assert.equal(existsSync(join(state, "logs")), false);
  assert.equal(existsSync(state), false);
});
