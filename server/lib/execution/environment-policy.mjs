import { homedir } from "node:os";
import { delimiter, dirname } from "node:path";

const DENIED_EXACT = new Set([
  "PATH",
  "HOME",
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

export function sanitizeChildEnv(env, { class: childClass } = {}) {
  const clean = {};
  let changed = false;
  for (const [key, value] of Object.entries(env || {})) {
    if (!controlsExecution(key)) {
      clean[key] = value;
      continue;
    }
    const trustedBaseline = ["provider", "editor"].includes(childClass) && (
      (key.toUpperCase() === "HOME" && value === homedir()) ||
      (key.toUpperCase() === "PATH" && value === minimalChildPath())
    );
    if (!trustedBaseline) changed = true;
  }
  if (["provider", "editor"].includes(childClass)) {
    const trustedHome = homedir();
    const trustedPath = minimalChildPath();
    if (env?.HOME !== trustedHome || env?.PATH !== trustedPath) changed = true;
    clean.HOME = trustedHome;
    clean.PATH = trustedPath;
  }
  return !changed && env && Object.keys(clean).length === Object.keys(env).length
    ? env
    : clean;
}
