import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export const EXECUTION_PROFILE_MISMATCH = "EATELIER_EXECUTION_PROFILE_MISMATCH: ";

export const GIT_POSTURE = Object.freeze({
  hooks: "disabled",
  pager: "disabled",
  globalConfig: "ignored",
  systemConfig: "ignored",
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sortedEnvironment(env) {
  return Object.fromEntries(
    Object.keys(env || {}).sort().map((key) => [key, env[key]]),
  );
}

function executableFile(path) {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutable(command, env = {}) {
  const value = String(command || "");
  if (!value) return null;
  if (isAbsolute(value)) return executableFile(value) ? resolve(value) : null;

  const extensions = process.platform === "win32"
    ? String(env.PATHEXT || process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
      .split(";")
      .filter(Boolean)
    : [""];
  const hasExtension = process.platform === "win32" && /\.[^\\/]+$/.test(value);
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = resolve(directory, `${value}${extension}`);
      if (executableFile(candidate)) return candidate;
    }
  }
  return null;
}

export function createExecutionProfile({
  agentLane,
  command,
  companionPath = null,
  env,
  capturedAt = new Date().toISOString(),
}) {
  const sortedEnv = sortedEnvironment(env);
  const envKeys = Object.keys(sortedEnv);
  const envKeyDigests = Object.fromEntries(
    envKeys.map((key) => [key, sha256(JSON.stringify([key, sortedEnv[key]]))]),
  );
  return {
    version: 1,
    capturedAt,
    agentLane,
    class: "provider",
    executable: {
      command,
      resolvedPath: resolveExecutable(command, sortedEnv),
    },
    companionPath: companionPath ?? null,
    envDigest: sha256(JSON.stringify(sortedEnv)),
    envKeys,
    // Values are never persisted. Per-key digests make an env mismatch useful
    // after restart without disclosing the value that changed.
    envKeyDigests,
    path: sortedEnv.PATH ?? null,
    home: sortedEnv.HOME ?? null,
    gitPosture: { ...GIT_POSTURE },
  };
}

function changedEnvironmentKeys(recorded, current) {
  const keys = new Set([...(recorded.envKeys || []), ...(current.envKeys || [])]);
  const changed = [...keys].filter((key) =>
    recorded.envKeyDigests?.[key] !== current.envKeyDigests?.[key]);
  if (changed.length > 0) return changed.sort();
  return ["(unavailable from legacy digest)"];
}

function printable(value) {
  return JSON.stringify(value ?? null);
}

export function executionProfileMismatch(recorded, current) {
  const differences = [];
  if (recorded.envDigest !== current.envDigest) {
    differences.push(`envDigest (keys: ${changedEnvironmentKeys(recorded, current).join(", ")})`);
  }
  for (const [name, before, after] of [
    ["executable.resolvedPath", recorded.executable?.resolvedPath, current.executable?.resolvedPath],
    ["companionPath", recorded.companionPath, current.companionPath],
    ["path", recorded.path, current.path],
    ["home", recorded.home, current.home],
  ]) {
    if (before !== after) differences.push(`${name}: ${printable(before)} -> ${printable(after)}`);
  }
  return differences.length > 0 ? `${EXECUTION_PROFILE_MISMATCH}${differences.join("; ")}` : null;
}

export function supersedeExecutionProfile(previous, current, { reason, actor, at }) {
  const { superseded = [], ...prior } = previous || {};
  return {
    ...current,
    superseded: [
      ...superseded,
      { ...prior, supersededAt: at, reason, actor },
    ],
  };
}

export function pinnedExecutable(entry, fallback) {
  return entry.record.executionProfile?.executable?.resolvedPath || fallback;
}

export function pinnedCompanionPath(entry) {
  return entry.record.executionProfile?.companionPath || null;
}
