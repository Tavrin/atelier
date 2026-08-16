import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { minimalChildPath } from "./execution/environment-policy.mjs";

const COMMAND_TIMEOUT_MS = 15_000;
export const GIT_TIMEOUT_MS = 60_000;
export const LONG_GIT_TIMEOUT_MS = 300_000;
export const SECRET_ENV_KEY = /key|token|secret|password|credential/i;
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
  { cwd, env, timeout, maxBuffer = MAX_COMMAND_BUFFER } = {},
) {
  const git = isGitExecutable(file);
  const effectiveTimeout = timeout ?? (git ? GIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS);
  const gitBaseEnv = {
    PATH: minimalChildPath(),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^LC_[A-Z0-9_]+$/.test(key)),
    ),
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
  };
  const effectiveEnv = git ? { ...gitBaseEnv, ...env, LC_ALL: "C" } : env;
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
          rejectPromise(new Error(message));
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
    if (SECRET_ENV_KEY.test(key)) delete clean[key];
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
      { windowsHide: true },
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
