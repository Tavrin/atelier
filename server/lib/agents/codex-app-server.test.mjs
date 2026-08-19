import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
  _appServerRunnerPath,
  _setPollIntervalMs,
  codexAppServerAgent,
  inspectCodexBinary,
  normalizeAppServerMessage,
  probeCodexAppServer,
} from "./codex-app-server.mjs";
import { _runnerTest } from "./codex-app-server-runner.mjs";
import {
  _legacyCodexWarning,
  _setCompanionResolver,
  codexAgent,
} from "./codex.mjs";
import { executionProfileMismatch } from "../execution/execution-profile.mjs";
import { normalizeLine } from "../stream.mjs";

const execFileAsync = promisify(execFile);
const FIXTURES = new URL("./fixtures/", import.meta.url);

test("detached runner direct spawns route through backend-neutral sandbox wrapping", () => {
  const calls = [];
  const backend = {
    id: "recording",
    version: () => "1",
    probe: () => ({ available: true, reason: "recording backend ready", evidence: {} }),
    wrap(input) {
      calls.push({ kind: "wrap", input: structuredClone(input) });
      return {
        file: "/recording/sandbox",
        args: ["boundary", "--", input.file, ...input.args],
        env: { ...input.env },
      };
    },
  };
  const spawned = { pid: 123 };
  const result = _runnerTest.spawnWithSandbox(
    {
      trustProfile: { confinement: "sandboxed-write", credential: "none" },
      backendId: "recording",
    },
    "/provider",
    ["app-server", "--stdio"],
    { cwd: "/workspace", env: { SAFE: "yes" } },
    {
      backends: new Map([[backend.id, backend]]),
      spawn(file, args, options) {
        calls.push({ kind: "spawn", file, args, options });
        return spawned;
      },
    },
  );
  assert.equal(result, spawned);
  assert.equal(calls[0].kind, "wrap");
  assert.deepEqual(calls[0].input.args, ["app-server", "--stdio"]);
  assert.deepEqual(calls[1], {
    kind: "spawn",
    file: "/recording/sandbox",
    args: ["boundary", "--", "/provider", "app-server", "--stdio"],
    options: { cwd: "/workspace", env: { SAFE: "yes" } },
  });
});

test("late sandbox refusal makes the runner terminal and releases its attachment lease", async (t) => {
  const fixture = await fixtureExecutable(t);
  const state = join(fixture.root, "jobs");
  await mkdir(state);
  const jobId = "a".repeat(24);
  const jobPath = join(state, `${jobId}.json`);
  const leasePath = join(state, `${jobId}.attach.json`);
  const streamFile = join(state, `${jobId}.stream.jsonl`);
  const promptPath = join(fixture.root, "prompt.txt");
  await writeFile(promptPath, "fixture prompt\n");
  await writeFile(streamFile, "");
  const identity = lstatSync(fixture.path);
  await writeFile(jobPath, `${JSON.stringify({
    version: 1,
    jobId,
    status: "queued",
    pid: null,
    pidStartIdentity: null,
    codexPath: fixture.path,
    binaryFiles: [{
      path: fixture.path,
      dev: String(identity.dev),
      ino: String(identity.ino),
    }],
    workspace: fixture.root,
    promptPath,
    streamFile,
    write: true,
    createdAt: new Date().toISOString(),
    summary: "",
    rawOutput: "",
    errorMessage: null,
    testStub: true,
    sandbox: {
      trustProfile: { confinement: "sandboxed-write", credential: "none" },
      backendId: "bwrap",
    },
  }, null, 2)}\n`);
  await writeFile(leasePath, "{}\n");
  const previousGuard = process.env.ATELIER_TEST_NO_REAL_PROVIDER;
  process.env.ATELIER_TEST_NO_REAL_PROVIDER = "1";
  t.after(() => {
    if (previousGuard === undefined) delete process.env.ATELIER_TEST_NO_REAL_PROVIDER;
    else process.env.ATELIER_TEST_NO_REAL_PROVIDER = previousGuard;
  });

  await _runnerTest.runJob(jobPath, {
    spawnAppServer() {
      const error = new Error(
        "EATELIER_SANDBOX_UNAVAILABLE: bwrap: backend disappeared after admission",
      );
      error.code = "EATELIER_SANDBOX_UNAVAILABLE";
      throw error;
    },
  });

  const terminal = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(terminal.status, "failed");
  assert.match(terminal.errorMessage, /^EATELIER_SANDBOX_UNAVAILABLE:/);
  assert.equal(typeof terminal.endedAt, "string");
  assert.equal(existsSync(leasePath), false);
});

test("app-server capability probe uses its supplied sandbox spawner", async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; };
  let captured;
  const resultPromise = probeCodexAppServer("/provider", { SAFE: "yes" }, {
    spawner(file, args, options) {
      captured = { file, args, options };
      setImmediate(() => {
        child.stdout.write(`${JSON.stringify({
          id: 1,
          result: { userAgent: "fixture", platformFamily: "unix", platformOs: "linux" },
        })}\n`);
        child.stdout.end();
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal((await resultPromise).userAgent, "fixture");
  assert.deepEqual(captured, {
    file: "/provider",
    args: ["app-server", "--stdio"],
    options: {
      env: { SAFE: "yes" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  });
});

async function fixtureExecutable(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-app-server-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "codex");
  await writeFile(path, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.147.0'\n");
  await chmod(path, 0o755);
  return { root, path, env: { ...process.env, PATH: root } };
}

async function fixtureNpmLauncher(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-npm-launcher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const target = {
    "linux:x64": ["codex-linux-x64", "x86_64-unknown-linux-musl"],
    "linux:arm64": ["codex-linux-arm64", "aarch64-unknown-linux-musl"],
    "darwin:x64": ["codex-darwin-x64", "x86_64-apple-darwin"],
    "darwin:arm64": ["codex-darwin-arm64", "aarch64-apple-darwin"],
    "win32:x64": ["codex-win32-x64", "x86_64-pc-windows-msvc"],
    "win32:arm64": ["codex-win32-arm64", "aarch64-pc-windows-msvc"],
  }[`${process.platform}:${process.arch}`];
  assert.ok(target, "test host needs a supported Codex platform target");
  const [packageName, triple] = target;
  const packageRoot = join(root, "node_modules", "@openai", packageName);
  const native = join(packageRoot, "vendor", triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const launcher = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
  await mkdir(join(packageRoot, "vendor", triple, "bin"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: `@openai/${packageName}`, version: "9.9.9" }));
  await writeFile(native, "native payload fixture\n");
  await writeFile(launcher, [
    "#!/usr/bin/env node",
    "const PLATFORM_PACKAGE_BY_TARGET = {};",
    "const packageMarker = '@openai/codex-';",
    "console.log('codex-cli 9.9.9');",
    "",
  ].join("\n"));
  await chmod(launcher, 0o755);
  await chmod(native, 0o755);
  return { root, launcher, native, env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}` } };
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
    "item/agentMessage/delta",
    "item/completed",
    "item/started",
    "thread/started",
    "thread/status/changed",
    "thread/tokenUsage/updated",
    "turn/completed",
    "turn/started",
  ]);
  for (const wrong of ["threadCreated", "turnStarted", "item.agent_message.delta"]) {
    assert.equal(methods.includes(wrong), false);
  }
  assert.match(messages[0].result.userAgent, /0\.147\.0/);
  const threadId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  const threaded = messages.filter((message) => message.params?.threadId);
  assert.ok(threaded.length > 0);
  assert.ok(threaded.every((message) => message.params.threadId === threadId));
  assert.ok(threaded.filter((message) => message.params.turnId)
    .every((message) => message.params.turnId === turnId));
  assert.equal(messages.find((message) => message.id === 2).result.thread.id, threadId);
  assert.equal(messages.find((message) => message.id === 3).result.turn.id, turnId);
});

test("captured fake-provider Claude NDJSON tripwire uses the existing normalizer shape", () => {
  const messages = readNdjson("claude-fake-provider.ndjson");
  assert.deepEqual([...new Set(messages.map(({ type }) => type))].sort(), [
    "assistant", "result", "system", "user",
  ]);
  assert.equal(messages.some(({ type }) => type === "assistant_message"), false);
  assert.deepEqual(messages.flatMap((message) => normalizeLine(JSON.stringify(message))), [
    { type: "status", state: "running", model: "fake", sessionId: "fake-captured-session" },
    { type: "message", kind: "text", text: "Inspecting the fixture." },
    { type: "message", kind: "tool_use", name: "Read", inputPreview: "{\"file_path\":\"fixture.txt\"}" },
    { type: "message", kind: "tool_result", preview: "fixture contents" },
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
    turns: 3,
    costUSD: 0,
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
  }]);
  assert.deepEqual(normalizeAppServerMessage({
    method: "item/completed",
    params: { item: { type: "agentMessage", text: "final text" } },
  }, entry), [{ type: "message", kind: "text", text: "final text" }]);
  const long = "x".repeat(800);
  for (const message of [
    { method: "item/agentMessage/delta", params: { delta: long } },
    { method: "item/started", params: { item: { type: "commandExecution", command: long } } },
    { method: "item/completed", params: { item: { type: "agentMessage", text: long } } },
  ]) {
    const [event] = normalizeAppServerMessage(message, entry);
    const payload = event.text ?? event.inputPreview ?? event.preview;
    assert.ok(payload.length <= 400);
  }
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
  const contentDigest = createHash("sha256").update(readFileSync(fixture.path)).digest("hex");
  const combinedDigest = createHash("sha256")
    .update(`${fixture.path}\0${contentDigest}\n`)
    .digest("hex");
  assert.deepEqual(profile.executable, {
    command: "codex",
    resolvedPath: fixture.path,
    version: "codex-cli 0.147.0",
    digest: combinedDigest,
    digestPaths: [fixture.path],
  });
  assert.equal(profile.binaryPinned, true);
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

test("npm launcher pinning digests the launcher and platform-native payload", async (t) => {
  const fixture = await fixtureNpmLauncher(t);
  const first = inspectCodexBinary(fixture.env);
  assert.equal(first.resolvedPath, fixture.launcher);
  assert.deepEqual(first.digestPaths, [fixture.launcher, fixture.native]);
  assert.equal(first.files.length, 2);
  assert.equal(first.version, "codex-cli 9.9.9");
  const launcherDigest = first.digest;
  await writeFile(fixture.native, "changed native payload fixture\n");
  const changed = inspectCodexBinary(fixture.env);
  assert.notEqual(changed.digest, launcherDigest);
  assert.deepEqual(changed.digestPaths, first.digestPaths);
});

test("runner protocol stream is redacted and ends with an explicit bounded truncation marker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-stream-limit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const streamFile = join(root, "stream.jsonl");
  const job = { streamFile };
  _runnerTest.appendStream(job, { method: "fixture", params: { text: "OPENAI_API_KEY=sk-abcdefghijklmnop" } });
  for (let index = 0; index < 300; index += 1) {
    _runnerTest.appendStream(job, { method: "fixture", params: { text: "x".repeat(5_000) } });
  }
  const captured = readFileSync(streamFile, "utf8");
  assert.ok(Buffer.byteLength(captured) <= _runnerTest.STREAM_BYTE_LIMIT);
  assert.doesNotMatch(captured, /sk-abcdefghijklmnop/);
  assert.match(captured, /"method":"atelier\/streamTruncated".*\n$/s);
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
  assert.equal(profile.executable.command, process.execPath);
  assert.equal(profile.executable.resolvedPath, process.execPath);
  assert.equal(profile.binaryPinned, false);
  assert.ok(entry.record.warnings.some((warning) => warning.includes("cannot pin the codex binary")));
});

test("pre-ATT routing uses only recorded companion evidence and record-owned env strategy", async (t) => {
  const fixture = await fixtureExecutable(t);
  const companion = join(fixture.root, "recorded-companion.mjs");
  await writeFile(companion, "// pinned pre-ATT companion\n");
  let freshResolutions = 0;
  _setCompanionResolver(() => {
    freshResolutions += 1;
    return companion;
  });
  t.after(() => _setCompanionResolver());

  const appEntry = { record: { lane: "codex", warnings: [] } };
  const appProfile = codexAgent.executionProfile({
    entry: appEntry,
    env: fixture.env,
    controlledKeys: [],
    hooksSupported: true,
  });
  assert.equal(appProfile.binaryPinned, true);
  assert.equal(freshResolutions, 0, "an undiscriminated fresh record must not consult the companion glob");

  const oldEntry = {
    record: {
      lane: "codex",
      warnings: [],
      executionProfile: { companionPath: companion },
    },
  };
  const oldProfile = codexAgent.executionProfile({
    entry: oldEntry,
    env: fixture.env,
    controlledKeys: [],
    hooksSupported: true,
  });
  assert.equal(oldProfile.companionPath, companion);
  assert.equal(freshResolutions, 0, "pre-ATT records must use the recorded companion path");
  await codexAgent.preLaunchChecks({
    entry: oldEntry,
    worktreePath: fixture.root,
    env: codexAgent.executionEnv(fixture.env, {
      project: { legacyCodexCompanion: false },
      entry: oldEntry,
    }),
    commandRunner: async () => ".git",
  });
  assert.equal(freshResolutions, 0);
  assert.equal(oldEntry.record.warnings.filter((warning) => warning === _legacyCodexWarning).length, 1);

  assert.equal(
    Object.hasOwn(codexAgent.executionEnv(fixture.env, {
      project: { legacyCodexCompanion: true },
      entry: appEntry,
    }), "CLAUDE_PLUGIN_DATA"),
    false,
    "a mutable project flag must not change an app-server record's environment",
  );
  assert.equal(
    typeof codexAgent.executionEnv(fixture.env, {
      project: { legacyCodexCompanion: false },
      entry: oldEntry,
    }).CLAUDE_PLUGIN_DATA,
    "string",
    "a legacy record keeps its companion environment after a project flag toggle",
  );
});

test("legacy interpreter aliases compare by realpath but a different binary still mismatches", {
  skip: process.platform === "win32",
}, async (t) => {
  const fixture = await fixtureExecutable(t);
  const alias = join(fixture.root, "node-alias");
  const companion = join(fixture.root, "recorded-companion.mjs");
  await symlink(process.execPath, alias);
  await writeFile(companion, "// legacy companion\n");
  const entry = {
    record: {
      lane: "codex",
      codexAdapter: "legacy-companion",
      executionProfile: {
        executable: { resolvedPath: alias },
        companionPath: companion,
      },
    },
  };
  const current = codexAgent.executionProfile({
    entry,
    env: fixture.env,
    controlledKeys: [],
    hooksSupported: true,
  });
  const recorded = structuredClone(current);
  assert.equal(current.executable.resolvedPath, alias);
  assert.equal(executionProfileMismatch(recorded, current, {
    executable: true,
  }), null);
  entry.record.executionProfile = { ...recorded, executable: {
    ...recorded.executable,
    resolvedPath: fixture.path,
  } };
  const changed = codexAgent.executionProfile({
    entry,
    env: fixture.env,
    controlledKeys: [],
    hooksSupported: true,
  });
  assert.match(executionProfileMismatch(entry.record.executionProfile, changed, {
    executable: true,
  }), /executable\.resolvedPath/);
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

test("launcher failure after job persistence stays reattachable instead of finishing", async (t) => {
  const fixture = await fixtureExecutable(t);
  const entry = {
    record: {
      id: "launcher-failure",
      lane: "codex",
      codexAdapter: "app-server",
      state: "preparing",
      readOnly: false,
      warnings: [],
      executionProfile: { executable: { resolvedPath: fixture.path } },
    },
    codexBinary: { files: [] },
    stderrLines: [],
  };
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  const retained = new Promise((resolvePromise) => {
    codexAppServerAgent.launch({
      entry,
      project: {},
      prompt: "persist before failure",
      worktreePath: fixture.root,
      dispatchDir: fixture.root,
      env: fixture.env,
      spawner: () => child,
      commandRunner: async () => assert.fail("launcher failure must not poll"),
      callbacks: {
        captureCodexJob(_entry, { jobId, workspace }) {
          entry.record.codexJobId = jobId;
          entry.record.codexWorkspace = workspace;
        },
        streamLines(streamValue, handler) {
          streamValue.setEncoding("utf8");
          streamValue.on("data", handler);
        },
        retainCodexReattachFailure(_entry, detail) { resolvePromise(detail); },
        finish() { assert.fail("an unresolved persisted job must not finish"); },
      },
    });
  });
  child.stderr.end("launcher timed out\n");
  child.stdout.end();
  child.emit("close", 1, null);
  assert.match(await retained, /restart reattach will resolve/);
  assert.match(entry.record.codexJobId, /^[a-f0-9]{24}$/);
  assert.equal(entry.record.state, "preparing");
});

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
  let capturedBeforeSpawn = false;
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
    captureCodexJob(_entry, { jobId, workspace }) {
      entry.codexJobId = jobId;
      entry.record.codexJobId = jobId;
      entry.record.codexWorkspace = workspace;
      capturedBeforeSpawn = true;
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
    spawner: (_file, args) => {
      assert.equal(capturedBeforeSpawn, true, "job id must be durable before detached spawn");
      assert.equal(args[args.indexOf("--job-id") + 1], entry.record.codexJobId);
      return launchChild({
        jobId: args[args.indexOf("--job-id") + 1],
        logFile: stream,
      });
    },
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
  assert.equal(events.some((event) => event.type === "status" && event.state === "completed"), false);
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
  await codexAppServerAgent.reattach({
    entry,
    project: {},
    workspace: resolve("."),
    env: process.env,
    commandRunner: async (_file, args) => {
      if (args[1] === "attach") {
        return JSON.stringify({ attached: true, attachLease: {} });
      }
      statusRead();
      return JSON.stringify({
        status: "running",
        pid: process.pid,
        pidStartIdentity: "fixture-identity",
        threadId: "thread-restart",
      });
    },
    callbacks: {
      emit(_entry, event) { return event; },
      captureCompanion() {},
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

test("detached runner survives its launcher under the guard and exposes its identity", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-runner-restart-test-"));
  const codexPath = join(root, "codex-stub.mjs");
  const promptPath = join(root, "prompt.txt");
  const statePath = join(root, "state");
  const releasePath = join(root, "release");
  const codexHome = join(root, "codex-home");
  await mkdir(statePath);
  await mkdir(codexHome);
  await writeFile(promptPath, "stub transport only\n");
  await writeFile(codexPath, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: {
      userAgent: "stub/1.0",
      platformFamily: "unix",
      platformOs: "linux"
    } }));
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
  const details = lstatSync(codexPath);
  const jobId = "a".repeat(24);
  const runnerEnv = {
    ...process.env,
    ATELIER_TEST_NO_REAL_PROVIDER: "1",
    CODEX_HOME: codexHome,
    CODEX_STUB_RELEASE: releasePath,
  };
  const launched = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath,
    "task",
    "--test-stub",
    "--job-id", jobId,
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify([{
      path: codexPath,
      dev: String(details.dev),
      ino: String(details.ino),
    }]),
    "--dispatcher-id", "restart-test-dispatcher",
    "--dispatcher-pid", String(process.pid),
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env: runnerEnv })).stdout);
  assert.equal(launched.jobId, jobId);
  await assert.rejects(
    execFileAsync(process.execPath, [
      _appServerRunnerPath,
      "attach",
      launched.jobId,
      "--state-dir", statePath,
      "--dispatcher-id", "second-dispatcher",
      "--dispatcher-pid", String(process.pid),
      "--dispatcher-pid-identity", _runnerTest.processStartIdentity(process.pid),
    ], { env: runnerEnv }),
    /attachment refused: lease held by dispatcher restart-test-dispatcher/,
  );
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

test("runner refuses a binary whose captured device/inode identity diverges before spawn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-runner-pin-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state");
  const codexHome = join(root, "codex-home");
  const codexPath = join(root, "codex-stub.mjs");
  const promptPath = join(root, "prompt.txt");
  await mkdir(statePath);
  await mkdir(codexHome);
  await writeFile(promptPath, "must never reach the stub\n");
  await writeFile(codexPath, "#!/usr/bin/env node\nthrow new Error('spawned despite pin divergence');\n");
  await chmod(codexPath, 0o755);
  const details = lstatSync(codexPath);
  const jobId = "b".repeat(24);
  const runnerEnv = { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1", CODEX_HOME: codexHome };
  await execFileAsync(process.execPath, [
    _appServerRunnerPath,
    "task",
    "--test-stub",
    "--job-id", jobId,
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify([{
      path: codexPath,
      dev: String(details.dev),
      ino: String(BigInt(details.ino) + 1n),
    }]),
    "--dispatcher-id", "pin-test-dispatcher",
    "--dispatcher-pid", String(process.pid),
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env: runnerEnv });
  let status;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = JSON.parse((await execFileAsync(process.execPath, [
      _appServerRunnerPath, "result", jobId, "--state-dir", statePath,
    ], { env: runnerEnv })).stdout);
    if (status.status === "failed") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(status.status, "failed");
  assert.match(status.summary, /binary identity diverged before spawn/);
});

test("runner times out a lifecycle request and escalates an ignored TERM to KILL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-runner-timeout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state");
  const codexHome = join(root, "codex-home");
  const codexPath = join(root, "codex-stub.mjs");
  const promptPath = join(root, "prompt.txt");
  const childPidPath = join(root, "child.pid");
  const termPath = join(root, "term-observed");
  await mkdir(statePath);
  await mkdir(codexHome);
  await writeFile(promptPath, "timeout fixture\n");
  await writeFile(codexPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
writeFileSync(process.env.CODEX_STUB_CHILD_PID, String(process.pid));
process.on("SIGTERM", () => writeFileSync(process.env.CODEX_STUB_TERM, "observed\\n"));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {
    userAgent: "stub/1.0", platformFamily: "unix", platformOs: "linux"
  } }));
  if (message.method === "thread/start") console.log(JSON.stringify({
    id: message.id, result: { thread: { id: "timeout-thread" } }
  }));
  // Deliberately never answer turn/start and deliberately ignore SIGTERM.
});
`);
  await chmod(codexPath, 0o755);
  const details = lstatSync(codexPath);
  const jobId = "c".repeat(24);
  const runnerEnv = {
    ...process.env,
    ATELIER_TEST_NO_REAL_PROVIDER: "1",
    ATELIER_TEST_CODEX_REQUEST_TIMEOUT_MS: "50",
    ATELIER_TEST_CODEX_TERMINATION_GRACE_MS: "50",
    CODEX_HOME: codexHome,
    CODEX_STUB_CHILD_PID: childPidPath,
    CODEX_STUB_TERM: termPath,
  };
  await execFileAsync(process.execPath, [
    _appServerRunnerPath, "task", "--test-stub",
    "--job-id", jobId,
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify([{
      path: codexPath, dev: String(details.dev), ino: String(details.ino),
    }]),
    "--dispatcher-id", "timeout-test-dispatcher",
    "--dispatcher-pid", String(process.pid),
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env: runnerEnv });
  let status;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    status = JSON.parse((await execFileAsync(process.execPath, [
      _appServerRunnerPath, "result", jobId, "--state-dir", statePath,
    ], { env: runnerEnv })).stdout);
    if (status.status === "failed") break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(status.status, "failed");
  assert.match(status.summary, /turn\/start request timed out/);
  assert.equal(existsSync(termPath), true, "the app-server must first receive TERM");
  const appServerPid = Number(readFileSync(childPidPath, "utf8"));
  let alive = true;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { process.kill(appServerPid, 0); } catch { alive = false; break; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(alive, false, "the TERM-ignoring app-server must be escalated to KILL");
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

test("stop during launch uses the persisted job id, kills the launcher, and warns while unproven", async (t) => {
  const launcher = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  t.after(() => {
    try {
      if (process.platform === "win32") launcher.kill("SIGKILL");
      else process.kill(-launcher.pid, "SIGKILL");
    } catch {
      // The tested stop should already have reaped it.
    }
  });
  await once(launcher, "spawn");
  const entry = {
    child: launcher,
    env: {},
    stderrLines: [],
    record: {
      codexJobId: "persisted-launch-window-job",
      codexWorkspace: resolve("."),
      warnings: [],
    },
  };
  const stopped = await codexAppServerAgent.stop({
    entry,
    commandRunner: async (_file, args) => {
      assert.equal(args[2], "persisted-launch-window-job");
      return JSON.stringify({ finish: false, warning: "runner death remains unproven" });
    },
  });
  assert.deepEqual(stopped, { finish: false, warning: "runner death remains unproven" });
  assert.deepEqual(entry.record.warnings, ["runner death remains unproven"]);
  if (launcher.exitCode === null && launcher.signalCode === null) await once(launcher, "exit");
});

test("status remains readable without a lease and advertises live-job adoption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-missing-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobId = "d".repeat(24);
  const jobPath = join(root, `${jobId}.json`);
  const live = {
    version: 1,
    jobId,
    status: "running",
    pid: process.pid,
    pidStartIdentity: _runnerTest.processStartIdentity(process.pid),
  };
  await writeFile(jobPath, JSON.stringify(live));
  const status = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath, "status", jobId, "--state-dir", root,
  ])).stdout);
  assert.equal(status.status, "running");
  assert.equal(status.adoptableViaAttach, true);
  assert.match(status.warning, /attachment lease is missing/);

  await writeFile(jobPath, JSON.stringify({
    ...live,
    status: "completed",
    pid: null,
    pidStartIdentity: null,
    endedAt: new Date().toISOString(),
  }));
  const completed = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath, "status", jobId, "--state-dir", root,
  ])).stdout);
  assert.equal(completed.status, "completed");
  assert.equal(completed.warning, undefined);
});

test("test-stub cannot bypass task or run guards outside its invoking tmp workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-guard-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const statePath = join(root, "state");
  const codexPath = join(root, "outside-workspace-codex.mjs");
  const promptPath = join(workspace, "prompt.txt");
  const receipt = join(root, "provider-spawned");
  await mkdir(workspace);
  await mkdir(statePath);
  await writeFile(promptPath, "guard fixture\n");
  await writeFile(codexPath, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(receipt)}, "spawned");\n`);
  await chmod(codexPath, 0o755);
  const details = lstatSync(codexPath);
  const files = [{ path: codexPath, dev: String(details.dev), ino: String(details.ino) }];
  const env = { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" };
  await assert.rejects(execFileAsync(process.execPath, [
    _appServerRunnerPath, "task", "--test-stub",
    "--job-id", "e".repeat(24),
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify(files),
    "--dispatcher-id", "guard-task",
    "--dispatcher-pid", String(process.pid),
    "--state-dir", statePath,
    "--workspace", workspace,
    "--prompt-file", promptPath,
  ], { env }), /EATELIER_REAL_PROVIDER_DISABLED/);

  const directId = "f".repeat(24);
  const directJob = join(statePath, `${directId}.json`);
  await writeFile(directJob, JSON.stringify({
    version: 1,
    jobId: directId,
    status: "queued",
    pid: null,
    pidStartIdentity: null,
    codexPath,
    binaryFiles: files,
    workspace,
    promptPath,
    streamFile: join(statePath, `${directId}.stream.jsonl`),
    testStub: true,
  }));
  await assert.rejects(execFileAsync(process.execPath, [
    _appServerRunnerPath, "run", "--job", directJob,
  ], { env }), /EATELIER_REAL_PROVIDER_DISABLED/);
  assert.equal(existsSync(receipt), false);
});

test("runner refuses every real-provider launch under the golden guard", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [_appServerRunnerPath, "task"], {
      env: { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" },
    }),
    /EATELIER_REAL_PROVIDER_DISABLED/,
  );
});

test("runner publishes finishing until the app-server is gone, then releases its lease", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier codex-finishing-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state");
  const codexPath = join(root, "codex stub.mjs");
  const promptPath = join(root, "prompt.txt");
  await mkdir(statePath);
  await writeFile(promptPath, "finish cleanly\n");
  await writeFile(codexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
// This delay IS the "finishing" window the assertions below sample for, and
// each sample costs a full runner status subprocess. Under the parallel batch
// a single sample can outlast a short window, so the poller steps over
// "finishing" entirely and the test fails while the runner behaved correctly.
// Keep this comfortably longer than a subprocess spawn under load; do not
// shrink it to speed the suite up.
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2000));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {
    userAgent: "stub/1.0", platformFamily: "unix", platformOs: "linux"
  } }));
  if (message.method === "thread/start") console.log(JSON.stringify({
    id: message.id, result: { thread: { id: "finishing-thread" } }
  }));
  if (message.method === "turn/start") {
    console.log(JSON.stringify({ id: message.id, result: { turn: { id: "finishing-turn" } } }));
    console.log(JSON.stringify({ method: "turn/completed", params: {
      threadId: "finishing-thread", turn: { id: "finishing-turn", status: "completed" }
    } }));
  }
});
`);
  await chmod(codexPath, 0o755);
  const details = lstatSync(codexPath);
  const jobId = "9".repeat(24);
  const env = { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" };
  await execFileAsync(process.execPath, [
    _appServerRunnerPath, "task", "--test-stub",
    "--job-id", jobId,
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify([{
      path: codexPath, dev: String(details.dev), ino: String(details.ino),
    }]),
    "--dispatcher-id", "finishing-test",
    "--dispatcher-pid", String(process.pid),
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env });
  const readStatus = async () => JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath, "status", jobId, "--state-dir", statePath,
  ], { env })).stdout);
  // "finishing" is TRANSIENT - it lasts only until the app-server actually exits.
  // Sampling it by spawning a `status` subprocess per attempt costs tens of
  // milliseconds per sample, so under a loaded batch a single sample can outlast
  // the whole window and the poller steps straight over it, failing a runner that
  // behaved correctly (atelier-7nv; widening the window reduced the rate but did
  // not remove the race). Read the job file directly instead: microseconds per
  // sample, so the window cannot be missed. The CLI still serves the terminal
  // assertions below, which are the ones that need the production entrypoint.
  const jobFile = join(statePath, `${jobId}.json`);
  let finishing;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Yield every sample: a synchronous busy-loop starves the event loop, so the
    // runner's own I/O never progresses and the state never advances at all.
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
    try {
      const snapshot = JSON.parse(readFileSync(jobFile, "utf8"));
      if (snapshot.status === "finishing") { finishing = snapshot; break; }
      if (snapshot.status === "completed") break;
    } catch {
      // Mid-write or not yet created; sample again.
    }
  }
  assert.equal(finishing?.status, "finishing", "never observed the transient finishing state");
  assert.ok(Number.isInteger(finishing.pid), "finishing must still expose the live runner");
  // Wait for the runner to be GONE, not merely for the status to flip. printableJob
  // derives pid as `alive ? job.pid : null`, so a completed job still reports its
  // pid for as long as the runner process is genuinely still exiting - that is
  // honest reporting, not a stale field. Asserting on the first completed sample
  // therefore races the runner's own exit: it passed on a fast workstation and
  // failed on CI with `3057 !== null`. The test's name is "then releases its
  // lease", so waiting for that release is what it meant all along.
  let completed;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    completed = await readStatus();
    if (completed.status === "completed" && completed.pid === null) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(completed.status, "completed");
  assert.equal(completed.pid, null, "the runner never released its pid after completing");
  assert.equal(existsSync(join(statePath, `${jobId}.attach.json`)), false);
});

test("launcher timeout leaves a persisted job that boot attach can adopt after the runner announces", {
  skip: process.platform !== "linux",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-codex-late-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, "state");
  const codexPath = join(root, "codex-stub.mjs");
  const promptPath = join(root, "prompt.txt");
  await mkdir(statePath);
  await writeFile(promptPath, "late runner\n");
  await writeFile(codexPath, `#!/usr/bin/env node
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {
    userAgent: "stub/1.0", platformFamily: "unix", platformOs: "linux"
  } }));
  if (message.method === "thread/start") console.log(JSON.stringify({
    id: message.id, result: { thread: { id: "late-thread" } }
  }));
  if (message.method === "turn/start") console.log(JSON.stringify({
    id: message.id, result: { turn: { id: "late-turn" } }
  }));
});
`);
  await chmod(codexPath, 0o755);
  const details = lstatSync(codexPath);
  const departed = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const departedPid = departed.pid;
  await once(departed, "exit");
  const jobId = "8".repeat(24);
  const env = {
    ...process.env,
    ATELIER_TEST_NO_REAL_PROVIDER: "1",
    ATELIER_TEST_CODEX_LAUNCH_TIMEOUT_MS: "25",
    ATELIER_TEST_CODEX_RUNNER_START_DELAY_MS: "100",
  };
  await assert.rejects(execFileAsync(process.execPath, [
    _appServerRunnerPath, "task", "--test-stub",
    "--job-id", jobId,
    "--codex", codexPath,
    "--binary-files-json", JSON.stringify([{
      path: codexPath, dev: String(details.dev), ino: String(details.ino),
    }]),
    "--dispatcher-id", "departed-dispatcher",
    "--dispatcher-pid", String(departedPid),
    "--state-dir", statePath,
    "--workspace", root,
    "--prompt-file", promptPath,
  ], { env }), /did not establish its pid identity/);
  assert.equal(existsSync(join(statePath, `${jobId}.json`)), true);

  let running;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    running = JSON.parse((await execFileAsync(process.execPath, [
      _appServerRunnerPath, "status", jobId, "--state-dir", statePath,
    ], { env })).stdout);
    if (running.status === "running" && Number.isInteger(running.pid)) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  assert.equal(running.status, "running");
  const attached = JSON.parse((await execFileAsync(process.execPath, [
    _appServerRunnerPath, "attach", jobId,
    "--state-dir", statePath,
    "--dispatcher-id", "boot-dispatcher",
    "--dispatcher-pid", String(process.pid),
    "--dispatcher-pid-identity", _runnerTest.processStartIdentity(process.pid),
    "--break-dead",
  ], { env })).stdout);
  assert.equal(attached.attached, true);
  await execFileAsync(process.execPath, [
    _appServerRunnerPath, "cancel", jobId, "--state-dir", statePath,
  ], { env });
});
