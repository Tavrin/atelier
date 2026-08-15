import assert from "node:assert/strict";
import test from "node:test";

import { assessReview } from "../../../shared/review-assessment.mjs";
import { createLiveSource } from "../data/live.mjs";
import { mergeGateReasons } from "../state/gates.mjs";
import { VillageStore } from "../state/village.mjs";

const SNAPSHOT_AT = "2026-07-30T20:00:00.000Z";

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("live post-merge events refresh main health and ack responses quiet the bell", async (t) => {
  const merged = {
    id: "main-red",
    project: "atelier",
    ticketId: "atelier-main-red",
    title: "Main health projection",
    lane: "claude",
    model: "sonnet",
    state: "completed",
    merged: {
      commit: "abc1234",
      mergedAt: "2026-07-30T19:59:00.000Z",
    },
    postMerge: { state: "passed", commit: "abc1234" },
    gates: [
      { gate: "changes", state: "passed" },
      { gate: "verify", state: "passed" },
      { gate: "review", state: "passed" },
      { gate: "merge", state: "passed" },
      { gate: "main", state: "passed" },
    ],
  };
  let mainHealth = {
    project: "atelier",
    state: "passed",
    checksTotal: 1,
    unresolvedFailures: [],
    running: [],
  };
  let streamOptions = null;
  let streamCloses = 0;
  let mainHealthReads = 0;

  const routes = new Map([
    ["/api/projects", { projects: [{ name: "atelier", requireReview: true }] }],
    ["/api/dispatches", [merged]],
    ["/api/convoys", { convoys: [] }],
    ["/api/projects/atelier/chronicle", {
      project: "atelier",
      generatedAt: SNAPSHOT_AT,
      records: [{ id: merged.id, title: merged.title }],
      summary: { merges: 1 },
      truncated: false,
    }],
    ["/api/projects/atelier/state", {
      issues: [],
      readyIssues: [],
      tracker: "committed",
      degraded: false,
      generatedAt: SNAPSHOT_AT,
    }],
    ["/api/projects/atelier/queue", {
      enabled: true,
      unavailable: false,
      parkedTickets: [],
    }],
    ["/api/projects/atelier/artifacts", {
      project: "atelier",
      generatedAt: SNAPSHOT_AT,
      artifacts: [],
    }],
    ["/api/dispatch/main-red", merged],
  ]);

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects/atelier/main-health") {
      mainHealthReads += 1;
      return response(mainHealth);
    }
    assert.ok(routes.has(path), `unexpected live-source request: ${path}`);
    return response(routes.get(path));
  });

  const acknowledged = {
    ...merged,
    postMerge: {
      state: "failed",
      commit: "abc1234",
      acknowledgedAt: "2026-07-30T20:02:00.000Z",
    },
  };
  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async (path) => {
      assert.equal(path, "/api/dispatch/main-red/ack-main-health");
      return response(acknowledged);
    },
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() { streamCloses += 1; } };
    },
  };
  const source = await createLiveSource({ core, search: "?project=atelier" });
  const store = new VillageStore(await source.load());
  assert.equal(store.village.hall.dock.bellRinging, false);

  const changes = [];
  const unsubscribe = source.subscribe((event) => {
    changes.push(store.applyEvent(event));
  });
  mainHealth = {
    project: "atelier",
    state: "failed",
    checksTotal: 2,
    unresolvedFailures: [{
      ...merged,
      postMerge: {
        state: "failed",
        commit: "abc1234",
        acknowledgedAt: null,
      },
    }],
    running: [],
  };
  await streamOptions.onAggregateEvent({
    type: "post-merge",
    dispatchId: merged.id,
    state: "failed",
  });

  assert.equal(mainHealthReads, 2, "load plus the relevant event each read main health");
  assert.equal(store.village.hall.dock.bellRinging, true);
  assert.equal(changes.filter((change) => change?.kind === "merged").length, 0);

  store.applyMainHealthRecord(await source.ackMainHealth(merged.id));
  assert.equal(store.village.hall.dock.failures.length, 1);
  assert.equal(store.village.hall.dock.bellRinging, false);

  routes.set("/api/projects/atelier/state", {
    issues: [{ id: "atelier-new-ready", title: "Fresh notice", status: "open" }],
    readyIssues: [{ id: "atelier-new-ready", title: "Fresh notice", status: "open" }],
    tracker: "committed",
    degraded: false,
    generatedAt: "2026-07-30T20:03:00.000Z",
  });
  routes.set("/api/projects/atelier/queue", {
    enabled: true,
    unavailable: false,
    parkedTickets: [{ ticketId: "atelier-parked" }],
  });
  await streamOptions.onBoardEvent({ type: "board", project: "atelier" });

  assert.deepEqual(
    store.village.board.papers.map(({ id }) => id),
    ["atelier-new-ready"],
    "a healthy board stream replaces the notice-board ready snapshot",
  );
  assert.equal(store.village.board.warning, true, "the paired queue projection is refreshed too");
  assert.equal(changes.at(-1)?.kind, "board");
  unsubscribe();
  const deliveredAtUnmount = changes.length;
  await streamOptions.onBoardEvent({ type: "board", project: "atelier" });
  assert.equal(streamCloses, 1, "unmount closes the aggregate and board stream owner");
  assert.equal(
    changes.length,
    deliveredAtUnmount,
    "an async board refresh finishing after unmount cannot reach the village",
  );
});

test("consecutive review refetch failures preserve overflow identity and a blocked merge", async (t) => {
  const target = {
    id: "review-live-overflow",
    project: "atelier",
    ticketId: "atelier-overflow",
    title: "Preserve review overflow",
    lane: "codex",
    model: "gpt-5",
    state: "completed",
    branchHead: "reviewed-head",
    outcome: { changes: "changed" },
    verify: { state: "passed", steps: [] },
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    gates: [
      { gate: "changes", state: "passed" },
      { gate: "verify", state: "passed" },
      { gate: "review", state: "not-run" },
      { gate: "merge", state: "pending" },
      { gate: "main", state: "not-run" },
    ],
  };
  let streamOptions = null;
  let failedRefetches = 0;
  const routes = new Map([
    ["/api/projects", {
      projects: [{
        name: "atelier",
        requireReview: true,
        reviewPolicy: "strict",
        tracker: "committed",
      }],
    }],
    ["/api/dispatches", [target]],
    ["/api/convoys", { convoys: [] }],
    ["/api/projects/atelier/chronicle", {
      project: "atelier",
      generatedAt: SNAPSHOT_AT,
      records: [],
      summary: { merges: 0 },
      truncated: false,
    }],
    ["/api/projects/atelier/state", {
      issues: [],
      readyIssues: [],
      tracker: "committed",
      degraded: false,
      generatedAt: SNAPSHOT_AT,
    }],
    ["/api/projects/atelier/queue", {
      enabled: true,
      unavailable: false,
      parkedTickets: [],
    }],
    ["/api/projects/atelier/main-health", {
      project: "atelier",
      state: "passed",
      checksTotal: 0,
      unresolvedFailures: [],
      running: [],
    }],
    ["/api/projects/atelier/artifacts", {
      project: "atelier",
      generatedAt: SNAPSHOT_AT,
      artifacts: [],
    }],
  ]);

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === `/api/dispatch/${target.id}`) {
      failedRefetches += 1;
      return response({ error: "record unavailable" }, 503);
    }
    assert.ok(routes.has(path), `unexpected live-source request: ${path}`);
    return response(routes.get(path));
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=atelier" });
  const store = new VillageStore(await source.load());
  const unsubscribe = source.subscribe((event) => store.applyEvent(event));
  const findings = Array.from({ length: 10 }, (_, index) => ({
    ref: `round-1:finding-${index + 1}`,
    severity: "nit",
    file: `docs/file-${index + 1}.md`,
    line: index + 1,
    summary: `Structured finding ${index + 1}.`,
    novelty: "new",
  }));
  const findingOverflowText =
    "[BLOCKER] server/lib/dispatch.mjs:99 - Overflow identity must survive.";

  await streamOptions.onAggregateEvent({
    type: "review",
    dispatchId: target.id,
    reviewDispatchId: "review-live-round",
    reviewedHead: "reviewed-head",
    round: 1,
    at: "2026-07-30T20:04:00.000Z",
    verdict: "fail",
    summary: "One blocker overflowed the structured cap.",
    findingCount: 11,
    findings,
    findingsTruncated: true,
    findingOverflowCount: 1,
    findingOverflowSeverity: "blocker",
    findingOverflowSeverityCounts: { blocker: 1 },
    findingOverflowSeverities: ["blocker"],
    findingOverflowText,
    gates: [{ gate: "review", state: "failed" }],
  });

  const afterReview = store.recordById(target.id);
  assert.equal(afterReview.review.current.findingOverflowText, findingOverflowText);
  assert.deepEqual(
    assessReview(afterReview, store.project).findings.at(-1),
    {
      ref: "round-1:overflow-1",
      severity: "blocker",
      file: "server/lib/dispatch.mjs",
      line: 99,
      summary: "Overflow identity must survive.",
      novelty: "new",
      overflow: true,
      overflowText: findingOverflowText,
    },
  );
  assert.deepEqual(mergeGateReasons(afterReview, store.project), ["review failed"]);

  await streamOptions.onAggregateEvent({
    type: "review-disposition",
    dispatchId: target.id,
    reviewDispositions: [{
      ref: "disposition-overflow-1",
      findingRef: "round-1:overflow-1",
      disposition: "waived",
      note: "Attempted waiver cannot make a BLOCKER mergeable.",
      actor: "operator:test",
      at: "2026-07-30T20:05:00.000Z",
    }],
  });

  const afterDisposition = store.recordById(target.id);
  assert.equal(failedRefetches, 2);
  assert.equal(afterDisposition.review.current.findingOverflowText, findingOverflowText);
  assert.deepEqual(mergeGateReasons(afterDisposition, store.project), ["review failed"]);
  unsubscribe();
});

test("an A-B-A selection epoch discards a slow response from the first A", async (t) => {
  const projects = [
    { name: "project-a", requireReview: true },
    { name: "project-b", requireReview: true },
  ];
  let projectAStateReads = 0;
  let resolveStaleState;
  let streamOptions;

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects") return response({ projects });
    if (path === "/api/dispatches") return response([]);
    if (path === "/api/convoys") return response([]);

    const match = /^\/api\/projects\/(project-a|project-b)\/(.+)$/.exec(path);
    assert.ok(match, `unexpected live-source request: ${path}`);
    const [, project, projection] = match;
    if (projection === "chronicle") {
      return response({
        project,
        generatedAt: SNAPSHOT_AT,
        records: [],
        summary: { merges: 0 },
        truncated: false,
      });
    }
    if (projection === "state") {
      if (project === "project-a") {
        projectAStateReads += 1;
        if (projectAStateReads === 2) {
          return new Promise((resolvePromise) => {
            resolveStaleState = () => resolvePromise(response({
              issues: [{ id: "project-a-stale", status: "open" }],
              readyIssues: [{ id: "project-a-stale", status: "open" }],
              tracker: "committed",
              degraded: false,
              generatedAt: SNAPSHOT_AT,
            }));
          });
        }
      }
      return response({
        issues: [],
        readyIssues: [],
        tracker: "committed",
        degraded: false,
        generatedAt: SNAPSHOT_AT,
      });
    }
    if (projection === "queue") {
      return response({ enabled: true, unavailable: false, parkedTickets: [] });
    }
    if (projection === "main-health") {
      return response({
        project,
        state: "passed",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
      });
    }
    if (projection === "artifacts") {
      return response({ project, generatedAt: SNAPSHOT_AT, artifacts: [] });
    }
    assert.fail(`unexpected projection: ${projection}`);
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=project-a" });
  await source.load();
  const snapshots = [];
  const unsubscribe = source.subscribe((event) => snapshots.push(event));

  const staleRefresh = streamOptions.onBoardEvent({
    type: "board",
    project: "project-a",
  });
  assert.equal(typeof resolveStaleState, "function");
  const selectedB = await source.selectProject("project-b");
  assert.equal(selectedB.project.name, "project-b");
  const selectedA = await source.selectProject("project-a");
  assert.equal(selectedA.project.name, "project-a");

  resolveStaleState();
  await staleRefresh;

  assert.deepEqual(snapshots, []);
  unsubscribe();
});

test("a slow full-world resync cannot overwrite a project switch", async (t) => {
  const projects = [
    { name: "project-a", requireReview: true },
    { name: "project-b", requireReview: true },
  ];
  let projectAStateReads = 0;
  let resolveStaleState;
  let streamOptions;

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects") return response({ projects });
    if (path === "/api/dispatches") return response([]);
    if (path === "/api/convoys") return response([]);

    const match = /^\/api\/projects\/(project-a|project-b)\/(.+)$/.exec(path);
    assert.ok(match, `unexpected live-source request: ${path}`);
    const [, project, projection] = match;
    if (projection === "chronicle") {
      return response({
        project,
        generatedAt: SNAPSHOT_AT,
        records: [],
        summary: { merges: 0 },
        truncated: false,
      });
    }
    if (projection === "state") {
      if (project === "project-a") {
        projectAStateReads += 1;
        if (projectAStateReads === 2) {
          return new Promise((resolvePromise) => {
            resolveStaleState = () => resolvePromise(response({
              issues: [{ id: "project-a-stale", status: "open" }],
              readyIssues: [{ id: "project-a-stale", status: "open" }],
              tracker: "committed",
              degraded: false,
              generatedAt: SNAPSHOT_AT,
            }));
          });
        }
      }
      return response({
        issues: [{ id: `${project}-current`, status: "open" }],
        readyIssues: [{ id: `${project}-current`, status: "open" }],
        tracker: "committed",
        degraded: false,
        generatedAt: SNAPSHOT_AT,
      });
    }
    if (projection === "queue") {
      return response({ enabled: true, unavailable: false, parkedTickets: [] });
    }
    if (projection === "main-health") {
      return response({
        project,
        state: "passed",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
      });
    }
    if (projection === "artifacts") {
      return response({ project, generatedAt: SNAPSHOT_AT, artifacts: [] });
    }
    assert.fail(`unexpected projection: ${projection}`);
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=project-a" });
  await source.load();
  const snapshots = [];
  const unsubscribe = source.subscribe((event) => snapshots.push(event));

  const staleResync = streamOptions.resync();
  while (typeof resolveStaleState !== "function") {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  const selectedB = await source.selectProject("project-b");
  assert.equal(selectedB.project.name, "project-b");
  resolveStaleState();
  await staleResync;

  assert.deepEqual(snapshots, []);
  assert.match(source.describe().detail, /project-b selected/);
  unsubscribe();
});

test("overlapping board refreshes for one project apply only in generation order", async (t) => {
  let stateReads = 0;
  let resolveSlowState;
  let streamOptions;

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects") {
      return response({ projects: [{ name: "atelier", requireReview: true }] });
    }
    if (path === "/api/dispatches") return response([]);
    if (path === "/api/convoys") return response([]);
    if (path === "/api/projects/atelier/chronicle") {
      return response({
        project: "atelier",
        generatedAt: SNAPSHOT_AT,
        records: [],
        summary: { merges: 0 },
        truncated: false,
      });
    }
    if (path === "/api/projects/atelier/state") {
      stateReads += 1;
      if (stateReads === 2) {
        return new Promise((resolvePromise) => {
          resolveSlowState = () => resolvePromise(response({
            issues: [{ id: "atelier-stale", status: "open" }],
            readyIssues: [{ id: "atelier-stale", status: "open" }],
            tracker: "committed",
            degraded: false,
            generatedAt: SNAPSHOT_AT,
          }));
        });
      }
      return response({
        issues: stateReads === 1 ? [] : [{ id: "atelier-current", status: "open" }],
        readyIssues: stateReads === 1 ? [] : [{ id: "atelier-current", status: "open" }],
        tracker: "committed",
        degraded: false,
        generatedAt: SNAPSHOT_AT,
      });
    }
    if (path === "/api/projects/atelier/queue") {
      return response({ enabled: true, unavailable: false, parkedTickets: [] });
    }
    if (path === "/api/projects/atelier/main-health") {
      return response({
        project: "atelier",
        state: "passed",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
      });
    }
    if (path === "/api/projects/atelier/artifacts") {
      return response({ project: "atelier", generatedAt: SNAPSHOT_AT, artifacts: [] });
    }
    assert.fail(`unexpected live-source request: ${path}`);
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=atelier" });
  await source.load();
  const snapshots = [];
  const unsubscribe = source.subscribe((event) => snapshots.push(event));

  const slow = streamOptions.onBoardEvent({ type: "board", project: "atelier" });
  assert.equal(typeof resolveSlowState, "function");
  await streamOptions.onBoardEvent({ type: "board", project: "atelier" });
  resolveSlowState();
  await slow;

  assert.equal(snapshots.length, 1);
  assert.deepEqual(
    snapshots[0].board.readyIssues.map(({ id }) => id),
    ["atelier-current"],
  );
  unsubscribe();
});

test("a newer board refresh cannot discard an in-flight full-world resync", async (t) => {
  const project = { name: "atelier", requireReview: true };
  const recoveredDispatch = {
    id: "recovered-dispatch",
    project: "atelier",
    ticketId: "atelier-recovered",
    state: "running",
  };
  let dispatchReads = 0;
  let chronicleReads = 0;
  let stateReads = 0;
  let resolveFullState;
  let streamOptions;

  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects") return response({ projects: [project] });
    if (path === "/api/dispatches") {
      dispatchReads += 1;
      return response(dispatchReads === 1 ? [] : [recoveredDispatch]);
    }
    if (path === "/api/convoys") return response([]);
    if (path === "/api/projects/atelier/chronicle") {
      chronicleReads += 1;
      return response({
        project: "atelier",
        generatedAt: SNAPSHOT_AT,
        records: chronicleReads === 1
          ? []
          : [{ id: "recovered-merge", title: "Recovered merge" }],
        summary: { merges: chronicleReads === 1 ? 0 : 1 },
        truncated: false,
      });
    }
    if (path === "/api/projects/atelier/state") {
      stateReads += 1;
      if (stateReads === 2) {
        return new Promise((resolvePromise) => {
          resolveFullState = () => resolvePromise(response({
            issues: [{ id: "stale-full-board", status: "open" }],
            readyIssues: [{ id: "stale-full-board", status: "open" }],
            tracker: "committed",
            degraded: false,
            generatedAt: SNAPSHOT_AT,
          }));
        });
      }
      return response({
        issues: stateReads === 1 ? [] : [{ id: "newer-board", status: "open" }],
        readyIssues: stateReads === 1 ? [] : [{ id: "newer-board", status: "open" }],
        tracker: "committed",
        degraded: false,
        generatedAt: SNAPSHOT_AT,
      });
    }
    if (path === "/api/projects/atelier/queue") {
      return response({ enabled: true, unavailable: false, parkedTickets: [] });
    }
    if (path === "/api/projects/atelier/main-health") {
      return response({
        project: "atelier",
        state: "passed",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
      });
    }
    if (path === "/api/projects/atelier/artifacts") {
      return response({ project: "atelier", generatedAt: SNAPSHOT_AT, artifacts: [] });
    }
    assert.fail(`unexpected live-source request: ${path}`);
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=atelier" });
  await source.load();
  const snapshots = [];
  const unsubscribe = source.subscribe((event) => snapshots.push(event));

  const full = streamOptions.resync();
  while (typeof resolveFullState !== "function") {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  await streamOptions.onBoardEvent({ type: "board", project: "atelier" });
  resolveFullState();
  await full;

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].type, "board.snapshot");
  assert.deepEqual(
    snapshots[1].data.board.readyIssues.map(({ id }) => id),
    ["newer-board"],
    "the older full request cannot overwrite the newer board surface",
  );
  assert.deepEqual(
    snapshots[1].data.dispatches.map(({ id }) => id),
    ["recovered-dispatch"],
    "the full resync still restores dispatch changes missed while disconnected",
  );
  assert.deepEqual(
    snapshots[1].data.chronicle.records.map(({ id }) => id),
    ["recovered-merge"],
    "the full resync still restores chronicle changes missed while disconnected",
  );
  unsubscribe();
});

test("a failed full-world resync rejects for the stream retry gate", async (t) => {
  let projectsFail = false;
  let streamOptions;
  t.mock.method(globalThis, "fetch", async (path) => {
    if (path === "/api/projects") {
      return projectsFail
        ? response({ error: "snapshot unavailable" }, 503)
        : response({ projects: [{ name: "atelier", requireReview: true }] });
    }
    if (path === "/api/dispatches") return response([]);
    if (path === "/api/convoys") return response([]);
    if (path === "/api/projects/atelier/chronicle") {
      return response({
        project: "atelier",
        generatedAt: SNAPSHOT_AT,
        records: [],
        summary: { merges: 0 },
        truncated: false,
      });
    }
    if (path === "/api/projects/atelier/state") {
      return response({
        issues: [],
        readyIssues: [],
        tracker: "committed",
        degraded: false,
        generatedAt: SNAPSHOT_AT,
      });
    }
    if (path === "/api/projects/atelier/queue") {
      return response({ enabled: true, unavailable: false, parkedTickets: [] });
    }
    if (path === "/api/projects/atelier/main-health") {
      return response({
        project: "atelier",
        state: "passed",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
      });
    }
    if (path === "/api/projects/atelier/artifacts") {
      return response({ project: "atelier", generatedAt: SNAPSHOT_AT, artifacts: [] });
    }
    assert.fail(`unexpected live-source request: ${path}`);
  });

  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => response({}),
    createThemeStream: (options) => {
      streamOptions = options;
      return { close() {} };
    },
  };
  const source = await createLiveSource({ core, search: "?project=atelier" });
  await source.load();
  const unsubscribe = source.subscribe(() => {});

  projectsFail = true;
  await assert.rejects(streamOptions.resync(), /snapshot unavailable/);
  unsubscribe();
});

test("live requests recheck lifecycle abort after reading text and before parsing", async () => {
  const controller = new AbortController();
  let parseCoercions = 0;
  const payload = {
    [Symbol.toPrimitive]() {
      parseCoercions += 1;
      return '{"merged":true}';
    },
  };
  const core = {
    atelierRequestOptions: (options) => options,
    createThemeActionClient: () => async () => ({
      ok: true,
      async text() {
        controller.abort();
        return payload;
      },
    }),
    createThemeStream: () => ({ close() {} }),
  };
  const source = await createLiveSource({ core, signal: controller.signal });

  await assert.rejects(source.merge("late-response"), { name: "AbortError" });
  assert.equal(parseCoercions, 0, "an aborted response body is never passed to JSON.parse");
});
