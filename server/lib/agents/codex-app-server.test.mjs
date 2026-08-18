import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  _appServerRunnerPath,
  _setPollIntervalMs,
  codexAppServerAgent,
  normalizeAppServerMessage,
} from "./codex-app-server.mjs";
import {
  _legacyCodexWarning,
  _setCompanionResolver,
  codexAgent,
} from "./codex.mjs";
import { executionProfileMismatch } from "../execution/execution-profile.mjs";
import { normalizeLine } from "../stream.mjs";

const execFileAsync = promisify(execFile);
const FIXTURES = new URL("./fixtures/", import.meta.url);

async function fixtureExecutable(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-app-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "codex");
  await writeFile(path, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.0'\n");
  await chmod(path, 0o755);
  return { root, path, env: { ...process.env, PATH: root } };
}

function readNdjson(name) {
  return readFileSync(new URL(name, FIXTURES), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("generated 0.147.0 schema snapshot binds the implemented method names", () => {
  const schema = JSON.parse(readFileSync(
    new URL("codex-app-server-0.147.0.schema.json", FIXTURES),
    "utf8",
  ));
  const serialized = JSON.stringify(schema);
  for (const method of [
    "thread/start",
    "thread/resume",
    "thread/read",
    "turn/start",
    "turn/interrupt",
    "item/agentMessage/delta",
    "thread/tokenUsage/updated",
    "turn/completed",
  ]) assert.ok(serialized.includes(`\"${method}\"`), `schema omitted ${method}`);
  for (const invented of ["thread/create", "turn/done", "agent/message/delta"]) {
    assert.ok(!serialized.includes(`\"${invented}\"`), `invented method landed: ${invented}`);
  }
});

test("captured app-server stream tripwire keeps the real notification set", () => {
  const messages = readNdjson("codex-app-server-0.147.0.ndjson");
  const methods = [...new Set(messages.map((message) => message.method).filter(Boolean))].sort();
  assert.deepEqual(methods, [
    "configWarning",
    "error",
    "item/completed",
    "item/started",
    "remoteControl/status/changed",
    "thread/started",
    "thread/status/changed",
    "turn/started",
  ]);
  for (const wrong of ["threadCreated", "turnStarted", "item.agent_message.delta"]) {
    assert.equal(methods.includes(wrong), false);
  }
  assert.match(messages[0].result.userAgent, /0\.147\.0/);
});

test("captured fake-provider Claude NDJSON tripwire uses the existing normalizer shape", () => {
  const messages = readNdjson("claude-fake-provider.ndjson");
  assert.deepEqual([...new Set(messages.map(({ type }) => type))].sort(), ["result", "system"]);
  assert.equal(messages.some(({ type }) => type === "assistant_message"), false);
  assert.deepEqual(messages.flatMap((message) => normalizeLine(JSON.stringify(message))), [
    { type: "status", state: "running", model: "fake", sessionId: "fake-captured-session" },
    { type: "usage", turns: 1, costUSD: 0, inputTokens: 0, outputTokens: 0 },
    { type: "exit", success: true, summary: "fake-agent scenario completed" },
  ]);
});

test("app-server event mapping emits text, tools, files, and token usage", () => {
  const entry = { record: { turns: 2, costUSD: 0 } };
  assert.deepEqual(normalizeAppServerMessage({
    method: "item/agentMessage/delta",
    params: { delta: "hello" },
  }, entry), [{ type: "message", kind: "text", text: "hello" }]);
  assert.equal(normalizeAppServerMessage({
    method: "item/started",
    params: { item: { type: "commandExecution", command: "node --test" } },
  }, entry)[0].kind, "tool_use");
  assert.equal(normalizeAppServerMessage({
    method: "item/completed",
    params: { item: { type: "fileChange", changes: [{ path: "x" }] } },
  }, entry)[0].kind, "files");
  assert.deepEqual(normalizeAppServerMessage({
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } } },
  }, entry), [{
    type: "usage",
    turns: 2,
    costUSD: 0,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  }]);
});

test("app-server execution profile records and compares path, version, and digest", async (t) => {
  const fixture = await fixtureExecutable(t);
  const entry = { record: { lane: "codex", codexAdapter: "app-server" } };
  const profile = codexAppServerAgent.executionProfile({
    entry,
    env: fixture.env,
    controlledKeys: [],
    hooksSupported: true,
  });
  assert.deepEqual(profile.executable, {
    command: "codex",
    resolvedPath: fixture.path,
    version: "codex-cli 0.147.0",
    digest: createHash("sha256").update(readFileSync(fixture.path)).digest("hex"),
  });
  const changed = structuredClone(profile);
  changed.executable.digest = "0".repeat(64);
  assert.match(executionProfileMismatch(profile, changed, {
    executable: true,
    executableVersion: true,
    executableDigest: true,
  }), /executable\.digest/);
  const legacy = structuredClone(profile);
  delete legacy.executable.version;
  delete legacy.executable.digest;
  assert.equal(executionProfileMismatch(legacy, profile, {
    executableVersion: true,
    executableDigest: true,
  }), null);
});

test("legacy opt-in warns once and pins the companion content digest", async (t) => {
  const fixture = await fixtureExecutable(t);
  const companion = join(fixture.root, "codex-companion.mjs");
  await writeFile(companion, "// captured companion fixture\n");
  _setCompanionResolver(() => companion);
  t.after(() => _setCompanionResolver());
  const entry = {
    record: {
      lane: "codex",
      codexAdapter: "legacy-companion",
      effort: null,
      warnings: [],
    },
  };
  const env = codexAgent.executionEnv(fixture.env);
  await codexAgent.preLaunchChecks({
    entry,
    worktreePath: fixture.root,
    env,
    commandRunner: async () => ".git",
  });
  const profile = codexAgent.executionProfile({
    entry,
    env,
    controlledKeys: [],
    hooksSupported: true,
  });
  assert.equal(entry.record.warnings.filter((warning) => warning === _legacyCodexWarning).length, 1);
  assert.equal(profile.companionPath, companion);
  assert.equal(
    profile.companionDigest,
    createHash("sha256").update(readFileSync(companion)).digest("hex"),
  );
  assert.equal(profile.executable.command, "codex");
});

function launchChild(payload) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  setImmediate(() => {
    child.stdout.end(`${JSON.stringify(payload)}\n`);
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

test("launch polls the detached runner, captures thread/output, and maps terminal success", async (t) => {
  const fixture = await fixtureExecutable(t);
  const stream = join(fixture.root, "captured.stream.jsonl");
  await writeFile(stream, [
    JSON.stringify({ method: "thread/started", params: { thread: { id: "thread-fixture" } } }),
    JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "implemented" } }),
    "",
  ].join("\n"));
  _setPollIntervalMs(5);
  t.after(() => _setPollIntervalMs());
  const entry = {
    record: {
      id: "dispatch-app-server",
      lane: "codex",
      codexAdapter: "app-server",
      state: "preparing",
      readOnly: false,
      worktreePath: fixture.root,
      turns: 0,
      costUSD: 0,
      sessionId: null,
      warnings: [],
      executionProfile: { executable: { resolvedPath: fixture.path } },
    },
    stderrLines: [],
  };
  const events = [];
  let finished;
  const done = new Promise((resolvePromise) => { finished = resolvePromise; });
  const callbacks = {
    streamLines(streamValue, handler) {
      streamValue.setEncoding("utf8");
      let buffered = "";
      streamValue.on("data", (chunk) => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop();
        for (const line of lines) handler(line);
      });
    },
    captureCompanion(_entry, { jobId, workspace }) {
      entry.codexJobId = jobId;
      entry.record.codexJobId = jobId;
      entry.record.codexWorkspace = workspace;
      entry.record.state = "running";
    },
    captureSession(_entry, id) { entry.record.sessionId = id; },
    captureWorkerPid: () => true,
    captureCodexProcessTree() {},
    resolveSnapshotWorker: () => true,
    emit(_entry, event) { events.push(event); return event; },
    finish(_entry, _project, code) { finished({ code, result: entry.result }); },
  };
  codexAppServerAgent.launch({
    entry,
    project: {},
    prompt: "fixture prompt",
    worktreePath: fixture.root,
    dispatchDir: fixture.root,
    env: fixture.env,
    spawner: () => launchChild({ jobId: "job-fixture", logFile: stream }),
    commandRunner: async (_file, args) => {
      if (args[1] === "status") {
        return JSON.stringify({
          status: "completed",
          pid: null,
          threadId: "thread-fixture",
          streamFile: stream,
        });
      }
      if (args[1] === "result") {
        return JSON.stringify({
          status: "completed",
          pid: null,
          threadId: "thread-fixture",
          streamFile: stream,
          rawOutput: "implemented",
          summary: "implemented",
        });
      }
      throw new Error(`unexpected runner command ${args.join(" ")}`);
    },
    callbacks,
  });
  const outcome = await done;
  assert.equal(outcome.code, 0);
  assert.equal(outcome.result.success, true);
  assert.equal(outcome.result.finalOutput.retrieved, true);
  assert.equal(entry.record.sessionId, "thread-fixture");
  assert.ok(events.some((event) => event.type === "message" && event.text === "implemented"));
});

test("restart reattach validates the persisted runner pid and stays fail-closed", async (t) => {
  _setPollIntervalMs(50);
  t.after(() => _setPollIntervalMs());
  const entry = {
    record: {
      state: "running",
      codexJobId: "job-restart",
      codexWorkspace: resolve("."),
      codexWorkerPid: process.pid,
    },
    stderrLines: [],
  };
  let classified = 0;
  let statusRead;
  const observed = new Promise((resolvePromise) => { statusRead = resolvePromise; });
  codexAppServerAgent.reattach({
    entry,
    project: {},
    workspace: resolve("."),
    env: process.env,
    commandRunner: async () => {
      statusRead();
      return JSON.stringify({ status: "running", pid: process.pid, threadId: "thread-restart" });
    },
    callbacks: {
      emit(_entry, event) { return event; },
      captureSession(_entry, id) { entry.record.sessionId = id; },
      classifyReportedWorker() { classified += 1; return "alive"; },
      captureWorkerPid: () => true,
      captureCodexProcessTree() {},
      resolveSnapshotWorker: () => false,
      finish() { assert.fail("a corroborated runner must not fail reattach"); },
    },
  });
  await observed;
  codexAppServerAgent.detach({ entry });
  assert.equal(classified, 1);
  assert.equal(entry.record.sessionId, "thread-restart");
});

test("detached runner survives its launcher and exposes the same pid identity to a fresh client", {
  skip: process.env.ATELIER_TEST_NO_REAL_PROVIDER === "1" || process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-runner-restart-test-"));
  const codexPath = join(root, "codex-stub.mjs");
  const promptPath = join(root, "prompt.txt");
  const statePath = join(root, "state");
  const releasePath = join(root, "release");
  await mkdir(statePath);
  await writeFile(promptPath, "stub transport only\n");
  await writeFile(codexPath, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { serverInfo: { name: "stub" } } }));
  } else if (message.method === "thread/start") {
    console.log(JSON.stringify({ id: message.id, result: { thread: { id: "stub-thread" } } }));
  } else if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "stub-turn" } } }));
    const timer = setInterval(() => {
      if (!existsSync(process.env.CODEX_STUB_RELEASE)) return;
      clearInterval(timer);
      console.log(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "stub complete" } }));
      console.log(JSON.stringify({ method: "turn/completed", params: { turn: { id: "stub-turn", status: "completed" } } }));
    }, 10);
  }
});
`);
  await chmod(codexPath, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerEnv = { ...process.env, CODEX_STUB_RELEASE: releasePath };
  const launched = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath,
    "task",
    "--codex", codexPath,
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env: runnerEnv })).stdout);
  t.after(async () => {
    try {
      await execFileAsync(process.execPath, [
        _appServerRunnerPath,
        "cancel",
        launched.jobId,
        "--state-dir", statePath,
      ], { env: runnerEnv });
    } catch {
      // The runner is expected to have exited by the successful path.
    }
  });

  const readStatus = async () => JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath,
    "status",
    launched.jobId,
    "--state-dir", statePath,
  ], { env: runnerEnv })).stdout);
  let beforeRestart;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    beforeRestart = await readStatus();
    if (beforeRestart.status === "running" && beforeRestart.threadId === "stub-thread") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(beforeRestart.status, "running");
  assert.equal(beforeRestart.threadId, "stub-thread");
  assert.equal(beforeRestart.pid, launched.pid);
  if (process.platform === "linux") {
    assert.match(beforeRestart.pidStartIdentity, /^linux-proc-start:/);
  } else {
    assert.equal(beforeRestart.pidStartIdentity, null);
  }

  // This new status client stands in for a newly started Atelier daemon. The
  // original task launcher is already gone, but the corroborated runner remains.
  const afterRestart = await readStatus();
  assert.equal(afterRestart.pid, beforeRestart.pid);
  assert.equal(afterRestart.pidStartIdentity, beforeRestart.pidStartIdentity);
  await writeFile(releasePath, "finish\n");
  let completed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    completed = await readStatus();
    if (completed.status === "completed") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.pid, null);
  const result = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath,
    "result",
    launched.jobId,
    "--state-dir", statePath,
  ], { env: runnerEnv })).stdout);
  assert.equal(result.threadId, "stub-thread");
  assert.equal(result.rawOutput, "stub complete");
});

test("app-server stop retains the fence when runner exit is unproven", async () => {
  const entry = {
    codexJobId: "job-unproven",
    env: {},
    record: { warnings: [], codexWorkspace: resolve(".") },
  };
  const stopped = await codexAppServerAgent.stop({
    entry,
    commandRunner: async () => JSON.stringify({
      finish: false,
      warning: "worker exit is unproven",
    }),
  });
  assert.deepEqual(stopped, { finish: false, warning: "worker exit is unproven" });
  assert.deepEqual(entry.record.warnings, ["worker exit is unproven"]);
});

test("runner refuses every real-provider launch under the golden guard", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [_appServerRunnerPath, "task"], {
      env: { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" },
    }),
    /EATELIER_REAL_PROVIDER_DISABLED/,
  );
});
