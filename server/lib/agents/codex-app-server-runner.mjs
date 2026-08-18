#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { redactValue } from "../stream.mjs";

const CLIENT_INFO = Object.freeze({
  name: "atelier",
  title: "Atelier",
  version: "0.3.0",
});
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function parseArgs(args) {
  const values = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      values._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (["background", "json", "write"].includes(key)) {
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
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
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

function liveWorker(job) {
  if (!Number.isInteger(job.pid) || job.pid <= 0 || !job.pidStartIdentity) return false;
  return processStartIdentity(job.pid) === job.pidStartIdentity;
}

function printableJob(job) {
  const alive = liveWorker(job);
  if (!TERMINAL.has(job.status) && !alive) {
    return {
      ...job,
      status: "failed",
      pid: null,
      errorMessage: "Atelier Codex app-server runner is not alive under its recorded pid identity",
    };
  }
  if (TERMINAL.has(job.status) && alive) {
    return { ...job, status: "running", terminalStatus: job.status, pid: job.pid };
  }
  return { ...job, pid: alive ? job.pid : null };
}

function appendStream(job, message) {
  appendFileSync(job.streamFile, `${JSON.stringify(redactValue(message))}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

class JsonRpcClient {
  constructor(proc, onNotification) {
    this.proc = proc;
    this.pending = new Map();
    this.nextId = 1;
    this.onNotification = onNotification;
    this.stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-8_000);
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.handleLine(line));
    proc.once("error", (error) => this.fail(error));
    proc.once("close", (code, signal) => {
      this.fail(new Error(
        `codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`})` +
        `${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
      ));
    });
  }

  send(message) {
    if (!this.proc.stdin.write(`${JSON.stringify(message)}\n`)) {
      return new Promise((resolvePromise) => this.proc.stdin.once("drain", resolvePromise));
    }
    return undefined;
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { method, resolve: resolvePromise, reject: rejectPromise });
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
      this.fail(new Error(`invalid codex app-server JSONL: ${error.message}`));
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

async function runJob(path) {
  let job = updateJob(path, (current) => ({
    ...current,
    status: "running",
    pid: process.pid,
    pidStartIdentity: processStartIdentity(process.pid),
    startedAt: new Date().toISOString(),
  }));
  let finalMessage = "";
  let terminalResolve;
  const terminal = new Promise((resolvePromise) => { terminalResolve = resolvePromise; });
  const proc = spawn(job.codexPath, ["app-server", "--stdio"], {
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
      job = updateJob(path, (current) => ({
        ...current,
        status: success ? "completed" : "failed",
        rawOutput: finalMessage,
        summary: errorMessage ?? finalMessage,
        errorMessage,
        endedAt: new Date().toISOString(),
      }));
      terminalResolve();
    }
  });

  const stop = async () => {
    try {
      if (job.threadId && job.turnId) {
        await client.request("turn/interrupt", { threadId: job.threadId, turnId: job.turnId });
      }
    } catch {
      // The process-group owner below remains the authoritative cancellation boundary.
    }
    job = updateJob(path, (current) => TERMINAL.has(current.status) ? current : ({
      ...current,
      status: "cancelled",
      summary: "stopped by user",
      endedAt: new Date().toISOString(),
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
    job = updateJob(path, (current) => ({
      ...current,
      status: current.status === "cancelled" ? "cancelled" : "failed",
      errorMessage: error.message,
      summary: current.summary || error.message,
      rawOutput: current.rawOutput ?? finalMessage,
      endedAt: new Date().toISOString(),
    }));
  } finally {
    if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
  }
}

function task(values) {
  if (process.env.ATELIER_TEST_NO_REAL_PROVIDER === "1") {
    throw new Error(
      "EATELIER_REAL_PROVIDER_DISABLED: Codex app-server launch is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1",
    );
  }
  for (const key of ["codex", "state-dir", "workspace", "prompt-file"]) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  const id = randomBytes(12).toString("hex");
  const path = jobPath(values["state-dir"], id);
  const streamFile = join(resolve(values["state-dir"]), `${id}.stream.jsonl`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(streamFile, "", { mode: 0o600 });
  const job = {
    version: 1,
    jobId: id,
    status: "queued",
    pid: null,
    pidStartIdentity: null,
    codexPath: resolve(values.codex),
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
  };
  writeJob(path, job);
  const child = spawn(process.execPath, [resolve(process.argv[1]), "run", "--job", path], {
    cwd: job.workspace,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  updateJob(path, (current) => ({
    ...current,
    pid: child.pid,
    pidStartIdentity: processStartIdentity(child.pid),
  }));
  return {
    jobId: id,
    logFile: streamFile,
    pid: child.pid,
    pidStartIdentity: processStartIdentity(child.pid),
  };
}

async function cancel(path) {
  let job = readJob(path);
  if (TERMINAL.has(job.status) && !liveWorker(job)) {
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
    console.log(JSON.stringify(task(values)));
    return;
  }
  if (!["status", "result", "cancel"].includes(command)) {
    throw new Error(`usage: ${basename(process.argv[1])} task|status|result|cancel|run`);
  }
  const id = values._[0];
  if (!values["state-dir"] || !id) throw new Error(`${command} requires JOB_ID and --state-dir`);
  const path = jobPath(values["state-dir"], id);
  if (command === "cancel") {
    console.log(JSON.stringify(await cancel(path)));
    return;
  }
  const job = printableJob(readJob(path));
  console.log(JSON.stringify(command === "result" ? { ...job, result: job } : job));
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export const _runnerTest = Object.freeze({
  CLIENT_INFO,
  processStartIdentity,
  printableJob,
});
