import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";

const DENIED_EXACT = new Set([
  "PATH",
  "HOME",
  "SSH_ASKPASS",
  "KRB5_CONFIG",
  "KRB5CCNAME",
  "GLIBC_TUNABLES",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "PYTHONPATH",
  "PERL5LIB",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "IFS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const DENIED_PREFIXES = [
  "XDG_",
  "GIT_",
  "LD_",
  "DYLD_",
  "NODE_REPL_",
  "CLAUDE_",
  "ANTHROPIC_",
  "OPENAI_",
  "CODEX_",
];

export const SECRET_ENV_KEY = /key|token|secret|password|credential/i;
const TRUSTED_BASELINE_CLASSES = new Set(["git", "provider", "editor", "tracker"]);

function controlsExecution(key) {
  const normalized = String(key).toUpperCase();
  return DENIED_EXACT.has(normalized) ||
    DENIED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function assertAllowedDispatchEnvKey(key) {
  if (controlsExecution(key)) {
    throw new Error(`${key} controls execution; not permitted in dispatchEnv`);
  }
  return key;
}

export function minimalChildPath() {
  const entries = process.platform === "win32"
    ? [
      dirname(process.execPath),
      process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : undefined,
      process.env.SystemRoot,
    ]
    : [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set(entries.filter(Boolean))].join(delimiter);
}

function trustedChildPath() {
  // The daemon's own PATH is trusted-local. The fixed list is solely the
  // fallback for the unusual case where the parent process has no PATH.
  return process.env.PATH || minimalChildPath();
}

function trustedChildHome() {
  return process.env.HOME || homedir();
}

function sanitizedChildEnv(
  env,
  { class: childClass, allowDenied = [] } = {},
  safePolicyKeyNames = new Set(),
) {
  const allowedDeniedKeys = new Set(allowDenied.map((key) => String(key).toUpperCase()));
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = key.toUpperCase();
    if (SECRET_ENV_KEY.test(key) && !safePolicyKeyNames.has(normalized)) continue;
    if (controlsExecution(key) && !allowedDeniedKeys.has(normalized)) continue;
    clean[key] = value;
  }
  if (TRUSTED_BASELINE_CLASSES.has(childClass)) {
    clean.HOME = trustedChildHome();
    clean.PATH = trustedChildPath();
  }
  return clean;
}

export function sanitizeChildEnv(env, options = {}) {
  return sanitizedChildEnv(env, options);
}

export function gitChildEnv(env, { allowDenied = [] } = {}) {
  const requestedCount = String(env?.GIT_CONFIG_COUNT ?? "");
  const callerCount = /^\d+$/.test(requestedCount) && Number.isSafeInteger(Number(requestedCount))
    ? Number(requestedCount)
    : 0;
  const postureIndex = callerCount;
  const posture = {
    GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: String(callerCount + 1),
    [`GIT_CONFIG_KEY_${postureIndex}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${postureIndex}`]: "/dev/null",
  };
  const callerChannelKeys = Array.from({ length: callerCount }, (_, index) => [
    `GIT_CONFIG_KEY_${index}`,
    `GIT_CONFIG_VALUE_${index}`,
  ]).flat();
  const merged = {
    PATH: trustedChildPath(),
    // HOME and the operator's global/system Git config remain trusted-local for
    // identity, credentials, safe.directory and repository access. Only hooks
    // and paging are disabled here; repo-local filters and attributes remain
    // trusted-local, and the broader transform boundary belongs to ATT-008.
    HOME: trustedChildHome(),
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
    ...(process.env.TERM === undefined ? {} : { TERM: process.env.TERM }),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => /^LC_[A-Z0-9_]+$/.test(key)),
    ),
    ...(process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {}),
    ...env,
    // Applied last so callers cannot restore pagers or repo-local hooks. The
    // hook entry is appended after the caller's complete env-config channel,
    // preserving that channel while giving this posture final precedence.
    ...posture,
    LC_ALL: "C",
  };
  const policyKeys = new Set(
    [...callerChannelKeys, ...Object.keys(posture)]
      .filter((key) => key.startsWith("GIT_CONFIG_KEY_"))
      .map((key) => key.toUpperCase()),
  );
  return sanitizedChildEnv(merged, {
    class: "git",
    allowDenied: [...allowDenied, ...callerChannelKeys, ...Object.keys(posture)],
  }, policyKeys);
}
