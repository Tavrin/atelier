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
const SAFE_POLICY_KEY_NAMES = new Set(["GIT_CONFIG_KEY_0"]);

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

export function sanitizeChildEnv(env, { class: childClass, allowDenied = [] } = {}) {
  const allowedDeniedKeys = new Set(allowDenied.map((key) => String(key).toUpperCase()));
  const clean = {};
  for (const [key, value] of Object.entries(env || {})) {
    const normalized = key.toUpperCase();
    if (SECRET_ENV_KEY.test(key) && !SAFE_POLICY_KEY_NAMES.has(normalized)) continue;
    if (controlsExecution(key) && !allowedDeniedKeys.has(normalized)) continue;
    clean[key] = value;
  }
  if (TRUSTED_BASELINE_CLASSES.has(childClass)) {
    clean.HOME = trustedChildHome();
    clean.PATH = trustedChildPath();
  }
  return clean;
}

export function gitChildEnv(env, { allowDenied = [] } = {}) {
  const posture = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_PAGER: "cat",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
  };
  const merged = {
    PATH: trustedChildPath(),
    // HOME remains trusted-local for credential helpers and repository access;
    // global/system Git config is deliberately disabled by the posture below.
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
    // Applied last so callers cannot restore global/system config, pagers, or
    // repo-local hooks. Repo-local filters and attributes remain trusted-local;
    // the broader content-transform boundary belongs to ATT-008 isolation.
    ...posture,
    LC_ALL: "C",
  };
  return sanitizeChildEnv(merged, {
    class: "git",
    allowDenied: [...allowDenied, ...Object.keys(posture)],
  });
}
