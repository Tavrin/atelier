import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

export const EXECUTION_PROFILE_MISMATCH = "EATELIER_EXECUTION_PROFILE_MISMATCH: ";

export const GIT_POSTURE = Object.freeze({
  pager: "disabled",
  globalConfig: "trusted-local",
  systemConfig: "trusted-local",
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
  for (const directory of String(env.PATH || "").split(delimiter)) {
    // Relative and empty PATH components are cwd-relative executable lookups.
    // A worktree must never influence what the daemon records as trusted.
    if (!directory || !isAbsolute(directory)) continue;
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
  controlledKeys = [],
  hooksSupported = true,
  capturedAt = new Date().toISOString(),
}) {
  const sortedEnv = sortedEnvironment(env);
  const controlled = new Set(controlledKeys);
  const envKeys = Object.keys(sortedEnv)
    .filter((key) => controlled.has(key) && key !== "PATH" && key !== "HOME");
  const controlledEnv = Object.fromEntries(envKeys.map((key) => [key, sortedEnv[key]]));
  const ambientEnv = Object.fromEntries(
    Object.entries(sortedEnv).filter(([key]) =>
      !controlled.has(key) && key !== "PATH" && key !== "HOME"),
  );
  const envKeyDigests = Object.fromEntries(
    envKeys.map((key) => [key, sha256(JSON.stringify([key, controlledEnv[key]]))]),
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
    // Only operator/project-controlled keys bind process admission. Ambient
    // daemon state is evidence and may warn, but must not kill restart recovery.
    envDigest: sha256(JSON.stringify(controlledEnv)),
    envKeys,
    // Values are never persisted. Per-key digests exist only for the controlled
    // surface so a refusal can name the exact keys without storing their values.
    envKeyDigests,
    ambientEnvDigest: sha256(JSON.stringify(ambientEnv)),
    ambientEnvKeys: Object.keys(ambientEnv),
    path: sortedEnv.PATH ?? null,
    home: sortedEnv.HOME ?? null,
    gitPosture: {
      hooks: hooksSupported ? "disabled" : "unsupported",
      ...GIT_POSTURE,
    },
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

export function executionProfileMismatch(recorded, current, {
  executable = false,
  companionPath = false,
} = {}) {
  const differences = [];
  if (recorded.envDigest !== current.envDigest) {
    differences.push(`envDigest (keys: ${changedEnvironmentKeys(recorded, current).join(", ")})`);
  }
  const fields = [
    ["path", recorded.path, current.path],
    ["home", recorded.home, current.home],
    ...(executable
      ? [["executable.resolvedPath", recorded.executable?.resolvedPath, current.executable?.resolvedPath]]
      : []),
    ...(companionPath
      ? [["companionPath", recorded.companionPath, current.companionPath]]
      : []),
  ];
  for (const [name, before, after] of fields) {
    if (before !== after) differences.push(`${name}: ${printable(before)} -> ${printable(after)}`);
  }
  return differences.length > 0 ? `${EXECUTION_PROFILE_MISMATCH}${differences.join("; ")}` : null;
}

export function executionProfileAmbientWarning(recorded, current) {
  if (!recorded?.ambientEnvDigest || recorded.ambientEnvDigest === current.ambientEnvDigest) {
    return null;
  }
  const keys = new Set([
    ...(recorded.ambientEnvKeys || []),
    ...(current.ambientEnvKeys || []),
  ]);
  return `execution profile ambient environment diverged (keys: ${[...keys].sort().join(", ") || "none"})`;
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
