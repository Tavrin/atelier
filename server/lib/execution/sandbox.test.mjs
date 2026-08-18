import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { killTracked, spawnTracked } from "../exec.mjs";
import {
  SANDBOX_UNAVAILABLE,
  createBwrapBackend,
  createPodmanBackend,
  sandboxExecutionProfile,
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
  assert.equal(wrapped.env.HOME, "/nonexistent");
  assert.deepEqual(wrapped.args.slice(-4), ["--", "/usr/bin/provider", "--flag", "value"]);
  assert.ok(wrapped.args.includes("--unshare-all"));
  assert.ok(calls.length >= 2);
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
  const outside = join(root, "outside.txt");
  const inside = join(worktree, "inside.txt");
  await mkdir(worktree);
  t.after(() => rm(root, { recursive: true, force: true }));

  const run = (confinement, target) => {
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
    });
    return spawnSync(wrapped.file, wrapped.args, {
      ...wrapped.options,
      encoding: "utf8",
    });
  };

  assert.equal(run("sandboxed-write", inside).status, 0);
  assert.equal(await readFile(inside, "utf8"), "written");
  assert.notEqual(run("sandboxed-write", outside).status, 0);
  assert.notEqual(run("sandboxed-review-readonly", inside).status, 0);
});
