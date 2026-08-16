import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { killTracked } from "../../server/lib/exec.mjs";
import { retrievedFinalOutput, unavailableFinalOutput } from "../../server/lib/stream.mjs";

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.mjs", import.meta.url));
const CAPABILITIES = Object.freeze({
  liveStream: true,
  liveInput: true,
  canResume: true,
  reportsCost: true,
  commitsOwnWork: true,
});

function requireTestGuard(env) {
  if (env?.ATELIER_TEST_NO_REAL_PROVIDER !== "1") {
    throw new Error("fake adapter requires ATELIER_TEST_NO_REAL_PROVIDER=1");
  }
  const scenario = env.ATELIER_FAKE_SCENARIO;
  if (!isAbsolute(scenario || "")) throw new Error("ATELIER_FAKE_SCENARIO must be absolute");
  return scenario;
}

function fakeChildEnvironment(env) {
  const childEnv = {
    HOME: env.HOME,
    PATH: env.PATH,
    LC_ALL: env.LC_ALL || "C",
  };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("ATELIER_TEST_")) childEnv[key] = value;
  }
  return childEnv;
}

function options() {
  return {
    models: [{ value: "fake", label: "Fake" }],
    efforts: [{ value: "low", label: "Low" }],
  };
}

function resolveModel({ requested } = {}) {
  if (requested !== undefined && requested !== "fake") throw new Error(`Unsupported model: ${requested}`);
  return "fake";
}

function validate({ effort } = {}) {
  if (effort !== undefined && effort !== "low") throw new Error("effort must be low");
}

function consume({ entry, project, child, callbacks, accumulateUsage }) {
  entry.child = child;
  callbacks.transition(entry, "running", callbacks.childIdentityFields?.(child.pid));
  let processError;
  let spawned = false;
  callbacks.streamLines(child.stdout, (line) => {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = null;
    }
    if (raw?.type?.startsWith("fake.")) {
      callbacks.emit(entry, { type: "message", kind: raw.type, text: JSON.stringify(raw) });
      if (raw.type === "fake.usage") {
        const usage = {
          type: "usage",
          turns: Number(raw.turns || 0),
          costUSD: Number(raw.costUSD || 0),
          inputTokens: Number(raw.inputTokens || 0),
          outputTokens: Number(raw.outputTokens || 0),
        };
        callbacks.emit(entry, usage);
        if (accumulateUsage) {
          entry.record.turns += usage.turns;
          entry.record.costUSD += usage.costUSD;
        } else {
          entry.record.turns = usage.turns;
          entry.record.costUSD = usage.costUSD;
        }
      }
      return;
    }
    for (const event of callbacks.normalizeLine(line)) {
      if (event.type === "status" && event.sessionId) callbacks.captureSession(entry, event.sessionId);
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
          finalOutput: typeof raw?.result === "string"
            ? retrievedFinalOutput(raw.result)
            : unavailableFinalOutput("the fake result event carried no final message"),
        };
        entry.record.exitSummary = stored.summary;
      }
    }
  });
  callbacks.streamLines(child.stderr, (line) => {
    entry.stderrLines.push(line);
    if (entry.stderrLines.length > 50) entry.stderrLines.shift();
  });
  child.once("spawn", () => {
    spawned = true;
    callbacks.commitOutcomeClear?.(entry);
  });
  child.once("error", (error) => {
    processError = error;
    if (!spawned) callbacks.restoreClearedOutcome?.(entry);
  });
  child.once("exit", () => callbacks.confirmChildExit?.(entry, child.pid));
  child.once("close", (code, signal) => {
    callbacks.confirmChildExit?.(entry, child.pid);
    void callbacks.finish(entry, project, code, signal, processError);
  });
}

function launch({ entry, project, worktreePath, env, spawner, callbacks }) {
  const scenario = requireTestGuard(env);
  const child = spawner(FAKE_AGENT, [scenario], {
    cwd: worktreePath,
    env: fakeChildEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  consume({ entry, project, child, callbacks, accumulateUsage: false });
}

function resume({ entry, project, worktreePath, env, spawner, callbacks }) {
  const scenario = requireTestGuard(env);
  const child = spawner(FAKE_AGENT, [scenario, "--resume", entry.record.sessionId], {
    cwd: worktreePath,
    env: fakeChildEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  consume({ entry, project, child, callbacks, accumulateUsage: true });
}

async function stop({ entry }) {
  if (!entry.child) return { finish: true };
  killTracked(entry.child);
  return { finish: false };
}

async function preLaunchChecks({ entry }) {
  requireTestGuard(entry.env);
}

export const fakeAgent = Object.freeze({
  id: "fake",
  displayName: "Fake test agent",
  capabilities: CAPABILITIES,
  options,
  resolveModel,
  validate,
  launch,
  resume,
  stop,
  preLaunchChecks,
});
