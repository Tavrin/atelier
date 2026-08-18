#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  appendDurable,
  readFileNoFollowSync,
  writeFileAtomic,
  writeFileExclusiveDurable,
} from "../fs-integrity.mjs";
import { redactText, redactValue } from "../stream.mjs";
import {
  createSandboxBackends,
  sandboxBackend,
  wrapSandboxSpawn,
} from "../execution/sandbox.mjs";

const CLIENT_INFO = Object.freeze({
  name: "atelier",
  title: "Atelier",
  version: "0.3.0",
});
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const REQUEST_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 2_000;
const STREAM_BYTE_LIMIT = 1024 * 1024;
const STREAM_TRUNCATION = `${JSON.stringify({
  method: "atelier/streamTruncated",
  params: { reason: `protocol stream exceeded ${STREAM_BYTE_LIMIT} bytes` },
})}\n`;
const truncatedStreams = new Set();
const sandboxBackends = createSandboxBackends();

function spawnWithSandbox(
  config,
  file,
  args,
  options,
  { backends = sandboxBackends, spawn: spawnProcess = spawn } = {},
) {
  if (!config) return spawnProcess(file, args, options);
  const wrapped = wrapSandboxSpawn({
    trustProfile: config.trustProfile,
    backend: sandboxBackend(backends, config.backendId),
    file,
    args,
    options,
  });
  return spawnProcess(wrapped.file, wrapped.args, wrapped.options);
}

function testTunable(name, fallback) {
  if (process.env.ATELIER_TEST_NO_REAL_PROVIDER !== "1") return fallback;
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function parseArgs(args) {
  const values = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      values._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["background", "json", "write", "test-stub", "break-dead"].includes(key)) {
      values[key] = true;
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${value} requires a value`);
    values[key] = next;
    index += 1;
  }
  return values;
}

function processStartIdentity(pid) {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return startTime && bootId ? `linux-proc-start:${bootId}:${startTime}` : null;
  } catch {
    return null;
  }
}

function readJob(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJob(path, job) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
}

function updateJob(path, update) {
  const current = readJob(path);
  const next = typeof update === "function" ? update(current) : { ...current, ...update };
  writeJob(path, next);
  return next;
}

function jobPath(root, id) {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("invalid Codex app-server job id");
  return join(resolve(root), `${id}.json`);
}

function leasePath(root, id) {
  jobPath(root, id);
  return join(resolve(root), `${id}.attach.json`);
}

function readLease(path) {
  return JSON.parse(readFileNoFollowSync(path, "utf8"));
}

function releaseLease(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function leaseValue(values) {
  const dispatcherPid = Number(values["dispatcher-pid"]);
  if (!values["dispatcher-id"] || !Number.isInteger(dispatcherPid) || dispatcherPid <= 0) {
    throw new Error("dispatcher attachment identity is required");
  }
  return {
    dispatcherInstanceId: values["dispatcher-id"],
    attachedAt: new Date().toISOString(),
    dispatcherPid,
    dispatcherPidIdentity: values["dispatcher-pid-identity"] ?? null,
  };
}

function takeLease(path, values, { breakDead = false } = {}) {
  const next = leaseValue(values);
  try {
    writeFileExclusiveDurable(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const current = readLease(path);
    const liveness = processLiveness(current.dispatcherPid, current.dispatcherPidIdentity);
    if (!breakDead || liveness.alive) {
      const detail = liveness.warning ? `; ${liveness.warning}` : "";
      throw new Error(
        `Codex job attachment refused: lease held by dispatcher ${current.dispatcherInstanceId}${detail}`,
      );
    }
    unlinkSync(path);
    writeFileExclusiveDurable(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  const liveness = processLiveness(next.dispatcherPid, next.dispatcherPidIdentity);
  return {
    attached: true,
    attachLease: next,
    ...(liveness.warning ? { warning: liveness.warning } : {}),
  };
}

function signalZeroAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processLiveness(pid, identity) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, corroboration: "absent" };
  if (!signalZeroAlive(pid)) return { alive: false, corroboration: "absent" };
  if (process.platform !== "linux") {
    return {
      alive: true,
      corroboration: "signal-0",
      warning: "Codex runner liveness uses weaker signal-0 corroboration on this platform",
    };
  }
  const current = processStartIdentity(pid);
  if (identity && current === identity) return { alive: true, corroboration: "pid-start-identity" };
  if (identity && current && current !== identity) return { alive: false, corroboration: "recycled" };
  return { alive: true, corroboration: "unresolved" };
}

function liveWorker(job) {
  const liveness = processLiveness(job.pid, job.pidStartIdentity);
  return liveness.alive && liveness.corroboration !== "unresolved";
}

function printableJob(job) {
  const liveness = processLiveness(job.pid, job.pidStartIdentity);
  const alive = liveness.alive && liveness.corroboration !== "unresolved";
  if (!TERMINAL.has(job.status) && !alive) {
    return {
      ...job,
      status: "failed",
      pid: null,
      errorMessage: "Atelier Codex app-server runner is not alive under its recorded pid identity",
    };
  }
  return {
    ...job,
    pid: alive ? job.pid : null,
    ...(liveness.warning ? { warning: liveness.warning } : {}),
  };
}

function pathInside(root, candidate) {
  let rootPath;
  let candidatePath;
  try {
    rootPath = realpathSync(root);
    candidatePath = realpathSync(candidate);
  } catch {
    return false;
  }
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${process.platform === "win32" ? "\\" : "/"}`);
}

function guardedStubAllowed(job) {
  if (process.env.ATELIER_TEST_NO_REAL_PROVIDER !== "1") return true;
  return job.testStub === true &&
    pathInside(tmpdir(), job.workspace) &&
    pathInside(job.workspace, job.codexPath);
}

function assertRealProviderGuard(job) {
  if (guardedStubAllowed(job)) return;
  throw new Error(
    "EATELIER_REAL_PROVIDER_DISABLED: Codex app-server launch is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1",
  );
}

function appendStream(job, message) {
  if (truncatedStreams.has(job.streamFile)) return;
  const line = `${JSON.stringify(redactValue(message))}\n`;
  let size = 0;
  try { size = statSync(job.streamFile).size; } catch { /* append creates it */ }
  if (size + Buffer.byteLength(line) > STREAM_BYTE_LIMIT - Buffer.byteLength(STREAM_TRUNCATION)) {
    appendDurable(job.streamFile, STREAM_TRUNCATION);
    truncatedStreams.add(job.streamFile);
    return;
  }
  appendDurable(job.streamFile, line);
}

class JsonRpcClient {
  constructor(proc, onNotification, onProtocolFailure = () => {}) {
    this.proc = proc;
    this.pending = new Map();
    this.nextId = 1;
    this.onNotification = onNotification;
    this.onProtocolFailure = onProtocolFailure;
    this.stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.handleLine(line));
    proc.once("error", (error) => {
      this.fail(error);
      this.onProtocolFailure(error);
    });
    proc.once("close", (code, signal) => {
      const error = new Error(
        `codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})` +
        `${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
      );
      this.fail(error);
      this.onProtocolFailure(error);
    });
  }

  send(message) {
    if (!this.proc.stdin.write(`${JSON.stringify(message)}\n`)) {
      return new Promise((resolvePromise) => this.proc.stdin.once("drain", resolvePromise));
    }
    return undefined;
  }

  request(method, params = {}, {
    timeoutMs = testTunable("ATELIER_TEST_CODEX_REQUEST_TIMEOUT_MS", REQUEST_TIMEOUT_MS),
  } = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        const error = new Error(`codex app-server ${method} request timed out`);
        pending.reject(error);
        this.onProtocolFailure(error);
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const protocolError = new Error(`invalid codex app-server JSONL: ${error.message}`);
      this.fail(protocolError);
      this.onProtocolFailure(protocolError);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: { code: -32601, message: `Atelier does not support server request ${message.method}` },
      });
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(
          `codex app-server ${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`,
        ));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.onNotification(message);
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function waitForClose(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("close", onClose);
      resolvePromise(closed);
    };
    const onClose = () => finish(true);
    proc.once("close", onClose);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function terminateAppServer(
  proc,
  graceMs = testTunable("ATELIER_TEST_CODEX_TERMINATION_GRACE_MS", TERMINATION_GRACE_MS),
) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  if (await waitForClose(proc, graceMs)) return;
  proc.kill("SIGKILL");
  await waitForClose(proc, graceMs);
}

function assertBinaryFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Codex binary identity capture is missing");
  }
  for (const pin of files) {
    const details = lstatSync(pin.path);
    if (!details.isFile() || details.isSymbolicLink() ||
        String(details.dev) !== String(pin.dev) || String(details.ino) !== String(pin.ino)) {
      throw new Error(`Codex binary identity diverged before spawn: ${pin.path}`);
    }
  }
}

async function runJob(path) {
  // The detached child, not the launcher, establishes its own fence as its
  // first state mutation. The launcher performs no post-spawn job writes.
  const initial = readJob(path);
  const startDelayMs = initial.testStub
    ? testTunable("ATELIER_TEST_CODEX_RUNNER_START_DELAY_MS", 0)
    : 0;
  if (startDelayMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, startDelayMs));
  }
  let job = updateJob(path, (current) => ({
    ...current,
    status: "running",
    pid: process.pid,
    pidStartIdentity: processStartIdentity(process.pid),
    startedAt: new Date().toISOString(),
  }));
  try {
    assertBinaryFiles(job.binaryFiles);
  } catch (error) {
    const safeError = redactText(error.message);
    updateJob(path, (current) => ({
      ...current,
      status: "failed",
      errorMessage: safeError,
      summary: safeError,
      endedAt: new Date().toISOString(),
    }));
    releaseLease(leasePath(dirname(path), initial.jobId));
    return;
  }
  try {
    assertRealProviderGuard(job);
  } catch (error) {
    const safeError = redactText(error.message);
    updateJob(path, (current) => ({
      ...current,
      status: "failed",
      errorMessage: safeError,
      summary: safeError,
      endedAt: new Date().toISOString(),
    }));
    releaseLease(leasePath(dirname(path), initial.jobId));
    throw error;
  }
  let finalMessage = "";
  let terminalResolve;
  let terminalReject;
  let turnStarted = false;
  let terminalSettled = false;
  const terminal = new Promise((resolvePromise, rejectPromise) => {
    terminalResolve = () => {
      if (terminalSettled) return;
      terminalSettled = true;
      resolvePromise();
    };
    terminalReject = (error) => {
      if (terminalSettled) return;
      terminalSettled = true;
      rejectPromise(error);
    };
  });
  let terminalOutcome;
  const proc = spawnWithSandbox(job.sandbox, job.codexPath, ["app-server", "--stdio"], {
    cwd: job.workspace,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new JsonRpcClient(proc, (message) => {
    appendStream(job, message);
    const params = message.params ?? {};
    const threadId = params.threadId ?? params.thread?.id;
    if (typeof threadId === "string" && threadId) {
      job = updateJob(path, (current) => ({ ...current, threadId }));
    }
    if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
      finalMessage += params.delta;
    }
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      finalMessage = String(params.item.text ?? finalMessage);
    }
    if (message.method === "thread/tokenUsage/updated") {
      job = updateJob(path, (current) => ({ ...current, usage: params.tokenUsage }));
    }
    if (message.method === "turn/completed") {
      const success = params.turn?.status === "completed";
      const errorMessage = params.turn?.error?.message ??
        (success ? null : `Codex turn ended with status ${params.turn?.status ?? "unknown"}`);
      terminalOutcome = {
        status: success ? "completed" : "failed",
        rawOutput: redactText(finalMessage),
        summary: redactText(errorMessage ?? finalMessage),
        errorMessage: errorMessage ? redactText(errorMessage) : null,
      };
      job = updateJob(path, (current) => ({
        ...current,
        ...terminalOutcome,
        status: "finishing",
      }));
      terminalResolve();
    }
  }, (error) => {
    if (turnStarted) terminalReject(error);
  });

  const stop = async () => {
    try {
      if (job.threadId && job.turnId) {
        await client.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
      }
    } catch {
      // The process-group owner below remains the authoritative cancellation boundary.
    }
    terminalOutcome = {
      status: "cancelled",
      summary: "stopped by user",
      errorMessage: null,
    };
    job = updateJob(path, (current) => TERMINAL.has(current.status) ? current : ({
      ...current,
      ...terminalOutcome,
      status: "finishing",
    }));
    proc.kill("SIGTERM");
    terminalResolve();
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  try {
    const initialized = await client.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    if (typeof initialized.userAgent !== "string" || !initialized.userAgent.trim() ||
        typeof initialized.platformFamily !== "string" || !initialized.platformFamily.trim() ||
        typeof initialized.platformOs !== "string" || !initialized.platformOs.trim()) {
      throw new Error("codex app-server initialize omitted required identity/capability fields");
    }
    appendStream(job, { id: 1, result: initialized });
    client.notify("initialized", {});
    let threadId = job.resumeThreadId;
    if (threadId) {
      const resumed = await client.request("thread/resume", { threadId, cwd: job.workspace });
      threadId = resumed.thread?.id ?? threadId;
    } else {
      const started = await client.request("thread/start", {
        cwd: job.workspace,
        approvalPolicy: "never",
        sandbox: job.write ? "workspace-write" : "read-only",
      });
      threadId = started.thread?.id;
    }
    if (typeof threadId !== "string" || !threadId) throw new Error("thread lifecycle returned no id");
    job = updateJob(path, (current) => ({ ...current, threadId }));
    turnStarted = true;
    const turn = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: readFileSync(job.promptPath, "utf8") }],
      cwd: job.workspace,
      approvalPolicy: "never",
      sandboxPolicy: job.write
        ? { type: "workspaceWrite", writableRoots: [job.workspace], networkAccess: true }
        : { type: "readOnly", networkAccess: false },
    });
    job = updateJob(path, (current) => ({
      ...current,
      turnId: turn.turn?.id ?? current.turnId ?? null,
    }));
    await terminal;
  } catch (error) {
    const safeError = redactText(error.message);
    terminalOutcome = {
      status: terminalOutcome?.status === "cancelled" ? "cancelled" : "failed",
      errorMessage: safeError,
      summary: redactText(job.summary || safeError),
      rawOutput: redactText(job.rawOutput ?? finalMessage),
    };
    job = updateJob(path, (current) => ({
      ...current,
      ...terminalOutcome,
      status: "finishing",
    }));
  } finally {
    await terminateAppServer(proc);
    const outcome = terminalOutcome ?? {
      status: "failed",
      errorMessage: "Codex app-server runner ended without a terminal outcome",
      summary: "Codex app-server runner ended without a terminal outcome",
    };
    job = updateJob(path, (current) => ({
      ...current,
      ...outcome,
      endedAt: new Date().toISOString(),
    }));
    releaseLease(leasePath(dirname(path), job.jobId));
  }
}

async function task(values) {
  if (process.env.ATELIER_TEST_NO_REAL_PROVIDER === "1" && values["test-stub"] !== true) {
    throw new Error(
      "EATELIER_REAL_PROVIDER_DISABLED: Codex app-server launch is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1",
    );
  }
  for (const key of [
    "job-id",
    "codex",
    "binary-files-json",
    "dispatcher-id",
    "dispatcher-pid",
    "state-dir",
    "workspace",
    "prompt-file",
  ]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const id = values["job-id"];
  const path = jobPath(values["state-dir"], id);
  const streamFile = join(resolve(values["state-dir"]), `${id}.stream.jsonl`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(streamFile, "", { mode: 0o600 });
  const binaryFiles = JSON.parse(values["binary-files-json"]);
  if (!Array.isArray(binaryFiles) || binaryFiles.length === 0) {
    throw new Error("--binary-files-json must carry at least one pinned file");
  }
  const job = {
    version: 1,
    jobId: id,
    status: "queued",
    pid: null,
    pidStartIdentity: null,
    codexPath: resolve(values.codex),
    binaryFiles,
    workspace: resolve(values.workspace),
    promptPath: resolve(values["prompt-file"]),
    streamFile,
    resumeThreadId: values.resume ?? null,
    threadId: values.resume ?? null,
    write: values.write === true,
    createdAt: new Date().toISOString(),
    summary: "",
    rawOutput: "",
    errorMessage: null,
    testStub: values["test-stub"] === true,
    sandbox: values["sandbox-json"] ? JSON.parse(values["sandbox-json"]) : null,
  };
  let binaryPinsMatch = true;
  try {
    assertBinaryFiles(binaryFiles);
  } catch {
    binaryPinsMatch = false;
  }
  if (process.env.ATELIER_TEST_NO_REAL_PROVIDER === "1" && binaryPinsMatch) {
    assertRealProviderGuard(job);
  }
  writeJob(path, job);
  const attachment = takeLease(leasePath(values["state-dir"], id), values);
  const child = spawn(process.execPath, [resolve(process.argv[1]), "run", "--job", path], {
    cwd: job.workspace,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  let owned = readJob(path);
  const deadline = Date.now() + testTunable("ATELIER_TEST_CODEX_LAUNCH_TIMEOUT_MS", 2_000);
  while (owned.pid !== child.pid && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    owned = readJob(path);
  }
  if (owned.pid !== child.pid) throw new Error("detached Codex runner did not establish its pid identity");
  return {
    jobId: id,
    logFile: streamFile,
    pid: owned.pid,
    pidStartIdentity: owned.pidStartIdentity,
    ...(attachment.warning ? { warning: attachment.warning } : {}),
  };
}

async function cancel(path) {
  let job = readJob(path);
  if (TERMINAL.has(job.status) && !liveWorker(job)) {
    releaseLease(leasePath(dirname(path), job.jobId));
    return { finish: true, status: job.status };
  }
  if (!liveWorker(job)) {
    return { finish: false, warning: "Codex runner cancellation could not prove worker identity" };
  }
  if (!TERMINAL.has(job.status)) {
    try {
      if (process.platform === "win32") process.kill(job.pid, "SIGTERM");
      else process.kill(-job.pid, "SIGTERM");
    } catch (error) {
      return { finish: false, warning: `Codex runner cancellation was unproven: ${error.message}` };
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    job = readJob(path);
    if (!liveWorker(job)) {
      const terminalStatus = TERMINAL.has(job.status) ? job.status : "cancelled";
      if (terminalStatus !== job.status) {
        job = updateJob(path, (current) => ({
          ...current,
          status: terminalStatus,
          summary: "stopped by user",
          endedAt: new Date().toISOString(),
        }));
      }
      return { finish: true, status: job.status };
    }
  }
  return {
    finish: false,
    warning: "Codex runner cancellation signal was delivered but worker exit is unproven",
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const values = parseArgs(rest);
  if (command === "run") return runJob(resolve(values.job));
  if (command === "task") {
    console.log(JSON.stringify(await task(values)));
    return;
  }
  if (!["status", "result", "cancel", "attach"].includes(command)) {
    throw new Error(`usage: ${basename(process.argv[1])} task|status|result|cancel|attach|run`);
  }
  const id = values._[0];
  if (!values["state-dir"] || !id) throw new Error(`${command} requires JOB_ID and --state-dir`);
  const path = jobPath(values["state-dir"], id);
  if (command === "attach") {
    readJob(path);
    console.log(JSON.stringify(takeLease(
      leasePath(values["state-dir"], id),
      values,
      { breakDead: values["break-dead"] === true },
    )));
    return;
  }
  if (command === "cancel") {
    console.log(JSON.stringify(await cancel(path)));
    return;
  }
  const job = printableJob(readJob(path));
  try {
    job.attachLease = readLease(leasePath(values["state-dir"], id));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!TERMINAL.has(job.status)) {
      job.warning = [job.warning, "Codex job attachment lease is missing; a dispatcher may adopt it with attach"]
        .filter(Boolean)
        .join("; ");
      job.adoptableViaAttach = true;
    }
  }
  console.log(JSON.stringify(command === "result" ? { ...job, result: job } : job));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const _runnerTest = Object.freeze({
  CLIENT_INFO,
  STREAM_BYTE_LIMIT,
  appendStream,
  processStartIdentity,
  printableJob,
  spawnWithSandbox,
});
