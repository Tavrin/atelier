import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const SANDBOX_UNAVAILABLE = "EATELIER_SANDBOX_UNAVAILABLE: ";

export const CONFINEMENTS = Object.freeze([
  "trusted-local",
  "sandboxed-write",
  "sandboxed-review-readonly",
  "advisory",
]);
export const CREDENTIAL_CONTAINMENTS = Object.freeze([
  "none",
  "brokered",
  "in-sandbox",
]);
export const SANDBOX_BACKEND_IDS = Object.freeze(["bwrap", "podman"]);
export const BUILT_IN_TRUST_PROFILE = Object.freeze({
  confinement: "trusted-local",
  credential: "none",
});

const SECRET_ENV_KEY = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIALS?)(?:_|$)/i;

function clonedProfile(profile = BUILT_IN_TRUST_PROFILE) {
  return {
    confinement: profile.confinement ?? BUILT_IN_TRUST_PROFILE.confinement,
    credential: profile.credential ?? BUILT_IN_TRUST_PROFILE.credential,
  };
}

export function resolveTrustProfile(project = {}, defaults = {}, requested = undefined) {
  return clonedProfile({
    ...BUILT_IN_TRUST_PROFILE,
    ...(defaults.trustProfile || {}),
    ...(project.trustProfile || {}),
    ...(requested || {}),
  });
}

export function resolveSandboxBackendId(project = {}, defaults = {}) {
  return project.sandboxBackend ?? defaults.sandboxBackend ?? "bwrap";
}

export function sandboxEnforcesIsolation(confinement) {
  return confinement === "sandboxed-write" || confinement === "sandboxed-review-readonly";
}

export function sandboxPostureLabel(sandbox) {
  const confinement = sandbox?.confinement ?? BUILT_IN_TRUST_PROFILE.confinement;
  const credential = sandbox?.credential ?? BUILT_IN_TRUST_PROFILE.credential;
  if (confinement === "trusted-local") {
    return `trusted-local (no isolation; credential ${credential})`;
  }
  if (confinement === "advisory") {
    return `advisory (non-enforcing; credential ${credential})`;
  }
  const backend = sandbox?.backendId || "unknown backend";
  return `${confinement} (isolated by ${backend}; credential ${credential})`;
}

function commandResult(file, args, spawn = spawnSync) {
  const result = spawn(file, args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    error: result.error,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function unavailableReason(result, label) {
  if (result.error?.code === "ENOENT") return `${label} executable was not found`;
  return result.error?.message || result.stderr || `${label} exited ${result.status}`;
}

function bwrapRestrictionReason(result) {
  const detail = unavailableReason(result, "bubblewrap");
  if (/apparmor|user namespace|userns|permission denied|operation not permitted/i.test(detail)) {
    return `unprivileged user namespace restriction prevented bubblewrap: ${detail}`;
  }
  return `bubblewrap isolation probe failed: ${detail}`;
}

function withoutCredentials(env) {
  const filtered = { ...(env || {}) };
  for (const key of Object.keys(filtered)) {
    if (SECRET_ENV_KEY.test(key) || ["SSH_AUTH_SOCK", "GPG_AGENT_INFO"].includes(key)) {
      delete filtered[key];
    }
  }
  filtered.HOME = "/nonexistent";
  delete filtered.CODEX_HOME;
  delete filtered.CLAUDE_CONFIG_DIR;
  return filtered;
}

function credentialDirectories(env, pathExists) {
  const home = typeof env?.HOME === "string" && isAbsolute(env.HOME) ? env.HOME : null;
  return [...new Set([
    typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME : null,
    typeof env?.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR : null,
    home ? join(home, ".codex") : null,
    home ? join(home, ".claude") : null,
  ])].filter((path) => path && isAbsolute(path) && pathExists(path));
}

function bwrapArgs({
  confinement,
  credential,
  file,
  args,
  cwd,
  env,
  pathExists,
}) {
  const wrapped = [
    "--die-with-parent",
    "--unshare-all",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
  ];
  if (credential !== "in-sandbox") {
    for (const path of credentialDirectories(env, pathExists)) {
      wrapped.push("--tmpfs", path, "--remount-ro", path);
    }
  }
  if (confinement === "sandboxed-write") {
    wrapped.push("--bind", cwd, cwd);
  }
  wrapped.push("--chdir", cwd, "--", file, ...args);
  return wrapped;
}

export function createBwrapBackend({
  file = "/usr/bin/bwrap",
  spawn = spawnSync,
  pathExists = existsSync,
} = {}) {
  return Object.freeze({
    id: "bwrap",
    version() {
      const result = commandResult(file, ["--version"], spawn);
      return result.status === 0 ? result.stdout || null : null;
    },
    probe() {
      if (process.platform !== "linux") {
        return {
          available: false,
          reason: "bubblewrap backend is Linux-only",
          evidence: { platform: process.platform, file },
        };
      }
      const result = commandResult(
        file,
        ["--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"],
        spawn,
      );
      return result.status === 0
        ? {
            available: true,
            reason: "bubblewrap unprivileged namespace probe succeeded",
            evidence: { file, status: result.status },
          }
        : {
            available: false,
            reason: bwrapRestrictionReason(result),
            evidence: {
              file,
              status: result.status,
              errorCode: result.error?.code ?? null,
              stderr: result.stderr.slice(0, 500),
            },
          };
    },
    wrap({ confinement, credential, file: childFile, args = [], cwd, env, brokerSocketPath }) {
      if (!sandboxEnforcesIsolation(confinement)) {
        return { file: childFile, args, env };
      }
      const wrappedEnv = credential === "in-sandbox" ? { ...(env || {}) } : withoutCredentials(env);
      return {
        file,
        args: bwrapArgs({
          confinement,
          credential,
          file: childFile,
          args: [...args],
          cwd,
          env,
          pathExists,
        }),
        env: wrappedEnv,
      };
    },
  });
}

export function createPodmanBackend({ file = "podman", spawn = spawnSync } = {}) {
  return Object.freeze({
    id: "podman",
    version() {
      const result = commandResult(file, ["--version"], spawn);
      return result.status === 0 ? result.stdout || null : null;
    },
    probe() {
      if (process.platform !== "linux") {
        return {
          available: false,
          reason: "podman backend is Linux-only",
          evidence: { platform: process.platform, file },
        };
      }
      const result = commandResult(file, ["info", "--format", "json"], spawn);
      if (result.status !== 0) {
        return {
          available: false,
          reason: `rootless podman probe failed: ${unavailableReason(result, "podman")}`,
          evidence: {
            file,
            status: result.status,
            errorCode: result.error?.code ?? null,
            stderr: result.stderr.slice(0, 500),
          },
        };
      }
      let info;
      try {
        info = JSON.parse(result.stdout);
      } catch (error) {
        return {
          available: false,
          reason: `podman info returned invalid JSON: ${error.message}`,
          evidence: { file, status: result.status },
        };
      }
      const rootless = info.host?.security?.rootless === true;
      const runtime = info.host?.ociRuntime?.name ?? null;
      const storageDriver = info.store?.graphDriverName ?? null;
      if (!rootless) {
        return {
          available: false,
          reason: "podman is available but is not running rootless",
          evidence: { file, rootless, runtime, storageDriver },
        };
      }
      return {
        available: true,
        reason: "rootless podman probe succeeded",
        evidence: { file, rootless, runtime, storageDriver },
      };
    },
    wrap({ confinement, credential, file: childFile, args = [], env }) {
      if (!sandboxEnforcesIsolation(confinement)) {
        return { file: childFile, args, env };
      }
      const error = new Error("podman sandbox wrap is not implemented");
      error.code = "EATELIER_SANDBOX_BACKEND_NOT_IMPLEMENTED";
      throw error;
    },
  });
}

export function createSandboxBackends(options = {}) {
  const backends = [createBwrapBackend(options.bwrap), createPodmanBackend(options.podman)];
  return new Map(backends.map((backend) => [backend.id, backend]));
}

export function sandboxBackend(backends, id) {
  const backend = backends?.get?.(id);
  if (backend) return backend;
  throw new Error(`Unknown sandbox backend: ${id}`);
}

function unavailable(backend, reason) {
  const error = new Error(`${SANDBOX_UNAVAILABLE}${backend.id}: ${reason}`);
  error.code = "EATELIER_SANDBOX_UNAVAILABLE";
  error.backendId = backend.id;
  return error;
}

function ensureAvailable(backend) {
  const probe = backend.probe();
  if (!probe || typeof probe.reason !== "string" || !probe.reason.trim()) {
    throw unavailable(backend, "backend probe returned no specific reason");
  }
  if (!probe.available) throw unavailable(backend, probe.reason);
  return probe;
}

function confinementShape(wrapped) {
  const separator = wrapped.args.indexOf("--");
  return {
    file: wrapped.file,
    args: separator >= 0 ? wrapped.args.slice(0, separator + 1) : [],
  };
}

export function sandboxArgvDigest(wrapped) {
  return createHash("sha256")
    .update(JSON.stringify(confinementShape(wrapped)))
    .digest("hex");
}

export function sandboxExecutionProfile({
  trustProfile,
  backend,
  cwd,
  env,
  brokerSocketPath,
}) {
  const profile = clonedProfile(trustProfile);
  if (!sandboxEnforcesIsolation(profile.confinement)) {
    return {
      ...profile,
      backendId: backend.id,
      backendVersion: backend.version(),
      argvDigest: null,
    };
  }
  ensureAvailable(backend);
  let wrapped;
  try {
    wrapped = backend.wrap({
      ...profile,
      file: "/bin/true",
      args: [],
      cwd,
      env,
      brokerSocketPath,
    });
  } catch (error) {
    throw unavailable(backend, error.message);
  }
  return {
    ...profile,
    backendId: backend.id,
    backendVersion: backend.version(),
    argvDigest: sandboxArgvDigest(wrapped),
  };
}

export function wrapSandboxSpawn({
  trustProfile,
  backend,
  file,
  args = [],
  options = {},
  brokerSocketPath,
}) {
  const profile = clonedProfile(trustProfile);
  if (!sandboxEnforcesIsolation(profile.confinement)) {
    return { file, args, options };
  }
  ensureAvailable(backend);
  let wrapped;
  try {
    wrapped = backend.wrap({
      ...profile,
      file,
      args,
      cwd: options.cwd,
      env: options.env,
      brokerSocketPath,
    });
  } catch (error) {
    throw unavailable(backend, error.message);
  }
  return {
    file: wrapped.file,
    args: wrapped.args,
    options: { ...options, env: wrapped.env },
  };
}
