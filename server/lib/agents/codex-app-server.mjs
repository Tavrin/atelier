import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { killTracked } from "../exec.mjs";
import { sanitizeChildEnv } from "../execution/environment-policy.mjs";
import {
  EXECUTION_PROFILE_MISMATCH,
  createExecutionProfile,
  pinnedExecutable,
  resolveExecutable,
} from "../execution/execution-profile.mjs";
import { stateDir } from "../paths.mjs";
import { retrievedFinalOutput } from "../stream.mjs";

const RUNNER_PATH = fileURLToPath(new URL("./codex-app-server-runner.mjs", import.meta.url));
const POLL_INTERVAL_MS = 2_000;
const STATUS_FAILURE_RETRY_LIMIT = 3;
const STREAM_READ_CHUNK_BYTES = 64 * 1024;
const KNOWN_STATUSES = new Set([
  "queued",
  "running",
  "finishing",
  "completed",
  "failed",
  "cancelled",
]);
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_GIT_WARNING =
  "Atelier cannot write the worktree gitdir - automatic Codex commit may fail";
const PROMPT_FILE_INSTRUCTION =
  "Before doing anything else, read and follow the complete task prompt in this UTF-8 file:";
let pollIntervalMs = POLL_INTERVAL_MS;
let modelFileOps = { readFileSync };
let appServerProber = probeCodexAppServer;

const PLATFORM_TARGET = Object.freeze({
  "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
});

function versionToken(stdout) {
  const match = /(?:^|\s)codex-cli\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/m.exec(
    String(stdout ?? ""),
  );
  return match ? `codex-cli ${match[1]}` : null;
}

function launcherScript(path) {
  if (basename(path) === "codex.js") return path;
  try {
    const source = readFileSync(path, "utf8");
    if (source.includes("PLATFORM_PACKAGE_BY_TARGET") && source.includes("@openai/codex-")) {
      return path;
    }
  } catch {
    // Native and test executables are valid single-file Codex launchers.
  }
  if (process.platform !== "win32") return null;
  const candidate = join(dirname(path), "node_modules", "@openai", "codex", "bin", "codex.js");
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function nativePayload(launcherPath) {
  const script = launcherScript(launcherPath);
  if (!script) return null;
  const target = PLATFORM_TARGET[`${process.platform}:${process.arch}`];
  if (!target) return null;
  const [platformPackage, targetTriple] = target;
  let vendorRoot;
  try {
    const require = createRequire(script);
    vendorRoot = join(dirname(require.resolve(`${platformPackage}/package.json`)), "vendor");
  } catch {
    vendorRoot = join(dirname(script), "..", "vendor");
  }
  const candidate = join(
    vendorRoot,
    targetTriple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function digestFiles(paths) {
  try {
    const hash = createHash("sha256");
    for (const path of paths) {
      const contentDigest = createHash("sha256").update(readFileSync(path)).digest("hex");
      hash.update(`${path}\0${contentDigest}\n`);
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function filePins(paths) {
  try {
    return paths.map((path) => {
      const details = lstatSync(path);
      if (!details.isFile() || details.isSymbolicLink()) throw new Error("not a regular file");
      return { path, dev: String(details.dev), ino: String(details.ino) };
    });
  } catch {
    return null;
  }
}

function probeCodex(path, env) {
  if (!path) return { version: null };
  let version = null;
  try {
    version = versionToken(execFileSync(path, ["--version"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }));
  } catch {
    // The profile records the failed probe as null; admission requirements reject it.
  }
  return { version };
}

export function inspectCodexBinary(env = process.env) {
  const searchedPath = resolveExecutable("codex", env);
  if (!searchedPath) {
    return { resolvedPath: null, version: null, digest: null, digestPaths: [], files: [] };
  }
  let resolvedPath;
  try {
    resolvedPath = realpathSync(searchedPath);
  } catch {
    return { resolvedPath: null, version: null, digest: null, digestPaths: [], files: [] };
  }
  const payload = nativePayload(resolvedPath);
  const digestPaths = payload ? [resolvedPath, payload] : [resolvedPath];
  return {
    resolvedPath,
    ...probeCodex(resolvedPath, env),
    digest: digestFiles(digestPaths),
    digestPaths,
    files: filePins(digestPaths),
  };
}

function validateInitializeResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("initialize returned no server identity");
  }
  if (typeof result.userAgent !== "string" || !result.userAgent.trim()) {
    throw new Error("initialize omitted userAgent server identity");
  }
  if (typeof result.platformFamily !== "string" || !result.platformFamily.trim() ||
      typeof result.platformOs !== "string" || !result.platformOs.trim()) {
    throw new Error("initialize omitted platform capability fields");
  }
  return result;
}

export async function probeCodexAppServer(path, env = process.env, { timeoutMs = 10_000 } = {}) {
  if (env?.ATELIER_TEST_NO_REAL_PROVIDER === "1") {
    throw new Error(
      "EATELIER_REAL_PROVIDER_DISABLED: Codex app-server probe is disabled by ATELIER_TEST_NO_REAL_PROVIDER=1",
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(path, ["app-server", "--stdio"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    let initializeResult;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      if (proc.exitCode === null && !proc.killed) proc.kill("SIGTERM");
      if (error) rejectPromise(error);
      else resolvePromise(result);
    };
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) {
        finish(new Error(message.error.message ?? JSON.stringify(message.error)));
        return;
      }
      proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      proc.stdin.end();
      try {
        initializeResult = validateInitializeResult(message.result);
      } catch (error) {
        finish(error);
      }
    });
    proc.once("error", (error) => finish(error));
    proc.once("close", (code) => {
      if (settled) return;
      if (code === 0 && initializeResult) finish(null, initializeResult);
      else finish(new Error(`codex app-server exited ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
    const timer = setTimeout(() => finish(new Error("codex app-server initialize handshake timed out")), timeoutMs);
    timer.unref?.();
    proc.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "atelier-doctor", title: "Atelier Doctor", version: "0.3.0" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    })}\n`);
  });
}

function executionEnv(env) {
  return sanitizeChildEnv(env, { class: "provider" });
}

function executionProfile({ entry, env, controlledKeys, hooksSupported }) {
  const binary = entry.codexBinaryFromPreLaunch === true
    ? entry.codexBinary
    : inspectCodexBinary(env);
  entry.codexBinaryFromPreLaunch = false;
  entry.codexBinary = binary;
  const profile = createExecutionProfile({
    agentLane: entry.record.lane,
    command: "codex",
    executableResolvedPath: binary.resolvedPath,
    executableVersion: binary.version,
    executableContentDigest: binary.digest,
    executableDigestPaths: binary.digestPaths,
    binaryPinned: true,
    env,
    controlledKeys,
    hooksSupported,
  });
  return profile;
}

function options() {
  return { models: [], efforts: [], resolvedModel: resolveModel() };
}

function resolveModel() {
  try {
    const config = modelFileOps.readFileSync(
      join(process.env.CODEX_HOME || join(process.env.HOME || "", ".codex"), "config.toml"),
      "utf8",
    );
    const match = /^\s*model\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/m.exec(config);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    // The protocol permits model omission, which means the Codex config default.
  }
  return "codex-default";
}

function validate({ effort }) {
  if (effort !== undefined && !EFFORT_VALUES.has(effort)) {
    throw new Error(`effort must be one of: ${[...EFFORT_VALUES].join(", ")}`);
  }
}

function addWarningOnce(entry, warning) {
  if (!entry.record.warnings.includes(warning)) entry.record.warnings.push(warning);
}

async function preLaunchChecks({ entry, worktreePath, env, commandRunner }) {
  const binary = inspectCodexBinary(env);
  entry.codexBinary = binary;
  entry.codexBinaryFromPreLaunch = true;
  if (!binary.resolvedPath) {
    throw new Error("Codex lane unavailable: codex could not be resolved on PATH");
  }
  if (!binary.version) throw new Error(`Codex lane unavailable: ${binary.resolvedPath} --version failed`);
  if (!binary.digest || !binary.files) {
    throw new Error(`Codex lane unavailable: ${binary.resolvedPath} could not be digested`);
  }
  try {
    await appServerProber(binary.resolvedPath, env);
  } catch (error) {
    throw new Error(`Codex lane unavailable: app-server initialize handshake failed: ${error.message}`);
  }
  if (entry.record.effort) {
    addWarningOnce(entry, "effort is ignored on the codex lane (reasoning effort is set in Codex configuration)");
  }
  let probePath;
  try {
    const rawGitDir = await commandRunner("git", ["-C", worktreePath, "rev-parse", "--git-dir"]);
    const gitDir = String(rawGitDir).trim();
    if (!gitDir) throw new Error("git rev-parse returned an empty git dir");
    probePath = join(resolve(worktreePath, gitDir), `.atelier-write-probe-${process.pid}-${randomBytes(6).toString("hex")}`);
    writeFileSync(probePath, "", { flag: "wx" });
    unlinkSync(probePath);
    probePath = undefined;
  } catch {
    if (probePath) {
      try { unlinkSync(probePath); } catch { /* best effort */ }
    }
    addWarningOnce(entry, CODEX_GIT_WARNING);
  }
}

function runnerStateDir() {
  return join(stateDir(), "codex-app-server", "jobs");
}

function profilePathWarning(error, operation) {
  if (error?.code !== "ENOENT") return null;
  return `${EXECUTION_PROFILE_MISMATCH}executable.resolvedPath could not spawn during Codex ${operation}: ${error.message}`;
}

function captureThread(entry, payload, callbacks) {
  const threadId = payload?.threadId ?? payload?.thread?.id ?? payload?.result?.threadId;
  if (typeof threadId !== "string" || !threadId || threadId === entry.record.sessionId) return;
  callbacks.captureSession(entry, threadId);
}

function usageEvent(entry, tokenUsage) {
  const total = tokenUsage?.total;
  if (!total || typeof total !== "object") return null;
  return {
    type: "usage",
    turns: (Number(entry.record.turns) || 0) + (entry.codexTurnCounted ? 0 : 1),
    costUSD: entry.record.costUSD,
    inputTokens: Number(total.inputTokens ?? 0),
    outputTokens: Number(total.outputTokens ?? 0),
    totalTokens: Number(total.totalTokens ?? 0),
  };
}

function eventPreview(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return String(text ?? "").slice(0, 400);
}

function itemEvent(method, item) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "commandExecution") {
    if (method === "item/started") {
      return {
        type: "message",
        kind: "tool_use",
        name: "Bash",
        inputPreview: eventPreview({ command: String(item.command ?? "") }),
      };
    }
    return {
      type: "message",
      kind: "tool_result",
      preview: eventPreview(item.aggregatedOutput ?? `Exit ${item.exitCode ?? "unknown"}`),
      exitCode: item.exitCode ?? null,
    };
  }
  if (item.type === "fileChange") {
    return {
      type: "message",
      kind: "files",
      phase: method === "item/started" ? "applying" : "completed",
      count: Array.isArray(item.changes) ? item.changes.length : 0,
      text: method === "item/started" ? "Applying file changes" : "File changes completed",
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    return method === "item/started"
      ? {
          type: "message",
          kind: "tool_use",
          name: String(item.tool ?? item.type),
          inputPreview: eventPreview(item.arguments ?? {}),
        }
      : {
          type: "message",
          kind: "tool_result",
          preview: eventPreview(item.result ?? item.status ?? "completed"),
        };
  }
  return null;
}

export function normalizeAppServerMessage(message, entry = { record: { turns: 0, costUSD: 0 } }) {
  const params = message?.params ?? {};
  if (message?.method === "item/agentMessage/delta") {
    return [{ type: "message", kind: "text", text: eventPreview(params.delta ?? "") }];
  }
  if (["item/started", "item/completed"].includes(message?.method)) {
    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      return [{ type: "message", kind: "text", text: eventPreview(params.item.text ?? "") }];
    }
    const event = itemEvent(message.method, params.item);
    return event ? [event] : [];
  }
  if (message?.method === "thread/tokenUsage/updated") {
    const event = usageEvent(entry, params.tokenUsage);
    return event ? [event] : [];
  }
  return [];
}

function tailStream(entry, callbacks) {
  if (!entry.codexLogPath) return;
  let fd;
  try {
    const size = statSync(entry.codexLogPath).size;
    let offset = entry.codexLogOffset ?? 0;
    if (size < offset) offset = 0;
    if (size === offset) return;
    fd = openSync(entry.codexLogPath, "r");
    while (offset < size) {
      const buffer = Buffer.alloc(Math.min(STREAM_READ_CHUNK_BYTES, size - offset));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      entry.codexLogOffset = offset;
      const text = `${entry.codexLogBuffer ?? ""}${buffer.subarray(0, bytesRead).toString("utf8")}`;
      const lines = text.split("\n");
      entry.codexLogBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        captureThread(entry, message.params ?? message.result ?? {}, callbacks);
        for (const event of normalizeAppServerMessage(message, entry)) callbacks.emit(entry, event);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") entry.stderrLines.push(`codex stream tail failed: ${error.message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function setLogPath(entry, path) {
  if (typeof path !== "string" || !path) return;
  if (entry.codexLogPath !== path) {
    entry.codexLogPath = path;
    entry.codexLogOffset = 0;
    entry.codexLogBuffer = "";
  }
}

async function failTurn(entry, project, callbacks, summary) {
  tailStream(entry, callbacks);
  entry.result = { success: false, summary };
  const stored = callbacks.emit(entry, { type: "exit", success: false, summary });
  entry.result.summary = stored.summary;
  await callbacks.finish(entry, project, null, null);
}

async function poll(entry, project, commandRunner, callbacks, { failOnFirstError = false } = {}) {
  if (entry.record.state !== "running") return;
  try {
    const raw = await commandRunner(process.execPath, [
      RUNNER_PATH,
      "status",
      entry.codexJobId,
      "--state-dir",
      runnerStateDir(),
    ], { cwd: entry.record.codexWorkspace, env: entry.env });
    const snapshot = JSON.parse(raw);
    captureThread(entry, snapshot, callbacks);
    setLogPath(entry, snapshot.streamFile);
    tailStream(entry, callbacks);
    const status = snapshot.status;
    const workerPid = snapshot.pid;
    if (!KNOWN_STATUSES.has(status)) {
      entry.codexStatusFailures = (entry.codexStatusFailures || 0) + 1;
      if (!failOnFirstError && entry.codexStatusFailures < STATUS_FAILURE_RETRY_LIMIT) {
        entry.stderrLines.push(`codex status unrecognized: ${JSON.stringify(status)}`);
        entry.pollTimer = setTimeout(
          () => void poll(entry, project, commandRunner, callbacks),
          pollIntervalMs,
        );
        entry.pollTimer.unref?.();
        return;
      }
      const gone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
      await failTurn(entry, project, callbacks, gone
        ? `worker reported an unrecognized status${failOnFirstError ? " after restart" : ""}: ${JSON.stringify(status)}`
        : `worker reported an unrecognized status${failOnFirstError ? " after restart" : ""} and could not be confirmed dead (pid ${workerPid})`);
      return;
    }
    entry.codexStatusFailures = 0;
    if (["queued", "running", "finishing"].includes(status)) {
      if (failOnFirstError) {
        const verdict = callbacks.classifyReportedWorker?.(
          entry,
          workerPid,
          snapshot.pidStartIdentity,
          { runnerSnapshot: true },
        ) ?? "alive";
        if (verdict !== "alive") {
          const gone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
          await failTurn(entry, project, callbacks, gone
            ? "worker lost during downtime"
            : `worker could not be confirmed alive or dead after restart (pid ${workerPid})`);
          return;
        }
        callbacks.confirmCodexReattach?.(entry);
      }
      const owned = callbacks.captureWorkerPid?.(entry, workerPid) ?? false;
      if (owned) callbacks.captureCodexProcessTree?.(entry, workerPid);
    }
    if (["completed", "failed", "cancelled"].includes(status)) {
      const result = JSON.parse(await commandRunner(process.execPath, [
        RUNNER_PATH,
        "result",
        entry.codexJobId,
        "--state-dir",
        runnerStateDir(),
      ], { cwd: entry.record.codexWorkspace, env: entry.env }));
      captureThread(entry, result, callbacks);
      tailStream(entry, callbacks);
      const workerGone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
      if (!workerGone) {
        await failTurn(entry, project, callbacks, `job reported ${status} but its worker could not be confirmed dead (pid ${workerPid})`);
        return;
      }
      if (failOnFirstError) callbacks.confirmCodexReattach?.(entry);
      if (!entry.codexTurnCounted) {
        entry.codexTurnCounted = true;
        entry.record.turns = (Number(entry.record.turns) || 0) + 1;
      }
      const rawOutput = typeof result.rawOutput === "string" ? result.rawOutput : "";
      const summary = String(result.errorMessage || result.summary || rawOutput || status);
      entry.result = {
        success: status === "completed",
        summary,
        rawOutput,
        finalOutput: retrievedFinalOutput(rawOutput, "the Codex app-server turn carried no final message"),
      };
      const stored = callbacks.emit(entry, { type: "exit", success: entry.result.success, summary });
      entry.result.summary = stored.summary;
      await callbacks.finish(entry, project, status === "completed" ? 0 : 1, null);
      return;
    }
    callbacks.emit(entry, { type: "status", state: status || "running", lane: "codex" });
  } catch (error) {
    const warning = profilePathWarning(error, "status polling");
    if (warning || failOnFirstError) {
      if (warning) addWarningOnce(entry, warning);
      await failTurn(entry, project, callbacks, warning || `worker status unavailable after restart: ${error.message}`);
      return;
    }
    entry.stderrLines.push(`codex status failed: ${error.message}`);
    entry.codexStatusFailures = (entry.codexStatusFailures || 0) + 1;
    if (entry.codexStatusFailures >= STATUS_FAILURE_RETRY_LIMIT) {
      const gone = callbacks.resolveSnapshotWorker?.(entry, entry.record.codexWorkerPid) ?? true;
      await failTurn(
        entry,
        project,
        callbacks,
        gone
          ? `worker status remained unavailable: ${error.message}`
          : `worker status remained unavailable and could not be confirmed dead: ${error.message}`,
      );
      return;
    }
  }
  entry.pollTimer = setTimeout(() => void poll(entry, project, commandRunner, callbacks), pollIntervalMs);
  entry.pollTimer.unref?.();
}

function promptFile(entry, prompt, dispatchDir) {
  const directory = dispatchDir ?? join(stateDir(), "dispatches");
  const safeId = String(entry.record.id).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || randomBytes(6).toString("hex");
  const path = resolve(directory, `${safeId}.codex-prompt.md`);
  writeFileSync(path, prompt, { encoding: "utf8", mode: 0o600 });
  entry.codexPromptPath = path;
  return path;
}

function launchRunner(options, { resume = false } = {}) {
  const { entry, project, prompt, worktreePath, dispatchDir, env, spawner, commandRunner, callbacks } = options;
  entry.codexTurnCounted = false;
  entry.codexStatusFailures = 0;
  entry.codexLogOffset = 0;
  entry.codexLogBuffer = "";
  const jobId = randomBytes(12).toString("hex");
  const binary = entry.codexBinary ?? inspectCodexBinary(env);
  const dispatcherLease = callbacks.dispatcherLease?.() ?? {
    dispatcherInstanceId: `atelier-process-${process.pid}`,
    dispatcherPid: process.pid,
    dispatcherPidIdentity: null,
  };
  callbacks.captureCodexJob?.(entry, { jobId, workspace: worktreePath });
  const args = [
    RUNNER_PATH,
    "task",
    "--job-id",
    jobId,
    "--codex",
    pinnedExecutable(entry, "codex"),
    "--binary-files-json",
    JSON.stringify(binary.files ?? []),
    "--dispatcher-id",
    dispatcherLease.dispatcherInstanceId,
    "--dispatcher-pid",
    String(dispatcherLease.dispatcherPid),
    ...(dispatcherLease.dispatcherPidIdentity
      ? ["--dispatcher-pid-identity", dispatcherLease.dispatcherPidIdentity]
      : []),
    "--state-dir",
    runnerStateDir(),
    "--workspace",
    worktreePath,
    "--prompt-file",
    promptFile(entry, prompt, dispatchDir),
    "--background",
    "--json",
    ...(entry.record.readOnly ? [] : ["--write"]),
    ...(resume ? ["--resume", entry.record.sessionId] : []),
  ];
  const child = spawner(process.execPath, args, { cwd: worktreePath, env });
  entry.child = child;
  let output = "";
  callbacks.streamLines(child.stdout, (line) => { output += `${line}\n`; });
  callbacks.streamLines(child.stderr, (line) => entry.stderrLines.push(line));
  let processError;
  child.once("error", (error) => { processError = error; });
  child.once("close", (code) => {
    if (entry.record.state === "stopping") {
      // stop() owns the cancellation proof. The launcher exiting only proves
      // that this short-lived child is gone; the detached runner may still be
      // writing, so its close event must never finish or clean the dispatch.
      entry.child = undefined;
      return;
    }
    let launch;
    try { launch = JSON.parse(output); } catch { launch = {}; }
    if (processError || code !== 0 || launch.jobId !== jobId) {
      entry.result = { success: false, summary: "Codex app-server runner launch failed" };
      entry.child = undefined;
      callbacks.retainCodexReattachFailure?.(
        entry,
        `Codex runner launcher failed after job ${jobId} was persisted; restart reattach will resolve the detached runner`,
      );
      return;
    }
    entry.child = undefined;
    entry.codexJobId = jobId;
    setLogPath(entry, launch.logFile);
    if (launch.warning) addWarningOnce(entry, launch.warning);
    callbacks.captureCompanion(entry, { jobId, workspace: worktreePath });
    if (callbacks.captureWorkerPid?.(entry, launch.pid)) {
      callbacks.captureCodexProcessTree?.(entry, launch.pid);
    }
    void poll(entry, project, commandRunner, callbacks);
  });
}

function launch(options) {
  launchRunner(options);
}

function resume({ text, ...options }) {
  launchRunner({ ...options, prompt: text }, { resume: true });
}

async function reattach({ entry, project, workspace, env, commandRunner, callbacks }) {
  entry.codexJobId = entry.record.codexJobId;
  entry.record.codexWorkspace = workspace;
  entry.env = env ?? entry.env ?? {};
  entry.codexLogOffset = 0;
  entry.codexLogBuffer = "";
  entry.codexStatusFailures = 0;
  const dispatcherLease = callbacks.dispatcherLease?.() ?? {
    dispatcherInstanceId: `atelier-process-${process.pid}`,
    dispatcherPid: process.pid,
    dispatcherPidIdentity: null,
  };
  const attached = JSON.parse(await commandRunner(process.execPath, [
    RUNNER_PATH,
    "attach",
    entry.codexJobId,
    "--state-dir",
    runnerStateDir(),
    "--dispatcher-id",
    dispatcherLease.dispatcherInstanceId,
    "--dispatcher-pid",
    String(dispatcherLease.dispatcherPid),
    ...(dispatcherLease.dispatcherPidIdentity
      ? ["--dispatcher-pid-identity", dispatcherLease.dispatcherPidIdentity]
      : []),
    "--break-dead",
  ], { cwd: entry.record.codexWorkspace, env: entry.env }));
  if (attached.warning) addWarningOnce(entry, attached.warning);
  callbacks.captureCompanion(entry, { jobId: entry.codexJobId, workspace });
  callbacks.emit(entry, {
    type: "status",
    state: "running",
    lane: "codex",
    detail: "reattached to Atelier Codex app-server runner after server restart",
  });
  void poll(entry, project, commandRunner, callbacks, { failOnFirstError: true });
}

function detach({ entry }) {
  if (entry.pollTimer) clearTimeout(entry.pollTimer);
  entry.pollTimer = undefined;
  entry.child = undefined;
}

async function stop({ entry, commandRunner }) {
  if (entry.pollTimer) clearTimeout(entry.pollTimer);
  entry.pollTimer = undefined;
  const launcher = entry.child;
  if (launcher) killTracked(launcher);
  const jobId = entry.codexJobId ?? entry.record.codexJobId;
  if (!jobId) {
    if (!launcher) return { finish: true };
    const warning = "Codex launcher was stopped before a runner job could be identified; runner death is unproven";
    addWarningOnce(entry, warning);
    return { finish: false, warning };
  }
  try {
    const raw = await commandRunner(process.execPath, [
      RUNNER_PATH,
      "cancel",
      jobId,
      "--state-dir",
      runnerStateDir(),
    ], { cwd: entry.record.codexWorkspace ?? entry.record.worktreePath, env: entry.env });
    const result = JSON.parse(raw);
    if (result.finish === true) return { finish: true };
    const warning = result.warning || "Codex app-server runner cancellation was unproven";
    addWarningOnce(entry, warning);
    return { finish: false, warning };
  } catch (error) {
    const warning = profilePathWarning(error, "cancel") || `Codex cancel failed: ${error.message}`;
    addWarningOnce(entry, warning);
    return { finish: false, warning };
  }
}

export const codexAppServerAgent = Object.freeze({
  id: "codex",
  displayName: "Codex",
  capabilities: Object.freeze({
    liveStream: true,
    liveInput: false,
    canResume: true,
    reportsCost: false,
    commitsOwnWork: false,
  }),
  options,
  resolveModel,
  validate,
  launch,
  resume,
  reattach,
  detach,
  stop,
  preLaunchChecks,
  executionEnv,
  executionProfile,
});

export function _setPollIntervalMs(next = POLL_INTERVAL_MS) {
  pollIntervalMs = next;
}

export function _setModelFileOps(nextFileOps = { readFileSync }) {
  modelFileOps = nextFileOps;
}

export function _setAppServerProber(next = probeCodexAppServer) {
  appServerProber = next;
}

export const _appServerRunnerPath = RUNNER_PATH;
