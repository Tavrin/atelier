import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { killTracked, spawnTracked } from "../exec.mjs";
import {
  SANDBOX_NETWORK_INCOMPATIBLE,
  SANDBOX_UNSUPPORTED_PLATFORM,
  SANDBOX_UNAVAILABLE,
  assertSandboxProviderCompatible,
  createBwrapBackend,
  createPodmanBackend,
  sandboxArgvDigest,
  sandboxExecutionProfile,
  sandboxPlatformSupport,
  wrapSandboxSpawn,
} from "./sandbox.mjs";
import {
  createExecutionProfile,
  executionProfileMismatch,
} from "./execution-profile.mjs";

const sandboxedWrite = Object.freeze({
  confinement: "sandboxed-write",
  credential: "none",
});

function result({ status = 0, stdout = "", stderr = "", error } = {}) {
  return { status, stdout, stderr, error };
}

test("bwrap probe names unprivileged namespace restrictions and wrap is pure", () => {
  const calls = [];
  const backend = createBwrapBackend({
    file: "/fixture/bwrap",
    spawn(file, args) {
      calls.push({ file, args });
      if (args[0] === "--version") return result({ stdout: "bubblewrap 0.10.0\n" });
      return result({ status: 1, stderr: "apparmor denied unprivileged user namespace" });
    },
  });
  const probe = backend.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /unprivileged user namespace restriction.*apparmor/i);
  assert.equal(backend.version(), "bubblewrap 0.10.0");

  const args = ["--flag", "value"];
  const env = { HOME: "/home/operator", ACCESS_TOKEN: "secret", SAFE: "yes" };
  const wrapped = backend.wrap({
    ...sandboxedWrite,
    file: "/usr/bin/provider",
    args,
    cwd: "/workspace",
    env,
  });
  assert.deepEqual(args, ["--flag", "value"]);
  assert.deepEqual(env, { HOME: "/home/operator", ACCESS_TOKEN: "secret", SAFE: "yes" });
  assert.equal(wrapped.file, "/fixture/bwrap");
  assert.equal(wrapped.env.ACCESS_TOKEN, undefined);
  assert.equal(wrapped.env.HOME, "/home/operator");
  assert.deepEqual(wrapped.args.slice(-4), ["--", "/usr/bin/provider", "--flag", "value"]);
  assert.ok(wrapped.args.includes("--unshare-all"));
  assert.ok(wrapped.args.includes("--die-with-parent"));
  assert.deepEqual(
    wrapped.args.filter((value, index) => wrapped.args[index - 1] === "--tmpfs"),
    ["/home/operator", `/run/user/${process.getuid()}`, "/tmp"],
  );
  assert.ok(calls[0].args.includes("--proc"), "probe omitted the production /proc construction");
  assert.ok(calls[0].args.includes("--bind"), "probe omitted the production writable bind");
  assert.ok(calls[0].args.includes("--tmpfs"), "probe omitted the credential/user-tree masks");
  assert.ok(calls.length >= 2);
});

test("credential containment masks user trees and restores only operator-owned bindings", () => {
  const backend = createBwrapBackend({
    file: "/fixture/bwrap",
    homePath: "/home/operator",
    uid: 1234,
  });
  const inputEnv = {
    HOME: "/home/operator",
    SSH_AUTH_SOCK: "/run/user/1234/agent.sock",
    GPG_AGENT_INFO: "/tmp/gpg-agent",
    DB_PASSWD: "secret",
    MONKEY: "secret",
    TOKENIZER: "secret",
    SAFE: "yes",
  };
  const wrapped = backend.wrap({
    confinement: "sandboxed-write",
    credential: "none",
    file: "/provider",
    args: [],
    cwd: "/workspace",
    env: inputEnv,
    operatorBindings: ["/operator/provider-runtime"],
  });
  for (const key of ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DB_PASSWD", "MONKEY", "TOKENIZER"]) {
    assert.equal(wrapped.env[key], undefined, key);
  }
  assert.equal(wrapped.env.SAFE, "yes");
  assert.deepEqual(
    wrapped.args.filter((value, index) => wrapped.args[index - 1] === "--tmpfs"),
    ["/home/operator", "/run/user/1234", "/tmp"],
  );
  const bindingIndex = wrapped.args.indexOf("/operator/provider-runtime");
  assert.equal(wrapped.args[bindingIndex - 1], "--ro-bind");

  const inSandbox = backend.wrap({
    confinement: "sandboxed-write",
    credential: "in-sandbox",
    file: "/provider",
    args: [],
    cwd: "/workspace",
    env: inputEnv,
    operatorBindings: ["/operator/credential"],
  });
  assert.equal(inSandbox.env.DB_PASSWD, "secret");
  assert.ok(inSandbox.args.includes("/operator/credential"));
  assert.ok(inSandbox.args.includes("/home/operator"), "in-sandbox lost the tmpfs default");
});

test("trusted-local and advisory never claim or construct isolation", () => {
  const backend = createBwrapBackend({
    spawn: () => result({ status: 1, stderr: "must not be consulted" }),
  });
  for (const confinement of ["trusted-local", "advisory"]) {
    const args = ["arg"];
    const env = { HOME: "/home/operator" };
    const wrapped = backend.wrap({
      confinement,
      credential: "none",
      file: "provider",
      args,
      cwd: "/workspace",
      env,
    });
    assert.equal(wrapped.file, "provider");
    assert.equal(wrapped.args, args);
    assert.equal(wrapped.env, env);
  }
});

test("recording backend proves the caller contract without bwrap concepts", () => {
  const calls = [];
  const backend = {
    id: "recording",
    version: () => "recording 1",
    probe: () => ({
      available: true,
      reason: "recording backend ready",
      evidence: { lifecycle: "recorded" },
    }),
    wrap(input) {
      calls.push(structuredClone(input));
      return { file: "recording-run", args: ["boundary", "--", input.file, ...input.args], env: { ...input.env } };
    },
  };
  const input = {
    trustProfile: sandboxedWrite,
    backend,
    cwd: "/workspace",
    env: { SAFE: "yes" },
  };
  const profile = sandboxExecutionProfile(input);
  assert.equal(profile.backendId, "recording");
  assert.equal(profile.backendVersion, "recording 1");
  assert.match(profile.argvDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(calls).includes("unshare"), false);
  assert.deepEqual(input.env, { SAFE: "yes" });
});

test("unavailable and available-but-unimplemented backends both fail closed before spawn", () => {
  let spawned = false;
  const unavailable = {
    id: "fixture",
    version: () => "1",
    probe: () => ({ available: false, reason: "fixture namespace denied", evidence: {} }),
    wrap() {
      throw new Error("must not wrap");
    },
  };
  assert.throws(
    () => wrapSandboxSpawn({
      trustProfile: sandboxedWrite,
      backend: unavailable,
      file: "provider",
      args: [],
      options: { cwd: "/workspace", env: {} },
      spawn: () => { spawned = true; },
    }),
    (error) =>
      error.code === "EATELIER_SANDBOX_UNAVAILABLE" &&
      error.message === `${SANDBOX_UNAVAILABLE}fixture: fixture namespace denied`,
  );
  assert.equal(spawned, false);

  const podman = createPodmanBackend({
    spawn(_file, args) {
      if (args[0] === "--version") return result({ stdout: "podman version 4.9.3\n" });
      return result({
        stdout: JSON.stringify({
          host: { security: { rootless: true }, ociRuntime: { name: "runc" } },
          store: { graphDriverName: "overlay" },
        }),
      });
    },
  });
  assert.deepEqual(podman.probe(), {
    available: true,
    reason: "rootless podman probe succeeded",
    evidence: {
      file: "podman",
      rootless: true,
      runtime: "runc",
      storageDriver: "overlay",
    },
  });
  assert.throws(
    () => sandboxExecutionProfile({
      trustProfile: sandboxedWrite,
      backend: podman,
      cwd: "/workspace",
      env: {},
    }),
    /EATELIER_SANDBOX_UNAVAILABLE: podman: podman sandbox wrap is not implemented/,
  );
});

test("real podman probe reports rootless details or a specific host refusal", () => {
  const backend = createPodmanBackend();
  const probe = backend.probe();
  assert.equal(typeof probe.available, "boolean");
  assert.ok(probe.reason.length > 10, "podman probe reason must be specific");
  assert.equal(typeof probe.evidence, "object");
  if (probe.available) {
    assert.equal(probe.evidence.rootless, true);
    assert.equal(typeof probe.evidence.runtime, "string");
    assert.equal(typeof probe.evidence.storageDriver, "string");
  } else {
    assert.match(probe.reason, /podman|rootless/i);
    assert.ok(
      probe.evidence.stderr || probe.evidence.errorCode,
      "an unavailable real probe must retain diagnostic evidence",
    );
  }
});

test("sandbox execution-profile comparison is pinned and legacy guarded", () => {
  const base = createExecutionProfile({
    agentLane: "claude",
    command: "claude",
    env: { PATH: "/usr/bin", HOME: "/home/operator" },
    sandbox: {
      confinement: "sandboxed-write",
      credential: "none",
      backendId: "bwrap",
      backendVersion: "bubblewrap 0.10.0",
      argvDigest: "a".repeat(64),
    },
  });
  const weakened = structuredClone(base);
  weakened.sandbox.confinement = "trusted-local";
  weakened.sandbox.argvDigest = null;
  assert.match(
    executionProfileMismatch(base, weakened, { sandbox: true }),
    /sandbox\.confinement.*sandbox\.argvDigest/,
  );
  const legacy = structuredClone(base);
  delete legacy.sandbox;
  assert.equal(executionProfileMismatch(legacy, weakened, { sandbox: true }), null);
});

test("argvDigest changes for every claimed security control without persisting env values", () => {
  const base = {
    file: "/usr/bin/bwrap",
    args: ["--die-with-parent", "--unshare-all", "--", "/provider", "secret-argument"],
    env: { SAFE: "not-persisted" },
    security: {
      environmentKeys: ["HOME", "SAFE"],
      processGroupPosture: "atelier-reaped-process-group",
      writableRoots: ["/worktree/a"],
      readOnlyRoots: [],
    },
  };
  const digest = sandboxArgvDigest(base);
  for (const weakened of [
    { ...base, args: ["--unshare-all", "--", "/provider"] },
    { ...base, security: { ...base.security, environmentKeys: [...base.security.environmentKeys, "ACCESS_TOKEN"] } },
    { ...base, security: { ...base.security, processGroupPosture: "untracked" } },
    { ...base, security: { ...base.security, writableRoots: ["/worktree/b"] } },
  ]) {
    assert.notEqual(sandboxArgvDigest(weakened), digest);
  }
  assert.equal(JSON.stringify(base).includes("not-persisted"), true);
  assert.equal(JSON.stringify({ digest }).includes("not-persisted"), false);
});

test("network-dependent providers and unsupported platforms refuse with distinct named errors", () => {
  assert.throws(
    () => assertSandboxProviderCompatible({
      trustProfile: sandboxedWrite,
      providerId: "claude",
      networkAccess: "required",
    }),
    (error) => error.code === "EATELIER_SANDBOX_NETWORK_INCOMPATIBLE" &&
      error.message.startsWith(SANDBOX_NETWORK_INCOMPATIBLE),
  );
  assert.deepEqual(sandboxPlatformSupport("darwin"), {
    supported: false,
    platform: "darwin",
    reason: "no sandbox backend exists for darwin",
  });
  const backend = createBwrapBackend({ platform: "darwin" });
  assert.throws(
    () => wrapSandboxSpawn({
      trustProfile: sandboxedWrite,
      backend,
      file: "/provider",
      options: { cwd: "/workspace", env: {} },
    }),
    (error) => error.code === "EATELIER_SANDBOX_UNSUPPORTED_PLATFORM" &&
      error.message === `${SANDBOX_UNSUPPORTED_PLATFORM}no sandbox backend exists for darwin`,
  );
});

test("bounded backend caching never reuses availability at the actual spawn boundary", () => {
  const state = { available: true, probes: 0, versions: 0 };
  const backend = {
    id: "fixture",
    version() {
      state.versions += 1;
      return "fixture 1";
    },
    probe() {
      state.probes += 1;
      return {
        available: state.available,
        reason: state.available ? "fixture ready" : "fixture disappeared",
        evidence: {},
      };
    },
    wrap(input) {
      return { file: input.file, args: [...input.args], env: { ...input.env } };
    },
  };
  sandboxExecutionProfile({ trustProfile: sandboxedWrite, backend, cwd: "/workspace", env: {} });
  sandboxExecutionProfile({ trustProfile: sandboxedWrite, backend, cwd: "/workspace", env: {} });
  assert.equal(state.probes, 1, "profile construction did not reuse its bounded cache");
  assert.equal(state.versions, 1, "backend version was synchronously repeated");
  state.available = false;
  assert.throws(
    () => wrapSandboxSpawn({
      trustProfile: sandboxedWrite,
      backend,
      file: "/provider",
      options: { cwd: "/workspace", env: {} },
    }),
    /EATELIER_SANDBOX_UNAVAILABLE: fixture: fixture disappeared/,
  );
  assert.equal(state.probes, 2, "spawn reused stale positive availability");
});

test("bwrap remains the tracked process-group leader reaped by killTracked", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap backend is Linux-only");
    return;
  }
  const backend = createBwrapBackend();
  const probe = backend.probe();
  if (!probe.available) {
    t.skip(probe.reason);
    return;
  }
  const wrapped = wrapSandboxSpawn({
    trustProfile: sandboxedWrite,
    backend,
    file: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    options: { cwd: process.cwd(), env: process.env, stdio: "ignore" },
    operatorBindings: [process.execPath],
  });
  const child = spawnTracked(wrapped.file, wrapped.args, wrapped.options);
  const exited = once(child, "exit");
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) killTracked(child, "SIGKILL");
  });
  assert.ok(child.pid > 0);
  process.kill(-child.pid, 0);
  killTracked(child);
  await exited;
  assert.notEqual(child.signalCode, null);
});

test("real bwrap enforcement limits writes to the worktree and makes review worktrees read-only", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap backend is Linux-only");
    return;
  }
  const backend = createBwrapBackend();
  const probe = backend.probe();
  if (!probe.available) {
    t.skip(probe.reason);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "atelier-sandbox-enforcement-"));
  const worktree = join(root, "worktree");
  const scratch = join(root, "scratch");
  const outside = join(root, "outside.txt");
  const inside = join(worktree, "inside.txt");
  await mkdir(worktree);
  await mkdir(scratch);
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = (confinement, target, sandboxOptions = {}) => {
    const wrapped = wrapSandboxSpawn({
      trustProfile: { confinement, credential: "none" },
      backend,
      file: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'written')",
        target,
      ],
      options: { cwd: worktree, env: process.env },
      operatorBindings: [process.execPath],
      ...sandboxOptions,
    });
    return spawnSync(wrapped.file, wrapped.args, {
      ...wrapped.options,
      encoding: "utf8",
    });
  };

  assert.equal(run("sandboxed-write", inside).status, 0);
  assert.equal(await readFile(inside, "utf8"), "written");
  run("sandboxed-write", outside);
  assert.equal(existsSync(outside), false, "ephemeral /tmp write reached the host");
  await writeFile(inside, "baseline");
  assert.notEqual(run("sandboxed-review-readonly", inside).status, 0);
  assert.equal(await readFile(inside, "utf8"), "baseline");
  assert.notEqual(run("sandboxed-write", inside, {
    writableRoots: [scratch],
    readOnlyRoots: [worktree],
  }).status, 0, "verification made its tested checkout writable");
  const scratchFile = join(scratch, "cache.txt");
  assert.equal(run("sandboxed-write", scratchFile, {
    writableRoots: [scratch],
    readOnlyRoots: [worktree],
  }).status, 0, "verification scratch was not writable");
  assert.equal(await readFile(scratchFile, "utf8"), "written");
});
