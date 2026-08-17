import { killTracked } from "../exec.mjs";
import { sanitizeChildEnv } from "../execution/environment-policy.mjs";
import {
  createExecutionProfile,
  pinnedExecutable,
} from "../execution/execution-profile.mjs";
import { retrievedFinalOutput, unavailableFinalOutput, userMessageLine } from "../stream.mjs";

const MODELS = Object.freeze([
  Object.freeze({ value: "sonnet", label: "Sonnet (5)" }),
  Object.freeze({ value: "sonnet[1m]", label: "Sonnet · 1M context" }),
  Object.freeze({ value: "opus", label: "Opus (4.8)" }),
  Object.freeze({ value: "opus[1m]", label: "Opus · 1M context" }),
  Object.freeze({ value: "haiku", label: "Haiku (4.5)" }),
]);
const EFFORTS = Object.freeze([
  Object.freeze({ value: "low", label: "Low" }),
  Object.freeze({ value: "medium", label: "Medium" }),
  Object.freeze({ value: "high", label: "High" }),
  Object.freeze({ value: "xhigh", label: "Extra high" }),
  Object.freeze({ value: "max", label: "Max" }),
]);
const MODEL_VALUES = new Set(MODELS.map(({ value }) => value));
const EFFORT_VALUES = new Set(EFFORTS.map(({ value }) => value));
const CAPABILITIES = Object.freeze({
  liveStream: true,
  liveInput: true,
  canResume: true,
  reportsCost: true,
  commitsOwnWork: true,
});

function spawnOptions(worktreePath, env) {
  return {
    cwd: worktreePath,
    env,
    ...(CAPABILITIES.liveInput ? { stdio: ["pipe", "pipe", "pipe"] } : {}),
  };
}

function executionEnv(env) {
  return sanitizeChildEnv(env, { class: "provider" });
}

function executionProfile({ entry, env }) {
  return createExecutionProfile({
    agentLane: entry.record.lane,
    command: "claude",
    env,
  });
}

function options() {
  return {
    models: MODELS.map((choice) => ({ ...choice })),
    efforts: EFFORTS.map((choice) => ({ ...choice })),
  };
}

function reviewReadOnlyArgs(entry) {
  if (!entry.record.readOnly) return [];
  return [
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "",
  ];
}

function resolveModel({ requested, profile = {} } = {}) {
  const model = String(requested ?? profile.model ?? profile.defaultModel ?? "sonnet").trim();
  if (!model) throw new Error("model must be a non-empty string");
  if (model.startsWith("-")) throw new Error('model must not start with "-"');
  if (!MODEL_VALUES.has(model)) {
    throw new Error(
      `Unsupported model: ${model} (allowed: ${[...MODEL_VALUES].join(", ")}; fable is reserved for the architect session)`,
    );
  }
  return model;
}

function validate({ effort }) {
  if (effort !== undefined && !EFFORT_VALUES.has(effort)) {
    throw new Error(`effort must be one of: ${[...EFFORT_VALUES].join(", ")}`);
  }
}

function consume({ entry, project, child, callbacks, accumulateUsage }) {
  entry.child = child;
  // atelier-tzw finding 1a: persist this worker's pid+identity atomically with
  // the running transition, so an unclean death (crash/SIGKILL/OOM, no
  // graceful shutdown) still leaves boot something to reap before it
  // declares the work dead and releases the claim.
  callbacks.transition(entry, "running", callbacks.childIdentityFields?.(child.pid));
  callbacks.streamLines(child.stdout, (line) => {
    // Parsed for EVERY line, not only plan runs (atelier-8r6): normalizeLine's
    // exit summary is a head-first 2,000-char slice, so on a long final message
    // it drops the tail - the only part outcome classification reads. `null`
    // records a result event that carried no string payload at all, which is a
    // retrieval failure rather than an empty answer.
    let fullResult;
    try {
      const raw = JSON.parse(line);
      if (raw?.type === "result") {
        fullResult = typeof raw.result === "string" ? raw.result : null;
      }
    } catch {
      // Malformed output still follows the shared normalizer path.
    }
    for (const normalized of callbacks.normalizeLine(line)) {
      const event = normalized.type === "exit" && entry.planRun && fullResult !== undefined
        ? { ...normalized, summary: fullResult ?? "" }
        : normalized;
      if (event.type === "status" && event.sessionId) {
        callbacks.captureSession(entry, event.sessionId);
      }
      const stored = callbacks.emit(entry, event);
      if (event.type === "usage") {
        if (accumulateUsage) {
          entry.record.turns += event.turns;
          entry.record.costUSD += event.costUSD;
        } else {
          entry.record.turns = event.turns;
          entry.record.costUSD = event.costUSD;
        }
      } else if (event.type === "exit") {
        entry.result = {
          ...event,
          summary: stored.summary,
          ...(typeof fullResult === "string" ? { rawOutput: fullResult } : {}),
          // Fail closed: a result event with no string payload is a retrieval
          // failure, NOT an empty final message, and never degrades to the
          // truncated display summary.
          finalOutput: fullResult === undefined || fullResult === null
            ? unavailableFinalOutput(
              "the claude result event carried no final message",
            )
            : retrievedFinalOutput(fullResult),
        };
        entry.record.exitSummary = stored.summary;
        // Close the steering window when a turn completes with no queued
        // reply - otherwise a live-input run waits on stdin forever (found
        // live: a finished dispatch lingered as "running"). Steering targets
        // in-flight turns; finished runs are reached via resume.
        if (child.stdin && !child.stdin.writableEnded) {
          if ((entry.pendingLiveReplies || 0) > 0) entry.pendingLiveReplies -= 1;
          else child.stdin.end();
        }
      }
    }
  });
  callbacks.streamLines(child.stderr, (line) => {
    entry.stderrLines.push(line);
    if (entry.stderrLines.length > 50) entry.stderrLines.shift();
  });
  let processError;
  let spawned = false;
  // `running` is transitioned above, before the child has proven it exists, so an
  // ASYNC spawn failure (ENOENT arrives as an 'error' event) would otherwise have
  // already erased the prior turn's question through clearOutcomeOnRunning. The
  // clear is reversible until 'spawn' confirms a real process (atelier-8r6): commit it
  // then, restore it if 'error' wins the race.
  child.once("spawn", () => {
    spawned = true;
    callbacks.commitOutcomeClear?.(entry);
  });
  child.once("error", (error) => {
    processError = error;
    if (!spawned) callbacks.restoreClearedOutcome?.(entry);
  });
  // An OBSERVED exit is confirmed death - node has reaped the child, so the
  // fence may be released with no probe (atelier-tzw round 4, item 2). Both events
  // report it: 'exit' is the earliest signal for a real child, 'close' is what
  // arrives when only stdio is being modelled. confirmChildExit is idempotent
  // and pid-keyed, so hearing both is harmless.
  child.once("exit", () => {
    callbacks.confirmChildExit?.(entry, child.pid);
  });
  child.once("close", (code, signal) => {
    callbacks.confirmChildExit?.(entry, child.pid);
    void callbacks.finish(entry, project, code, signal, processError);
  });
}

function launch({
  entry,
  project,
  prompt,
  worktreePath,
  maxTurns,
  env,
  spawner,
  callbacks,
}) {
  const profile = project.dispatchProfile || {};
  const allowedTools = Array.isArray(entry.allowedTools)
    ? entry.allowedTools
    : Array.isArray(profile.allowedTools) ? profile.allowedTools : [];
  const args = [
    "-p",
    prompt,
    "--model",
    entry.record.model,
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    allowedTools.join(","),
    ...reviewReadOnlyArgs(entry),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (Array.isArray(entry.disallowedTools) && entry.disallowedTools.length > 0) {
    // --allowedTools only pre-APPROVES; settings can still permit tools.
    // Planning runs rely on the deny list. Review runs additionally use the
    // CLI's safe-mode/no-tools posture and an MCP wildcard deny.
    args.push("--disallowedTools", entry.disallowedTools.join(","));
  }
  if (entry.record.effort) args.push("--effort", entry.record.effort);
  const child = spawner(
    pinnedExecutable(entry, "claude"),
    args,
    spawnOptions(worktreePath, env),
  );
  child.stdin.write(userMessageLine(prompt));
  consume({ entry, project, child, callbacks, accumulateUsage: false });
}

function resume({
  entry,
  project,
  text,
  worktreePath,
  maxTurns,
  env,
  spawner,
  callbacks,
}) {
  const profile = project.dispatchProfile || {};
  const allowedTools = Array.isArray(entry.allowedTools)
    ? entry.allowedTools
    : Array.isArray(profile.allowedTools) ? profile.allowedTools : [];
  const args = [
    "-p",
    "--resume",
    entry.record.sessionId,
    text,
    "--model",
    entry.record.model,
    "--max-turns",
    String(maxTurns),
    "--allowedTools",
    allowedTools.join(","),
    ...reviewReadOnlyArgs(entry),
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (Array.isArray(entry.disallowedTools) && entry.disallowedTools.length > 0) {
    args.push("--disallowedTools", entry.disallowedTools.join(","));
  }
  if (entry.record.effort) args.push("--effort", entry.record.effort);
  const child = spawner(
    pinnedExecutable(entry, "claude"),
    args,
    spawnOptions(worktreePath, env),
  );
  child.stdin.write(userMessageLine(text));
  consume({ entry, project, child, callbacks, accumulateUsage: true });
}

async function stop({ entry }) {
  if (entry.child) {
    killTracked(entry.child);
    return { finish: false };
  }
  return { finish: true };
}

async function preLaunchChecks() {}

export const claudeAgent = Object.freeze({
  id: "claude",
  displayName: "Claude",
  capabilities: CAPABILITIES,
  options,
  resolveModel,
  validate,
  launch,
  resume,
  stop,
  preLaunchChecks,
  executionEnv,
  executionProfile,
});
