import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { isSecretEnvKey } from "./secret-environment.mjs";

export const SANDBOX_UNAVAILABLE = "EATELIER_SANDBOX_UNAVAILABLE: ";
export const SANDBOX_UNSUPPORTED_PLATFORM = "EATELIER_SANDBOX_UNSUPPORTED_PLATFORM: ";
export const SANDBOX_NETWORK_INCOMPATIBLE = "EATELIER_SANDBOX_NETWORK_INCOMPATIBLE: ";
export const SANDBOX_LEGACY_COMPANION_INCOMPATIBLE =
  "EATELIER_SANDBOX_LEGACY_COMPANION_INCOMPATIBLE: ";
export const VERIFICATION_READONLY_TREE = "EATELIER_VERIFICATION_READONLY_TREE: ";
export const SANDBOX_PROCESS_GROUP_POSTURE = "atelier-reaped-process-group";

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

const BACKEND_CACHE_TTL_MS = 1_000;
const backendCache = new WeakMap();

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

export function resolveSandboxBindings(defaults = {}, providerId, credential) {
  const paths = defaults.sandboxBindings?.[providerId]?.[credential] ?? [];
  return absolutePaths(paths, `defaults.sandboxBindings.${providerId}.${credential}`);
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
    if (isSecretEnvKey(key)) delete filtered[key];
  }
  delete filtered.CODEX_HOME;
  delete filtered.CLAUDE_CONFIG_DIR;
  return filtered;
}

function absolutePaths(paths, label) {
  if (!Array.isArray(paths)) throw new Error(`${label} must be an array`);
  return [...new Set(paths.map((path) => {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
      throw new Error(`${label} entries must be absolute paths without NUL`);
    }
    return resolve(path);
  }))].sort();
}

function userTreeMasks(env, { homePath = homedir(), uid = process.getuid?.() } = {}) {
  const home = typeof env?.HOME === "string" && isAbsolute(env.HOME)
    ? resolve(env.HOME)
    : resolve(homePath);
  const runtime = Number.isInteger(uid) && uid >= 0 ? `/run/user/${uid}` : null;
  return [...new Set([home, runtime, "/tmp"].filter(Boolean))];
}

function pathInside(parent, candidate) {
  const segment = relative(resolve(parent), resolve(candidate));
  return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
}

function assertWritableRootsDoNotOverlapReadOnly(writableRoots, readOnlyRoots) {
  for (const writable of writableRoots) {
    for (const readOnly of readOnlyRoots) {
      if (pathInside(readOnly, writable) || pathInside(writable, readOnly)) {
        const error = new Error(
          `${VERIFICATION_READONLY_TREE}${readOnly} cannot overlap writable root ${writable}`,
        );
        error.code = "EATELIER_VERIFICATION_READONLY_TREE";
        throw error;
      }
    }
  }
}

function effectiveWritableRoots(confinement, cwd, writableRoots) {
  if (writableRoots !== undefined) return absolutePaths(writableRoots, "writableRoots");
  return confinement === "sandboxed-write" ? absolutePaths([cwd], "writableRoots") : [];
}

function bwrapArgs({
  confinement,
  file,
  args,
  cwd,
  env,
  operatorBindings = [],
  writableRoots,
  readOnlyRoots,
  homePath,
  uid,
}) {
  const writable = effectiveWritableRoots(confinement, cwd, writableRoots);
  const readOnly = readOnlyRoots === undefined
    ? (confinement === "sandboxed-review-readonly"
        ? absolutePaths([cwd], "readOnlyRoots")
        : [])
    : absolutePaths(readOnlyRoots, "readOnlyRoots");
  const bindings = absolutePaths(operatorBindings, "operatorBindings");
  assertWritableRootsDoNotOverlapReadOnly(writable, readOnly);
  const wrapped = [
    "--die-with-parent",
    "--unshare-all",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
  ];
  for (const path of userTreeMasks(env, { homePath, uid })) {
    wrapped.push("--tmpfs", path);
  }
  for (const path of bindings) {
    wrapped.push("--ro-bind", path, path);
  }
  for (const path of readOnly) {
    wrapped.push("--ro-bind", path, path);
  }
  for (const path of writable) {
    wrapped.push("--bind", path, path);
  }
  wrapped.push("--chdir", cwd, "--", file, ...args);
  return { args: wrapped, writableRoots: writable, readOnlyRoots: readOnly };
}

export function createBwrapBackend({
  file = "/usr/bin/bwrap",
  spawn = spawnSync,
  platform = process.platform,
  homePath = homedir(),
  uid = process.getuid?.(),
} = {}) {
  return Object.freeze({
    id: "bwrap",
    version() {
      const result = commandResult(file, ["--version"], spawn);
      return result.status === 0 ? result.stdout || null : null;
    },
    probe() {
      if (platform !== "linux") {
        return {
          available: false,
          unsupportedPlatform: true,
          reason: `no sandbox backend exists for ${platform}`,
          evidence: { platform, file },
        };
      }
      const construction = bwrapArgs({
        confinement: "sandboxed-write",
        file: "/bin/true",
        args: [],
        cwd: process.cwd(),
        env: process.env,
        writableRoots: [process.cwd()],
        homePath,
        uid,
      });
      const result = commandResult(
        file,
        construction.args,
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
    wrap({
      confinement,
      credential,
      file: childFile,
      args = [],
      cwd,
      env,
      operatorBindings = [],
      writableRoots,
      readOnlyRoots,
      processGroupPosture = SANDBOX_PROCESS_GROUP_POSTURE,
    }) {
      if (!sandboxEnforcesIsolation(confinement)) {
        return { file: childFile, args, env };
      }
      const wrappedEnv = credential === "in-sandbox" ? { ...(env || {}) } : withoutCredentials(env);
      const construction = bwrapArgs({
        confinement,
        file: childFile,
        args: [...args],
        cwd,
        env,
        operatorBindings,
        writableRoots,
        readOnlyRoots,
        homePath,
        uid,
      });
      return {
        file,
        args: construction.args,
        env: wrappedEnv,
        security: {
          environmentKeys: Object.keys(wrappedEnv).sort(),
          processGroupPosture,
          writableRoots: construction.writableRoots,
          readOnlyRoots: construction.readOnlyRoots,
        },
      };
    },
  });
}

export function createPodmanBackend({
  file = "podman",
  spawn = spawnSync,
  platform = process.platform,
} = {}) {
  return Object.freeze({
    id: "podman",
    version() {
      const result = commandResult(file, ["--version"], spawn);
      return result.status === 0 ? result.stdout || null : null;
    },
    probe() {
      if (platform !== "linux") {
        return {
          available: false,
          unsupportedPlatform: true,
          reason: `no sandbox backend exists for ${platform}`,
          evidence: { platform, file },
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

function unsupportedPlatform(backend, probe) {
  const platform = probe?.evidence?.platform ?? process.platform;
  const reason = probe?.reason || `no sandbox backend exists for ${platform}`;
  const error = new Error(`${SANDBOX_UNSUPPORTED_PLATFORM}${reason}`);
  error.code = "EATELIER_SANDBOX_UNSUPPORTED_PLATFORM";
  error.backendId = backend.id;
  error.platform = platform;
  return error;
}

function cacheFor(backend) {
  let cached = backendCache.get(backend);
  if (!cached) {
    cached = {};
    backendCache.set(backend, cached);
  }
  return cached;
}

function cachedBackendVersion(backend, now = Date.now()) {
  const cached = cacheFor(backend);
  if (cached.versionAt !== undefined && now - cached.versionAt < BACKEND_CACHE_TTL_MS) {
    return cached.version;
  }
  cached.version = backend.version();
  cached.versionAt = now;
  return cached.version;
}

function cachedBackendProbe(backend, { fresh = false, now = Date.now() } = {}) {
  const cached = cacheFor(backend);
  if (!fresh && cached.probeAt !== undefined && now - cached.probeAt < BACKEND_CACHE_TTL_MS) {
    return cached.probe;
  }
  cached.probe = backend.probe();
  cached.probeAt = now;
  return cached.probe;
}

function ensureAvailable(backend, { fresh = false } = {}) {
  const probe = cachedBackendProbe(backend, { fresh });
  if (!probe || typeof probe.reason !== "string" || !probe.reason.trim()) {
    throw unavailable(backend, "backend probe returned no specific reason");
  }
  if (probe.unsupportedPlatform === true) throw unsupportedPlatform(backend, probe);
  if (!probe.available) throw unavailable(backend, probe.reason);
  return probe;
}

function confinementShape(wrapped) {
  const separator = wrapped.args.indexOf("--");
  return {
    file: wrapped.file,
    args: separator >= 0 ? wrapped.args.slice(0, separator + 1) : [],
    environmentKeys: wrapped.security?.environmentKeys ?? Object.keys(wrapped.env || {}).sort(),
    processGroupPosture: wrapped.security?.processGroupPosture ?? null,
    writableRoots: wrapped.security?.writableRoots ?? [],
    readOnlyRoots: wrapped.security?.readOnlyRoots ?? [],
  };
}

function withSecurityShape(wrapped, {
  confinement,
  cwd,
  processGroupPosture,
  writableRoots,
  readOnlyRoots,
}) {
  const writable = wrapped.security?.writableRoots ??
    effectiveWritableRoots(confinement, cwd, writableRoots);
  const readOnly = wrapped.security?.readOnlyRoots ??
    (readOnlyRoots === undefined && confinement === "sandboxed-review-readonly"
      ? absolutePaths([cwd], "readOnlyRoots")
      : absolutePaths(readOnlyRoots ?? [], "readOnlyRoots"));
  return {
    ...wrapped,
    security: {
      environmentKeys: wrapped.security?.environmentKeys ?? Object.keys(wrapped.env || {}).sort(),
      processGroupPosture: wrapped.security?.processGroupPosture ?? processGroupPosture,
      writableRoots: writable,
      readOnlyRoots: readOnly,
    },
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
  operatorBindings = [],
  processGroupPosture = SANDBOX_PROCESS_GROUP_POSTURE,
}) {
  const profile = clonedProfile(trustProfile);
  if (!sandboxEnforcesIsolation(profile.confinement)) {
    return {
      ...profile,
      backendId: backend.id,
      backendVersion: cachedBackendVersion(backend),
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
      operatorBindings,
      processGroupPosture,
    });
    wrapped = withSecurityShape(wrapped, {
      confinement: profile.confinement,
      cwd,
      processGroupPosture,
    });
  } catch (error) {
    if (error?.code === "EATELIER_VERIFICATION_READONLY_TREE") throw error;
    throw unavailable(backend, error.message);
  }
  return {
    ...profile,
    backendId: backend.id,
    backendVersion: cachedBackendVersion(backend),
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
  operatorBindings = [],
  writableRoots,
  readOnlyRoots = [],
  processGroupPosture = SANDBOX_PROCESS_GROUP_POSTURE,
}) {
  const profile = clonedProfile(trustProfile);
  if (!sandboxEnforcesIsolation(profile.confinement)) {
    return { file, args, options };
  }
  // A fresh probe is mandatory at the actual spawn boundary. Profile creation
  // may reuse the immediately preceding bounded cache entry, but can never make
  // a disappeared backend look available here.
  ensureAvailable(backend, { fresh: true });
  let wrapped;
  try {
    wrapped = backend.wrap({
      ...profile,
      file,
      args,
      cwd: options.cwd,
      env: options.env,
      brokerSocketPath,
      operatorBindings,
      writableRoots,
      readOnlyRoots,
      processGroupPosture,
    });
  } catch (error) {
    if (error?.code === "EATELIER_VERIFICATION_READONLY_TREE") throw error;
    throw unavailable(backend, error.message);
  }
  return {
    file: wrapped.file,
    args: wrapped.args,
    options: { ...options, env: wrapped.env },
  };
}

export function assertSandboxProviderCompatible({
  trustProfile,
  providerId,
  networkAccess,
  legacyCompanion = false,
}) {
  const profile = clonedProfile(trustProfile);
  if (!sandboxEnforcesIsolation(profile.confinement)) return;
  if (legacyCompanion) {
    const error = new Error(
      `${SANDBOX_LEGACY_COMPANION_INCOMPATIBLE}legacy Codex companion cannot run under ${profile.confinement}`,
    );
    error.code = "EATELIER_SANDBOX_LEGACY_COMPANION_INCOMPATIBLE";
    throw error;
  }
  if (networkAccess === "required") {
    const error = new Error(
      `${SANDBOX_NETWORK_INCOMPATIBLE}${providerId} requires provider network access, but ${profile.confinement} denies network and the slice-2 broker is not available`,
    );
    error.code = "EATELIER_SANDBOX_NETWORK_INCOMPATIBLE";
    throw error;
  }
}

export function sandboxPlatformSupport(platform = process.platform) {
  return platform === "linux"
    ? { supported: true, platform, reason: "Linux sandbox backends are available" }
    : { supported: false, platform, reason: `no sandbox backend exists for ${platform}` };
}
