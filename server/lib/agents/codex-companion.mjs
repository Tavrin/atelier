import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  close,
  open,
  read,
  readFileSync,
  readdirSync,
  stat,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { killTracked } from "../exec.mjs";
import { sanitizeChildEnv } from "../execution/environment-policy.mjs";
import {
  EXECUTION_PROFILE_MISMATCH,
  createExecutionProfile,
  executableDigest,
  pinnedCompanionPath,
  pinnedExecutable,
  resolveExecutable,
} from "../execution/execution-profile.mjs";
import { stateDir } from "../paths.mjs";
import { retrievedFinalOutput, unavailableFinalOutput } from "../stream.mjs";
import { SUPPORTED_CODEX_VERSION } from "./codex-app-server.mjs";

const POLL_INTERVAL_MS = 30_000;
// Ordinary polling already treats transient command failures as retryable. A
// missing pinned path gets the same bounded grace, then fails deterministically.
const STATUS_PROFILE_FAILURE_RETRY_LIMIT = 3;
let pollIntervalMs = POLL_INTERVAL_MS;
const LOG_TAIL_INTERVAL_MS = 2_000;
const LOG_READ_CHUNK_BYTES = 64 * 1024;
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const NO_USAGE_WARNING = "codex lane reports no usage data";
const CODEX_GIT_WARNING =
  "Atelier cannot write the worktree gitdir - automatic Codex commit may fail";
const PROMPT_FILE_INSTRUCTION =
  "Before doing anything else, read and follow the complete task prompt in this UTF-8 file:";
const MAX_PENDING_COMMAND_LINES = 100;
const MAX_PENDING_COMMAND_BYTES = 64 * 1024;
const KNOWN_COMPANION_STATUSES = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "canceled",
]);

const nativeLogFileOps = {
  stat(path) {
    return new Promise((resolvePromise, rejectPromise) => {
      stat(path, (error, value) => error ? rejectPromise(error) : resolvePromise(value));
    });
  },
  open(path) {
    return new Promise((resolvePromise, rejectPromise) => {
      open(path, "r", (error, fd) => error ? rejectPromise(error) : resolvePromise(fd));
    });
  },
  read(fd, buffer, offset, length, position) {
    return new Promise((resolvePromise, rejectPromise) => {
      read(fd, buffer, offset, length, position, (error, bytesRead) => {
        if (error) rejectPromise(error);
        else resolvePromise(bytesRead);
      });
    });
  },
  close(fd) {
    return new Promise((resolvePromise, rejectPromise) => {
      close(fd, (error) => error ? rejectPromise(error) : resolvePromise());
    });
  },
};

function resolveCompanionPath() {
  const root = join(homedir(), ".claude", "plugins", "cache", "openai-codex", "codex");
  let versions;
  try {
    versions = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return undefined;
  }
  for (const version of versions) {
    const candidate = join(root, version, "scripts", "codex-companion.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next cached version.
    }
  }
  return undefined;
}

function parseCompanionLaunch(output) {
  try {
    const value = JSON.parse(output);
    if (typeof value.jobId === "string") {
      return {
        jobId: value.jobId,
        logFile: typeof value.logFile === "string" ? value.logFile : undefined,
      };
    }
  } catch {
    // Retain compatibility with companion versions that only print text.
  }
  const jobId = output.match(/\bas\s+([a-zA-Z0-9._-]+)\./)?.[1];
  return jobId ? { jobId } : {};
}

let companionResolver = resolveCompanionPath;
let gitDirFileOps = { writeFileSync, unlinkSync };
let logFileOps = nativeLogFileOps;
let modelFileOps = { readFileSync };

const TURN_FIELDS = ["turns", "numTurns", "num_turns", "totalTurns", "total_turns"];
const COST_FIELDS = [
  "costUSD",
  "costUsd",
  "cost_usd",
  "totalCostUSD",
  "totalCostUsd",
  "total_cost_usd",
];
const INPUT_TOKEN_FIELDS = ["inputTokens", "input_tokens"];
const OUTPUT_TOKEN_FIELDS = ["outputTokens", "output_tokens"];
const TOTAL_TOKEN_FIELDS = ["totalTokens", "total_tokens"];

function nonNegativeNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function maxField(current, candidate) {
  const number = nonNegativeNumber(candidate);
  if (number === undefined) return current;
  return current === undefined ? number : Math.max(current, number);
}

function collectField(target, key, candidate) {
  const value = maxField(target[key], candidate);
  if (value !== undefined) target[key] = value;
}

function extractUsage(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = {};
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const field of TURN_FIELDS) collectField(usage, "turns", value[field]);
    for (const field of COST_FIELDS) collectField(usage, "costUSD", value[field]);
    for (const field of INPUT_TOKEN_FIELDS) {
      collectField(usage, "inputTokens", value[field]);
    }
    for (const field of OUTPUT_TOKEN_FIELDS) {
      collectField(usage, "outputTokens", value[field]);
    }
    for (const field of TOTAL_TOKEN_FIELDS) {
      collectField(usage, "totalTokens", value[field]);
    }
    for (const child of Object.values(value)) visit(child);
  }

  visit(payload);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function recordUsage(entry, payload, callbacks, { final = false } = {}) {
  const usage = extractUsage(payload);
  if (usage) {
    entry.codexUsageObserved = true;
    if (usage.turns !== undefined) {
      entry.record.turns = Math.max(Number(entry.record.turns) || 0, usage.turns);
    }
    if (usage.costUSD !== undefined) {
      entry.record.costUSD = Math.max(Number(entry.record.costUSD) || 0, usage.costUSD);
    }
    const signature = JSON.stringify(usage);
    if (signature !== entry.codexUsageSignature) {
      entry.codexUsageSignature = signature;
      callbacks?.emit?.(entry, {
        type: "usage",
        turns: entry.record.turns,
        costUSD: entry.record.costUSD,
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
      });
    }
  }
  if (final && !entry.codexUsageObserved && !entry.record.warnings.includes(NO_USAGE_WARNING)) {
    entry.record.warnings.push(NO_USAGE_WARNING);
  }
  return usage;
}

function setLogPath(entry, payload) {
  const path = payload?.logFile ?? payload?.job?.logFile ?? payload?.storedJob?.logFile;
  if (typeof path !== "string" || !path) return false;
  if (entry.codexLogPath !== path) {
    entry.codexLogPath = path;
    entry.codexLogOffset = 0;
    entry.codexLogBuffer = "";
    entry.codexPendingCommand = undefined;
    entry.codexLogDecoder = new StringDecoder("utf8");
  }
  return true;
}

function captureThread(entry, payload, callbacks) {
  const threadId = [
    payload?.job?.threadId,
    payload?.storedJob?.threadId,
    payload?.result?.threadId,
    payload?.threadId,
  ].find((value) => typeof value === "string" && value.trim())?.trim();
  if (!threadId || entry.record.sessionId === threadId) return false;
  callbacks.captureSession(entry, threadId);
  return true;
}

function rawLogEvent(text) {
  return { type: "message", kind: "raw", text };
}

function quoteIsEscaped(text, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function hasAmbiguousDelimiter(text, delimiter) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === delimiter && !quoteIsEscaped(text, index)) return true;
  }
  return false;
}

function commandPayload(fragments, delimiter = '"') {
  const joined = fragments.join("\n");
  const trimmed = joined.trimEnd();
  const finalQuote = trimmed.length - 1;
  if (trimmed[finalQuote] !== delimiter || quoteIsEscaped(trimmed, finalQuote)) {
    return { state: "pending" };
  }
  const payload = trimmed.slice(0, finalQuote);
  if (hasAmbiguousDelimiter(payload, delimiter)) return { state: "ambiguous" };
  return {
    state: "complete",
    payload: delimiter === '"'
      ? payload.replace(/\\(["\\])/g, "$1")
      : payload.replace(/\\(['\\])/g, "$1"),
  };
}

function pendingCommandEvents(entry) {
  const pending = entry.codexPendingCommand;
  entry.codexPendingCommand = undefined;
  return pending ? pending.rawLines.map(rawLogEvent) : [];
}

function isLogRecordBoundary(line) {
  return /^\[[^\]\r\n]+\]\s+\S/.test(line) ||
    /^Applying \d+ file change(?:s|\(s\))?$/.test(line) ||
    line === "File changes completed";
}

function parseCompanionLogLine(entry, line) {
  if (entry.codexPendingCommand) {
    if (isLogRecordBoundary(line)) {
      return [...pendingCommandEvents(entry), ...parseCompanionLogLine(entry, line)];
    }
    const pending = entry.codexPendingCommand;
    pending.rawLines.push(line);
    pending.fragments.push(line);
    pending.bytes += Buffer.byteLength(line) + 1;
    const parsed = commandPayload(pending.fragments, pending.delimiter);
    if (parsed.state === "complete") {
      entry.codexPendingCommand = undefined;
      return [{
        type: "message",
        kind: "tool_use",
        name: "Bash",
        inputPreview: JSON.stringify({ command: parsed.payload }),
        caption: pending.timestamp,
      }];
    }
    if (
      parsed.state === "ambiguous" ||
      pending.rawLines.length > MAX_PENDING_COMMAND_LINES ||
      pending.bytes > MAX_PENDING_COMMAND_BYTES
    ) {
      return pendingCommandEvents(entry);
    }
    return [];
  }

  // The companion log clamps long records and replaces their tail with `...`.
  // That is still enough attribution to render an honest command card, as long
  // as the UI makes the missing payload explicit.
  const truncatedCommand = /^\[([^\]\r\n]+)\] Running command: \/usr\/bin\/zsh -lc (["'])(.*\.\.\.)$/.exec(line);
  if (truncatedCommand) {
    const payload = truncatedCommand[3].slice(0, -3).trimEnd();
    if (hasAmbiguousDelimiter(payload, truncatedCommand[2])) return [rawLogEvent(line)];
    return [{
      type: "message",
      kind: "tool_use",
      name: "Bash",
      inputPreview: JSON.stringify({ command: payload }),
      caption: truncatedCommand[1],
      truncated: true,
    }];
  }

  const command = /^\[([^\]\r\n]+)\] Running command: \/usr\/bin\/zsh -lc (["'])(.*)$/.exec(line);
  if (command) {
    const pending = {
      timestamp: command[1],
      delimiter: command[2],
      fragments: [command[3]],
      rawLines: [line],
      bytes: Buffer.byteLength(line),
    };
    const parsed = commandPayload(pending.fragments, pending.delimiter);
    if (parsed.state === "complete") {
      return [{
        type: "message",
        kind: "tool_use",
        name: "Bash",
        inputPreview: JSON.stringify({ command: parsed.payload }),
        caption: pending.timestamp,
      }];
    }
    if (parsed.state === "ambiguous") return [rawLogEvent(line)];
    entry.codexPendingCommand = pending;
    return [];
  }

  const completed = /^\[([^\]\r\n]+)\] Command completed: .* \(exit (-?\d+)\)\s*$/.exec(line);
  if (completed) {
    const exitCode = Number(completed[2]);
    return [{
      type: "message",
      kind: "tool_result",
      preview: `Exit ${exitCode}`,
      exitCode,
      caption: completed[1],
    }];
  }

  const failed = /^\[([^\]\r\n]+)\] Command failed: .* \(exit (-?\d+)\)\s*$/.exec(line);
  if (failed) {
    const exitCode = Number(failed[2]);
    return [{
      type: "message",
      kind: "tool_result",
      preview: `Exit ${exitCode}`,
      exitCode,
      caption: failed[1],
    }];
  }

  const applying = /^Applying (\d+) file change(?:s|\(s\))?$/.exec(line);
  if (applying) {
    return [{
      type: "message",
      kind: "files",
      phase: "applying",
      count: Number(applying[1]),
      text: line,
    }];
  }
  if (line === "File changes completed") {
    return [{
      type: "message",
      kind: "files",
      phase: "completed",
      text: line,
    }];
  }
  return [rawLogEvent(line)];
}

function emitCompleteLogLines(entry, callbacks, text) {
  entry.codexLogBuffer = `${entry.codexLogBuffer ?? ""}${text}`;
  const lines = entry.codexLogBuffer.split("\n");
  entry.codexLogBuffer = lines.pop();
  for (const line of lines) {
    for (const event of parseCompanionLogLine(entry, line.replace(/\r$/, ""))) {
      callbacks.emit(entry, event);
    }
  }
}

async function tailLogOnce(entry, callbacks) {
  if (!entry.codexLogPath) return;
  if (entry.codexLogRead) return entry.codexLogRead;
  entry.codexLogRead = (async () => {
    let fd;
    try {
      const info = await logFileOps.stat(entry.codexLogPath);
      if (info.size < (entry.codexLogOffset ?? 0)) {
        entry.codexLogOffset = 0;
        entry.codexLogBuffer = "";
        entry.codexPendingCommand = undefined;
        entry.codexLogDecoder = new StringDecoder("utf8");
      }
      if (info.size === (entry.codexLogOffset ?? 0)) return;
      fd = await logFileOps.open(entry.codexLogPath);
      while ((entry.codexLogOffset ?? 0) < info.size) {
        const remaining = info.size - (entry.codexLogOffset ?? 0);
        const buffer = Buffer.allocUnsafe(Math.min(LOG_READ_CHUNK_BYTES, remaining));
        const bytesRead = await logFileOps.read(
          fd,
          buffer,
          0,
          buffer.length,
          entry.codexLogOffset ?? 0,
        );
        if (bytesRead === 0) break;
        entry.codexLogOffset = (entry.codexLogOffset ?? 0) + bytesRead;
        const decoder = entry.codexLogDecoder ??= new StringDecoder("utf8");
        emitCompleteLogLines(entry, callbacks, decoder.write(buffer.subarray(0, bytesRead)));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const warning = `codex log tail failed: ${error.message}`;
        if (!entry.stderrLines.includes(warning)) entry.stderrLines.push(warning);
      }
    } finally {
      if (fd !== undefined) await logFileOps.close(fd).catch(() => {});
    }
  })();
  try {
    await entry.codexLogRead;
  } finally {
    entry.codexLogRead = undefined;
  }
}

function scheduleLogTail(entry, callbacks) {
  if (!entry.codexLogPath || entry.codexLogTailStarted) return;
  entry.codexLogTailStarted = true;
  entry.codexLogTailStopped = false;

  const run = async () => {
    await tailLogOnce(entry, callbacks);
    if (entry.codexLogTailStopped || entry.record.state !== "running") return;
    entry.codexLogTimer = setTimeout(run, LOG_TAIL_INTERVAL_MS);
    entry.codexLogTimer.unref?.();
  };
  void run();
}

async function stopLogTail(entry, callbacks) {
  entry.codexLogTailStopped = true;
  if (entry.codexLogTimer) clearTimeout(entry.codexLogTimer);
  entry.codexLogTimer = undefined;
  await tailLogOnce(entry, callbacks);
  for (const event of pendingCommandEvents(entry)) callbacks.emit(entry, event);
}

function options() {
  return { models: [], efforts: [], resolvedModel: resolveModel() };
}

function resolveModel() {
  try {
    const config = modelFileOps.readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
    const match = /^\s*model\s*=\s*"([^"\r\n]+)"\s*(?:#.*)?$/m.exec(config);
    if (match?.[1]?.trim()) return match[1].trim();
  } catch {
    // The companion's persisted request.model is null when Atelier leaves model
    // selection to Codex, so config.toml is the first usable local source.
  }
  return "codex-default";
}

function validate({ effort }) {
  if (effort !== undefined && !EFFORT_VALUES.has(effort)) {
    throw new Error(`effort must be one of: ${[...EFFORT_VALUES].join(", ")}`);
  }
}

function companionEnv(env) {
  return sanitizeChildEnv({
    ...env,
    CLAUDE_PLUGIN_DATA: join(stateDir(), "codex-companion"),
  }, {
    class: "provider",
    // The Codex adapter owns this companion IPC root; project env cannot set it.
    allowDenied: ["CLAUDE_PLUGIN_DATA"],
  });
}

function executionEnv(env) {
  return companionEnv(env);
}

function executionProfile({
  entry,
  env,
  controlledKeys,
  hooksSupported,
  resolveCurrent = false,
}) {
  const companionPath = resolveCurrent
    ? companionResolver() ?? null
    : entry.companionPath ?? companionResolver() ?? null;
  const pinnedLegacy = entry.record.codexAdapter === "legacy-companion";
  const command = pinnedLegacy ? "codex" : "node";
  const resolvedPath = resolveExecutable(command, env);
  let executableVersion = null;
  if (pinnedLegacy && resolvedPath) {
    try {
      executableVersion = execFileSync(resolvedPath, ["--version"], {
        env,
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      }).trim() || null;
    } catch {
      // Admission requirements turn the missing version into a refusal.
    }
  }
  return createExecutionProfile({
    agentLane: entry.record.lane,
    command,
    companionPath,
    companionDigest: pinnedLegacy ? executableDigest(companionPath) : null,
    executableVersion,
    executableContentDigest: pinnedLegacy ? executableDigest(resolvedPath) : null,
    env,
    controlledKeys,
    hooksSupported,
  });
}

function companionCommand(entry) {
  return entry.record.codexAdapter === "legacy-companion"
    ? process.execPath
    : pinnedExecutable(entry, "node");
}

function pinnedCodexEnv(entry, env) {
  // Profile admission proves this PATH still resolves the recorded Codex path,
  // version, and digest before the companion inherits it. The private companion
  // state root is injected here so app-server records never receive it.
  if (env?.CLAUDE_PLUGIN_DATA === join(stateDir(), "codex-companion")) return env;
  return companionEnv(env);
}

function profilePathWarning(entry, error, operation) {
  if (error?.code !== "ENOENT") return null;
  return `${EXECUTION_PROFILE_MISMATCH}executable.resolvedPath could not spawn during Codex ${operation}: ${error.message}`;
}

function addWarningOnce(entry, warning) {
  if (!Array.isArray(entry.record.warnings)) entry.record.warnings = [];
  if (!entry.record.warnings.includes(warning)) entry.record.warnings.push(warning);
}

function companionErrorMessage(payload) {
  return [
    payload?.job?.errorMessage,
    payload?.storedJob?.errorMessage,
    payload?.storedJob?.result?.errorMessage,
    payload?.errorMessage,
  ].find((value) => typeof value === "string" && value.trim())?.trim();
}

function companionFinalMessage(payload) {
  return [
    payload?.storedJob?.result?.rawOutput,
    payload?.result?.rawOutput,
    payload?.rawOutput,
  ].find((value) => typeof value === "string" && value.trim());
}

function companionSummaryMessage(payload) {
  return [
    payload?.storedJob?.result?.summary,
    payload?.job?.summary,
    payload?.summary,
  ].find((value) => typeof value === "string" && value.trim())?.trim();
}

function attachCompanion(entry) {
  const companionPath = entry.companionPath ?? pinnedCompanionPath(entry) ?? companionResolver();
  if (!companionPath) {
    throw new Error("Codex lane unavailable: codex-companion.mjs was not found");
  }
  entry.companionPath = companionPath;
}

async function preLaunchChecks({ entry, worktreePath, env, commandRunner }) {
  attachCompanion(entry);
  if (entry.record.codexAdapter === "legacy-companion") {
    const pinned = executionProfile({
      entry,
      env: env ?? entry.env ?? process.env,
      controlledKeys: [],
      hooksSupported: true,
    });
    if (pinned.executable.version !== SUPPORTED_CODEX_VERSION) {
      throw new Error(
        `Codex lane unavailable: unsupported ${pinned.executable.version ?? "version"}; ` +
        `expected ${SUPPORTED_CODEX_VERSION}`,
      );
    }
  }
  if (entry.record.effort) {
    entry.record.warnings.push(
      "effort is ignored on the codex lane (reasoning effort is set in ~/.codex/config.toml)",
    );
  }

  let probePath;
  try {
    const rawGitDir = await commandRunner("git", ["-C", worktreePath, "rev-parse", "--git-dir"]);
    const gitDir = String(rawGitDir).trim();
    if (!gitDir) throw new Error("git rev-parse returned an empty git dir");
    probePath = join(
      resolve(worktreePath, gitDir),
      `.atelier-write-probe-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    gitDirFileOps.writeFileSync(probePath, "", { flag: "wx" });
    gitDirFileOps.unlinkSync(probePath);
    probePath = undefined;
  } catch {
    if (probePath) {
      try {
        gitDirFileOps.unlinkSync(probePath);
      } catch {
        // Best-effort cleanup after a failed create/delete probe.
      }
    }
    if (!entry.record.warnings.includes(CODEX_GIT_WARNING)) {
      entry.record.warnings.push(CODEX_GIT_WARNING);
    }
  }
}

async function failCompanionTurn(entry, project, callbacks, summary) {
  recordUsage(entry, undefined, callbacks, { final: true });
  await stopLogTail(entry, callbacks);
  entry.result = { success: false, summary };
  const stored = callbacks.emit(entry, { type: "exit", ...entry.result });
  entry.result.summary = stored.summary;
  await callbacks.finish(entry, project, null, null);
}

async function poll(
  entry,
  project,
  commandRunner,
  callbacks,
  { failOnFirstError = false } = {},
) {
  if (entry.record.state !== "running") return;
  try {
    const raw = await commandRunner(
      companionCommand(entry),
      [entry.companionPath, "status", entry.codexJobId, "--json"],
      {
        cwd: entry.record.codexWorkspace ?? entry.record.worktreePath,
        env: pinnedCodexEnv(entry, entry.env),
      },
    );
    entry.codexStatusProfileFailures = 0;
    const snapshot = JSON.parse(raw);
    captureThread(entry, snapshot, callbacks);
    recordUsage(entry, snapshot, callbacks);
    if (setLogPath(entry, snapshot)) scheduleLogTail(entry, callbacks);
    const status = snapshot.job?.status ?? snapshot.status;
    // EVERY snapshot's reported pid is examined, whatever its status says
    // (round 5): the unrecognized-status and terminal-status edges used to decide
    // this turn's fate - up to and including "completed", which a human then
    // merges - without ever looking at the worker the snapshot was pointing at.
    const workerPid = snapshot.job?.pid ?? snapshot.pid;
    if (failOnFirstError && !KNOWN_COMPANION_STATUSES.has(status)) {
      // A restart-time reattach must never trust an unrecognized status
      // (syntactically valid JSON, but not one of the statuses this adapter
      // understands) enough to keep polling forever or silently report
      // "running" - fail closed the same as a dead/unverifiable worker. Failing
      // closed still means proving death first: an unrecognized status says
      // nothing at all about whether the worker is running.
      const workerGone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
      await failCompanionTurn(
        entry,
        project,
        callbacks,
        workerGone
          ? `worker reported an unrecognized status after restart: ${JSON.stringify(status)}`
          : `worker reported an unrecognized status after restart (${JSON.stringify(status)}) and could not be confirmed dead (pid ${workerPid})`,
      );
      return;
    }
    if (["queued", "running"].includes(status)) {
      // Liveness MUST be judged against the pid/identity already on record
      // before that record is updated - capturing the fresh pid first would
      // make a reused-pid check compare the new identity against itself and
      // always "match". A restart-time reattach must never assume a persisted
      // job is still alive; round 4 adds the other half of that honesty: it must
      // not assume it is DEAD either. The verdict is three-way, decided by the
      // dispatcher's single classifier.
      if (failOnFirstError) {
        const verdict = callbacks.classifyReportedWorker?.(entry, workerPid) ?? "alive";
        if (verdict !== "alive") {
          // Not provably ours-and-running. Resolve the fence: if the worker is
          // proven gone the turn fails and the claim goes back as before; if it
          // cannot be confirmed (no /proc on this host, or a crash window that
          // lost the identity) the pid is fenced and the claim is RETAINED by the
          // guard in releaseClaim until it is proven dead or dismissed.
          const workerGone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
          await failCompanionTurn(
            entry,
            project,
            callbacks,
            workerGone
              ? "worker lost during downtime"
              : `worker could not be confirmed alive or dead after restart (pid ${workerPid})`,
          );
          return;
        }
      }
      // The app-server and its MCP children are NOT in the worker's process
      // group, so the companion's own cancel cannot reach them and a later walk
      // cannot find them - a broker reparents to init the moment its task-worker
      // exits. The tree therefore has to be captured WHILE the job is alive and
      // persisted for the reaper to use (atelier-za6).
      //
      // Gated on captureWorkerPid's verdict: it classifies any existing fence
      // before adopting a reported pid, so a pid it REFUSED (a recycled one, or
      // one reported while a different worker is still alive) never has its
      // descendants recorded as Atelier's to kill (round-2 review, blocker 1).
      const owned = callbacks.captureWorkerPid?.(entry, workerPid) ?? false;
      if (owned) callbacks.captureCodexProcessTree?.(entry, workerPid);
    }
    callbacks.emit(entry, { type: "status", state: status || "running", lane: "codex" });
    if (["completed", "failed", "cancelled", "canceled"].includes(status)) {
      let summary = companionErrorMessage(snapshot) ??
        companionFinalMessage(snapshot) ??
        companionSummaryMessage(snapshot) ??
        status;
      // The DISPLAY summary stays best-effort - the bounded status snapshot is a
      // fine fallback for a transcript line. Outcome CLASSIFICATION is not: this
      // fetch is the only source of the job's real final output, so when it fails
      // the failure is recorded as such (atelier-8r6, the archived attempt's MAJOR).
      // Falling back to the status summary here is what let a run that ended on a
      // question be recorded as a clean `completed`.
      let finalOutput;
      let rawOutput;
      try {
        const resultRaw = await commandRunner(
          companionCommand(entry),
          [entry.companionPath, "result", entry.codexJobId, "--json"],
          {
            cwd: entry.record.codexWorkspace ?? entry.record.worktreePath,
            env: pinnedCodexEnv(entry, entry.env),
          },
        );
        const result = JSON.parse(resultRaw);
        captureThread(entry, result, callbacks);
        recordUsage(entry, result, callbacks);
        if (setLogPath(entry, result)) scheduleLogTail(entry, callbacks);
        rawOutput = companionFinalMessage(result);
        summary = companionErrorMessage(result) ??
          rawOutput ??
          companionSummaryMessage(result) ??
          summary;
        finalOutput = retrievedFinalOutput(
          rawOutput,
          "the codex companion result carried no final message",
        );
      } catch (error) {
        finalOutput = unavailableFinalOutput(
          `the codex companion result could not be read: ${error.message}`,
        );
      }
      recordUsage(entry, undefined, callbacks, { final: true });
      await stopLogTail(entry, callbacks);
      // A terminal job status is the closest thing this lane gets to observing an
      // exit, so this is where the worker fence may be released - still probed,
      // never assumed. Round 5 hands it the SNAPSHOT's pid too, so the crash
      // window (a terminal job whose worker Atelier never captured) is fenced and
      // examined instead of going unseen: a turn must never complete - and so
      // never become mergeable - on top of a worker that may still be writing.
      const workerGone = callbacks.resolveSnapshotWorker?.(entry, workerPid) ?? true;
      if (!workerGone) {
        await failCompanionTurn(
          entry,
          project,
          callbacks,
          `job reported ${status} but its worker could not be confirmed dead (pid ${workerPid})`,
        );
        return;
      }
      entry.result = {
        success: status === "completed",
        summary: String(summary),
        finalOutput,
        ...(typeof rawOutput === "string" ? { rawOutput } : {}),
      };
      const stored = callbacks.emit(entry, {
        type: "exit",
        success: entry.result.success,
        summary: entry.result.summary,
      });
      entry.result.summary = stored.summary;
      await callbacks.finish(entry, project, status === "completed" ? 0 : 1, null);
      return;
    }
  } catch (error) {
    const profileWarning = profilePathWarning(entry, error, "status polling");
    if (profileWarning) {
      entry.codexStatusProfileFailures = (entry.codexStatusProfileFailures || 0) + 1;
      if (entry.codexStatusProfileFailures >= STATUS_PROFILE_FAILURE_RETRY_LIMIT) {
        addWarningOnce(entry, profileWarning);
        await failCompanionTurn(entry, project, callbacks, profileWarning);
        return;
      }
    } else if (failOnFirstError) {
      await failCompanionTurn(
        entry,
        project,
        callbacks,
        `worker status unavailable after restart: ${error.message}`,
      );
      return;
    } else {
      entry.stderrLines.push(`codex status failed: ${error.message}`);
    }
  }
  entry.pollTimer = setTimeout(
    () => void poll(entry, project, commandRunner, callbacks),
    pollIntervalMs,
  );
  entry.pollTimer.unref?.();
}

function resetCompanionLogTail(entry) {
  if (entry.codexLogTimer) clearTimeout(entry.codexLogTimer);
  entry.codexLogPath = undefined;
  entry.codexLogOffset = 0;
  entry.codexLogBuffer = "";
  entry.codexPendingCommand = undefined;
  entry.codexLogDecoder = new StringDecoder("utf8");
  entry.codexLogTailStarted = false;
  entry.codexLogTailStopped = false;
  entry.codexLogTimer = undefined;
}

function resetCompanionTurn(entry) {
  resetCompanionLogTail(entry);
  entry.codexJobId = undefined;
  entry.codexStatusProfileFailures = 0;
}

function filePrompt(entry, prompt, dispatchDir) {
  const directory = dispatchDir ?? join(stateDir(), "dispatches");
  const safeId = String(entry.record.id)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120) || randomBytes(6).toString("hex");
  const promptPath = resolve(directory, `${safeId}.codex-prompt.md`);
  writeFileSync(promptPath, prompt, {
    encoding: "utf8",
    mode: 0o600,
  });
  entry.codexPromptPath = promptPath;
  return `${PROMPT_FILE_INSTRUCTION}\n${promptPath}`;
}

function launchCompanion({
  entry,
  project,
  prompt,
  worktreePath,
  dispatchDir,
  env,
  spawner,
  commandRunner,
  callbacks,
}, { resume = false } = {}) {
  resetCompanionTurn(entry);
  const promptArgument = filePrompt(entry, prompt, dispatchDir);
  const args = [
    entry.companionPath,
    "task",
    ...(entry.record.readOnly ? [] : ["--write"]),
    ...(resume ? ["--resume"] : []),
    "--background",
    "--json",
    promptArgument,
  ];
  const child = spawner(
    companionCommand(entry),
    args,
    { cwd: worktreePath, env: pinnedCodexEnv(entry, env) },
  );
  entry.child = child;
  let output = "";
  callbacks.streamLines(child.stdout, (line) => {
    output += `${line}\n`;
  });
  callbacks.streamLines(child.stderr, (line) => {
    entry.stderrLines.push(line);
    if (entry.stderrLines.length > 50) entry.stderrLines.shift();
  });
  let processError;
  child.once("error", (error) => {
    processError = error;
  });
  child.once("close", (code) => {
    if (entry.record.state === "stopping") {
      void callbacks.finish(entry, project, code, null, processError);
      return;
    }
    const launch = parseCompanionLaunch(output);
    if (processError || code !== 0 || !launch.jobId) {
      entry.result = { success: false, summary: "Codex companion launch failed" };
      void callbacks.finish(entry, project, code, null, processError);
      return;
    }
    entry.codexJobId = launch.jobId;
    if (launch.logFile) setLogPath(entry, launch);
    entry.child = undefined;
    // codexJobId/codexWorkspace must land in the SAME persisted write as the
    // running transition - a crash between a bare state write and a later
    // jobId write would otherwise leave a "running" record with nothing to
    // reattach to.
    callbacks.captureCompanion(entry, { jobId: launch.jobId, workspace: worktreePath });
    scheduleLogTail(entry, callbacks);
    void poll(entry, project, commandRunner, callbacks);
  });
}

function launch(options) {
  launchCompanion(options);
}

function resume({ text, ...options }) {
  attachCompanion(options.entry);
  launchCompanion({ ...options, prompt: text }, { resume: true });
}

function reattach({ entry, project, workspace, env, commandRunner, callbacks }) {
  attachCompanion(entry);
  entry.codexJobId = entry.record.codexJobId;
  entry.record.codexWorkspace = workspace;
  entry.env = env ?? entry.env ?? {};
  resetCompanionLogTail(entry);
  callbacks.emit(entry, {
    type: "status",
    state: "running",
    lane: "codex",
    detail: "reattached after server restart",
  });
  void poll(entry, project, commandRunner, callbacks, { failOnFirstError: true });
}

function detach({ entry }) {
  // Deliberately does NOT touch entry.record or the companion job: the
  // worker is meant to keep running unattended (KillMode=process leaves it
  // alone) until a future boot reattaches to it.
  if (entry.pollTimer) clearTimeout(entry.pollTimer);
  entry.pollTimer = undefined;
  entry.codexLogTailStopped = true;
  if (entry.codexLogTimer) clearTimeout(entry.codexLogTimer);
  entry.codexLogTimer = undefined;
  entry.child = undefined;
}

async function stop({ entry, commandRunner }) {
  entry.codexLogTailStopped = true;
  if (entry.codexLogTimer) clearTimeout(entry.codexLogTimer);
  entry.codexLogTimer = undefined;
  if (entry.codexJobId) {
    try {
      await commandRunner(
        companionCommand(entry),
        [entry.companionPath, "cancel", entry.codexJobId, "--json"],
        {
          cwd: entry.record.codexWorkspace ?? entry.record.worktreePath,
          env: pinnedCodexEnv(entry, entry.env),
        },
      );
    } catch (error) {
      entry.stderrLines.push(`codex cancel failed: ${error.message}`);
      const warning = profilePathWarning(entry, error, "cancel");
      if (warning) {
        addWarningOnce(entry, warning);
        return { finish: false, warning };
      }
    }
    return { finish: true };
  }
  if (entry.child) {
    killTracked(entry.child);
    return { finish: false };
  }
  return { finish: true };
}

export const codexAgent = Object.freeze({
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

export function _setCompanionResolver(nextResolver = resolveCompanionPath) {
  companionResolver = nextResolver;
}

export function _setGitDirFileOps(nextFileOps = { writeFileSync, unlinkSync }) {
  gitDirFileOps = nextFileOps;
}

export function _setLogFileOps(nextFileOps = nativeLogFileOps) {
  logFileOps = nextFileOps;
}

export function _setModelFileOps(nextFileOps = { readFileSync }) {
  modelFileOps = nextFileOps;
}

// Only the SECOND poll onwards runs the ordinary (non-fail-closed) branch, which
// is the one that adopts a reported worker pid. Reaching it in a test otherwise
// means waiting out the real 30s interval.
export function _setPollIntervalMs(nextIntervalMs = POLL_INTERVAL_MS) {
  pollIntervalMs = nextIntervalMs;
}

export function _parseCompanionLogLines(lines) {
  const entry = {};
  const events = [];
  for (const line of lines) events.push(...parseCompanionLogLine(entry, line));
  events.push(...pendingCommandEvents(entry));
  return events;
}

export const _extractUsage = extractUsage;
export const _recordUsage = recordUsage;
export const _setLogPath = setLogPath;
export const _tailLogOnce = tailLogOnce;
