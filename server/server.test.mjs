import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { _clearProbeCache } from "./lib/capabilities.mjs";
import { _setModelFileOps } from "./lib/agents/codex.mjs";
import {
  createDispatcher,
  _setProbe as _setDispatchProbe,
  _setRunFile as _setDispatchRunFile,
  _setSpawner as _setDispatchSpawner,
} from "./lib/dispatch.mjs";
import { loadRegistry, normalizeProject } from "./lib/registry.mjs";
import {
  _setBrResolver as _setTrackerBrResolver,
  _setRunner,
} from "./lib/tracker.mjs";
import { CHRONICLE_LIMIT } from "./lib/world-contract.mjs";
import { createServer, listenLoopback, shutdownServer } from "./server.mjs";

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");

async function gitProject(root, name, tracker) {
  const path = join(root, name);
  await mkdir(path);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: path });
  await writeFile(join(path, "README.md"), `${name}\n`);
  if (tracker === "committed") {
    await mkdir(join(path, ".beads"));
    await writeFile(join(path, ".beads", "issues.jsonl"), "");
  }
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atelier Test",
      "-c",
      "user.email=atelier@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: path },
  );
  return {
    name,
    path,
    mainBranch: "main",
    tracker,
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: [],
    dispatchProfile: {},
  };
}

function dispatcherStub() {
  const emitter = new EventEmitter();
  const replies = [];
  const plans = [];
  const reviews = [];
  const reviewDispositions = [];
  const merges = [];
  const verifyReruns = [];
  const resumedQueueTickets = [];
  const convoys = [{
    id: "convoy-1",
    project: "tracked",
    ticketIds: ["tracked-1", "tracked-2"],
    cursor: 0,
    state: "running",
    currentDispatchId: "dispatch-1",
    reason: null,
  }];
  const queueDraining = new Set();
  const codexSweeps = [];
  const records = ["dispatch-1", "dispatch-2"].map((id, index) => ({
    id,
    project: "tracked",
    state: index === 0 ? "completed" : "running",
    worktreePath: null,
    strandedBrWrites: false,
    verify: { state: index === 0 ? "passed" : "running", steps: [] },
    merged: null,
  }));
  return {
    _records: records,
    _replies: replies,
    _plans: plans,
    _reviews: reviews,
    _reviewDispositions: reviewDispositions,
    _merges: merges,
    _verifyReruns: verifyReruns,
    _resumedQueueTickets: resumedQueueTickets,
    _convoys: convoys,
    _queueDraining: queueDraining,
    list: () => records,
    get: (id) => records.find((record) => id === record.id),
    getEvents: (id, since = 0) =>
      records.some((record) => id === record.id) && since < 1
        ? [{ type: "status", state: "running", dispatchId: id, seq: 1 }]
        : [],
    dispatch: async (opts) => {
      if (String(opts.prompt || "").startsWith("-")) {
        throw new Error('prompt must not start with "-"');
      }
      return { id: records[0].id };
    },
    stop: async () => ({ ...records[0], state: "stopped" }),
    reply: async (id, { text, force }) => {
      const record = records.find((candidate) => candidate.id === id);
      replies.push({ id, text, ...(force !== undefined ? { force } : {}) });
      return { ...record, state: "running", replyText: text };
    },
    plan: async (id, body) => {
      const record = records.find((candidate) => candidate.id === id);
      plans.push({ id, ...body });
      return { ...record, state: "running", planAction: body.action };
    },
    review: async (id, body) => {
      reviews.push({ id, ...body });
      return {
        id: "review-dispatch",
        project: "tracked",
        state: "queued",
        reviewOf: id,
        readOnly: true,
      };
    },
    reviewDisposition: async (id, body) => {
      reviewDispositions.push({ id, ...body });
      return {
        ...records.find((candidate) => candidate.id === id),
        reviewDispositions: reviewDispositions.map((entry, index) => ({
          ref: `disposition-${index + 1}`,
          findingRef: entry.findingRef,
          disposition: entry.disposition,
          ...(entry.redirectTicket ? { redirectTicket: entry.redirectTicket } : {}),
          note: entry.note,
          actor: entry.actor,
          at: "2026-07-31T00:00:00.000Z",
        })),
      };
    },
    rerunVerification: async (id) => {
      const record = records.find((candidate) => candidate.id === id);
      verifyReruns.push(id);
      return { ...record, state: "verifying", verify: { state: "running", steps: [], attempt: 2 } };
    },
    listConvoys: () => convoys,
    createConvoy: async (project, { ticketIds }) => {
      const convoy = {
        id: `convoy-${convoys.length + 1}`,
        project,
        ticketIds,
        cursor: 0,
        state: "running",
        currentDispatchId: null,
        reason: null,
      };
      convoys.push(convoy);
      return convoy;
    },
    resumeConvoy: async (id) => {
      const convoy = convoys.find((candidate) => candidate.id === id);
      convoy.state = "running";
      return convoy;
    },
    cancelConvoy: (id) => {
      const convoy = convoys.find((candidate) => candidate.id === id);
      convoy.state = "canceled";
      return convoy;
    },
    dismiss: async (id) => {
      const record = records.find((candidate) => candidate.id === id);
      record.dismissed = { at: "2026-07-21T12:30:00.000Z" };
      return record;
    },
    merge: async (id, options) => {
      merges.push({ id, ...options });
      return {
        ...records.find((record) => record.id === id),
        state: "completed",
        merged: {
          commit: options.force ? "forced" : "merged",
          mergedAt: "2026-07-21T12:00:00.000Z",
          strategy: "ff",
          ...(options.force
            ? {
                forcedBy: options.forcedBy,
                reason: options.reason,
                dispositionRef: options.dispositionRef,
              }
            : {}),
        },
      };
    },
    getMainHealth: (name) => ({
      project: name,
      state: "failed",
      unresolvedFailures: records.filter((record) => record.postMerge?.state === "failed"),
      running: [],
    }),
    acknowledgePostMergeFailure: (id) => {
      const record = records.find((candidate) => candidate.id === id);
      record.postMerge.acknowledgedAt = "2026-07-22T12:00:00.000Z";
      return record;
    },
    getQueue: (name) =>
      name === "degraded"
        ? { enabled: false, unavailable: true }
        : {
            enabled: true,
            consecutiveFailures: 0,
            lastError: null,
            failureLimit: 2,
            parkedTickets: [],
          },
    setQueue: (name, { enabled }) =>
      name === "degraded"
        ? { enabled: false, unavailable: true }
        : {
            enabled,
            consecutiveFailures: 0,
            lastError: null,
            failureLimit: 2,
            parkedTickets: [],
          },
    resumeQueueTicket: (name, ticketId) => {
      resumedQueueTickets.push({ name, ticketId });
      return {
        enabled: true,
        consecutiveFailures: 0,
        lastError: null,
        failureLimit: 2,
        parkedTickets: [],
      };
    },
    gc: async ({ olderThanDays = 7, dryRun = false } = {}) => ({
      dryRun,
      olderThanDays,
      dismissed: dryRun ? ["dispatch-old"] : [],
      orphans: [],
      errors: [],
    }),
    drainQueuesOnce: async () => {},
    _codexSweeps: codexSweeps,
    sweepCodexProcesses: async () => {
      codexSweeps.push(Date.now());
      return { supported: true, swept: true, reaped: [], reported: [], errors: [] };
    },
    isQueueDrainRunning: (name) => queueDraining.has(name),
    rollup: () => ({
      projects: [
        {
          project: "tracked",
          runs: 2,
          completed: 1,
          failed: 0,
          merged: 0,
          turns: 4,
          costUSD: 0.25,
        },
      ],
      days: [{ day: "2026-07-21", runs: 2, costUSD: 0.25 }],
      totals: { runs: 2, turns: 4, costUSD: 0.25 },
    }),
    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
}

function boardEventsStub() {
  const emitter = new EventEmitter();
  const notifications = [];
  return {
    notifications,
    refresh() {},
    close() {},
    notify(project) {
      notifications.push(project);
      emitter.emit("event", { type: "board", project });
    },
    emit(event) {
      emitter.emit("event", event);
    },
    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
}

function readSseReplay(port, path, headers = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      let data = "";
      response.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (!data.includes(": heartbeat\n\n")) return;
        resolvePromise(data);
        response.destroy();
      });
    });
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") rejectPromise(error);
    });
    request.end();
  });
}

function send(port, { method = "GET", path = "/", body, contentType, actor } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = {};
    if (contentType) headers["Content-Type"] = contentType;
    if (actor !== undefined) headers["X-Atelier-Actor"] = actor;
    if (body !== undefined) headers["Content-Length"] = Buffer.byteLength(body);
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", rejectPromise);
    request.end(body);
  });
}

function browserModuleSpecifiers(source) {
  const specifiers = [];
  const staticImports = /(?:^|\n)\s*(?:import|export)\s+(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticImports, dynamicImports]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

async function serverFixture(
  t,
  {
    defaults = {},
    editorCommand,
    spawner,
    commandRunner,
    chronicleGitRunner,
    brExecutable,
    browserHomeDir,
    boardEvents = boardEventsStub(),
    dispatcher = dispatcherStub(),
    eventLog,
    bootStamp,
    uiDir,
    themesDir,
    codexSweepIntervalMs,
    beforeCreateServer,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "atelier-server-"));
  const tracked = await gitProject(root, "tracked", "committed");
  const degraded = await gitProject(root, "degraded", "none");
  const registry = {
    version: 1,
    defaults: { ...defaults, ...(editorCommand ? { editorCommand } : {}) },
    groups: [],
    projects: [tracked, degraded],
  };
  const registryPath = join(root, "config", "projects.json");
  const atelierStateDir = join(root, "atelier-state");
  await mkdir(atelierStateDir);
  // A factory gets the built registry + state dir, so a test can put the REAL
  // dispatcher behind the real routes instead of a stub.
  if (typeof dispatcher === "function") dispatcher = dispatcher({ registry, atelierStateDir });
  if (typeof eventLog === "function") eventLog = eventLog({ registry, atelierStateDir });
  await beforeCreateServer?.({ registry, root, tracked, degraded });
  const server = createServer({
    registry,
    dispatcher,
    registryPath,
    atelierStateDir,
    browserHomeDir: browserHomeDir ?? root,
    spawner,
    commandRunner,
    chronicleGitRunner,
    brExecutable,
    boardEvents,
    eventLog,
    bootStamp,
    uiDir,
    themesDir,
    ...(codexSweepIntervalMs === undefined ? {} : { codexSweepIntervalMs }),
  });
  const address = await listenLoopback(server, 0);
  _setModelFileOps({ readFileSync: () => 'model = "gpt-5.6-server-fixture"\n' });
  _clearProbeCache();
  t.after(async () => {
    _setRunner();
    _setTrackerBrResolver();
    _setModelFileOps();
    _clearProbeCache();
    server.close();
    await once(server, "close").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return {
    port: address.port,
    address: server.address().address,
    root,
    registry,
    registryPath,
    atelierStateDir,
    dispatcher,
    eventLog,
    boardEvents,
    tracked,
    degraded,
  };
}

test("server enforces JSON gates, body cap, API 404s and degraded tracker gate", async (t) => {
  const { port, address } = await serverFixture(t);
  assert.equal(address, "127.0.0.1");

  const unsupported = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: "{}",
    contentType: "text/plain",
  });
  assert.equal(unsupported.status, 415);
  assert.match(unsupported.text, /Content-Type/);

  const oversized = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: "x".repeat(256 * 1024 + 1),
    contentType: "application/json",
  });
  assert.equal(oversized.status, 413);

  const missing = await send(port, { path: "/api/missing" });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.text), { error: "Not found" });

  const gated = await send(port, {
    method: "POST",
    path: "/api/projects/degraded/create",
    body: JSON.stringify({ title: "Title", desc: "Description" }),
    contentType: "application/json",
  });
  assert.equal(gated.status, 409);

  const leadingDash = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "tracked", prompt: "-f/etc/hostname" }),
    contentType: "application/json",
  });
  assert.equal(leadingDash.status, 400);

  // ui/ ships with Spec C: the root now serves the app shell.
  const staticRoot = await send(port, { path: "/" });
  assert.equal(staticRoot.status, 200);
  assert.match(staticRoot.headers["content-type"] ?? "", /text\/html/);
});

test("POST /api/dispatches/drain-lease proxies the dispatcher's lease and surfaces refusals", async (t) => {
  const leaseCalls = [];
  const dispatcher = {
    ...dispatcherStub(),
    acquireDrainLease(options) {
      leaseCalls.push(options);
      if (leaseCalls.length > 1) {
        const error = new Error("Refusing drain lease: 1 active dispatch (dispatch-2)");
        error.status = 409;
        throw error;
      }
      return { token: "lease-abc", expiresAt: "2026-07-30T00:00:10.000Z" };
    },
  };
  const { port } = await serverFixture(t, { dispatcher });

  const granted = await send(port, {
    method: "POST",
    path: "/api/dispatches/drain-lease",
    body: JSON.stringify({ ttlMs: 5000 }),
    contentType: "application/json",
  });
  assert.equal(granted.status, 200);
  assert.deepEqual(
    JSON.parse(granted.text),
    { token: "lease-abc", expiresAt: "2026-07-30T00:00:10.000Z" },
  );
  assert.deepEqual(leaseCalls, [{ ttlMs: 5000 }]);

  const refused = await send(port, {
    method: "POST",
    path: "/api/dispatches/drain-lease",
    body: "{}",
    contentType: "application/json",
  });
  assert.equal(refused.status, 409);
  assert.match(JSON.parse(refused.text).error, /active dispatch/);
});

test("POST /api/dispatches/drain-lease/release proxies the dispatcher's release call", async (t) => {
  const releaseCalls = [];
  const dispatcher = {
    ...dispatcherStub(),
    releaseDrainLease(token) {
      releaseCalls.push(token);
      return token === "known-token";
    },
  };
  const { port } = await serverFixture(t, { dispatcher });

  const released = await send(port, {
    method: "POST",
    path: "/api/dispatches/drain-lease/release",
    body: JSON.stringify({ token: "known-token" }),
    contentType: "application/json",
  });
  assert.equal(released.status, 200);
  assert.deepEqual(JSON.parse(released.text), { released: true });

  const unknown = await send(port, {
    method: "POST",
    path: "/api/dispatches/drain-lease/release",
    body: JSON.stringify({ token: "stale-token" }),
    contentType: "application/json",
  });
  assert.equal(unknown.status, 200);
  assert.deepEqual(JSON.parse(unknown.text), { released: false });
  assert.deepEqual(releaseCalls, ["known-token", "stale-token"]);
});

test("static UI assets stay on one boot snapshot until the server restarts", async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), "atelier-ui-snapshot-"));
  const uiDir = join(assetRoot, "ui");
  await cp(UI_DIR, uiDir, { recursive: true });
  t.after(() => rm(assetRoot, { recursive: true, force: true }));

  const firstBoot = await serverFixture(t, { uiDir });
  const appPath = join(uiDir, "app.js");
  const marker = "// updated-on-disk-after-first-boot";
  const original = await readFile(appPath, "utf8");
  await writeFile(appPath, `${original}\n${marker}\n`);

  const stillBooted = await send(firstBoot.port, { path: "/app.js" });
  assert.equal(stillBooted.status, 200);
  assert.doesNotMatch(stillBooted.text, /updated-on-disk-after-first-boot/);

  const restarted = await serverFixture(t, { uiDir });
  const afterRestart = await send(restarted.port, { path: "/app.js" });
  assert.equal(afterRestart.status, 200);
  assert.match(afterRestart.text, /updated-on-disk-after-first-boot/);
});

test("theme-facing core modules serve from stable boot-snapshotted /theme-lib aliases", async (t) => {
  const assetRoot = await mkdtemp(join(tmpdir(), "atelier-theme-lib-snapshot-"));
  const uiDir = join(assetRoot, "ui");
  await cp(UI_DIR, uiDir, { recursive: true });
  t.after(() => rm(assetRoot, { recursive: true, force: true }));

  const firstBoot = await serverFixture(t, { uiDir });
  for (const fileName of ["request.mjs", "actor.mjs", "theme-stream.mjs"]) {
    const response = await send(firstBoot.port, { path: `/theme-lib/${fileName}` });
    assert.equal(response.status, 200, `${fileName} is absent from the theme library snapshot`);
    assert.match(response.headers["content-type"] ?? "", /^text\/javascript/);
    assert.equal(response.text, await readFile(join(uiDir, fileName), "utf8"));
  }
  assert.equal(
    (await send(firstBoot.port, { path: "/ui/request.mjs" })).status,
    404,
    "a theme-relative escape to the source tree must remain unavailable",
  );

  const requestPath = join(uiDir, "request.mjs");
  const marker = "// theme-lib-updated-after-boot";
  await writeFile(requestPath, `${await readFile(requestPath, "utf8")}\n${marker}\n`);
  assert.doesNotMatch(
    (await send(firstBoot.port, { path: "/theme-lib/request.mjs" })).text,
    /theme-lib-updated-after-boot/,
  );

  const restarted = await serverFixture(t, { uiDir });
  assert.match(
    (await send(restarted.port, { path: "/theme-lib/request.mjs" })).text,
    /theme-lib-updated-after-boot/,
  );
});

test("theme manifests and assets are discovered and served from one boot snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-server-themes-"));
  const themesDir = join(root, "themes");
  const bundle = join(themesDir, "forest");
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, "entry.mjs"), "export function mount() {}\n");
  await writeFile(join(bundle, "scene.txt"), "boot one\n");
  await writeFile(join(bundle, "manifest.json"), JSON.stringify({
    id: "forest",
    name: "Forest",
    version: "1.0.0",
    contractVersion: "0.4.0",
    tier: "render+actions",
    adapter: "webgl",
    entry: "entry.mjs",
  }));
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await serverFixture(t, { themesDir });
  const inventory = JSON.parse((await send(first.port, { path: "/api/themes" })).text);
  assert.deepEqual(inventory, {
    themes: [{
      id: "forest",
      name: "Forest",
      version: "1.0.0",
      contractVersion: "0.4.0",
      tier: "render+actions",
      adapter: "webgl",
      entry: "entry.mjs",
      entryUrl: "/themes/forest/entry.mjs",
    }],
    isolation: "same-page-first-party",
  });
  assert.match(
    (await send(first.port, { path: "/themes/forest/entry.mjs" })).headers["content-type"],
    /^text\/javascript/,
  );
  assert.equal((await send(first.port, { path: "/themes/forest/scene.txt" })).text, "boot one\n");

  await writeFile(join(bundle, "scene.txt"), "boot two\n");
  assert.equal(
    (await send(first.port, { path: "/themes/forest/scene.txt" })).text,
    "boot one\n",
  );
  const restarted = await serverFixture(t, { themesDir });
  assert.equal(
    (await send(restarted.port, { path: "/themes/forest/scene.txt" })).text,
    "boot two\n",
  );
});

test("every browser module reachable from app.js is served by the static allowlist", async (t) => {
  const { port } = await serverFixture(t);
  const pending = ["/app.js"];
  const visited = new Set();

  while (pending.length > 0) {
    const route = pending.shift();
    if (visited.has(route)) continue;
    visited.add(route);

    const response = await send(port, { path: route });
    assert.equal(response.status, 200, `${route} is imported but not served`);
    assert.match(response.headers["content-type"] ?? "", /^text\/javascript/);
    for (const specifier of browserModuleSpecifiers(response.text)) {
      assert.match(
        specifier,
        /^(?:\.\.?\/|\/)/,
        `${route} imports bare runtime dependency ${specifier}`,
      );
      pending.push(new URL(specifier, `http://atelier.test${route}`).pathname);
    }
  }

  for (const expectedRoute of [
    "/agent-selection.mjs",
    "/app.js",
    "/board-stream.mjs",
    "/components.mjs",
    "/main-health.mjs",
    "/notifications.mjs",
    "/reply-availability.mjs",
    "/shared/review-assessment.mjs",
    "/request.mjs",
    "/actor.mjs",
    "/theme-host.mjs",
  ]) {
    assert.equal(visited.has(expectedRoute), true, `${expectedRoute} was not discovered`);
  }
  const themeStream = await send(port, { path: "/theme-stream.mjs" });
  assert.equal(themeStream.status, 200, "theme-stream helper is exported for theme bundles");
  assert.match(themeStream.headers["content-type"] ?? "", /^text\/javascript/);
});

test("project chronicle is bounded API data cached from the boot record snapshot", async (t) => {
  const dispatcher = dispatcherStub();
  dispatcher._records.splice(0, dispatcher._records.length, {
    id: "merged-one",
    project: "tracked",
    ticketId: "tracked-1",
    branch: "atelier/theme-substrate-merged-one",
    state: "completed",
    costUSD: 3,
    review: { verdict: "pass" },
    merged: { mergedAt: "2026-07-29T10:00:00.000Z" },
    postMerge: { state: "passed" },
  }, {
    id: "waiting",
    project: "tracked",
    branch: "atelier/waiting-waiting",
    state: "completed",
    costUSD: 2,
    merged: null,
  });
  const { port } = await serverFixture(t, {
    dispatcher,
    bootStamp: { version: "fixture", bootedAt: "2026-07-30T08:00:00.000Z" },
  });

  const first = JSON.parse((await send(port, {
    path: "/api/projects/tracked/chronicle",
  })).text);
  assert.deepEqual(first, {
    project: "tracked",
    generatedAt: "2026-07-30T08:00:00.000Z",
    records: [{
      id: "merged-one",
      ticketId: "tracked-1",
      title: "theme-substrate",
      mergedAt: "2026-07-29T10:00:00.000Z",
      costUSD: 3,
      rounds: 1,
      postMerge: "passed",
      diff: null,
    }],
    summary: {
      merges: 1,
      firstPassReviews: 1,
      reviewedMerges: 1,
      reviewPassRate: 1,
      finalRoundSeverityDistribution: { blocker: 0, major: 0, minor: 0, nit: 0 },
      finalRoundSeverityDistributionByOutcome: {
        merged: { blocker: 0, major: 0, minor: 0, nit: 0 },
        gated: { blocker: 0, major: 0, minor: 0, nit: 0 },
        parked: { blocker: 0, major: 0, minor: 0, nit: 0 },
        dismissed: { blocker: 0, major: 0, minor: 0, nit: 0 },
      },
      costPerMergeUSD: 5,
      unlandedSpendUSD: 2,
    },
    truncated: false,
  });

  dispatcher._records.push({
    id: "merged-after-boot",
    project: "tracked",
    branch: "atelier/late-merged-after-boot",
    costUSD: 4,
    merged: { mergedAt: "2026-07-30T09:00:00.000Z" },
  });
  const cached = JSON.parse((await send(port, {
    path: "/api/projects/tracked/chronicle",
  })).text);
  assert.deepEqual(cached, first, "chronicle drifted from its boot snapshot");
  assert.equal((await send(port, {
    path: "/api/projects/missing/chronicle",
  })).status, 404);
});

test("project artifacts are path-safe boot snapshots and reject encoded project traversal", async (t) => {
  const bootedAt = "2026-07-30T08:00:00.000Z";
  const { port, tracked } = await serverFixture(t, {
    bootStamp: { version: "fixture", bootedAt },
    beforeCreateServer: async ({ tracked: project }) => {
      await mkdir(join(project.path, "docs", "specs"), { recursive: true });
      await mkdir(join(project.path, "docs", "design", "nested"), { recursive: true });
      await writeFile(
        join(project.path, "docs", "specs", "village.md"),
        "# Village lifecycle\n",
      );
      await writeFile(
        join(project.path, "docs", "design", "nested", "layout.md"),
        "notes\n\n## Layout study\n",
      );
      await writeFile(join(project.path, "docs", "design", "skip.txt"), "# Skip\n");
    },
  });

  const endpoint = `/api/projects/${encodeURIComponent(tracked.name)}/artifacts`;
  const firstResponse = await send(port, { path: endpoint });
  assert.equal(firstResponse.status, 200);
  const first = JSON.parse(firstResponse.text);
  assert.equal(first.project, tracked.name);
  assert.equal(first.generatedAt, bootedAt);
  assert.deepEqual(first.artifacts.map(({ kind, title, path }) => ({ kind, title, path })), [
    { kind: "design", title: "Layout study", path: "docs/design/nested/layout.md" },
    { kind: "spec", title: "Village lifecycle", path: "docs/specs/village.md" },
  ]);
  assert.ok(first.artifacts.every(({ updatedAt }) => !Number.isNaN(Date.parse(updatedAt))));

  await writeFile(join(tracked.path, "docs", "specs", "late.md"), "# Added after boot\n");
  assert.deepEqual(
    JSON.parse((await send(port, { path: endpoint })).text),
    first,
    "artifacts drifted from the boot snapshot",
  );

  assert.equal(
    (await send(port, {
      path: "/api/projects/%2e%2e%2ftracked/artifacts",
    })).status,
    404,
  );
  assert.equal(
    (await send(port, {
      path: "/api/projects/missing/artifacts",
    })).status,
    404,
  );
});

test("chronicle boot batches merge-commit numstat with per-entry null fallback", async (t) => {
  const calls = [];
  const hostileKeys = ["GIT_DIR", "LD_AUDIT", "SSH_ASKPASS"];
  const previousHostile = Object.fromEntries(hostileKeys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previousHostile)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const missingCommit = "0".repeat(40);
  let resolvedCommit;
  let historyCommit;
  const dispatcher = ({ registry }) => {
    const stub = dispatcherStub();
    const project = registry.projects.find(({ name }) => name === "tracked");
    execFileSync("git", ["switch", "-q", "-c", "chronicle-feature"], { cwd: project.path });
    writeFileSync(join(project.path, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "feature.txt"], { cwd: project.path });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Atelier Test",
        "-c",
        "user.email=atelier@example.invalid",
        "commit",
        "-q",
        "-m",
        "feature",
      ],
      { cwd: project.path },
    );
    execFileSync("git", ["switch", "-q", "main"], { cwd: project.path });
    writeFileSync(join(project.path, "main.txt"), "main\n");
    execFileSync("git", ["add", "main.txt"], { cwd: project.path });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Atelier Test",
        "-c",
        "user.email=atelier@example.invalid",
        "commit",
        "-q",
        "-m",
        "main",
      ],
      { cwd: project.path },
    );
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Atelier Test",
        "-c",
        "user.email=atelier@example.invalid",
        "merge",
        "-q",
        "--no-ff",
        "chronicle-feature",
        "-m",
        "merge",
      ],
      { cwd: project.path },
    );
    resolvedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.path,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["switch", "-q", "-c", "chronicle-history"], { cwd: project.path });
    writeFileSync(join(project.path, "history.txt"), "history\n");
    execFileSync("git", ["add", "history.txt"], { cwd: project.path });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Atelier Test",
        "-c",
        "user.email=atelier@example.invalid",
        "commit",
        "-q",
        "-m",
        "history",
      ],
      { cwd: project.path },
    );
    execFileSync("git", ["switch", "-q", "main"], { cwd: project.path });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Atelier Test",
        "-c",
        "user.email=atelier@example.invalid",
        "merge",
        "-q",
        "--no-ff",
        "chronicle-history",
        "-m",
        "merge: archived work (tracked-old)",
      ],
      { cwd: project.path },
    );
    historyCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: project.path,
      encoding: "utf8",
    }).trim();
    stub._records.splice(0, stub._records.length, {
      id: "resolved-merge",
      project: "tracked",
      branch: "atelier/resolved-resolved-merge",
      merged: {
        commit: resolvedCommit,
        mergedAt: "2026-07-29T10:00:00.000Z",
      },
    }, {
      id: "missing-merge",
      project: "tracked",
      branch: "atelier/missing-missing-merge",
      merged: {
        commit: missingCommit,
        mergedAt: "2026-07-29T11:00:00.000Z",
      },
    });
    process.env.GIT_DIR = "/hostile/repository";
    process.env.LD_AUDIT = "/hostile/audit.so";
    process.env.SSH_ASKPASS = "/hostile/askpass";
    return stub;
  };
  const chronicleGitRunner = (file, args, options) => {
    calls.push({ file, args, options });
    return execFileSync(file, args, options);
  };
  const { port } = await serverFixture(t, { dispatcher, chronicleGitRunner });

  const project = JSON.parse((await send(port, {
    path: "/api/projects/tracked/chronicle",
  })).text);
  assert.deepEqual(
    project.records
      .filter(({ id }) => id === "resolved-merge" || id === "missing-merge")
      .map(({ id, diff }) => ({ id, diff })),
    [{
      id: "resolved-merge",
      diff: { files: 1, insertions: 1, deletions: 0 },
    }, {
      id: "missing-merge",
      diff: null,
    }],
  );
  assert.deepEqual(
    project.records.find(({ id }) => id === historyCommit.slice(0, 8)),
    {
      id: historyCommit.slice(0, 8),
      ticketId: "tracked-old",
      title: "archived work (tracked-old)",
      mergedAt: project.records.find(({ id }) => id === historyCommit.slice(0, 8)).mergedAt,
      costUSD: null,
      rounds: 0,
      postMerge: null,
      diff: { files: 1, insertions: 1, deletions: 0 },
    },
  );

  const aggregate = JSON.parse((await send(port, { path: "/api/chronicle" })).text);
  assert.equal(
    aggregate.records.some(({ id, project: projectName }) =>
      id === historyCommit.slice(0, 8) && projectName === "tracked"),
    true,
  );
  const numstatCalls = calls.filter(({ args }) => args.includes("--numstat"));
  assert.equal(numstatCalls.length, 1, "numstat must be one batched Git call, not one call per entry");
  assert.equal(numstatCalls[0].file, "git");
  assert.equal(numstatCalls[0].args.includes("log"), true);
  assert.equal(numstatCalls[0].args.includes("--first-parent"), true);
  assert.deepEqual(
    new Set(numstatCalls[0].args.slice(-3)),
    new Set([resolvedCommit, missingCommit, historyCommit]),
  );
  const historyCalls = calls.filter(({ args }) => args.includes("--merges"));
  assert.ok(historyCalls.length > 0, "chronicle history must use the injected Git runner");
  for (const { options } of [...historyCalls, ...numstatCalls]) {
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.LD_AUDIT, undefined);
    assert.equal(options.env.SSH_ASKPASS, undefined);
    assert.equal(options.env.PATH, process.env.PATH);
    assert.equal(options.env.HOME, process.env.HOME);
    assert.equal(options.env.LC_ALL, "C");
  }
});

test("aggregate chronicle merges registered projects chronologically at the shared bound", async (t) => {
  const dispatcher = dispatcherStub();
  dispatcher._records.splice(
    0,
    dispatcher._records.length,
    ...Array.from({ length: CHRONICLE_LIMIT + 2 }, (_, index) => ({
      id: `merged-${index}`,
      project: index % 2 === 0 ? "tracked" : "degraded",
      ticketId: `ticket-${index}`,
      branch: `atelier/work-${index}-merged-${index}`,
      merged: {
        mergedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      },
    })),
  );
  const bootedAt = "2026-07-30T08:00:00.000Z";
  const { port } = await serverFixture(t, {
    dispatcher,
    bootStamp: { version: "fixture", bootedAt },
  });

  const aggregate = JSON.parse((await send(port, { path: "/api/chronicle" })).text);

  assert.equal(aggregate.generatedAt, bootedAt);
  assert.equal(aggregate.records.length, CHRONICLE_LIMIT);
  assert.equal(aggregate.truncated, true);
  assert.deepEqual(aggregate.records[0], {
    id: "merged-2",
    ticketId: "ticket-2",
    title: "work-2",
    mergedAt: new Date(Date.UTC(2026, 0, 1, 0, 2)).toISOString(),
    costUSD: null,
    rounds: 0,
    postMerge: null,
    diff: null,
    project: "tracked",
  });
  assert.equal(aggregate.records.at(-1).project, "degraded");
  assert.equal(
    aggregate.records.some(({ id }) => id === "merged-0"),
    false,
    "the oldest over-bound merge is the negative control",
  );
});

test("a project registered after boot gets an empty frozen chronicle snapshot", async (t) => {
  const dispatcher = dispatcherStub();
  const bootedAt = "2026-07-30T08:00:00.000Z";
  const { port, root } = await serverFixture(t, {
    dispatcher,
    bootStamp: { version: "fixture", bootedAt },
  });
  const aggregateAtBoot = JSON.parse((await send(port, { path: "/api/chronicle" })).text);
  const project = await gitProject(root, "registered-late", "none");
  const registered = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify(project),
    contentType: "application/json",
  });
  assert.equal(registered.status, 201);

  dispatcher._records.push({
    id: "late-record",
    project: "registered-late",
    branch: "atelier/late-record",
    merged: { mergedAt: "2026-07-30T09:00:00.000Z" },
  });
  const response = await send(port, {
    path: "/api/projects/registered-late/chronicle",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    project: "registered-late",
    generatedAt: bootedAt,
    records: [],
    summary: {
      merges: 0,
      firstPassReviews: 0,
      reviewedMerges: 0,
      reviewPassRate: null,
      finalRoundSeverityDistribution: { blocker: 0, major: 0, minor: 0, nit: 0 },
      finalRoundSeverityDistributionByOutcome: {
        merged: { blocker: 0, major: 0, minor: 0, nit: 0 },
        gated: { blocker: 0, major: 0, minor: 0, nit: 0 },
        parked: { blocker: 0, major: 0, minor: 0, nit: 0 },
        dismissed: { blocker: 0, major: 0, minor: 0, nit: 0 },
      },
      costPerMergeUSD: null,
      unlandedSpendUSD: 0,
    },
    truncated: false,
  });
  const aggregateAfterRegistration = JSON.parse(
    (await send(port, { path: "/api/chronicle" })).text,
  );
  assert.deepEqual(
    aggregateAfterRegistration,
    aggregateAtBoot,
    "post-boot project and record must remain absent from the aggregate snapshot",
  );
});

test("the codex process sweep runs on its own configurable interval, never once per boot", async (t) => {
  // Boot-emptiness gets an interval long enough that no amount of load can fire
  // it: asserting "still empty" against a 15ms timer would be a race, and the
  // claim is about createServer() not sweeping at all, not about timing.
  const quiet = dispatcherStub();
  await serverFixture(t, { dispatcher: quiet, codexSweepIntervalMs: 600_000 });
  // Boot deliberately does NOT sweep here: the dispatcher runs one once its own
  // boot recovery settles, and one per createServer() call would turn a test run
  // - or two servers on one host - into a /proc scan storm.
  assert.deepEqual(quiet._codexSweeps, []);

  const ticking = dispatcherStub();
  await serverFixture(t, { dispatcher: ticking, codexSweepIntervalMs: 15 });
  const deadline = Date.now() + 5_000;
  while (ticking._codexSweeps.length < 2) {
    if (Date.now() >= deadline) throw new Error("the periodic codex process sweep never ran");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
});

test("doctor GC route delegates validated options to the live dispatcher", async (t) => {
  const { port } = await serverFixture(t);
  const result = await send(port, {
    method: "POST",
    path: "/api/doctor/gc",
    body: JSON.stringify({ olderThanDays: 14, dryRun: true }),
    contentType: "application/json",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.text), {
    dryRun: true,
    olderThanDays: 14,
    dismissed: ["dispatch-old"],
    orphans: [],
    errors: [],
  });

  const rejected = await send(port, {
    method: "POST",
    path: "/api/doctor/gc",
    body: JSON.stringify({ path: "/tmp/client-controlled" }),
    contentType: "application/json",
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /Unknown doctor GC fields: path/);
});

test("project state uses tracker readiness semantics and reports its source from trackerPath", async (t) => {
  const readyCalls = [];
  const commandRunner = async (file, args, options) => {
    readyCalls.push({ file, args, cwd: options?.cwd });
    assert.deepEqual(args, ["ready", "--json"]);
    return JSON.stringify([
      {
        id: "tracked-child",
        priority: 0,
        created_at: "2026-07-30T10:00:00.000Z",
      },
      {
        id: "tracked-related",
        priority: 1,
        created_at: "2026-07-30T11:00:00.000Z",
      },
      {
        id: "tracked-parked",
        priority: 2,
        created_at: "2026-07-30T12:00:00.000Z",
      },
    ]);
  };
  const { port, tracked, atelierStateDir, dispatcher } = await serverFixture(t, {
    commandRunner,
    brExecutable: "/fixture/br",
  });
  const trackerPath = join(atelierStateDir, "trackers", tracked.name);
  const issues = [
    {
      id: "tracked-epic",
      title: "Container epic",
      status: "open",
      issue_type: "epic",
      priority: 0,
      dependencies: [{
        depends_on_id: "tracked-child",
        dependency_type: "parent-child",
        status: "open",
      }],
    },
    {
      id: "tracked-child",
      title: "Actionable child",
      status: "open",
      priority: 0,
      dependencies: [{
        depends_on_id: "tracked-epic",
        dependency_type: "parent-child",
        status: "open",
      }],
    },
    {
      id: "tracked-blocked",
      title: "External blocked work",
      status: "open",
      priority: 0,
      dependencies: [{
        depends_on_id: "tracked-open-blocker",
        dependency_type: "blocks",
        status: "open",
      }],
    },
    {
      id: "tracked-related",
      title: "Non-blocking relationship",
      status: "open",
      priority: 1,
      dependencies: [{
        depends_on_id: "tracked-open-blocker",
        dependency_type: "related",
        status: "open",
      }],
    },
    {
      id: "tracked-deferred",
      title: "Future deferred work",
      status: "open",
      priority: 0,
      defer_until: "2099-01-01T00:00:00.000Z",
    },
    { id: "tracked-pinned", title: "Pinned record", status: "open", pinned: true },
    { id: "tracked-ephemeral", title: "Ephemeral record", status: "open", ephemeral: true },
    { id: "tracked-template", title: "Template record", status: "open", issue_type: "template" },
    { id: "tracked-wisp", title: "Wisp record", status: "open", issue_type: "wisp" },
    {
      id: "tracked-parked",
      title: "External parked work",
      status: "open",
      priority: 0,
    },
    { id: "tracked-open-blocker", title: "Open blocker", status: "open", priority: 0 },
  ];
  await mkdir(join(trackerPath, ".beads"), { recursive: true });
  await writeFile(
    join(trackerPath, ".beads", "issues.jsonl"),
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await rm(join(tracked.path, ".beads"), { recursive: true, force: true });
  Object.assign(tracked, { tracker: "personal", trackerPath });
  dispatcher.getQueue = () => ({
    enabled: true,
    parkedTickets: [{ ticketId: "tracked-parked", parked: true }],
  });
  _clearProbeCache();

  const response = await send(port, { path: `/api/projects/${tracked.name}/state` });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.issues, issues, "the complete tracker projection remains available");
  assert.deepEqual(
    body.readyIssues.map(({ id }) => id),
    ["tracked-child", "tracked-related"],
    "tracker exclusions, blocking-type semantics, hierarchy, and Atelier parking are preserved",
  );
  assert.equal(
    body.readyIssues.some(({ id }) => id === "tracked-deferred"),
    false,
    "a future-deferred ticket omitted by br ready must remain omitted",
  );
  assert.equal(
    body.readyIssues.some(({ id }) => id === "tracked-epic"),
    false,
    "an epic with an actionable child must not be advertised in place of the child",
  );
  assert.deepEqual(
    body.readyIssues.filter(({ id }) =>
      ["tracked-pinned", "tracked-ephemeral", "tracked-template", "tracked-wisp"].includes(id)),
    [],
    "tracker-owned issue-kind exclusions must stay excluded",
  );
  assert.deepEqual(readyCalls, [{
    file: "/fixture/br",
    args: ["ready", "--json"],
    cwd: trackerPath,
  }]);
  assert.equal(body.source, join(trackerPath, ".beads", "issues.jsonl"));
  assert.equal(body.degraded, false);
});

for (const readinessFailure of [
  {
    name: "an absent br binary",
    options: {
      brExecutable: "/fixture/br-does-not-exist",
    },
  },
  {
    name: "a nonzero br ready exit",
    options: {
      brExecutable: "/fixture/br",
      commandRunner: async () => {
        throw Object.assign(new Error("br ready exited 1"), { code: 1 });
      },
    },
  },
]) {
  test(`project state fails readyIssues closed for ${readinessFailure.name}`, async (t) => {
    const { port, tracked } = await serverFixture(t, readinessFailure.options);
    const issue = {
      id: "tracked-survives",
      title: "Valid tracker record",
      status: "open",
      priority: 1,
    };
    const issuePath = join(tracked.path, ".beads", "issues.jsonl");
    await writeFile(issuePath, `${JSON.stringify(issue)}\n`);
    _clearProbeCache();

    const response = await send(port, { path: `/api/projects/${tracked.name}/state` });

    assert.equal(response.status, 200);
    const body = JSON.parse(response.text);
    assert.deepEqual(body.issues, [issue], "valid JSONL remains available");
    assert.deepEqual(body.readyIssues, [], "unavailable readiness never guesses ready work");
    assert.equal(body.degraded, true);
    assert.equal(body.tracker, "committed");
    assert.equal(body.source, issuePath);
    assert.equal(new Date(body.generatedAt).toISOString(), body.generatedAt);
  });
}

test("malformed successful br ready JSON degrades without falling back to text", async (t) => {
  const calls = [];
  const { port, tracked } = await serverFixture(t, {
    brExecutable: "/fixture/br",
    commandRunner: async (_file, args) => {
      calls.push(args);
      return "{not-json";
    },
  });
  const issue = { id: "tracked-valid", title: "Still visible", status: "open" };
  await writeFile(
    join(tracked.path, ".beads", "issues.jsonl"),
    `${JSON.stringify(issue)}\n`,
  );
  _clearProbeCache();

  const response = await send(port, { path: `/api/projects/${tracked.name}/state` });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.deepEqual(body.issues, [issue]);
  assert.deepEqual(body.readyIssues, []);
  assert.equal(body.degraded, true);
  assert.deepEqual(calls, [["ready", "--json"]]);
});

test("project state retries a changed tracker source instead of mixing issue generations", async (t) => {
  let issuePath;
  let readyCalls = 0;
  const { port, tracked } = await serverFixture(t, {
    brExecutable: "/fixture/br",
    commandRunner: async (_file, args) => {
      assert.deepEqual(args, ["ready", "--json"]);
      readyCalls += 1;
      if (readyCalls === 1) {
        await writeFile(
          issuePath,
          `${JSON.stringify({
            id: "tracked-racing",
            title: "Claimed concurrently",
            status: "in_progress",
            assignee: "other-agent",
          })}\n`,
        );
        return JSON.stringify([
          { id: "tracked-racing", priority: 0, created_at: "2026-07-31T08:00:00Z" },
        ]);
      }
      return "[]";
    },
  });
  issuePath = join(tracked.path, ".beads", "issues.jsonl");
  await writeFile(
    issuePath,
    `${JSON.stringify({
      id: "tracked-racing",
      title: "Initially open",
      status: "open",
      priority: 0,
    })}\n`,
  );
  _clearProbeCache();

  const response = await send(port, { path: `/api/projects/${tracked.name}/state` });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.equal(readyCalls, 2);
  assert.equal(body.degraded, false);
  assert.equal(body.issues[0].status, "in_progress");
  assert.deepEqual(body.readyIssues, []);
  assert.equal(
    body.readyIssues.some(({ status }) => status === "in_progress"),
    false,
  );
});

test("projects payload distinguishes the own profile from the resolved default agent", async (t) => {
  const { port, registry } = await serverFixture(t);
  registry.defaults.dispatchProfile = { lane: "claude" };
  registry.projects[0] = normalizeProject(
    { ...registry.projects[0], defaultAgent: "codex" },
    registry.defaults,
  );

  const response = await send(port, { path: "/api/projects" });
  assert.equal(response.status, 200);
  const project = JSON.parse(response.text).projects.find(({ name }) => name === "tracked");
  assert.equal(project.dispatchProfile.lane, "claude");
  assert.deepEqual(project.ownDispatchProfile, {});
  assert.equal(project.resolvedDefaultAgent, "codex");
});

test("fresh install serves, probes, creates, and uses a project without hand-edited JSON", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-fresh-install-"));
  const registryPath = join(root, "config", "projects.json");
  const atelierStateDir = join(root, "state");
  const registry = await loadRegistry(registryPath);
  const server = createServer({
    registry,
    dispatcher: dispatcherStub(),
    registryPath,
    atelierStateDir,
  });
  const address = await listenLoopback(server, 0);
  t.after(async () => {
    server.close();
    await once(server, "close").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const shell = await send(address.port, { path: "/" });
  assert.equal(shell.status, 200);
  const candidate = join(root, "project");
  await mkdir(candidate);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: candidate });
  const probed = await send(address.port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: candidate }),
    contentType: "application/json",
  });
  assert.equal(probed.status, 200);
  const probe = JSON.parse(probed.text);
  const created = await send(address.port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({ path: probe.path, ...probe.inferred }),
    contentType: "application/json",
  });
  assert.equal(created.status, 201);
  const state = await send(address.port, { path: "/api/projects/project/state" });
  assert.equal(state.status, 200);
  const stateBody = JSON.parse(state.text);
  assert.equal(stateBody.degraded, true);
  assert.deepEqual(stateBody.issues, []);
  assert.deepEqual(stateBody.readyIssues, []);
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).projects.length, 1);
});

test("project probe validates paths and infers commands without executing them", async (t) => {
  const { port, root, atelierStateDir } = await serverFixture(t, {
    defaults: { dispatchProfile: { lane: "codex" } },
  });
  const relative = await send(port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: "relative/project" }),
    contentType: "application/json",
  });
  assert.equal(relative.status, 400);

  const missing = await send(port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: join(root, "missing") }),
    contentType: "application/json",
  });
  assert.equal(missing.status, 404);

  const statePath = await send(port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: atelierStateDir }),
    contentType: "application/json",
  });
  assert.equal(statePath.status, 400);
  assert.match(statePath.text, /Atelier state directory/);

  const candidate = join(root, "Candidate Repo");
  await mkdir(candidate);
  execFileSync("git", ["init", "-q", "--initial-branch=feature"], { cwd: candidate });
  await writeFile(join(candidate, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: candidate });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atelier Test",
      "-c",
      "user.email=atelier@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: candidate },
  );
  execFileSync("git", ["branch", "main"], { cwd: candidate });
  execFileSync("git", ["branch", "release"], { cwd: candidate });
  execFileSync("git", ["remote", "add", "origin", candidate], { cwd: candidate });
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: candidate });
  execFileSync(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
    { cwd: candidate },
  );
  await writeFile(join(candidate, "Cargo.toml"), "[workspace]\nmembers = []\n");
  await writeFile(join(candidate, "Makefile"), "test:\n\ttouch PROBE_MUST_NOT_RUN\n");
  const response = await send(port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: candidate }),
    contentType: "application/json",
  });
  assert.equal(response.status, 200);
  const probe = JSON.parse(response.text);
  assert.equal(probe.path, candidate);
  assert.equal(probe.resolvedDefaultAgent, "codex");
  assert.equal(probe.git.isRepo, true);
  assert.equal(probe.git.branch, "feature");
  assert.deepEqual(probe.git.branches, ["feature", "main", "release"]);
  assert.equal(probe.git.remoteHead, "main");
  assert.equal(probe.tracker.detected, "none");
  assert.equal(probe.inferred.name, "candidate-repo");
  assert.equal(probe.inferred.mainBranch, "main");
  assert.equal(probe.inferred.archetype, "git-only");
  assert.deepEqual(probe.inferred.verifyCommands, ["cargo check --workspace", "make test"]);
  await assert.rejects(readFile(join(candidate, "PROBE_MUST_NOT_RUN"), "utf8"), /ENOENT/);
});

test("directory browser stays within canonical roots and returns directory marker badges only", async (t) => {
  const { port, root, registry } = await serverFixture(t);
  const browserRoot = join(root, "browser");
  const gitRepo = join(browserRoot, "git-repo");
  const beadsProject = join(browserRoot, "beads-project");
  const plainDirectory = join(browserRoot, "plain");
  const outside = await mkdtemp(join(tmpdir(), "atelier-browser-outside-"));
  const registeredParent = await mkdtemp(join(tmpdir(), "atelier-browser-registered-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  t.after(() => rm(registeredParent, { recursive: true, force: true }));
  const registeredProject = join(registeredParent, "external-project");
  await mkdir(registeredProject);
  registry.projects.push({
    ...registry.projects[0],
    name: "external-project",
    path: registeredProject,
  });
  await mkdir(join(gitRepo, ".git"), { recursive: true });
  await mkdir(join(beadsProject, ".beads"), { recursive: true });
  await mkdir(plainDirectory, { recursive: true });
  await writeFile(join(browserRoot, "not-a-directory.txt"), "must not be listed\n");
  await symlink(outside, join(browserRoot, "escape"), "dir");

  const initial = await send(port, { path: "/api/fs/dirs" });
  assert.equal(initial.status, 200);
  assert.equal(JSON.parse(initial.text).path, root);

  const registered = await send(port, {
    path: `/api/fs/dirs?path=${encodeURIComponent(registeredParent)}`,
  });
  assert.equal(registered.status, 200);
  assert.equal(JSON.parse(registered.text).path, registeredParent);

  const response = await send(port, {
    path: `/api/fs/dirs?path=${encodeURIComponent(browserRoot)}`,
  });
  assert.equal(response.status, 200);
  const listing = JSON.parse(response.text);
  assert.equal(listing.path, browserRoot);
  assert.equal(listing.parent, root);
  assert.deepEqual(listing.roots, [root, registeredParent]);
  assert.deepEqual(listing.breadcrumbs, [
    { name: root, path: root },
    { name: "browser", path: browserRoot },
  ]);
  assert.deepEqual(
    listing.directories.map(({ name, git, beads }) => ({ name, git, beads })),
    [
      { name: "beads-project", git: false, beads: true },
      { name: "git-repo", git: true, beads: false },
      { name: "plain", git: false, beads: false },
    ],
  );
  assert.equal(listing.directories.some((entry) => entry.name === "not-a-directory.txt"), false);
  assert.equal(listing.directories.some((entry) => entry.name === "escape"), false);

  for (const requested of [outside, join(root, ".."), join(browserRoot, "escape")]) {
    const rejected = await send(port, {
      path: `/api/fs/dirs?path=${encodeURIComponent(requested)}`,
    });
    assert.equal(rejected.status, 403);
    assert.match(rejected.text, /outside the allowed directory browser roots/);
  }
  const file = await send(port, {
    path: `/api/fs/dirs?path=${encodeURIComponent(join(browserRoot, "not-a-directory.txt"))}`,
  });
  assert.equal(file.status, 400);
});

test("project create is atomic and live; duplicates reject and delete gates active work", async (t) => {
  const { port, root, registry, registryPath } = await serverFixture(t);
  const candidate = await gitProject(root, "new-project", "none");
  const entry = { ...candidate, archetype: "git-only", warn: "never deploy" };
  const createdResponse = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify(entry),
    contentType: "application/json",
  });
  assert.equal(createdResponse.status, 201);
  assert.equal(JSON.parse(createdResponse.text).name, "new-project");
  assert.equal(registry.projects.some((project) => project.name === "new-project"), true);

  const storedText = await readFile(registryPath, "utf8");
  assert.match(storedText, /\n  "version": 1,/);
  assert.equal(JSON.parse(storedText).projects.some((project) => project.name === "new-project"), true);
  assert.deepEqual(
    (await readdir(join(root, "config"))).filter((name) => name.endsWith(".tmp")),
    [],
  );

  const live = await send(port, { path: "/api/projects" });
  assert.equal(JSON.parse(live.text).projects.some((project) => project.name === "new-project"), true);

  for (const duplicate of [entry, { ...entry, name: "other-name" }]) {
    const response = await send(port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify(duplicate),
      contentType: "application/json",
    });
    assert.equal(response.status, 409);
  }

  const active = await send(port, { method: "DELETE", path: "/api/projects/tracked" });
  assert.equal(active.status, 409);
  assert.match(active.text, /active dispatches/);

  const removed = await send(port, { method: "DELETE", path: "/api/projects/new-project" });
  assert.equal(removed.status, 200);
  assert.equal(registry.projects.some((project) => project.name === "new-project"), false);
  assert.equal(
    JSON.parse(await readFile(registryPath, "utf8")).projects.some(
      (project) => project.name === "new-project",
    ),
    false,
  );
});

test("project PATCH atomically updates only mutable settings and mutates the live registry", async (t) => {
  const { port, root, registry, registryPath } = await serverFixture(t);
  const response = await send(port, {
    method: "PATCH",
    path: "/api/projects/tracked",
    body: JSON.stringify({
      notes: "Primary Atelier checkout",
      verifyCommands: ["node --test", "node scripts/smoke.mjs"],
      warn: "never publish",
      dispatchProfile: { lane: "claude", model: "opus", effort: "high", maxTurns: 80 },
      defaultAgent: "codex",
      autoCommitTracker: true,
      autoCloseOnMerge: true,
      requireReview: true,
      reviewPolicy: "tiered",
      maxFixRounds: 6,
      budgetUSDPerDay: 15.75,
      queueFailureLimit: 4,
      unpricedDispatchCapPerDay: 4,
    }),
    contentType: "application/json",
  });

  assert.equal(response.status, 200);
  const updated = JSON.parse(response.text);
  assert.equal(updated.name, "tracked");
  assert.equal(updated.path, registry.projects[0].path);
  assert.equal(updated.notes, "Primary Atelier checkout");
  assert.equal(updated.defaultAgent, "codex");
  assert.deepEqual(updated.verifyCommands, ["node --test", "node scripts/smoke.mjs"]);
  assert.deepEqual(updated.dispatchProfile, {
    lane: "claude",
    model: "opus",
    effort: "high",
    maxTurns: 80,
  });
  assert.deepEqual(updated.ownDispatchProfile, updated.dispatchProfile);
  assert.equal(updated.resolvedDefaultAgent, "claude");
  assert.equal(registry.projects[0].autoCloseOnMerge, true);
  assert.equal(registry.projects[0].requireReview, true);
  assert.equal(registry.projects[0].reviewPolicy, "tiered");
  assert.equal(registry.projects[0].maxFixRounds, 6);
  assert.equal(registry.projects[0].budgetUSDPerDay, 15.75);
  assert.equal(registry.projects[0].queueFailureLimit, 4);
  assert.equal(registry.projects[0].unpricedDispatchCapPerDay, 4);
  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.projects[0].warn, "never publish");
  assert.equal(stored.projects[0].defaultAgent, "codex");
  assert.equal(stored.projects[0].budgetUSDPerDay, 15.75);
  assert.equal(stored.projects[0].maxFixRounds, 6);
  assert.equal(stored.projects[0].reviewPolicy, "tiered");
  assert.equal(stored.projects[0].queueFailureLimit, 4);
  assert.equal(stored.projects[0].unpricedDispatchCapPerDay, 4);
  assert.deepEqual(
    (await readdir(join(root, "config"))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("queueFailureLimit parking changes immediately reach board SSE without a tracker write", async (t) => {
  const boardEvents = boardEventsStub();
  const setup = await serverFixture(t, {
    defaults: { queueFailureLimit: 4 },
    boardEvents,
    dispatcher: ({ registry }) => {
      const dispatcher = dispatcherStub();
      dispatcher.getQueue = (name) => {
        if (name === "degraded") return { enabled: false, unavailable: true };
        const project = registry.projects.find((candidate) => candidate.name === name);
        const failureLimit = project.queueFailureLimit ?? registry.defaults.queueFailureLimit;
        return {
          enabled: true,
          consecutiveFailures: 0,
          lastError: null,
          failureLimit,
          parkedTickets: 3 >= failureLimit
            ? [{ ticketId: "tracked-three-failures", attempts: 3, parked: true }]
            : [],
        };
      };
      return dispatcher;
    },
  });
  const issuePath = join(setup.tracked.path, ".beads", "issues.jsonl");
  const trackerContents = '{"id":"tracked-three-failures","status":"open"}\n';
  await writeFile(issuePath, trackerContents);

  let patchPromise;
  const boardEvent = new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      { host: "127.0.0.1", port: setup.port, path: "/api/board/events" },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (data.includes(": heartbeat\n\n") && !patchPromise) {
            patchPromise = send(setup.port, {
              method: "PATCH",
              path: "/api/projects/tracked",
              body: JSON.stringify({ queueFailureLimit: 2 }),
              contentType: "application/json",
            });
          }
          if (!data.includes('data: {"type":"board","project":"tracked"}\n\n')) return;
          resolvePromise(data);
          response.destroy();
        });
      },
    );
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") rejectPromise(error);
    });
    request.end();
  });

  const data = await boardEvent;
  const patched = await patchPromise;
  assert.equal(patched.status, 200);
  assert.equal(JSON.parse(patched.text).queueFailureLimit, 2);
  assert.match(data, /event: board\ndata: \{"type":"board","project":"tracked"\}/);
  assert.deepEqual(boardEvents.notifications, ["tracked"]);
  assert.equal(await readFile(issuePath, "utf8"), trackerContents);
});

test("Git project onboarding initializes the selected external or in-repo tracker location", async (t) => {
  const { port, root, atelierStateDir, registryPath } = await serverFixture(t);
  const fakeBr = join(root, "br");
  await writeFile(fakeBr, "fixture\n");
  _setTrackerBrResolver(() => fakeBr);
  const calls = [];
  _setRunner(async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    await mkdir(join(options.cwd, ".beads"), { recursive: true });
    await writeFile(join(options.cwd, ".beads", "issues.jsonl"), "");
    return "";
  });

  const externalRepo = await gitProject(root, "external-choice", "none");
  const externalResponse = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({
      ...externalRepo,
      archetype: "full",
      tracker: "personal",
      trackerLocation: "external",
    }),
    contentType: "application/json",
  });
  assert.equal(externalResponse.status, 201);
  const external = JSON.parse(externalResponse.text);
  const externalTrackerPath = join(atelierStateDir, "trackers", external.name);
  assert.equal(external.trackerPath, externalTrackerPath);
  assert.equal(external.tracker, "personal");
  assert.equal(calls[0].cwd, externalTrackerPath);
  await assert.rejects(readFile(join(external.path, ".beads", "issues.jsonl")), /ENOENT/);

  const inRepo = await gitProject(root, "in-repo-choice", "none");
  const inRepoResponse = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({
      ...inRepo,
      archetype: "full",
      tracker: "committed",
      trackerLocation: "in-repo",
    }),
    contentType: "application/json",
  });
  assert.equal(inRepoResponse.status, 201);
  const inRepoCreated = JSON.parse(inRepoResponse.text);
  assert.equal("trackerPath" in inRepoCreated, false);
  assert.equal(inRepoCreated.tracker, "committed");
  assert.equal(calls[1].cwd, inRepo.path);
  assert.equal(await readFile(join(inRepo.path, ".beads", "issues.jsonl"), "utf8"), "");

  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.projects.find((project) => project.name === external.name).trackerPath, externalTrackerPath);
  assert.equal(
    "trackerPath" in stored.projects.find((project) => project.name === inRepoCreated.name),
    false,
  );
});

test("project onboarding rejects tracker location outside full-project choices", async (t) => {
  const { port, root } = await serverFixture(t);
  const candidate = await gitProject(root, "invalid-location", "none");
  for (const body of [
    { ...candidate, archetype: "full", trackerLocation: "somewhere" },
    { ...candidate, archetype: "git-only", trackerLocation: "external" },
  ]) {
    const response = await send(port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    assert.equal(response.status, 400);
  }
});

test("project PATCH rejects immutable, unknown, and registry-invalid fields", async (t) => {
  const { port, registry } = await serverFixture(t);
  for (const body of [
    { name: "renamed" },
    { path: "/tmp/replacement" },
    { mystery: true },
    { dispatchProfile: { maxTurns: 0 } },
    { defaultAgent: "missing" },
    { verifyCommands: "node --test" },
    { budgetUSDPerDay: 0 },
    { maxFixRounds: 0 },
    { reviewPolicy: "permissive" },
    { queueFailureLimit: 0 },
    { unpricedDispatchCapPerDay: 0 },
    { unpricedDispatchCapPerDay: 1.5 },
  ]) {
    const response = await send(port, {
      method: "PATCH",
      path: "/api/projects/tracked",
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    assert.equal(response.status, 400);
  }
  assert.equal(registry.projects[0].name, "tracked");
  assert.deepEqual(registry.projects[0].verifyCommands, []);
});

test("project probe lets validated .atelier.json defaults win over inference", async (t) => {
  const { port, root } = await serverFixture(t);
  const candidate = join(root, "configured");
  await mkdir(candidate);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: candidate });
  await writeFile(join(candidate, "Cargo.toml"), "[workspace]\nmembers = []\n");
  await writeFile(
    join(candidate, ".atelier.json"),
    JSON.stringify({
      name: "from-config",
      mainBranch: "release",
      verifyCommands: ["node --test"],
      warn: "no release commands",
      defaultAgent: "claude",
      dispatchProfile: { model: "opus", effort: "high", maxTurns: 80 },
      budgetUSDPerDay: 12.5,
      requireReview: true,
      reviewPolicy: "advisory",
      maxFixRounds: 5,
    }),
  );

  const response = await send(port, {
    method: "POST",
    path: "/api/projects/probe",
    body: JSON.stringify({ path: candidate }),
    contentType: "application/json",
  });
  assert.equal(response.status, 200);
  const inferred = JSON.parse(response.text).inferred;
  assert.equal(inferred.name, "from-config");
  assert.equal(inferred.mainBranch, "release");
  assert.deepEqual(inferred.verifyCommands, ["node --test"]);
  assert.equal(inferred.warn, "no release commands");
  assert.equal(inferred.defaultAgent, "claude");
  assert.deepEqual(inferred.dispatchProfile, { model: "opus", effort: "high", maxTurns: 80 });
  assert.equal(inferred.budgetUSDPerDay, 12.5);
  assert.equal(inferred.requireReview, true);
  assert.equal(inferred.reviewPolicy, "advisory");
  assert.equal(inferred.maxFixRounds, 5);
});

test("tracker-only creation initializes once, routes board writes, and gates git operations", async (t) => {
  const { port, root, dispatcher } = await serverFixture(t);
  const trackerPath = join(root, "notes");
  await mkdir(trackerPath);
  const calls = [];
  _setRunner(async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    if (args[0] === "init") {
      await mkdir(join(options.cwd, ".beads"), { recursive: true });
      await writeFile(join(options.cwd, ".beads", "issues.jsonl"), "");
      return "";
    }
    if (args[0] === "create") return "notes-1\n";
    return "";
  });
  const entry = {
    name: "notes",
    path: trackerPath,
    mainBranch: null,
    tracker: "personal",
    archetype: "tracker-only",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: [],
    warn: "",
    dispatchProfile: {},
  };

  const create = () =>
    send(port, {
      method: "POST",
      path: "/api/projects",
      body: JSON.stringify(entry),
      contentType: "application/json",
    });
  assert.equal((await create()).status, 201);
  assert.equal(calls.filter((call) => call.args[0] === "init").length, 1);
  assert.deepEqual(calls[0].args, ["init", "--prefix", "notes"]);
  assert.equal(calls[0].cwd, trackerPath);

  assert.equal((await send(port, { method: "DELETE", path: "/api/projects/notes" })).status, 200);
  assert.equal((await create()).status, 201);
  assert.equal(calls.filter((call) => call.args[0] === "init").length, 1);

  const boardCreate = await send(port, {
    method: "POST",
    path: "/api/projects/notes/create",
    body: JSON.stringify({ title: "Remember", desc: "A tracker-only task" }),
    contentType: "application/json",
  });
  assert.equal(boardCreate.status, 201);
  assert.deepEqual(JSON.parse(boardCreate.text), { id: "notes-1" });
  assert.equal(calls.find((call) => call.args[0] === "create").cwd, trackerPath);

  dispatcher._records.push({
    id: "notes-dispatch",
    project: "notes",
    state: "completed",
    verify: { state: "passed", steps: [] },
    merged: null,
  });
  const gated = await Promise.all([
    send(port, { path: "/api/projects/notes/queue" }),
    send(port, {
      method: "POST",
      path: "/api/dispatch",
      body: JSON.stringify({ project: "notes", prompt: "work", verify: true }),
      contentType: "application/json",
    }),
    send(port, {
      method: "POST",
      path: "/api/dispatch/notes-dispatch/merge",
      body: JSON.stringify({}),
      contentType: "application/json",
    }),
  ]);
  for (const response of gated) {
    assert.equal(response.status, 409);
    assert.match(response.text, /tracker-only project/);
  }
});

test("tracker-only creation reports a clear 409 when br is missing", async (t) => {
  const { port, root } = await serverFixture(t);
  const trackerPath = join(root, "missing-br");
  await mkdir(trackerPath);
  _setTrackerBrResolver(() => join(root, "not-installed", "br"));
  const response = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({
      name: "missing-br",
      path: trackerPath,
      mainBranch: null,
      tracker: "personal",
      archetype: "tracker-only",
      containerized: false,
      verifyMode: "worktree",
      verifyCommands: [],
      warn: "",
      dispatchProfile: {},
    }),
    contentType: "application/json",
  });
  assert.equal(response.status, 409);
  assert.match(response.text, /br is required.*not found/);
});

test("tracker-only creation without a path uses the Atelier-owned state directory", async (t) => {
  const { port, atelierStateDir } = await serverFixture(t);
  _setRunner(async (_file, args, options) => {
    assert.deepEqual(args, ["init", "--prefix", "inbox"]);
    await mkdir(join(options.cwd, ".beads"), { recursive: true });
    await writeFile(join(options.cwd, ".beads", "issues.jsonl"), "");
    return "";
  });
  const response = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({
      name: "inbox",
      mainBranch: null,
      tracker: "personal",
      archetype: "tracker-only",
      containerized: false,
      verifyMode: "worktree",
      verifyCommands: [],
      warn: "",
      dispatchProfile: {},
    }),
    contentType: "application/json",
  });
  assert.equal(response.status, 201);
  const project = JSON.parse(response.text);
  assert.equal(project.path, join(atelierStateDir, "trackers", "inbox"));
  assert.equal(await readFile(join(project.path, ".beads", "issues.jsonl"), "utf8"), "");
});

test("git-only projects expose dispatch and reject board tracker operations", async (t) => {
  const { port, degraded } = await serverFixture(t);
  degraded.archetype = "git-only";

  const board = await send(port, {
    method: "POST",
    path: "/api/projects/degraded/create",
    body: JSON.stringify({ title: "No board", desc: "Git only" }),
    contentType: "application/json",
  });
  assert.equal(board.status, 409);
  const queue = await send(port, { path: "/api/projects/degraded/queue" });
  assert.equal(queue.status, 200);
  assert.deepEqual(JSON.parse(queue.text), { enabled: false, unavailable: true });
  const dispatch = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "degraded", prompt: "work" }),
    contentType: "application/json",
  });
  assert.equal(dispatch.status, 202);
});

test("dispatch budget errors preserve override metadata in 409 JSON", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.dispatch = async ({ force } = {}) => {
    if (force === true) return { id: "dispatch-forced" };
    const error = new Error("daily budget reached ($2.50 of $2.00)");
    error.status = 409;
    error.budgetExceeded = true;
    error.spentUSD = 2.5;
    error.budgetUSD = 2;
    throw error;
  };

  const blocked = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "tracked", prompt: "budgeted work" }),
    contentType: "application/json",
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual(JSON.parse(blocked.text), {
    error: "daily budget reached ($2.50 of $2.00)",
    budgetExceeded: true,
    spentUSD: 2.5,
    budgetUSD: 2,
  });

  const forced = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "tracked", prompt: "budgeted work", force: true }),
    contentType: "application/json",
  });
  assert.equal(forced.status, 202);
  assert.equal(JSON.parse(forced.text).id, "dispatch-forced");
});

test("unpriced dispatch cap errors preserve count metadata in 409 JSON", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.dispatch = async ({ force } = {}) => {
    if (force === true) return { id: "dispatch-forced" };
    const error = new Error("daily unpriced dispatch cap reached (3 of 3)");
    error.status = 409;
    error.dispatchCountExceeded = true;
    error.dispatchesToday = 3;
    error.dispatchCap = 3;
    throw error;
  };

  const blocked = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "tracked", prompt: "unpriced work" }),
    contentType: "application/json",
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual(JSON.parse(blocked.text), {
    error: "daily unpriced dispatch cap reached (3 of 3)",
    dispatchCountExceeded: true,
    dispatchesToday: 3,
    dispatchCap: 3,
  });

  const forced = await send(port, {
    method: "POST",
    path: "/api/dispatch",
    body: JSON.stringify({ project: "tracked", prompt: "unpriced work", force: true }),
    contentType: "application/json",
  });
  assert.equal(forced.status, 202);
  assert.equal(JSON.parse(forced.text).id, "dispatch-forced");
});

test("merge route forwards the optional force flag and returns the updated record", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const audit = {
    forcedBy: "maintainer",
    reason: "Human authority accepts the open finding.",
    dispositionRef: "ticket-comment-75",
  };
  const response = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/merge",
    body: JSON.stringify({ force: true, ...audit }),
    contentType: "application/json",
  });

  assert.equal(response.status, 200);
  const record = JSON.parse(response.text);
  assert.equal(record.id, "dispatch-1");
  assert.equal(record.merged.commit, "forced");
  assert.deepEqual(dispatcher._merges, [{
    id: "dispatch-1",
    force: true,
    ...audit,
    actor: "api",
  }]);
});

test("main-health API lists and persistently acknowledges unresolved failures", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher._records[0].postMerge = {
    state: "failed",
    commit: "abcdef1234567890",
    evidenceTail: "not ok 1",
  };

  const listed = await send(port, { path: "/api/projects/tracked/main-health" });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    JSON.parse(listed.text).unresolvedFailures.map(({ id }) => id),
    ["dispatch-1"],
  );

  const acknowledged = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/ack-main-health",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(
    JSON.parse(acknowledged.text).postMerge.acknowledgedAt,
    "2026-07-22T12:00:00.000Z",
  );
});

test("review route creates a linked read-only dispatch and forwards force", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const response = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/review",
    body: JSON.stringify({ force: true }),
    contentType: "application/json",
  });

  assert.equal(response.status, 202);
  assert.deepEqual(JSON.parse(response.text), {
    id: "review-dispatch",
    project: "tracked",
    state: "queued",
    reviewOf: "dispatch-1",
    readOnly: true,
  });
  assert.deepEqual(dispatcher._reviews, [{ id: "dispatch-1", force: true, actor: "api" }]);
});

test("review disposition API requires and round-trips an explicit human actor", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const body = {
    findingRef: "round-2:finding-3",
    disposition: "redirected",
    redirectTicket: "atelier-gg0",
    note: "This subsystem is owned by the redirect ticket.",
    actor: "maintainer",
  };
  const response = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/review-disposition",
    body: JSON.stringify(body),
    contentType: "application/json",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(dispatcher._reviewDispositions, [{ id: "dispatch-1", ...body }]);
  assert.deepEqual(JSON.parse(response.text).reviewDispositions[0], {
    ref: "disposition-1",
    ...body,
    at: "2026-07-31T00:00:00.000Z",
  });

  const supersedingBody = {
    ...body,
    disposition: "waived",
    redirectTicket: undefined,
    note: "The architect explicitly waives this finding.",
  };
  const superseding = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/review-disposition",
    body: JSON.stringify(supersedingBody),
    contentType: "application/json",
  });
  assert.equal(superseding.status, 200);
  assert.deepEqual(
    JSON.parse(superseding.text).reviewDispositions.map(({ ref, disposition }) => ({
      ref,
      disposition,
    })),
    [
      { ref: "disposition-1", disposition: "redirected" },
      { ref: "disposition-2", disposition: "waived" },
    ],
    "the API appends a superseding ruling without rewriting history",
  );

  const missingActor = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/review-disposition",
    body: JSON.stringify({ ...body, actor: undefined }),
    contentType: "application/json",
  });
  assert.equal(missingActor.status, 400);
  assert.match(JSON.parse(missingActor.text).error, /actor/);
});

test("verify route admits a re-run, reports it as started, and rejects unknown fields", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const admitted = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/verify",
    body: JSON.stringify({}),
    contentType: "application/json",
  });

  // 202, not 200: the response says the attempt is running, not that it passed.
  assert.equal(admitted.status, 202);
  assert.equal(JSON.parse(admitted.text).state, "verifying");
  assert.equal(JSON.parse(admitted.text).verify.attempt, 2);
  assert.deepEqual(dispatcher._verifyReruns, ["dispatch-1"]);

  const rejected = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/verify",
    body: JSON.stringify({ force: true }),
    contentType: "application/json",
  });
  assert.equal(rejected.status, 400);
  assert.match(JSON.parse(rejected.text).error, /Unknown verification fields: force/);

  const unknown = await send(port, {
    method: "POST",
    path: "/api/dispatch/missing/verify",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(unknown.status, 404);
  assert.deepEqual(dispatcher._verifyReruns, ["dispatch-1"]);
});

test("dismiss route delegates terminal cleanup and returns the updated record", async (t) => {
  const { port } = await serverFixture(t);
  const response = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/dismiss",
    body: JSON.stringify({}),
    contentType: "application/json",
  });

  assert.equal(response.status, 200);
  const record = JSON.parse(response.text);
  assert.equal(record.id, "dispatch-1");
  assert.deepEqual(record.dismissed, { at: "2026-07-21T12:30:00.000Z" });
});

test("deregistered dispatch APIs preserve history and reject mutations with 404", async (t) => {
  const dispatcher = dispatcherStub();
  dispatcher._records.splice(0, dispatcher._records.length, {
    id: "orphan-dispatch",
    project: "removed-project",
    state: "completed",
    projectRemoved: true,
    worktreePath: null,
    merged: null,
    dismissed: null,
  });
  dispatcher.rollup = () => ({
    projects: [{ project: "removed-project", projectRemoved: true, runs: 1 }],
    days: [],
    totals: { runs: 1, turns: 0, costUSD: 0 },
  });
  const removed = () => {
    const error = new Error("Project removed: removed-project");
    error.status = 404;
    throw error;
  };
  // stop and merge still need project config to do anything and 404 exactly
  // as before. dismiss is excluded here (atelier-2nx): a terminal record's
  // dismissal no longer needs its project registered, so the real dispatcher
  // never throws this error from dismiss - see server/lib/dispatch.test.mjs
  // for that behavior at the dispatcher layer, and the "dismisses a terminal
  // dispatch" test elsewhere in this file for the HTTP route on a live record.
  dispatcher.stop = removed;
  dispatcher.merge = removed;
  const { port } = await serverFixture(t, { dispatcher });

  const [history, rollup] = await Promise.all([
    send(port, { path: "/api/dispatches" }),
    send(port, { path: "/api/rollup" }),
  ]);
  assert.equal(JSON.parse(history.text)[0].projectRemoved, true);
  assert.equal(JSON.parse(rollup.text).projects[0].projectRemoved, true);

  for (const action of ["stop", "merge"]) {
    const response = await send(port, {
      method: "POST",
      path: `/api/dispatch/orphan-dispatch/${action}`,
      body: "{}",
      contentType: "application/json",
    });
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.text), { error: "Project removed: removed-project" });
  }

  const dismissResponse = await send(port, {
    method: "POST",
    path: "/api/dispatch/orphan-dispatch/dismiss",
    body: "{}",
    contentType: "application/json",
  });
  assert.equal(dismissResponse.status, 200);
  assert.equal(JSON.parse(dismissResponse.text).dismissed !== null, true);
});

test("reply route validates its text cap and delegates to the dispatcher", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const response = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/reply",
    body: JSON.stringify({ text: "continue from here" }),
    contentType: "application/json",
  });

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).replyText, "continue from here");
  assert.deepEqual(dispatcher._replies, [
    { id: "dispatch-1", text: "continue from here" },
  ]);

  await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/reply",
    body: JSON.stringify({ text: "override budget", force: true }),
    contentType: "application/json",
  });
  assert.deepEqual(dispatcher._replies.at(-1), {
    id: "dispatch-1",
    text: "override budget",
    force: true,
  });

  for (const text of ["   ", "-leading-option", "x".repeat(32 * 1024 + 1)]) {
    const rejected = await send(port, {
      method: "POST",
      path: "/api/dispatch/dispatch-1/reply",
      body: JSON.stringify({ text }),
      contentType: "application/json",
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(dispatcher._replies.length, 2);
});

test("plan route delegates approve and revise actions through the resume endpoint", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const approve = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/plan",
    body: JSON.stringify({ action: "approve" }),
    contentType: "application/json",
  });
  const revise = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/plan",
    body: JSON.stringify({ action: "revise", text: "cover rollback" }),
    contentType: "application/json",
  });
  const forcedApprove = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/plan",
    body: JSON.stringify({ action: "approve", force: true }),
    contentType: "application/json",
  });

  assert.equal(approve.status, 200);
  assert.equal(JSON.parse(approve.text).planAction, "approve");
  assert.equal(revise.status, 200);
  assert.equal(JSON.parse(revise.text).planAction, "revise");
  assert.equal(forcedApprove.status, 200);
  assert.deepEqual(dispatcher._plans, [
    { id: "dispatch-1", action: "approve", text: undefined, actor: "api" },
    { id: "dispatch-1", action: "revise", text: "cover rollback", actor: "api" },
    { id: "dispatch-1", action: "approve", text: undefined, force: true, actor: "api" },
  ]);

  const missing = await send(port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/plan",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(missing.status, 400);
});

test("convoy routes create, list, resume, and cancel batches", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  const created = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/convoy",
    body: JSON.stringify({ ticketIds: ["tracked-2", "tracked-3"] }),
    contentType: "application/json",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(JSON.parse(created.text).ticketIds, ["tracked-2", "tracked-3"]);

  const listed = await send(port, { path: "/api/convoys" });
  assert.equal(listed.status, 200);
  assert.equal(JSON.parse(listed.text).length, 2);

  dispatcher._convoys[1].state = "paused";
  const resumed = await send(port, {
    method: "POST",
    path: "/api/convoys/convoy-2/resume",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(JSON.parse(resumed.text).state, "running");
  const canceled = await send(port, {
    method: "POST",
    path: "/api/convoys/convoy-2/cancel",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(JSON.parse(canceled.text).state, "canceled");
});

test("open-editor routes use only server-resolved project and worktree paths", async (t) => {
  const unavailable = await serverFixture(t);
  const unconfigured = await send(unavailable.port, {
    method: "POST",
    path: "/api/projects/tracked/open-editor",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(unconfigured.status, 409);

  const calls = [];
  const spawner = (command, args, options) => {
    const child = new EventEmitter();
    child.unref = () => calls.at(-1).unrefed = true;
    calls.push({ command, args, options, unrefed: false });
    return child;
  };
  const configured = await serverFixture(t, { editorCommand: "code", spawner });
  const projectsPayload = JSON.parse((await send(configured.port, { path: "/api/projects" })).text);
  assert.equal(projectsPayload.editorConfigured, true);
  assert.equal("editorCommand" in projectsPayload, false);
  configured.dispatcher._records[0].worktreePath = configured.tracked.path;
  for (const path of [
    "/api/projects/tracked/open-editor",
    "/api/dispatch/dispatch-1/open-editor",
  ]) {
    const response = await send(configured.port, {
      method: "POST",
      path,
      body: JSON.stringify({}),
      contentType: "application/json",
    });
    assert.equal(response.status, 202);
  }
  assert.deepEqual(
    calls.map(({ command, args, options, unrefed }) => ({
      command,
      args,
      cwd: options.cwd,
      stdio: options.stdio,
      unrefed,
    })),
    [
      {
        command: "code",
        args: [configured.tracked.path],
        cwd: configured.tracked.path,
        stdio: "ignore",
        unrefed: true,
      },
      {
        command: "code",
        args: [configured.tracked.path],
        cwd: configured.tracked.path,
        stdio: "ignore",
        unrefed: true,
      },
    ],
  );
  for (const { options } of calls) {
    assert.equal(options.env.PATH, process.env.PATH);
    assert.equal(options.env.HOME, process.env.HOME);
  }

  const clientPath = await send(configured.port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/open-editor",
    body: JSON.stringify({ path: "/tmp/client-controlled" }),
    contentType: "application/json",
  });
  assert.equal(clientPath.status, 400);
  assert.equal(calls.length, 2);

  configured.dispatcher._records[0].worktreePath = join(configured.root, "missing-worktree");
  const missing = await send(configured.port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/open-editor",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(missing.status, 404);

  configured.dispatcher._records[0].worktreePath = null;
  const notReady = await send(configured.port, {
    method: "POST",
    path: "/api/dispatch/dispatch-1/open-editor",
    body: JSON.stringify({}),
    contentType: "application/json",
  });
  assert.equal(notReady.status, 409);
});

test("queue routes expose runtime state, toggles, and explicit ticket resumes", async (t) => {
  const { port, dispatcher, boardEvents } = await serverFixture(t);
  const current = await send(port, { path: "/api/projects/tracked/queue" });
  assert.equal(current.status, 200);
  assert.deepEqual(JSON.parse(current.text), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
  });

  const toggled = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/queue",
    body: JSON.stringify({ enabled: false }),
    contentType: "application/json",
  });
  assert.equal(toggled.status, 200);
  assert.equal(JSON.parse(toggled.text).enabled, false);

  const resumed = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/queue",
    body: JSON.stringify({ resumeTicketId: "tracked-1" }),
    contentType: "application/json",
  });
  assert.equal(resumed.status, 200);
  assert.deepEqual(dispatcher._resumedQueueTickets, [
    { name: "tracked", ticketId: "tracked-1" },
  ]);
  assert.deepEqual(
    boardEvents.notifications,
    ["tracked", "tracked"],
    "queue toggles and parking resumes invalidate live ready-work consumers",
  );

  dispatcher.resumeQueueTicket = () => {
    const error = new Error("Could not persist queue resume; ticket remains parked");
    error.status = 503;
    throw error;
  };
  const failedResume = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/queue",
    body: JSON.stringify({ resumeTicketId: "tracked-1" }),
    contentType: "application/json",
  });
  assert.equal(failedResume.status, 503);
  assert.deepEqual(JSON.parse(failedResume.text), {
    error: "Could not persist queue resume; ticket remains parked",
  });

  const unavailable = await send(port, { path: "/api/projects/degraded/queue" });
  assert.deepEqual(JSON.parse(unavailable.text), { enabled: false, unavailable: true });
});

test("move-tracker route moves both directions, smokes br, and returns user-owned next steps", async (t) => {
  const calls = [];
  const setup = await serverFixture(t, {
    commandRunner: async (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd });
      return "";
    },
    brExecutable: "/fixture/br",
  });
  for (const record of setup.dispatcher._records) record.state = "completed";

  const externalResponse = await send(setup.port, {
    method: "POST",
    path: "/api/projects/tracked/move-tracker",
    body: JSON.stringify({ to: "external" }),
    contentType: "application/json",
  });
  assert.equal(externalResponse.status, 200);
  const external = JSON.parse(externalResponse.text);
  const externalRoot = join(setup.atelierStateDir, "trackers", "tracked");
  assert.equal(external.project.trackerPath, externalRoot);
  assert.equal(external.project.tracker, "personal");
  assert.match(external.nextSteps, /Atelier never commits deletions/);
  assert.deepEqual(calls[0], { file: "/fixture/br", args: ["ready"], cwd: externalRoot });
  assert.equal(await readFile(join(externalRoot, ".beads", "issues.jsonl"), "utf8"), "");
  await assert.rejects(readFile(join(setup.tracked.path, ".beads", "issues.jsonl")), /ENOENT/);

  const inRepoResponse = await send(setup.port, {
    method: "POST",
    path: "/api/projects/tracked/move-tracker",
    body: JSON.stringify({ to: "in-repo" }),
    contentType: "application/json",
  });
  assert.equal(inRepoResponse.status, 200);
  const inRepo = JSON.parse(inRepoResponse.text);
  assert.equal("trackerPath" in inRepo.project, false);
  assert.equal(inRepo.project.tracker, "committed");
  assert.match(inRepo.nextSteps, /Atelier never git-adds or commits/);
  assert.deepEqual(calls[1], {
    file: "/fixture/br",
    args: ["ready"],
    cwd: setup.tracked.path,
  });
  assert.equal(await readFile(join(setup.tracked.path, ".beads", "issues.jsonl"), "utf8"), "");
  assert.equal(calls.some((call) => call.file === "git"), false);
  const stored = JSON.parse(await readFile(setup.registryPath, "utf8"));
  assert.equal("trackerPath" in stored.projects.find((project) => project.name === "tracked"), false);
});

test("move-tracker route refuses active dispatches and a running queue drain", async (t) => {
  const setup = await serverFixture(t, {
    commandRunner: async () => "",
    brExecutable: "/fixture/br",
  });
  const requestMove = () => send(setup.port, {
    method: "POST",
    path: "/api/projects/tracked/move-tracker",
    body: JSON.stringify({ to: "external" }),
    contentType: "application/json",
  });

  const active = await requestMove();
  assert.equal(active.status, 409);
  assert.match(active.text, /active dispatches/);

  for (const record of setup.dispatcher._records) record.state = "completed";
  setup.dispatcher._queueDraining.add("tracked");
  const draining = await requestMove();
  assert.equal(draining.status, 409);
  assert.match(draining.text, /running queue drain/);
  assert.equal(await readFile(join(setup.tracked.path, ".beads", "issues.jsonl"), "utf8"), "");
});

test("move-tracker route returns 409 and restores the old location after failed br smoke", async (t) => {
  const setup = await serverFixture(t, {
    commandRunner: async () => {
      throw new Error("br ready failed");
    },
    brExecutable: "/fixture/br",
  });
  for (const record of setup.dispatcher._records) record.state = "completed";

  const response = await send(setup.port, {
    method: "POST",
    path: "/api/projects/tracked/move-tracker",
    body: JSON.stringify({ to: "external" }),
    contentType: "application/json",
  });
  assert.equal(response.status, 409);
  assert.match(response.text, /move rolled back/);
  assert.equal(await readFile(join(setup.tracked.path, ".beads", "issues.jsonl"), "utf8"), "");
  const externalRoot = join(setup.atelierStateDir, "trackers", "tracked");
  await assert.rejects(readFile(join(externalRoot, ".beads", "issues.jsonl")), /ENOENT/);
  assert.equal("trackerPath" in setup.registry.projects[0], false);
  const stored = JSON.parse(await readFile(setup.registryPath, "utf8"));
  assert.equal("trackerPath" in stored.projects.find((project) => project.name === "tracked"), false);
});

test("rollup route returns the dispatcher aggregation", async (t) => {
  const { port } = await serverFixture(t);
  const response = await send(port, { path: "/api/rollup" });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    projects: [
      {
        project: "tracked",
        runs: 2,
        completed: 1,
        failed: 0,
        merged: 0,
        turns: 4,
        costUSD: 0.25,
      },
    ],
    days: [{ day: "2026-07-21", runs: 2, costUSD: 0.25 }],
    totals: { runs: 2, turns: 4, costUSD: 0.25 },
  });
});

test("agents route exposes registered adapter metadata and composer options", async (t) => {
  const { port } = await serverFixture(t);
  const response = await send(port, { path: "/api/agents" });

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), [
    {
      id: "claude",
      displayName: "Claude",
      capabilities: {
        liveStream: true,
        liveInput: true,
        canResume: true,
        reportsCost: true,
        commitsOwnWork: true,
      },
      options: {
        models: [
          { value: "sonnet", label: "Sonnet (5)" },
          { value: "sonnet[1m]", label: "Sonnet · 1M context" },
          { value: "opus", label: "Opus (4.8)" },
          { value: "opus[1m]", label: "Opus · 1M context" },
          { value: "haiku", label: "Haiku (4.5)" },
        ],
        efforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra high" },
          { value: "max", label: "Max" },
        ],
      },
    },
    {
      id: "codex",
      displayName: "Codex",
      capabilities: {
        liveStream: true,
        liveInput: false,
        canResume: true,
        reportsCost: false,
        commitsOwnWork: false,
      },
      options: {
        models: [],
        efforts: [],
        resolvedModel: "gpt-5.6-server-fixture",
      },
    },
  ]);
});

test("composer UI fetches agents and renders adapter-provided choices", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /api\("\/api\/agents"\)/);
  assert.match(app.text, /state\.agentsPromise/);
  assert.match(app.text, /agent\.displayName/);
  assert.match(app.text, /field\("Agent", lane\)/);
  assert.match(app.text, /modelField\.hidden = models\.length === 0/);
  assert.match(app.text, /effortField\.hidden = efforts\.length === 0/);
  assert.match(app.text, /Model: \$\{agent\.options\?\.resolvedModel \|\| "codex-default"\} — configured in ~\/\.codex\/config\.toml/);
  assert.match(app.text, /defaultAgent: agent\.value/);
  assert.match(app.text, /agent\.options\?\.models/);
  assert.match(app.text, /agent\.options\?\.efforts/);
  assert.match(app.text, /For one-offs and experiments\. Real work deserves a ticket/);
  assert.match(app.text, /Prompt comes from the ticket description and acceptance criteria/);
  assert.match(app.text, /Prompt comes from this ticket's description/);
  assert.match(app.text, /syncComposerGuidance\(composer, issue\.id\)/);
  assert.doesNotMatch(app.text, /const MODEL_CHOICES/);
  assert.doesNotMatch(app.text, /const EFFORT_CHOICES/);
});

test("composer keeps the resolved agent implicit until the user changes the select", async (t) => {
  const { port } = await serverFixture(t);
  const [app, selectionModule] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/agent-selection.mjs" }),
  ]);

  assert.equal(selectionModule.status, 200);
  assert.match(app.text, /composerAgentId\(project, agentList\)/);
  assert.match(app.text, /let laneTouched = false/);
  assert.match(app.text, /lane\.addEventListener\("change", \(\) => \{\s+laneTouched = true/);
  assert.match(app.text, /dispatchLanePayload\(laneTouched, lane\.value\)/);
  assert.doesNotMatch(app.text, /\n\s+lane: lane\.value,/);
});

test("settings seeds its agent from defaultAgent before the project-owned legacy lane", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /settingsAgentId\(project, agentList\)/);
  assert.doesNotMatch(app.text, /profile\.lane \|\| project\.defaultAgent/);
  assert.match(app.text, /delete dispatchProfile\.lane/);
  assert.match(app.text, /defaultAgent: agent\.value/);
});

test("plan-preview UI is opt-in and exposes paused review actions", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /Plan first \(review before execution\)/);
  assert.match(app.text, /if \(planFirst\.control\.checked\) body\.planFirst = true/);
  assert.match(app.text, /agent\?\.id === "claude" && agent\.capabilities\?\.canResume === true/);
  assert.match(app.text, /"queued", "preparing", "running", "plan_ready", "verifying"/);
  assert.match(app.text, /element\("section", "plan-card panel"\)/);
  assert.match(app.text, /button\("Approve plan", "button primary"\)/);
  assert.match(app.text, /button\("Revise plan"\)/);
  assert.match(app.text, /\/plan`, \{/);
  assert.match(app.text, /\["status", "message", "reply", "plan"/);
  assert.match(app.text, /"plan_ready"/);
  assert.match(css.text, /\.state-chip\.state-plan_ready/);
  assert.match(css.text, /\.plan-card/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("transcript assets render raw lines with textContent and muted monospace styling", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.equal(app.status, 200);
  const rawBranch = app.text.match(
    /if \(event\.type === "message" && event\.kind === "raw"\) \{[\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(rawBranch);
  assert.match(rawBranch, /"transcript-event line-raw"/);
  assert.match(rawBranch, /wrapper\.textContent = stripAnsi\(event\.text \|\| ""\)/);
  assert.doesNotMatch(rawBranch, /innerHTML/);

  assert.equal(css.status, 200);
  const rawStyle = css.text.match(/\.line-raw \{[\s\S]*?\n\}/)?.[0];
  assert.ok(rawStyle);
  assert.match(rawStyle, /color: var\(--muted\)/);
  assert.match(rawStyle, /ui-monospace/);
});

test("transcript UI renders typed file cards and exposes the shared card legend", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.equal(app.status, 200);
  assert.match(app.text, /const TRANSCRIPT_CARD_LEGEND = \[/);
  for (const card of [
    "Assistant message",
    "Bash command",
    "Tool result",
    "File changes",
    "Your reply",
    "Raw log",
    "Verification",
  ]) {
    assert.match(app.text, new RegExp(`card: "${card}"`));
  }
  assert.match(app.text, /function transcriptLegendTable\(\)/);
  assert.match(app.text, /function openTranscriptLegend\(\)/);
  assert.match(app.text, /modalFrame\("Transcript", "Card legend", "transcript-legend"\)/);
  assert.match(app.text, /legend\.append\([\s\S]*?transcriptLegendTable\(\)/);
  assert.match(app.text, /button\("\?", "icon-button transcript-legend-toggle"\)/);
  assert.match(app.text, /"Open transcript card legend"/);
  assert.match(app.text, /event\.kind === "files"/);
  assert.match(app.text, /"transcript-event files-event"/);
  assert.doesNotMatch(app.text, /innerHTML/);

  assert.equal(css.status, 200);
  assert.match(css.text, /\.files-event \{/);
  assert.match(css.text, /\.transcript-legend-toggle \{/);
  assert.match(css.text, /\.transcript-legend-card \{/);
});

test("transcript cards expose distinct hierarchy and command outcome markers", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.equal(app.status, 200);
  assert.match(app.text, /"tool-truncated", "Truncated payload"/);
  assert.match(app.text, /failed \? " failed-result" : succeeded \? " success-result" : ""/);
  assert.match(app.text, /`exit-badge\$\{failed \? " danger" : " success"\}`/);
  assert.doesNotMatch(app.text, /innerHTML/);

  assert.equal(css.status, 200);
  for (const selector of [
    ".transcript-event.message-text",
    ".line-raw",
    ".tool-use",
    ".tool-result",
    ".tool-result.success-result",
    ".tool-result.failed-result",
    ".files-event",
    ".tool-truncated",
    ".exit-badge.danger",
  ]) {
    assert.match(css.text, new RegExp(`${selector.replaceAll(".", "\\.")} \\{`));
  }
  assert.match(app.text, /styleguideGroup\("Transcript activity"\)/);
  for (const token of ["--accent", "--info", "--success", "--danger"]) {
    assert.match(css.text, new RegExp(`var\\(${token}\\)`));
  }
});

test("dispatch UI consumes verification records and streams output as text nodes", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /"verify", "verify-output"/);
  assert.match(app.text, /record\.verify\?\.steps/);
  assert.match(app.text, /output\.append\(document\.createTextNode/);
  assert.doesNotMatch(
    app.text.match(/function updateVerificationEvent[\s\S]*?\n  \}/)?.[0] || "",
    /innerHTML/,
  );
  assert.match(css.text, /\.state-chip\.state-verifying/);
  assert.match(css.text, /\.verification-output/);
});

test("dispatch UI exposes linked spec reviews and the opt-in merge gate", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css, availability] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
    send(port, { path: "/reply-availability.mjs" }),
  ]);

  assert.match(app.text, /Run spec review/);
  assert.match(app.text, /\/review`, \{/);
  assert.match(app.text, /function reviewVerdict/);
  assert.match(app.text, /function renderReviewHistory/);
  assert.match(app.text, /Review trajectory/);
  assert.match(app.text, /finding count unavailable/);
  // The merge-gate and staleness helpers are pure, so they live in the served
  // availability module where ui/reply-availability.test.mjs asserts their
  // behavior directly; what matters here is that they are served and wired.
  assert.equal(availability.status, 200);
  const staleSource = availability.text.match(
    /export function reviewIsStale\(review, branchHead, reviewGateState = undefined\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(staleSource, "reviewIsStale helper must be served");
  const reviewIsStale = Function(
    `${staleSource.replace("export function", "function")}; return reviewIsStale;`,
  )();
  assert.equal(
    reviewIsStale({ verdict: "pass", reviewedHead: "old-head" }, "new-head"),
    true,
  );
  assert.equal(
    reviewIsStale({ verdict: "pass", reviewedHead: "same-head" }, "same-head"),
    false,
  );
  assert.equal(
    reviewIsStale(
      { verdict: "fail", reviewedHead: "old-head" },
      "new-head",
      "passed-with-dispositions",
    ),
    true,
  );
  assert.equal(reviewIsStale({ verdict: "fail", reviewedHead: "old-head" }, "new-head"), false);
  assert.match(availability.text, /review stale - re-review required/);
  assert.match(
    availability.text,
    /reviewIsStale\(record\.review, record\.branchHead, acceptedState\)/,
  );
  assert.match(availability.text, /project\?\.requireReview/);
  assert.match(app.text, /reviewIsStale/);
  assert.match(
    app.text,
    /event\.type === "review"\) \{\s*applyReviewEvent\(record, event\);\s*if \(event\.branchHead\) record\.branchHead = event\.branchHead;\s*if \(Array\.isArray\(event\.gates\)\) record\.gates = event\.gates;\s*else void refreshRecord\(\);/,
    "the dispatch detail stream must not retain the pending review gate after a round lands",
  );
  assert.match(
    app.text,
    /event\.type === "review-disposition"\) \{\s*applyReviewDispositionEvent\(record, event\);\s*updateRecordDisplay\(\);\s*void refreshRecord\(\);/,
    "the dispatch detail stream must apply disposition and gate fallbacks before refetch",
  );
  assert.match(app.text, /Require passing spec review before merge/);
  assert.match(app.text, /requireReview: requireReview\.control\.checked/);
  assert.match(app.text, /Review finding policy/);
  assert.match(app.text, /reviewPolicy: reviewPolicy\.value/);
  assert.match(app.text, /Maximum review fix rounds/);
  assert.match(app.text, /let maxFixRoundsEdited = false/);
  assert.match(app.text, /maxFixRounds\.addEventListener\("input"/);
  assert.match(
    app.text,
    /if \(maxFixRoundsEdited\) body\.maxFixRounds = Number\(maxFixRounds\.value\)/,
  );
  assert.doesNotMatch(
    app.text,
    /queueFailureLimit:[\s\S]{0,200}maxFixRounds: Number\(maxFixRounds\.value\)/,
  );
  assert.match(
    app.text,
    /"review", "review-disposition", "verify-rerun", "verify", "verify-output"/,
  );
  assert.match(app.text, /read-only review/);
  assert.match(css.text, /\.badge\.review-pass/);
  assert.match(css.text, /\.badge\.review-fail/);
  assert.match(css.text, /\.review-history-card/);
  assert.match(css.text, /\.review-trajectory/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("dispatch UI offers the verify re-run only where the server would accept it", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css, availability] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
    send(port, { path: "/reply-availability.mjs" }),
  ]);

  assert.match(app.text, /Re-run verify/);
  assert.match(app.text, /\/verify`, \{/);
  assert.match(app.text, /verifyRerunAvailability\(record, rerunProject\)/);
  assert.match(app.text, /event\.type === "verify-rerun"/);
  assert.match(app.text, /function verificationAttemptRows/);
  // The eligibility contract itself is pure and served, so the button and the
  // dispatcher gate cannot drift apart silently.
  assert.equal(availability.status, 200);
  const source = availability.text.match(
    /export function verifyRerunAvailability\(record, project\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(source, "verifyRerunAvailability helper must be served");
  const verifyRerunAvailability = Function(
    `${source.replace("export function", "function")}; return verifyRerunAvailability;`,
  )();
  const project = { verifyMode: "worktree", verifyCommands: ["node --test"] };
  const stranded = { state: "completed", verify: { state: "failed" }, worktreePath: "/w/dispatch-1" };
  assert.equal(verifyRerunAvailability(stranded, project).available, true);
  for (const record of [
    { ...stranded, verify: { state: "passed" } },
    { ...stranded, state: "needs_input", verify: { state: "skipped" } },
    { ...stranded, merged: { commit: "abc1234" } },
    { ...stranded, reviewOf: "dispatch-target" },
    { ...stranded, worktreePath: null },
  ]) {
    assert.equal(verifyRerunAvailability(record, project).available, false);
  }
  assert.equal(
    verifyRerunAvailability(stranded, { verifyMode: "worktree", verifyCommands: [] }).available,
    false,
  );
  // The elapsed display reads the same latest-attempt clock GC uses.
  assert.match(app.text, /lastActivityAt\(record\)/);
  const activitySource = availability.text.match(
    /export function lastActivityAt\(record\) \{[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(activitySource, "lastActivityAt helper must be served");
  assert.match(css.text, /\.verification-attempts \{/);
  assert.match(css.text, /\.verification-header-actions \{/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("components module serves app-state-free DOM primitives", async (t) => {
  const { port } = await serverFixture(t);
  const components = await send(port, { path: "/components.mjs" });

  assert.equal(components.status, 200);
  assert.match(components.headers["content-type"], /^text\/javascript; charset=utf-8/);
  assert.match(components.text, /function element/);
  assert.match(components.text, /function badge/);
  assert.match(components.text, /function stateChip/);
  assert.match(components.text, /function button/);
  assert.doesNotMatch(components.text, /innerHTML/);
});

test("sidebar exposes add-project onboarding and a prominent fresh-install label", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /state\.projects\.length === 0 \? "Add your first project" : "\+ Add project"/);
  assert.match(app.text, /openAddProjectModal\(\)/);
  assert.match(app.text, /api\("\/api\/projects\/probe"/);
  assert.match(app.text, /function renderAddProjectConfirmation/);
  assert.match(app.text, /radioChoice\(\s+"archetype"/);
  assert.match(app.text, /Where does the tracker live\?/);
  assert.match(app.text, /Atelier-managed \(default\)/);
  assert.match(app.text, /Nothing is added to the repository; the tracker stays on this machine/);
  assert.match(app.text, /Inside the repository \(committed\)/);
  assert.match(app.text, /Syncs with teammates through Git and remains visible in the repository/);
  assert.match(app.text, /const mainBranch = document\.createElement\("select"\)/);
  assert.match(app.text, /Array\.isArray\(probe\.git\.branches\)/);
  assert.match(app.text, /Other \/ unborn branch…/);
  assert.match(app.text, /Remote HEAD:/);
  assert.match(app.text, /"onboarding-advanced wide"/);
  assert.match(app.text, /field\("Default agent", defaultAgent\)/);
  assert.match(app.text, /Inherit Atelier default/);
  assert.match(app.text, /withOnboardingDefaultAgent\(project, defaultAgent\.value\)/);
  assert.doesNotMatch(app.text, /defaultAgent: defaultAgent\.value/);
  assert.match(app.text, /"Daily budget \(USD\)"/);
  assert.match(app.text, /project\.autoCommitTracker = autoCommit\.control\.checked/);
  assert.match(app.text, /project\.autoCloseOnMerge = autoClose\.control\.checked/);
  assert.match(app.text, /project\.trackerLocation = selectedTrackerLocation\(\)/);
  assert.match(app.text, /api\("\/api\/projects", \{ method: "POST", body: project \}\)/);
  assert.doesNotMatch(app.text, /innerHTML/);
  assert.match(css.text, /\.add-project-confirm-form/);
  assert.match(css.text, /\.probe-facts/);
  assert.match(css.text, /\.tracker-location-choices/);
  assert.match(css.text, /\.radio-choice-copy/);
  assert.match(css.text, /\.onboarding-advanced-grid/);
});

test("project onboarding exposes a server-scoped folder explorer with manual path fallback", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /api\(`\/api\/fs\/dirs\$\{query\}`\)/);
  assert.match(app.text, /function renderDirectoryListing/);
  assert.match(app.text, /directory\.git/);
  assert.match(app.text, /directory\.beads/);
  assert.match(app.text, /Project path \(manual entry\)/);
  assert.match(app.text, /Absolute paths remain available as an escape hatch/);
  assert.doesNotMatch(app.text, /innerHTML/);
  assert.match(css.text, /\.directory-browser/);
  assert.match(css.text, /\.directory-breadcrumbs/);
  assert.match(css.text, /\.directory-list/);
});

test("the served cockpit assets know the unfinished outcome states", async (t) => {
  // atelier-8r6: the UI keeps its own copies of the terminal-state set, so a state
  // the server considers finished but app.js does not would render as live work
  // forever - and an unstyled chip would read as an ordinary completion.
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  const terminalSet = /const TERMINAL_STATES = new Set\(\[([^\]]*)\]\)/.exec(app.text);
  assert.ok(terminalSet, "app.js no longer declares TERMINAL_STATES");
  assert.match(terminalSet[1], /"needs_input"/);
  assert.match(terminalSet[1], /"completed_empty"/);
  // The styleguide inventory must render every state chip that can appear.
  const styleguideStates = /const STYLEGUIDE_DISPATCH_STATES = \[([^\]]*)\]/.exec(app.text);
  assert.ok(styleguideStates, "app.js no longer declares STYLEGUIDE_DISPATCH_STATES");
  assert.match(styleguideStates[1], /"needs_input"/);
  assert.match(styleguideStates[1], /"completed_empty"/);
  assert.match(css.text, /\.state-chip\.state-needs_input/);
  assert.match(css.text, /\.state-chip\.state-completed_empty/);
  // The verify panel's empty state comes from the shared pure contract, so a
  // deliberate skip shows its recorded reason rather than a false claim about the
  // project's configuration.
  // Passed the project too, so it can tell "no commands configured" from
  // "configured but skipped" instead of guessing (atelier-8r6 round 3).
  assert.match(app.text, /verificationEmptyMessage\(record, verifyProject\)/);
  assert.doesNotMatch(app.text, /\? "No verification commands configured\."/);
});

test("styleguide route exposes the living component inventory", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /function renderStyleguide/);
  assert.match(app.text, /"styleguide"/);
});

test("PWA manifest and atelier glyph are served from the static allowlist", async (t) => {
  const { port } = await serverFixture(t);
  const [index, manifestResponse, icon] = await Promise.all([
    send(port, { path: "/" }),
    send(port, { path: "/manifest.webmanifest" }),
    send(port, { path: "/icon.svg" }),
  ]);

  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers["content-type"], /^application\/manifest\+json; charset=utf-8/);
  const manifest = JSON.parse(manifestResponse.text);
  assert.deepEqual(
    {
      name: manifest.name,
      short_name: manifest.short_name,
      start_url: manifest.start_url,
      display: manifest.display,
      theme_color: manifest.theme_color,
      background_color: manifest.background_color,
    },
    {
      name: "Atelier",
      short_name: "Atelier",
      start_url: "/",
      display: "standalone",
      theme_color: "#4053c4",
      background_color: "#1c1f27",
    },
  );
  assert.deepEqual(manifest.icons, [
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
  ]);
  assert.equal(icon.status, 200);
  assert.match(icon.headers["content-type"], /^image\/svg\+xml; charset=utf-8/);
  assert.match(icon.text, /<circle cx="34"/);
  assert.match(icon.text, /<circle cx="94"/);
  assert.match(index.text, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(index.text, /rel="icon" type="image\/svg\+xml" href="\/icon\.svg"/);
  assert.match(index.text, /no service worker: offline is meaningless for a loopback tool/);
  assert.doesNotMatch(index.text, /serviceWorker\.register/);
});

test("keyboard shortcuts expose global navigation and a safe overlay", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /const SHORTCUTS = \[/);
  assert.match(app.text, /function handleGlobalShortcut/);
  assert.match(app.text, /function openShortcutsOverlay/);
  assert.match(app.text, /SHORTCUT_SEQUENCE_MS = 800/);
  assert.match(app.text, /window\.addEventListener\("keydown", handleGlobalShortcut\)/);
  assert.match(app.text, /target\.matches\("input, textarea, select"\)/);
  assert.match(app.text, /"Open all dispatches"/);
  assert.match(app.text, /"Open the styleguide"/);
  assert.match(app.text, /"Open the matching sidebar project"/);
  assert.match(app.text, /"Focus the board filter"/);
  assert.match(app.text, /"Open New dispatch"/);
  assert.match(app.text, /"Toggle this shortcuts overlay"/);
  assert.match(app.text, /element\("table", "shortcut-table"\)/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("dispatch UI gates normal merges and confirms force merges in-app", async (t) => {
  const { port } = await serverFixture(t);
  const [app, availability] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/reply-availability.mjs" }),
  ]);

  assert.match(app.text, /Approve & merge/);
  assert.match(availability.text, /export function mergeGateReasons/);
  assert.match(app.text, /mergeGateReasons\(record, project\)/);
  // The unresolved-orphan gate must reach the button through the same reason
  // list, so the normal merge disables while Force merge stays offered.
  assert.match(availability.text, /a prior worker could not be confirmed dead/);
  assert.match(app.text, /openForceMergeConfirmation/);
  assert.match(app.text, /modalFrame\("Override merge gates"/);
  assert.match(app.text, /body: \{ force, \.\.\.forceAudit \}/);
  assert.match(app.text, /forcedBy: forcedBy\.value\.trim\(\)/);
  assert.match(app.text, /dispositionRef: dispositionRef\.value\.trim\(\)/);
  assert.match(app.text, /badge\("merged", "merged"\)/);
  assert.match(app.text, /badge\("dismissed", "dismissed"\)/);
  assert.match(app.text, /openDismissConfirmation/);
  assert.match(app.text, /modalFrame\("Dispatch cleanup"/);
  assert.match(app.text, /\/dismiss`, \{/);
  assert.doesNotMatch(app.text, /window\.confirm/);
});

test("ticket close and dispatch history UI surface unmerged and removed-project warnings", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /function openTicketCloseConfirmation/);
  assert.match(app.text, /!record\.merged && !record\.dismissed/);
  assert.match(app.text, /has not been merged or dismissed/);
  assert.match(app.text, /badge\("project removed", "project-removed"\)/);
  assert.match(app.text, /projectRemovedBadge\.hidden = !record\.projectRemoved/);
});

test("project UI renders tracker-aware ready-queue controls", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /Ready-queue autonomy/);
  assert.match(app.text, /role", "switch"/);
  assert.match(app.text, /body: \{ enabled: !queue\.enabled \}/);
  assert.match(app.text, /body: \{ resumeTicketId: parked\.ticketId \}/);
  assert.match(app.text, /Queue failure limit/);
  assert.match(app.text, /queueFailureLimit: queueFailureLimit\.value/);
  assert.match(app.text, /auto-disabled after repeated failures - re-enable to reset/);
  assert.match(app.text, /badge\("no tracker", "tracker-none"\)/);
});

test("daily limit UI edits both ceilings and confirms structured force overrides in-app", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /Object\.assign\(error, payload\)/);
  assert.match(app.text, /function openBudgetConfirmation/);
  assert.match(app.text, /function isDispatchLimitError/);
  assert.match(app.text, /button\("Dispatch anyway", "button danger"\)/);
  assert.match(app.text, /This project has spent \$\{formatMoney\(error\.spentUSD\)\} of its \$\{formatMoney\(error\.budgetUSD\)\} daily budget/);
  assert.match(app.text, /field\(\s*"Daily budget \(USD\)"/);
  assert.match(app.text, /budgetUSDPerDay: dailyBudget\.value \? Number\(dailyBudget\.value\) : null/);
  assert.match(app.text, /field\(\s*"Unpriced dispatch cap\/day"/);
  assert.match(app.text, /unpricedDispatchCapPerDay: unpricedDispatchCap\.value/);
  assert.match(app.text, /This project has started \$\{error\.dispatchesToday\} of its \$\{error\.dispatchCap\} daily dispatches on lanes without reported cost/);
  assert.match(app.text, /error\.budgetExceeded === true \|\| error\.dispatchCountExceeded === true/);
  assert.match(app.text, /body: \{ \.\.\.body, force: true \}/);
  assert.match(app.text, /body: \{ text, \.\.\.\(force \? \{ force: true \} : \{\}\) \}/);
  assert.match(app.text, /await requestPlanContinuation\(action, true\)/);
  assert.doesNotMatch(app.text, /window\.confirm/);
});

test("project UI starts ordered convoys and renders progress controls", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /button\("Start convoy", "button compact"\)/);
  assert.match(app.text, /function openConvoyModal/);
  assert.match(app.text, /let readyForConvoy = readyIssuesFrom\(payload\)/);
  assert.match(app.text, /replaceReadyConsumers\(nextPayload/);
  assert.match(app.text, /const projection = boardProjection\(payload\)/);
  assert.match(app.text, /readyDegraded: projection\.readyDegraded/);
  assert.match(app.text, /badge\(readyDegraded\.label, "ready-degraded"\)/);
  assert.match(app.text, /indicator\.title = readyDegraded\.detail/);
  assert.match(app.text, /const creation = ticketCreationState\(payload\)/);
  assert.match(app.text, /if \(creation\.available\) return renderCreatePanel\(project\)/);
  assert.match(app.text, /"git-state-card tracker-unavailable-card"/);
  assert.match(app.text, /renderTicketCreationControl\(project, payload\)/);
  assert.match(app.text, /title: "Not Ready"/);
  assert.match(app.text, /nonReadyIssueLabel\(issue, \{ issues: byId, parkedTickets \}\)/);
  assert.doesNotMatch(app.text, /archetype === "git-only" \|\| payload\.degraded/);
  assert.doesNotMatch(app.text, /function convoyReadyIssues/);
  assert.match(app.text, /Select 2-20 ready tickets and arrange their exact dispatch order/);
  assert.match(app.text, /body: \{ ticketIds \}/);
  assert.match(app.text, /function renderConvoyProgress/);
  assert.match(app.text, /`\$\{position\}\/\$\{total\}`/);
  assert.match(app.text, /\/resume`, \{/);
  assert.match(app.text, /\/cancel`, \{/);
  assert.match(app.text, /badge\(`convoy \$\{record\.batchSeq\}`/);
  assert.match(app.text, /badge\("convoy 2", "convoy"\)/);
  assert.match(css.text, /\.badge\.convoy/);
  assert.match(css.text, /\.convoy-strip/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("ticket and dispatch UI expose an opt-in cost-stated bake-off", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /button\("Bake-off…", "button compact secondary-action"\)/);
  assert.match(app.text, /This runs the ticket twice - two agents, two worktrees, roughly double tokens\./);
  assert.match(app.text, /lanes: \["claude", "codex"\]/);
  assert.match(app.text, /`bake-off sibling: \$\{sibling\.id\} →`/);
  assert.match(app.text, /bakeoff-group-start/);
  assert.match(app.text, /sibling \$\{bakeoffWinner\.id\} already merged - dismiss this attempt/);
  assert.match(app.text, /badge\("bake-off", "bakeoff"\)/);
  assert.match(css.text, /\.badge\.bakeoff/);
  assert.match(css.text, /\.dispatch-table \.bakeoff-row/);
  assert.doesNotMatch(app.text, /innerHTML/);
});

test("project UI exposes Board, Dispatches, and Settings tabs with onboarding audit hints", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /\["board", "Board"\]/);
  assert.match(app.text, /\["dispatches", "Dispatches"\]/);
  assert.match(app.text, /\["settings", "Settings"\]/);
  assert.match(app.text, /renderDispatchRows\(dispatchesContainer, projectDispatches\(\)\)/);
  assert.match(app.text, /settingsPanel\.append\(renderProjectSettings\(project, agentList, queue\)\)/);
  assert.match(app.text, /"Tracker location"/);
  assert.match(app.text, /button\("Move tracker"\)/);
  assert.match(app.text, /project\.trackerPath \|\| project\.path/);
  assert.match(app.text, /function openMoveTrackerConfirmation/);
  assert.match(app.text, /\/move-tracker`, \{/);
  assert.match(app.text, /body: \{ to \}/);
  assert.match(app.text, /Run br ready at the new location; any failure rolls back/);
  assert.match(app.text, /state\.trackerMoveNotes\.set\(project\.name, result\.nextSteps\)/);
  assert.match(app.text, /showToast\(result\.nextSteps, "success"\)/);
  assert.match(app.text, /"tracker-move-next-steps"/);
  assert.doesNotMatch(app.text, /window\.confirm/);
  assert.match(app.text, /method: "PATCH"/);
  assert.match(app.text, /A project named \$\{name\.value\.trim\(\)\} is already registered/);
  assert.match(app.text, /no build files recognized - add commands manually/);
  assert.doesNotMatch(app.text, /controls\.append\(renderQueueCard/);
});

test("project UI renders archetype badges and hides incompatible panels", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /function archetypeLabel/);
  assert.match(app.text, /function archetypeBadge/);
  assert.match(app.text, /hasExternalTracker\(project\) \? "FULL·EXT" : archetype/);
  assert.match(app.text, /External tracker: \$\{project\.trackerPath\}/);
  assert.match(app.text, /if \(archetype === "tracker-only"\) \{/);
  assert.match(app.text, /archetype === "full"[\s\S]*?\/queue/);
  assert.match(app.text, /archetypeLabel\(project\) !== "tracker-only"/);
  assert.match(app.text, /"No tracker configured\. Board panels are unavailable\."/);
  assert.match(css.text, /\.archetype-full/);
  assert.match(css.text, /\.archetype-git-only/);
  assert.match(css.text, /\.archetype-tracker-only/);
});

test("all-dispatches UI renders one-shot rollup totals, projects, and DOM bars", async (t) => {
  const { port } = await serverFixture(t);
  const app = await send(port, { path: "/app.js" });

  assert.match(app.text, /Promise\.all\(\[refreshDispatches\(\), api\("\/api\/rollup"\)\]\)/);
  assert.match(app.text, /function renderRollup/);
  assert.match(app.text, /formatMoney\(rollup\.totals\?\.costUSD\)/);
  assert.match(app.text, /element\("div", "rollup-bar"\)/);
  assert.match(app.text, /bar\.title = `\$\{day\.day\} \$\{formatMoney\(cost\)\}`/);
  assert.doesNotMatch(app.text, /createElement\(["'](?:canvas|svg)["']\)/);
});

test("notification UI persists opt-in and serves the behavioral notifier module", async (t) => {
  const { port } = await serverFixture(t);
  const [index, app, notifications] = await Promise.all([
    send(port, { path: "/" }),
    send(port, { path: "/app.js" }),
    send(port, { path: "/notifications.mjs" }),
  ]);

  assert.match(index.text, /id="notification-toggle"/);
  assert.match(index.text, /role="switch"/);
  assert.match(app.text, /storageSet\("atelier-notify"/);
  assert.match(app.text, /Notification\.requestPermission\(\)/);
  assert.match(app.text, /createDesktopNotifier/);
  assert.equal(notifications.status, 200);
  assert.match(notifications.headers["content-type"], /text\/javascript/);
});

test("UI surfaces exact verification provenance and serves the DOM health renderer", async (t) => {
  const { port } = await serverFixture(t);
  const [app, healthModule, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/main-health.mjs" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /function verificationContextText/);
  assert.match(app.text, /Verified exact worktree HEAD/);
  assert.equal(healthModule.status, 200);
  assert.match(healthModule.text, /renderProjectMainHealth/);
  assert.match(app.text, /Post-merge main health/);
  assert.match(css.text, /\.post-merge-health/);
  assert.match(css.text, /\.main-health-banner-slot/);
});

test("UI polish assets keep board, transcript, theme, table, and phone contracts", async (t) => {
  const { port } = await serverFixture(t);
  const [index, app, css] = await Promise.all([
    send(port, { path: "/" }),
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(index.text, /name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(index.text, /id="sidebar-menu-toggle"/);
  assert.match(index.text, /id="appearance-toggle"/);
  assert.match(index.text, /id="world-theme-toggle"/);
  assert.match(index.text, /Dashboard \(built-in\)/);
  assert.match(index.text, /id="theme-host"/);
  assert.match(index.text, /id="theme-command-trigger"/);
  assert.match(app.text, /window\.setTimeout\(applyFilter, 150\)/);
  assert.match(app.text, /`Show all \(\$\{columnData\.issues\.length\}\)`/);
  assert.match(app.text, /function stripAnsi/);
  assert.match(app.text, /function renderToolUse/);
  assert.match(app.text, /function renderStatusTimeline/);
  assert.match(app.text, /"Model",\s+"Agent",\s+"Started",\s+"Elapsed"/);
  assert.match(app.text, /storageSet\("atelier-theme", next\)/);
  assert.match(app.text, /storageSet\("atelier-world-theme", selected\)/);
  assert.match(app.text, /await raceThemeGeneration\(import\(theme\.entryUrl\), token\)/);
  assert.match(app.text, /entryModule\.mount \?\? entryModule\.default/);
  assert.match(app.text, /entryModule\.dispose/);
  assert.match(app.text, /trackThemeCanvases\(generationRoot\)/);
  assert.match(app.text, /generation: token/);
  assert.match(app.text, /entryModule\.dispose\(token\)/);
  assert.match(app.text, /Theme cleanup failed/);
  assert.match(app.text, /await queueThemeTeardown\(lifecycle\)/);
  assert.match(app.text, /themeTeardownTail/);
  assert.doesNotMatch(app.text, /themeActivationTail/);
  assert.match(app.text, /controller: new AbortController\(\)/);
  assert.match(app.text, /signal: current\.controller\.signal/);
  assert.match(app.text, /fallBackToDashboard\(\)/);
  assert.match(app.text, /themeCommandTrigger\.addEventListener\("click", openCommandPalette\)/);
  assert.doesNotMatch(app.text, /innerHTML/);
  assert.match(css.text, /color-scheme: light dark/);
  assert.match(css.text, /light-dark\(/);
  assert.match(css.text, /:root\[data-theme="light"\]/);
  assert.match(css.text, /:root\[data-theme="dark"\]/);
  assert.match(css.text, /\.theme-top-strip/);
  assert.match(css.text, /\.theme-generation/);
  assert.match(css.text, /\.theme-host\[hidden\][\s\S]*?display: none/);
  assert.match(css.text, /body\.theme-active \.atelier-shell/);
  assert.match(css.text, /@media \(max-width: 880px\)/);
  assert.match(css.text, /scroll-snap-type: x mandatory/);
  assert.match(css.text, /@media \(max-width: 600px\)[\s\S]*?\.modal-root/);
});

test("create route validates type and priority before invoking tracker.createIssue", async (t) => {
  const { port } = await serverFixture(t);
  const calls = [];
  _setRunner(async (_file, args) => {
    calls.push(args);
    return args[0] === "create" ? "tracked-1\n" : "";
  });

  for (const body of [
    { title: "Title", desc: "Description", type: "feature" },
    { title: "Title", desc: "Description", type: "task", priority: "P9" },
  ]) {
    const response = await send(port, {
      method: "POST",
      path: "/api/projects/tracked/create",
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls.length, 0);

  const valid = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/create",
    body: JSON.stringify({
      title: "Title",
      desc: "Description",
      type: "chore",
      priority: "P2",
    }),
    contentType: "application/json",
  });
  assert.equal(valid.status, 201);
  assert.deepEqual(JSON.parse(valid.text), { id: "tracked-1" });
  assert.deepEqual(calls.find((args) => args[0] === "create"), [
    "create",
    "Title",
    "--description",
    "Description",
    "--type",
    "chore",
    "--silent",
    "--priority",
    "2",
  ]);

  const literal = '\"; echo pwned';
  const comment = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/comment",
    body: JSON.stringify({ id: "tracked-1", text: literal }),
    contentType: "application/json",
  });
  assert.equal(comment.status, 200);
  assert.deepEqual(
    calls.find((args) => args[0] === "comments"),
    ["comments", "add", "tracked-1", literal],
  );

  const closed = await send(port, {
    method: "POST",
    path: "/api/projects/tracked/close",
    body: JSON.stringify({ id: "tracked-1", reason: "MCP completed it" }),
    contentType: "application/json",
  });
  assert.equal(closed.status, 200);
  assert.deepEqual(
    calls.find((args) => args[0] === "close"),
    ["close", "tracked-1", "--reason", "MCP completed it"],
  );
  assert.equal(
    calls.filter((args) => args.join("\0") === ["sync", "--flush-only"].join("\0")).length,
    3,
  );
});

test("dispatch SSE has replay headers and an immediate heartbeat frame", async (t) => {
  const { port } = await serverFixture(t);
  const firstChunk = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/api/dispatch/dispatch-1/events" },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (!data.includes("\n\n")) return;
          resolvePromise({ headers: response.headers, chunk: data });
          response.destroy();
        });
      },
    );
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") rejectPromise(error);
    });
    request.end();
  });
  assert.match(firstChunk.headers["content-type"], /^text\/event-stream/);
  assert.equal(firstChunk.headers["cache-control"], "no-store");
  assert.match(firstChunk.chunk, /event: status/);

  const heartbeat = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/dispatch/dispatch-1/events",
        headers: { "Last-Event-ID": "1" },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (!data.includes("\n\n")) return;
          resolvePromise(data);
          response.destroy();
        });
      },
    );
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") rejectPromise(error);
    });
    request.end();
  });
  assert.match(heartbeat, /: heartbeat/);
});

test("board SSE emits the new channel shape and an immediate heartbeat", async (t) => {
  const { port, boardEvents } = await serverFixture(t);
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const firstConnection = await readSseReplay(port, "/api/board/events");
  const secondConnection = await readSseReplay(port, "/api/board/events");
  const firstHelloMatch = /^event: hello\ndata: (.+)\n\n/.exec(firstConnection);
  const secondHelloMatch = /^event: hello\ndata: (.+)\n\n/.exec(secondConnection);

  assert.ok(firstHelloMatch, "the hello event is written first");
  assert.ok(secondHelloMatch, "every board connection receives a hello event first");
  const firstHello = JSON.parse(firstHelloMatch[1]);
  const secondHello = JSON.parse(secondHelloMatch[1]);
  assert.equal(firstHello.type, "hello");
  assert.equal(firstHello.version, packageJson.version);
  assert.equal(new Date(firstHello.bootedAt).toISOString(), firstHello.bootedAt);
  assert.equal(secondHello.bootedAt, firstHello.bootedAt);

  const received = await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path: "/api/board/events" },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk.toString("utf8");
          if (!data.includes('data: {"type":"board","project":"tracked"}\n\n')) return;
          resolvePromise({ response, data });
          response.destroy();
        });
        setImmediate(() => boardEvents.emit({ type: "board", project: "tracked" }));
      },
    );
    request.on("error", (error) => {
      if (error.code !== "ECONNRESET") rejectPromise(error);
    });
    request.end();
  });

  assert.equal(received.response.statusCode, 200);
  assert.match(received.response.headers["content-type"] ?? "", /text\/event-stream/);
  assert.match(received.data, /^event: hello\ndata: /);
  assert.match(received.data, /: heartbeat\n\n/);
  assert.match(
    received.data,
    /event: board\ndata: \{"type":"board","project":"tracked"\}\n\n/,
  );
});

test("graceful shutdown ends SSE streams and closes board event resources", async (t) => {
  const boardEvents = boardEventsStub();
  let boardCloseCalls = 0;
  boardEvents.close = () => {
    boardCloseCalls += 1;
  };
  const server = createServer({
    registry: { version: 1, defaults: {}, groups: [], projects: [] },
    dispatcher: dispatcherStub(),
    boardEvents,
  });
  const { port } = await listenLoopback(server, 0);
  t.after(async () => {
    if (server.listening) await shutdownServer(server);
  });

  const openStream = (path) => new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ host: "127.0.0.1", port, path }, (response) => {
      response.on("data", (chunk) => {
        if (chunk.toString("utf8").includes(": heartbeat\n\n")) resolvePromise(response);
      });
    });
    request.on("error", rejectPromise);
    request.end();
  });
  const [dispatchStream, boardStream] = await Promise.all([
    openStream("/api/dispatches/events"),
    openStream("/api/board/events"),
  ]);
  const streamsEnded = Promise.all([
    once(dispatchStream, "end"),
    once(boardStream, "end"),
  ]);

  await shutdownServer(server);
  await streamsEnded;

  assert.equal(boardCloseCalls, 1);
  assert.equal(server.listening, false);
});

test("graceful shutdown asks the dispatcher to stop children and awaits it", async () => {
  let releaseDispatcher;
  let receivedGraceMs;
  let eventLogFlushes = 0;
  const dispatcherStopped = new Promise((resolvePromise) => {
    releaseDispatcher = resolvePromise;
  });
  const dispatcher = {
    ...dispatcherStub(),
    shutdown({ graceMs }) {
      receivedGraceMs = graceMs;
      return dispatcherStopped;
    },
  };
  const server = createServer({
    registry: { version: 1, defaults: {}, groups: [], projects: [] },
    dispatcher,
    boardEvents: boardEventsStub(),
    eventLog: {
      append() {},
      _flush() {
        eventLogFlushes += 1;
      },
    },
  });
  await listenLoopback(server, 0);

  let settled = false;
  const stopping = shutdownServer(server, { timeoutMs: 100 }).then(() => {
    settled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(receivedGraceMs, 100);
  assert.equal(settled, false);
  assert.equal(eventLogFlushes, 0, "the log flush waits for shutdown lifecycle events");
  releaseDispatcher();
  await stopping;
  assert.equal(eventLogFlushes, 1);
  assert.equal(server.listening, false);
});

test("graceful shutdown stops accepting connections before the dispatcher's async shutdown resolves (finding 5)", async () => {
  let releaseDispatcher;
  const dispatcherStopped = new Promise((resolvePromise) => {
    releaseDispatcher = resolvePromise;
  });
  const dispatcher = {
    ...dispatcherStub(),
    shutdown() {
      return dispatcherStopped;
    },
  };
  const server = createServer({
    registry: { version: 1, defaults: {}, groups: [], projects: [] },
    dispatcher,
    boardEvents: boardEventsStub(),
  });
  const { port } = await listenLoopback(server, 0);

  const stopping = shutdownServer(server, { timeoutMs: 200 });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  // The dispatcher's own shutdown() (which is what runs the lane-asymmetric
  // dispatch sweep) is still pending here - never released. If the HTTP
  // server were still admitting connections at this point, SIGTERM would be
  // able to admit work after the sweep already started; server.close() must
  // already have run.
  await assert.rejects(send(port, { path: "/api/dispatches" }), /ECONNREFUSED/);

  releaseDispatcher();
  await stopping;
});

test("board SSE returns an injected boot stamp verbatim", async (t) => {
  const bootStamp = {
    version: "9.8.7-restarted",
    bootedAt: "2026-07-22T09:30:00.000Z",
  };
  const { port } = await serverFixture(t, { bootStamp });
  const connection = await readSseReplay(port, "/api/board/events");
  const helloMatch = /^event: hello\ndata: (.+)\n\n/.exec(connection);

  assert.ok(helloMatch, "the injected hello event is written first");
  assert.deepEqual(JSON.parse(helloMatch[1]), { type: "hello", ...bootStamp });
});

test("project board and sidebar consume board events while preserving board view state", async (t) => {
  const { port } = await serverFixture(t);
  const [app, css] = await Promise.all([
    send(port, { path: "/app.js" }),
    send(port, { path: "/atelier.css" }),
  ]);

  assert.match(app.text, /new EventSource\("\/api\/board\/events"\)/);
  assert.match(app.text, /source\.addEventListener\("hello"/);
  assert.match(app.text, /bootStamp\.version !== this\.bootStamp\.version/);
  assert.match(app.text, /bootStamp\.bootedAt !== this\.bootStamp\.bootedAt/);
  assert.match(app.text, /Atelier was updated - refresh to load the new interface/);
  assert.match(app.text, /addEventListener\("click", \(\) => location\.reload\(\)\)/);
  assert.match(app.text, /refreshBoardEvent\(event\)/);
  assert.match(app.text, /state\.boardEventHandler\?\.\(event, payload\)/);
  assert.match(app.text, /createBoardStreamGate/);
  assert.match(app.text, /resync: resyncBoardPayloads/);
  assert.match(app.text, /includeQueue: true/);
  assert.match(app.text, /parkedTickets = parkedTicketsFrom\(nextPayload, parkedTickets\)/);
  assert.match(app.text, /nextBoardGeneration\(state\.boardRequestGenerations, projectName\)/);
  assert.match(app.text, /acceptBoardGeneration\(/);
  assert.match(app.text, /refreshOpenConvoyEligibility\(nextReadyIssues\)/);
  assert.match(app.text, /controls\.selection\.disabled = !ready/);
  assert.match(app.text, /filterText: region\.querySelector/);
  assert.match(app.text, /boardScrollLeft/);
  assert.match(app.text, /body\.scrollTop = saved\.columns/);
  assert.match(app.text, /const refresh = button\("Refresh"\)/);
  assert.match(css.text, /\.board-count-chip/);
  assert.match(css.text, /\.ready-degraded/);
  assert.match(css.text, /\.toast-update\s*\{[^}]*pointer-events: auto;/s);
});

test("aggregate dispatch SSE uses composite ids and resumes per dispatch", async (t) => {
  const { port } = await serverFixture(t);

  const initial = await readSseReplay(port, "/api/dispatches/events");
  assert.match(initial, /id: dispatch-1:1\n/);
  assert.match(initial, /id: dispatch-2:1\n/);

  const resumed = await readSseReplay(port, "/api/dispatches/events", {
    "Last-Event-ID": "dispatch-1:1",
  });
  assert.doesNotMatch(resumed, /id: dispatch-1:1\n/);
  assert.match(resumed, /id: dispatch-2:1\n/);

  const malformed = await readSseReplay(port, "/api/dispatches/events", {
    "Last-Event-ID": "not-composite",
  });
  assert.match(malformed, /id: dispatch-1:1\n/);
  assert.match(malformed, /id: dispatch-2:1\n/);
});

test("aggregate dispatch SSE caps no-resume terminal replay but keeps active history", async (t) => {
  const emitter = new EventEmitter();
  const records = [
    { id: "active", state: "running", startedAt: "2026-07-21T01:01:00.000Z" },
    { id: "terminal", state: "completed", startedAt: "2026-07-21T01:00:00.000Z" },
  ];
  const dispatcher = {
    ...dispatcherStub(),
    list: () => records,
    getEvents: (id) => id === "active"
      ? [{ type: "status", state: "running", dispatchId: id, seq: 1 }]
      : Array.from({ length: 60 }, (_, index) => ({
        type: "status",
        state: "completed",
        dispatchId: id,
        seq: index + 1,
      })),
    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
  const { port } = await serverFixture(t, { dispatcher });

  const replay = await readSseReplay(port, "/api/dispatches/events");

  assert.match(replay, /id: active:1\n/);
  assert.doesNotMatch(replay, /id: terminal:10\n/);
  assert.match(replay, /id: terminal:11\n/);
  assert.match(replay, /id: terminal:60\n/);
  assert.equal((replay.match(/id: terminal:/g) || []).length, 50);
});

test("aggregate dispatch SSE treats needs_input and completed_empty as terminal history", async (t) => {
  // atelier-8r6: an unfinished outcome is terminal. Leaving it out of the server's
  // terminal set would put it in the uncapped ACTIVE replay - the aggregate view
  // would keep presenting a finished dispatch as live work.
  const emitter = new EventEmitter();
  const records = [
    { id: "asking", state: "needs_input", startedAt: "2026-07-21T01:02:00.000Z" },
    { id: "quiet", state: "completed_empty", startedAt: "2026-07-21T01:01:00.000Z" },
    { id: "active", state: "running", startedAt: "2026-07-21T01:00:00.000Z" },
  ];
  const dispatcher = {
    ...dispatcherStub(),
    list: () => records,
    getEvents: (id) => Array.from({ length: 40 }, (_, index) => ({
      type: "status",
      state: records.find((record) => record.id === id).state,
      dispatchId: id,
      seq: index + 1,
    })),
    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
  const { port } = await serverFixture(t, { dispatcher });

  const replay = await readSseReplay(port, "/api/dispatches/events");

  // Only the running dispatch keeps its full uncapped history; the two finished
  // outcomes share the 50-event terminal cap, so the oldest of them is trimmed.
  assert.equal((replay.match(/id: active:/g) || []).length, 40);
  assert.equal(
    (replay.match(/id: asking:/g) || []).length + (replay.match(/id: quiet:/g) || []).length,
    50,
  );
  assert.match(replay, /id: asking:40\n/);
  assert.doesNotMatch(replay, /id: quiet:1\n/);
});

test("aggregate dispatch SSE replays reply events with composite ids", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.getEvents = (id, since = 0) =>
    since < 2 ? [{ type: "reply", text: "continue", dispatchId: id, seq: 2 }] : [];

  const replay = await readSseReplay(port, "/api/dispatches/events");
  assert.match(replay, /id: dispatch-1:2\n/);
  assert.match(replay, /event: reply\n/);
  assert.match(replay, /"text":"continue"/);
});

test("aggregate dispatch SSE replays plan events with composite ids", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.getEvents = (id, since = 0) =>
    since < 3 ? [{ type: "plan", text: "Review this plan", dispatchId: id, seq: 3 }] : [];

  const replay = await readSseReplay(port, "/api/dispatches/events");
  assert.match(replay, /id: dispatch-1:3\n/);
  assert.match(replay, /event: plan\n/);
  assert.match(replay, /"text":"Review this plan"/);
});

test("aggregate dispatch SSE replays linked review verdicts with composite ids", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.getEvents = (id, since = 0) =>
    since < 4
      ? [{
          type: "review",
          reviewDispatchId: "review-1",
          verdict: "pass",
          summary: "Spec satisfied.",
          dispatchId: id,
          seq: 4,
        }]
      : [];

  const replay = await readSseReplay(port, "/api/dispatches/events");
  assert.match(replay, /id: dispatch-1:4\n/);
  assert.match(replay, /event: review\n/);
  assert.match(replay, /"reviewDispatchId":"review-1"/);
});

test("aggregate dispatch SSE replays post-merge main health failures", async (t) => {
  const { port, dispatcher } = await serverFixture(t);
  dispatcher.getEvents = (id, since = 0) =>
    since < 5
      ? [{
          type: "post-merge",
          phase: "end",
          state: "failed",
          commit: "abcdef1234567890",
          output: "combined suite failed",
          dispatchId: id,
          seq: 5,
        }]
      : [];

  const replay = await readSseReplay(port, "/api/dispatches/events");
  assert.match(replay, /id: dispatch-1:5\n/);
  assert.match(replay, /event: post-merge\n/);
  assert.match(replay, /"commit":"abcdef1234567890"/);
  assert.match(replay, /"output":"combined suite failed"/);
});

// atelier-tzw round 3 (I7): the regression net the exposedRecord()/publicRecord()
// split lacks on its own. getMainHealth() leaked every plumbing field straight out
// of GET /api/projects/:name/main-health for the whole of round 2 precisely
// because nothing walked the served surface as a whole - and the post-merge
// verifier's NESTED pair kept leaking out of all of them until atelier-kaz, for the
// same reason: nothing here knew to look for it.
const PLUMBING_FIELDS = [
  "codexJobId",
  "codexWorkspace",
  "codexWorkerPid",
  "codexWorkerPidIdentity",
  "childPid",
  "childPidIdentity",
  // atelier-yqk: the verification runner's fence is the same class of plumbing.
  "verifyPid",
  "verifyPidIdentity",
];

// atelier-kaz: the post-merge verifier's pair is NESTED inside `postMerge`, which
// every record-serving route hands out whole - so it leaked out of all of them
// until exposedRecord learned to copy-and-strip it. Substring names alone cannot
// express this one ("pid" appears inside "codexWorkerPid"), so it is asserted as
// a JSON key.
const NESTED_PLUMBING_KEYS = ['"pid":', '"pidIdentity":'];

// A stand-in agent child that starts and then simply stays running, so a route
// under test returns its record instead of racing the agent to a terminal state.
function heldAgentChild() {
  const child = new EventEmitter();
  child.stdin = { write() {}, end() {}, writable: true, destroyed: false, writableEnded: false };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test("no HTTP endpoint that serves a dispatch record ever exposes a fencing pid or workspace path (I7)", async (t) => {
  const workspace = join(tmpdir(), "atelier-i7-workspace");
  const mutatorRoot = join(tmpdir(), `atelier-i7-worktrees-${process.pid}`);
  const plumbing = {
    codexJobId: "codex-job-i7",
    codexWorkspace: workspace,
    // A live pid with NO persisted identity is the one case the boot pass must
    // RETAIN rather than clear (I1/I3), which is what keeps these fields on the
    // record for the whole test. It is also never signalled, so pointing it at
    // the test runner itself is safe.
    codexWorkerPid: process.pid,
    codexWorkerPidIdentity: null,
    childPid: process.pid,
    childPidIdentity: null,
    verifyPid: process.pid,
    verifyPidIdentity: null,
  };
  const base = {
    project: "tracked",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: null,
    worktreePath: null,
    startedAt: "2026-07-30T08:00:00.000Z",
    endedAt: "2026-07-30T08:05:00.000Z",
    turns: 1,
    costUSD: 0.25,
    sessionId: "i7-session",
    exitSummary: "done",
    strandedBrWrites: false,
    verify: null,
    merged: { commit: "abcdef1234567890", mergedAt: "2026-07-30T08:06:00.000Z", strategy: "ff" },
    dismissed: null,
    warnings: [],
    ...plumbing,
  };
  const records = [
    {
      ...base,
      id: "i7-main-health",
      postMerge: {
        state: "failed",
        commit: "abcdef1234567890",
        mergeCommit: "abcdef1234567890",
        queuedAt: "2026-07-30T08:06:00.000Z",
        error: "main health failed",
        steps: [],
        // Same trick as the pairs above: a live pid with no identity is retained
        // by the boot pass, so the nested fence stays on the record for the whole
        // sweep - and is never signalled.
        pid: process.pid,
        pidIdentity: null,
      },
    },
    { ...base, id: "i7-plain", postMerge: null },
    // Round 4 item 8: the six record-returning routes the walk did not reach.
    // These carry NO fence (a fenced record is refused by the reply/plan/merge
    // gates) - which costs the walk nothing, because publicRecord emits all six
    // keys unconditionally, so a leak shows up as the KEY being present whatever
    // its value.
    ...["i7-reply", "i7-plan", "i7-merge", "i7-review"].map((id) => ({
      ...base,
      ...Object.fromEntries(PLUMBING_FIELDS.map((field) => [field, null])),
      id,
      branch: `atelier/${id}`,
      worktreePath: join(mutatorRoot, id),
      merged: null,
      postMerge: null,
      state: id === "i7-plan" ? "plan_ready" : "completed",
      endedAt: id === "i7-plan" ? null : "2026-07-30T08:05:00.000Z",
      ...(id === "i7-plan" ? { plan: { state: "ready", text: "do the thing" } } : {}),
      ...(id === "i7-merge" ? { verify: { state: "passed", steps: [] } } : {}),
      ...(id === "i7-review" ? { prompt: "the original task, persisted" } : {}),
    })),
  ];

  t.after(async () => {
    _setDispatchSpawner();
    _setDispatchRunFile();
    _setDispatchProbe();
    await rm(mutatorRoot, { recursive: true, force: true });
  });
  _setDispatchProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setDispatchSpawner(() => heldAgentChild());
  _setDispatchRunFile(async (file, args) => {
    if (args?.[2] === "worktree" && args?.[3] === "add") {
      mkdirSync(args[6], { recursive: true });
      return "";
    }
    if (args?.[2] === "rev-parse" && args?.[3] === "--verify") return "validated-head\n";
    if (args?.[2] === "rev-parse") return "abcdef1234567890\n";
    if (args?.[2] === "diff") return "diff --git a/x b/x\n+one line\n";
    return "";
  });

  const { port, atelierStateDir } = await serverFixture(t, {
    dispatcher: ({ registry, atelierStateDir: stateDirectory }) => {
      mkdirSync(join(stateDirectory, "dispatches"), { recursive: true });
      writeFileSync(
        join(stateDirectory, "dispatches", "index.jsonl"),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        "utf8",
      );
      for (const record of records) {
        if (record.worktreePath) mkdirSync(record.worktreePath, { recursive: true });
      }
      return createDispatcher({ registry, stateDir: stateDirectory });
    },
  });

  // Guard the guard, twice over: the sweep below proves nothing unless the
  // records really are carrying the plumbing while it runs.
  const persisted = readFileSync(
    join(atelierStateDir, "dispatches", "index.jsonl"),
    "utf8",
  );
  for (const field of PLUMBING_FIELDS) {
    assert.match(persisted, new RegExp(`"${field}":`), `${field} is not persisted at all`);
  }
  for (const key of NESTED_PLUMBING_KEYS) {
    assert.ok(persisted.includes(key), `${key} is not persisted at all`);
  }
  assert.match(persisted, new RegExp(`"childPid":${process.pid}`));
  assert.match(persisted, new RegExp(`"verifyPid":${process.pid}`));
  // orphanUnresolved is the public proof that the fence is STILL on the record
  // after boot (an uncorroborated live pid is retained, never cleared) - and
  // waiting for it also synchronises with the boot pass.
  for (let attempt = 0; ; attempt += 1) {
    const probe = await send(port, { path: "/api/dispatch/i7-main-health" });
    if (JSON.parse(probe.text).orphanUnresolved === true) break;
    assert.ok(attempt < 200, "the boot pass never retained the uncorroborated fence");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }

  const routes = [
    { path: "/api/dispatches" },
    { path: "/api/dispatch/i7-main-health" },
    { path: "/api/dispatch/i7-plain" },
    { path: "/api/projects/tracked/main-health" },
    { path: "/api/rollup" },
    { path: "/api/convoys" },
    { method: "POST", path: "/api/dispatch/i7-main-health/ack-main-health", body: "{}" },
    { method: "POST", path: "/api/dispatch/i7-plain/dismiss", body: "{}" },
    {
      method: "POST",
      path: "/api/dispatch",
      body: JSON.stringify({ project: "tracked", prompt: "i7 create path" }),
      status: 202,
    },
    {
      method: "POST",
      path: "/api/dispatch/i7-reply/reply",
      body: JSON.stringify({ text: "i7 reply path" }),
    },
    { method: "POST", path: "/api/dispatch/i7-reply/stop", body: "{}" },
    {
      method: "POST",
      path: "/api/dispatch/i7-plan/plan",
      body: JSON.stringify({ action: "approve" }),
    },
    { method: "POST", path: "/api/dispatch/i7-merge/merge", body: "{}" },
    { method: "POST", path: "/api/dispatch/i7-review/review", body: "{}", status: 202 },
  ];
  for (const route of routes) {
    const result = await send(port, {
      method: route.method ?? "GET",
      path: route.path,
      body: route.body,
      contentType: route.body === undefined ? undefined : "application/json",
    });
    assert.equal(
      result.status,
      route.status ?? 200,
      `${route.path} -> ${result.status}: ${result.text}`,
    );
    for (const field of [...PLUMBING_FIELDS, ...NESTED_PLUMBING_KEYS]) {
      assert.equal(
        result.text.includes(field),
        false,
        `${route.path} leaked ${field}: ${result.text.slice(0, 400)}`,
      );
    }
  }
  // The SSE surface carries events, not records - assert it stays that way.
  const replay = await readSseReplay(port, "/api/dispatches/events");
  for (const field of [...PLUMBING_FIELDS, ...NESTED_PLUMBING_KEYS]) {
    assert.equal(replay.includes(field), false, `the event stream leaked ${field}`);
  }
  // Proof the sweep looks at real payloads: main-health did serve the record.
  const mainHealth = await send(port, { path: "/api/projects/tracked/main-health" });
  const health = JSON.parse(mainHealth.text);
  assert.equal(health.state, "failed");
  assert.deepEqual(
    health.unresolvedFailures.map((record) => record.id),
    ["i7-main-health"],
  );
});

test("GET /api/logs reads the event log, filtered and bounded", async (t) => {
  const { port, atelierStateDir } = await serverFixture(t);
  const { createEventLog } = await import("./lib/event-log.mjs");
  const log = createEventLog({ stateDir: atelierStateDir });
  log.append("queue.drain", { project: "tracked", decision: "skipped", reason: "budget" });
  log.append("queue.drain", { project: "other", decision: "picked", ticketId: "other-1" });
  log.append("dispatch.transition", { project: "tracked", dispatchId: "d-1", to: "failed" });

  const all = await send(port, { path: "/api/logs" });
  assert.equal(all.status, 200);
  assert.deepEqual(
    JSON.parse(all.text).events.map(({ kind }) => kind),
    ["queue.drain", "queue.drain", "dispatch.transition"],
  );

  const byKind = await send(port, { path: "/api/logs?kind=queue.drain&project=other" });
  const filtered = JSON.parse(byKind.text).events;
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].ticketId, "other-1");

  const byDispatch = await send(port, { path: "/api/logs?dispatchId=d-1" });
  assert.deepEqual(
    JSON.parse(byDispatch.text).events.map(({ kind }) => kind),
    ["dispatch.transition"],
  );

  const bounded = await send(port, { path: "/api/logs?limit=1" });
  assert.deepEqual(
    JSON.parse(bounded.text).events.map(({ kind }) => kind),
    ["dispatch.transition"],
  );

  const future = await send(port, {
    path: `/api/logs?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
  });
  assert.deepEqual(JSON.parse(future.text).events, []);

  // A bounded response is not negotiable: the route rejects an over-cap limit
  // rather than serving the whole retention window.
  const overCap = await send(port, { path: "/api/logs?limit=5000" });
  assert.equal(overCap.status, 400);
  assert.match(JSON.parse(overCap.text).error, /between 1 and 1000/);
  const badSince = await send(port, { path: "/api/logs?since=yesterday-ish" });
  assert.equal(badSince.status, 400);
  assert.match(JSON.parse(badSince.text).error, /ISO-8601/);
  const dateOnly = await send(port, { path: "/api/logs?since=2026-07-30" });
  assert.equal(dateOnly.status, 400, "Date.parse-compatible non-timestamps are rejected");
  assert.match(JSON.parse(dateOnly.text).error, /ISO-8601/);
  const tooManyKinds = Array.from({ length: 17 }, (_, index) => `kind.${index}`).join(",");
  const overKinds = await send(port, {
    path: `/api/logs?kind=${encodeURIComponent(tooManyKinds)}`,
  });
  assert.equal(overKinds.status, 400);
  assert.match(JSON.parse(overKinds.text).error, /at most 16/);
});

test("GET /api/logs exposes the processing cap without truncating an in-cap result", async (t) => {
  const { createEventLog } = await import("./lib/event-log.mjs");
  const { port, eventLog } = await serverFixture(t, {
    eventLog: ({ atelierStateDir }) =>
      createEventLog({
        stateDir: atelierStateDir,
        maxBytes: 260,
        rotations: 5,
        maxScanBytes: 220,
      }),
  });
  for (let index = 0; index < 12; index += 1) {
    eventLog.append("service.sample", { index, detail: "x".repeat(80) });
    eventLog._flush();
  }

  const sparse = JSON.parse((await send(port, {
    path: "/api/logs?kind=does.not.exist&limit=1000",
  })).text);
  assert.deepEqual(sparse.events, []);
  assert.equal(sparse.truncated, true);

  const newest = JSON.parse((await send(port, {
    path: "/api/logs?kind=service.sample&limit=1",
  })).text);
  assert.equal(newest.events.length, 1);
  assert.equal(newest.events[0].index, 11);
  assert.equal(newest.truncated, undefined, "complete in-cap searches omit the warning");
});

test("a settings change is logged with its actor and a redacted field diff", async (t) => {
  const { port, atelierStateDir } = await serverFixture(t);
  const { createEventLog } = await import("./lib/event-log.mjs");

  const patched = await send(port, {
    method: "PATCH",
    path: "/api/projects/tracked",
    body: JSON.stringify({
      notes: "ANTHROPIC_API_KEY=sk-live-abcdefghijklmnopqrstu",
      budgetUSDPerDay: 12,
    }),
    contentType: "application/json",
    actor: "ui",
  });
  assert.equal(patched.status, 200);

  const events = createEventLog({ stateDir: atelierStateDir }).read({ kind: "registry.change" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "ui");
  assert.equal(events[0].action, "update");
  assert.equal(events[0].project, "tracked");
  assert.deepEqual(Object.keys(events[0].changes).sort(), ["budgetUSDPerDay", "notes"]);
  assert.deepEqual(events[0].changes.budgetUSDPerDay, { from: null, to: 12 });
  assert.match(events[0].changes.notes.to, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(events), /sk-live-abcdef/);
});

test("an unrecognized actor header degrades to api instead of being persisted", async (t) => {
  const { port, atelierStateDir } = await serverFixture(t);
  const { createEventLog } = await import("./lib/event-log.mjs");

  await send(port, {
    method: "PATCH",
    path: "/api/projects/tracked",
    body: JSON.stringify({ notes: "second" }),
    contentType: "application/json",
    actor: "Not A Valid Actor!",
  });
  const events = createEventLog({ stateDir: atelierStateDir }).read({ kind: "registry.change" });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, "api");
});

test("theme actor headers retain bounded theme:<id> provenance", async (t) => {
  const { port, atelierStateDir } = await serverFixture(t);
  const { createEventLog } = await import("./lib/event-log.mjs");

  const patched = await send(port, {
    method: "PATCH",
    path: "/api/projects/tracked",
    body: JSON.stringify({ notes: "changed from a first-party theme" }),
    contentType: "application/json",
    actor: "theme:forest-town",
  });
  assert.equal(patched.status, 200);
  const events = createEventLog({ stateDir: atelierStateDir }).read({ kind: "registry.change" });
  assert.equal(events[0].actor, "theme:forest-town");
});

test("every dispatch mutation route threads one validated actor context", async (t) => {
  const calls = [];
  const stub = dispatcherStub();
  stub._records[0].postMerge = { state: "failed", commit: "bad-main" };
  stub.dispatch = async (_body, context) => {
    calls.push(["dispatch", context]);
    return { id: "dispatch-1" };
  };
  for (const method of ["stop", "dismiss", "rerunVerification", "acknowledgePostMergeFailure"]) {
    stub[method] = async (id, context) => {
      calls.push([method, context]);
      return { ...stub.get(id), state: "completed" };
    };
  }
  for (const method of ["reply", "plan", "merge", "review"]) {
    stub[method] = async (id, options) => {
      calls.push([method, options]);
      return { ...stub.get(id), state: "completed" };
    };
  }
  const { port } = await serverFixture(t, { dispatcher: stub });
  const mutation = (path, body = {}, actor = "theme:forest-town") => send(port, {
    method: "POST",
    path,
    body: JSON.stringify(body),
    contentType: "application/json",
    actor,
  });

  await mutation("/api/dispatch", { project: "tracked", prompt: "ship it" });
  await mutation("/api/dispatch/dispatch-1/stop");
  await mutation("/api/dispatch/dispatch-1/reply", { text: "continue" });
  await mutation("/api/dispatch/dispatch-1/plan", { action: "approve" });
  await mutation("/api/dispatch/dispatch-1/merge", { force: false });
  await mutation("/api/dispatch/dispatch-1/review");
  await mutation("/api/dispatch/dispatch-1/verify");
  await mutation("/api/dispatch/dispatch-1/dismiss");
  await mutation("/api/dispatch/dispatch-1/ack-main-health");
  await mutation("/api/dispatch/dispatch-1/stop", {}, "Not A Valid Actor!");

  assert.deepEqual(
    calls.map(([method, context]) => [method, context.actor]),
    [
      ["dispatch", "theme:forest-town"],
      ["stop", "theme:forest-town"],
      ["reply", "theme:forest-town"],
      ["plan", "theme:forest-town"],
      ["merge", "theme:forest-town"],
      ["review", "theme:forest-town"],
      ["rerunVerification", "theme:forest-town"],
      ["dismiss", "theme:forest-town"],
      ["acknowledgePostMergeFailure", "theme:forest-town"],
      ["stop", "api"],
    ],
  );
});

test("queue toggles carry the requesting actor into the dispatcher", async (t) => {
  const toggles = [];
  const resumes = [];
  const stub = dispatcherStub();
  stub.setQueue = (name, { enabled }, options) => {
    toggles.push({ name, enabled, options });
    return { enabled, consecutiveFailures: 0, lastError: null, failureLimit: 2, parkedTickets: [] };
  };
  stub.resumeQueueTicket = (name, ticketId, options) => {
    resumes.push({ name, ticketId, options });
    return {
      enabled: true,
      consecutiveFailures: 0,
      lastError: null,
      failureLimit: 2,
      parkedTickets: [],
    };
  };
  const { port } = await serverFixture(t, { dispatcher: stub });

  await send(port, {
    method: "POST",
    path: "/api/projects/tracked/queue",
    body: JSON.stringify({ enabled: false }),
    contentType: "application/json",
    actor: "mcp",
  });
  await send(port, {
    method: "POST",
    path: "/api/projects/tracked/queue",
    body: JSON.stringify({ resumeTicketId: "tracked-1" }),
    contentType: "application/json",
  });
  assert.deepEqual(toggles, [{ name: "tracked", enabled: false, options: { actor: "mcp" } }]);
  assert.deepEqual(resumes, [
    { name: "tracked", ticketId: "tracked-1", options: { actor: "api" } },
  ]);
});

test("project add and remove are recorded with their actor", async (t) => {
  const { port, root, atelierStateDir } = await serverFixture(t);
  const { createEventLog } = await import("./lib/event-log.mjs");
  const candidate = await gitProject(root, "logged-project", "none");

  const created = await send(port, {
    method: "POST",
    path: "/api/projects",
    body: JSON.stringify({
      ...candidate,
      archetype: "git-only",
      notes: "openai_api_key=must-not-survive-removal",
    }),
    contentType: "application/json",
    actor: "cli",
  });
  assert.equal(created.status, 201);
  const removed = await send(port, {
    method: "DELETE",
    path: "/api/projects/logged-project",
    actor: "mcp",
  });
  assert.equal(removed.status, 200);

  const events = createEventLog({ stateDir: atelierStateDir }).read({ kind: "registry.change" });
  assert.deepEqual(
    events.map(({ action, project, actor }) => ({ action, project, actor })),
    [
      { action: "add", project: "logged-project", actor: "cli" },
      { action: "remove", project: "logged-project", actor: "mcp" },
    ],
  );
  // The add carries the registered entry as a field diff, so a later reader can
  // see WHAT was registered, not just that something was.
  assert.equal(events[0].changes.name.to, "logged-project");
  assert.equal(events[0].changes.archetype.to, "git-only");
  // Removal carries the full registration as from -> null, through the same
  // write-time redactor as additions and updates.
  assert.deepEqual(events[1].changes.name, { from: "logged-project", to: null });
  assert.deepEqual(events[1].changes.archetype, { from: "git-only", to: null });
  assert.equal(events[1].changes.notes.from, "openai_api_key=[redacted]");
  assert.doesNotMatch(JSON.stringify(events), /must-not-survive-removal/);
});
