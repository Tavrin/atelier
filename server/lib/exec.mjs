import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

import {
  gitChildEnv,
  sanitizeChildEnv,
  SECRET_ENV_KEY,
} from "./execution/environment-policy.mjs";
import { isSecretEnvKey } from "./execution/secret-environment.mjs";

const COMMAND_TIMEOUT_MS = 15_000;
export const GIT_TIMEOUT_MS = 60_000;
export const LONG_GIT_TIMEOUT_MS = 300_000;
export { SECRET_ENV_KEY };
const MAX_COMMAND_BUFFER = 8 * 1024 * 1024;
let execFileRunner = execFile;

function isGitExecutable(file) {
  return basename(String(file)).toLowerCase().replace(/\.exe$/, "") === "git";
}

function isFile(path) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveBrExecutable() {
  const names = process.platform === "win32" ? ["br.exe", "br"] : ["br"];
  const pathEntries = (process.env.PATH || "").split(delimiter).filter(Boolean);

  for (const pathEntry of pathEntries) {
    for (const name of names) {
      const candidate = join(pathEntry, name);
      if (isFile(candidate)) return candidate;
    }
  }

  for (const name of names) {
    const fallback = join(homedir(), ".cargo", "bin", name);
    if (isFile(fallback)) return fallback;
  }

  return join(homedir(), ".cargo", "bin", names[0]);
}

export function runFile(
  file,
  args,
  { cwd, env, timeout, maxBuffer = MAX_COMMAND_BUFFER, allowDenied = [] } = {},
) {
  const git = isGitExecutable(file);
  const effectiveTimeout = timeout ?? (git ? GIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
  const effectiveEnv = git
    ? gitChildEnv(env, { allowDenied })
    : env === undefined ? sanitizeChildEnv(process.env, { class: "tracker" }) : env;
  return new Promise((resolvePromise, rejectPromise) => {
    execFileRunner(
      file,
      args,
      {
        cwd,
        env: effectiveEnv,
        timeout: effectiveTimeout,
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          const message = detail || `${file} exited with an error`;
          const wrapped = new Error(message, { cause: error });
          // Adapter lifecycle policy distinguishes an executable that could not
          // spawn from an ordinary non-zero exit. Preserve Node's spawn evidence
          // while still presenting the bounded stderr/stdout message above.
          if (error.code !== undefined) wrapped.code = error.code;
          if (error.path !== undefined) wrapped.path = error.path;
          rejectPromise(wrapped);
          return;
        }
        resolvePromise(String(stdout));
      },
    );
  });
}

export function _setExecFileRunner(nextRunner = execFile) {
  execFileRunner = nextRunner;
}

export function envHygiene(env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (isSecretEnvKey(key)) delete clean[key];
  }
  return clean;
}

export function spawnTracked(
  cmd,
  args,
  { cwd, env, stdio = ["ignore", "pipe", "pipe"] },
) {
  return spawn(cmd, args, {
    cwd,
    env,
    // Ignored stdin remains the default: an unused pipe makes claude -p stall
    // 3s waiting for input on every non-live-input dispatch.
    stdio,
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  });
}

export function killTracked(child, { graceMs = 5_000 } = {}) {
  if (!child?.pid) return undefined;

  if (process.platform === "win32") {
    return execFile(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      {
        env: sanitizeChildEnv(process.env, { class: "tracker" }),
        windowsHide: true,
      },
      () => {},
    );
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return undefined;
  }

  if (child.exitCode !== null || child.signalCode !== null) return undefined;

  const escalation = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }, graceMs);
  escalation.unref();
  child.once("exit", () => clearTimeout(escalation));
  return escalation;
}
