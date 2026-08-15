import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { installService, renderServiceUnit, restartServiceSafely, windowsTaskArgs } from "./service.mjs";

const nodePath = "/opt/node/bin/node";
const scriptPath = "/opt/atelier/bin/atelier.mjs";

test("renderServiceUnit produces the systemd user unit", () => {
  const unit = renderServiceUnit({ nodePath, scriptPath });
  assert.equal(
    unit,
    [
      "[Unit]",
      "Description=Atelier agent cockpit",
      "",
      "[Service]",
      "Environment=PATH=/opt/node/bin:%h/.local/bin:%h/.cargo/bin:/usr/local/bin:/usr/bin:/bin",
      `ExecStart=${nodePath} ${scriptPath} serve`,
      "KillMode=process",
      "TimeoutStopSec=20",
      "Restart=on-failure",
      "RestartSec=3",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
});

test("renderServiceUnit never uses KillMode=mixed - it would SIGKILL a detached codex worker", () => {
  // KillMode=mixed SIGTERMs the main process but still SIGKILLs every other
  // process left in the unit's control group (systemd.kill(5)), which
  // includes a companion worker Atelier deliberately left running for boot
  // reattach. Only KillMode=process leaves the rest of the cgroup alone.
  assert.doesNotMatch(renderServiceUnit({ nodePath, scriptPath }), /KillMode=mixed/);
  assert.match(renderServiceUnit({ nodePath, scriptPath }), /^KillMode=process$/m);
});

test("installService writes and enables the Linux systemd user unit in order", async () => {
  const calls = [];
  const output = [];
  await installService({
    platform: "linux",
    nodePath,
    scriptPath,
    homePath: "/home/fixture",
    username: "fixture",
    makeDirectory: async (...args) => calls.push(["mkdir", ...args]),
    writeText: async (...args) => calls.push(["write", ...args]),
    removeFile: async (...args) => calls.push(["remove", ...args]),
    fileExists: async () => false,
    runner: async (...args) => calls.push(["run", ...args]),
    print: (line) => output.push(line),
  });

  const unitPath = join("/home/fixture", ".config", "systemd", "user", "atelier.service");
  assert.deepEqual(calls, [
    ["mkdir", join("/home/fixture", ".config", "systemd", "user"), { recursive: true }],
    ["write", unitPath, renderServiceUnit({ nodePath, scriptPath }), "utf8"],
    ["run", "systemctl", ["--user", "daemon-reload"]],
    ["run", "systemctl", ["--user", "enable", "--now", "atelier.service"]],
  ]);
  assert.deepEqual(output, [
    `Installed ${unitPath}`,
    "For boot-without-login persistence, run: loginctl enable-linger fixture",
  ]);
});

test("installService removes the Linux unit when enabling fails", async () => {
  const removed = [];
  await assert.rejects(
    installService({
      platform: "linux",
      nodePath,
      scriptPath,
      homePath: "/home/fixture",
      makeDirectory: async () => {},
      writeText: async () => {},
      removeFile: async (path) => removed.push(path),
      fileExists: async () => false,
      runner: async (_file, args) => {
        if (args.includes("enable")) throw new Error("enable denied");
      },
      print: () => {},
    }),
    /Service installation failed: enable denied/,
  );
  assert.deepEqual(removed, [
    join("/home/fixture", ".config", "systemd", "user", "atelier.service"),
  ]);
});

test("installService dry-run prints Linux content without writes or commands", async () => {
  const output = [];
  let touched = false;
  await installService({
    platform: "linux",
    nodePath,
    scriptPath,
    homePath: "/home/fixture",
    dryRun: true,
    makeDirectory: async () => {
      touched = true;
    },
    writeText: async () => {
      touched = true;
    },
    runner: async () => {
      touched = true;
    },
    print: (line) => output.push(line),
  });
  assert.equal(touched, false);
  assert.deepEqual(output, [renderServiceUnit({ nodePath, scriptPath })]);
});

test("installService overwrites an existing Linux unit WITHOUT restarting it (atelier-tzw constraint 3)", async () => {
  const calls = [];
  const output = [];
  await installService({
    platform: "linux",
    nodePath,
    scriptPath,
    homePath: "/home/fixture",
    username: "fixture",
    makeDirectory: async (...args) => calls.push(["mkdir", ...args]),
    writeText: async (...args) => calls.push(["write", ...args]),
    removeFile: async (...args) => calls.push(["remove", ...args]),
    fileExists: async () => true,
    runner: async (...args) => calls.push(["run", ...args]),
    print: (line) => output.push(line),
  });

  const unitPath = join("/home/fixture", ".config", "systemd", "user", "atelier.service");
  // daemon-reload only reloads unit FILE definitions - it never touches a
  // running instance, so applying a unit change (e.g. picking up
  // KillMode=process) must never itself restart a server that may have
  // active dispatches. The human/doctor applies it via --safe-restart.
  assert.deepEqual(calls, [
    ["mkdir", join("/home/fixture", ".config", "systemd", "user"), { recursive: true }],
    ["write", unitPath, renderServiceUnit({ nodePath, scriptPath }), "utf8"],
    ["run", "systemctl", ["--user", "daemon-reload"]],
  ]);
  assert.deepEqual(output, [
    `Updated ${unitPath}`,
    "Unit change staged but NOT activated - run: atelier doctor --safe-restart",
    "For boot-without-login persistence, run: loginctl enable-linger fixture",
  ]);
});

test("installService registers an ONLOGON Windows task with argv", async () => {
  const calls = [];
  await installService({
    platform: "win32",
    nodePath: "C:\\Node\\node.exe",
    scriptPath: "C:\\Atelier\\bin\\atelier.mjs",
    runner: async (...args) => calls.push(args),
    print: () => {},
  });
  assert.deepEqual(calls, [
    [
      "schtasks",
      windowsTaskArgs({
        nodePath: "C:\\Node\\node.exe",
        scriptPath: "C:\\Atelier\\bin\\atelier.mjs",
      }),
    ],
  ]);
});

function fakeJsonResponse(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

function fakeFetcher(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      const next = responses.shift();
      if (!next) throw new Error("fakeFetcher: no response queued");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("restartServiceSafely refuses on non-Linux platforms", async () => {
  await assert.rejects(restartServiceSafely({ platform: "win32" }), /not supported on win32/);
});

test("restartServiceSafely refuses when atelier.service is not reachable", async () => {
  const { fetch } = fakeFetcher([new Error("connect ECONNREFUSED")]);
  await assert.rejects(
    restartServiceSafely({
      platform: "linux",
      fetcher: fetch,
      runner: async () => {
        throw new Error("must not run systemctl when the service is unreachable");
      },
    }),
    /not reachable.*ECONNREFUSED/,
  );
});

test("restartServiceSafely refuses and never restarts when the drain lease reports active dispatches", async () => {
  const { fetch, calls } = fakeFetcher([
    fakeJsonResponse(409, { error: "Refusing drain lease: 1 active dispatch (abc123)" }),
  ]);
  let ran = false;
  await assert.rejects(
    restartServiceSafely({
      platform: "linux",
      fetcher: fetch,
      runner: async () => {
        ran = true;
      },
    }),
    /Refusing restart: Refusing drain lease: 1 active dispatch/,
  );
  assert.equal(ran, false);
  assert.equal(calls.length, 1);
});

test("restartServiceSafely acquires the drain lease and restarts atelier.service when idle", async () => {
  const { fetch, calls } = fakeFetcher([
    fakeJsonResponse(200, { token: "lease-token", expiresAt: "2026-07-30T00:00:10.000Z" }),
  ]);
  const runnerCalls = [];
  const output = [];
  const result = await restartServiceSafely({
    platform: "linux",
    fetcher: fetch,
    runner: async (...args) => {
      runnerCalls.push(args);
    },
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { dryRun: false });
  assert.deepEqual(runnerCalls, [["systemctl", ["--user", "restart", "atelier.service"]]]);
  // No release call: a successful restart tears down the in-memory lease
  // along with the rest of the old process's state, same as any other
  // dispatcher state.
  assert.equal(calls.length, 1);
  assert.deepEqual(output, ["Restarted atelier.service safely (no active dispatches)"]);
});

test("restartServiceSafely dry-run checks and releases the lease without restarting", async () => {
  const { fetch, calls } = fakeFetcher([
    fakeJsonResponse(200, { token: "lease-token", expiresAt: "2026-07-30T00:00:10.000Z" }),
    fakeJsonResponse(200, { released: true }),
  ]);
  let ran = false;
  const output = [];
  const result = await restartServiceSafely({
    platform: "linux",
    dryRun: true,
    fetcher: fetch,
    runner: async () => {
      ran = true;
    },
    print: (line) => output.push(line),
  });
  assert.deepEqual(result, { dryRun: true });
  assert.equal(ran, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { token: "lease-token" });
  assert.deepEqual(output, ["Safe to restart atelier.service: no active dispatches"]);
});

test("restartServiceSafely releases the lease when the actual systemctl restart fails", async () => {
  const { fetch, calls } = fakeFetcher([
    fakeJsonResponse(200, { token: "lease-token", expiresAt: "2026-07-30T00:00:10.000Z" }),
    fakeJsonResponse(200, { released: true }),
  ]);
  await assert.rejects(
    restartServiceSafely({
      platform: "linux",
      fetcher: fetch,
      runner: async () => {
        throw new Error("systemctl denied");
      },
    }),
    /systemctl denied/,
  );
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { token: "lease-token" });
});
