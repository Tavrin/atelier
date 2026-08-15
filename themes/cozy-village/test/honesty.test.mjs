import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createFixtureSource } from "../data/fixture.mjs";
import {
  buildVillage,
  granaryGrowth,
  PATHS,
  reviewIsStale,
  stationForRecord,
  STATION_DEFINITIONS,
  VillageStore,
} from "../state/village.mjs";

const NOW = new Date("2026-07-30T20:00:00.000Z");

async function fixture() {
  return createFixtureSource({ scripted: false }).load();
}

function servedGates({
  changes = "passed",
  verify = "not-run",
  review = "not-run",
  merge = "not-run",
  main = "not-run",
} = {}) {
  return [
    { gate: "changes", state: changes },
    { gate: "verify", state: verify },
    { gate: "review", state: review },
    { gate: "merge", state: merge },
    { gate: "main", state: main },
  ];
}

function record(id, patch = {}) {
  return {
    id,
    project: "atelier",
    ticketId: `atelier-${id}`,
    title: `Work ${id}`,
    lane: "claude",
    model: "sonnet",
    state: "running",
    startedAt: NOW.toISOString(),
    outcome: { changes: "changed", question: null },
    verify: null,
    review: null,
    merged: null,
    dismissed: null,
    gates: servedGates({ verify: "pending" }),
    ...patch,
  };
}

test("the world model contains exactly seven permanent signed stations and no merge exteriors", async () => {
  const data = await fixture();
  const village = buildVillage({ ...data, now: NOW });
  assert.equal(village.stations.length, 7);
  assert.deepEqual(village.stations.map(({ id }) => id), [
    "notice",
    "workshop",
    "assay",
    "cottage",
    "hall",
    "granary",
    "rnd",
  ]);
  assert.equal(new Set(village.stations.map(({ sign }) => sign)).size, 7);
  assert.ok(village.stations.every(({ sign, icon }) => sign.includes(icon)));
  assert.equal(Object.hasOwn(village, "town"), false);
  assert.equal(Object.hasOwn(village, "yards"), false);
  assert.equal(Object.hasOwn(village, "buildings"), false);

  const hugeHistory = {
    ...data,
    chronicle: {
      ...data.chronicle,
      records: Array.from({ length: 500 }, (_, index) => ({
        id: `merge-${index}`,
        title: `Merge ${index}`,
      })),
      summary: { merges: 500 },
    },
  };
  assert.equal(buildVillage({ ...hugeHistory, now: NOW }).stations.length, 7);
});

test("ready papers trust the server projection while degradation and parking become a ribbon", () => {
  const issues = [
    { id: "r1", title: "Ready first", status: "open", priority: 1, dependencies: [] },
    { id: "r0", title: "Ready urgent", status: "open", priority: 0 },
    {
      id: "blocked",
      title: "Blocked",
      status: "open",
      priority: 0,
      dependencies: [{ depends_on_id: "r1" }],
    },
    {
      id: "closed-dependency",
      title: "Now ready",
      status: "open",
      priority: 2,
      dependencies: [{ depends_on_id: "done" }],
    },
    { id: "done", title: "Done", status: "closed", priority: 0 },
    { id: "progress", title: "In progress", status: "in_progress", priority: 0 },
    { id: "parked", title: "Parked after retries", status: "open", priority: 0 },
  ];
  const projectedReady = [issues[1], issues[0], issues[3]];

  const village = buildVillage({
    board: {
      issues,
      readyIssues: projectedReady,
      source: "/tracker/.beads/issues.jsonl",
      tracker: "none",
      degraded: true,
      generatedAt: NOW.toISOString(),
    },
    queue: {
      unavailable: true,
      lastError: "queue read failed",
      parkedTickets: [{ ticketId: "parked", parked: true }],
    },
    now: NOW,
  });
  assert.deepEqual(village.board.papers.map(({ id, title }) => ({ id, title })), [
    { id: "r0", title: "Ready urgent" },
    { id: "r1", title: "Ready first" },
    { id: "closed-dependency", title: "Now ready" },
  ]);
  assert.equal(village.board.warning, true);
  assert.match(village.board.warnings.join(" "), /tracker degraded/);
  assert.match(village.board.warnings.join(" "), /queue unavailable/);
  assert.match(village.board.warnings.join(" "), /queue read failed/);
  assert.match(village.board.warnings.join(" "), /1 parked ticket/);
  assert.equal(village.board.papers.some(({ id }) => id === "parked"), false);

  const missingProjection = buildVillage({
    board: { issues, tracker: "committed", degraded: false },
    queue: { parkedTickets: [] },
    now: NOW,
  });
  assert.deepEqual(
    missingProjection.board.papers,
    [],
    "the theme must not recreate readiness from the unfiltered issue list",
  );
});

test("healthy tracker data names a readiness-only degradation honestly", () => {
  const village = buildVillage({
    board: {
      issues: [{ id: "atelier-open", title: "Open", status: "open" }],
      readyIssues: [],
      tracker: "committed",
      degraded: true,
    },
    queue: { parkedTickets: [] },
    now: NOW,
  });

  assert.match(village.board.warnings.join(" "), /readiness degraded \(br ready\)/);
  assert.doesNotMatch(village.board.warnings.join(" "), /tracker degraded/);
});

test("fixture parcels occupy lifecycle stations and inspection failures return marked", async () => {
  const data = await fixture();
  const village = buildVillage({ ...data, now: NOW });
  const at = (id) => village.parcels.find((parcel) => parcel.id === id);
  assert.equal(at("c7d21a94").stationId, "hall");
  assert.equal(at("3f80b6e2").stationId, "cottage");
  assert.equal(at("a15c9d77").stationId, "assay");
  assert.equal(at("a15c9d77").bay, "verify");
  assert.equal(at("6b2e40f1").stationId, "workshop");
  assert.equal(at("6b2e40f1").marked, true);
  assert.equal(at("6b2e40f1").returned, true);
  assert.equal(at("d904ce38").stationId, "workshop");
  assert.equal(at("d904ce38").marked, true);
  assert.equal(at("72af1b05").stationId, "workshop");
  assert.equal(at("1c46fa9b").stationId, "workshop");
  assert.equal(at("e58d3c60").stationId, "workshop");
  assert.equal(at("e58d3c60").bay, null, "review has not started, so no movement is earned");
});

test("the town hall exposes whose hand forced a merge and why", async () => {
  const data = await fixture();
  const forced = {
    id: "forced-archive",
    ticketId: "atelier-forced",
    title: "Audited override",
    mergedAt: "2026-07-30T19:30:00.000Z",
    forcedBy: "maintainer",
    reason: "Human authority accepts the remaining risk.",
    dispositionRef: "ticket-comment-75",
  };
  const village = buildVillage({
    ...data,
    chronicle: {
      ...data.chronicle,
      records: [...data.chronicle.records, forced],
      summary: {
        ...data.chronicle.summary,
        merges: data.chronicle.records.length + 1,
      },
    },
    now: NOW,
  });
  assert.deepEqual(
    village.hall.overrides.map(({ forcedBy, reason, dispositionRef }) => ({
      forcedBy,
      reason,
      dispositionRef,
    })),
    [{
      forcedBy: "maintainer",
      reason: "Human authority accepts the remaining risk.",
      dispositionRef: "ticket-comment-75",
    }],
  );
  const chrome = await readFile(new URL("../ui/chrome.mjs", import.meta.url), "utf8");
  assert.match(chrome, /Human override register/);
  assert.match(chrome, /Override by/);
});

test("failed and stopped terminal work remains on a workshop bench until dismissed", () => {
  const failed = record("failed", {
    state: "failed",
    gates: servedGates({ verify: "failed" }),
  });
  const stopped = record("stopped", {
    state: "stopped",
    gates: servedGates({ changes: "unknown" }),
  });
  let village = buildVillage({ dispatches: [failed, stopped], now: NOW });
  assert.deepEqual(village.workshop.parcels.map(({ id }) => id), ["failed", "stopped"]);
  assert.ok(village.workshop.parcels.every(({ retained, marked }) => retained && marked));

  village = buildVillage({
    dispatches: [failed, { ...stopped, dismissed: { at: NOW.toISOString() } }],
    now: NOW,
  });
  assert.deepEqual(village.workshop.parcels.map(({ id }) => id), ["failed"]);
});

test("movement follows only authoritative lifecycle transitions", () => {
  const ready = {
    id: "atelier-route",
    title: "Route work",
    status: "open",
    priority: 0,
    dependencies: [],
  };
  const store = new VillageStore({
    project: { name: "atelier", requireReview: true },
    board: {
      issues: [ready],
      readyIssues: [ready],
      tracker: "committed",
      degraded: false,
    },
    dispatches: [],
    chronicle: {
      generatedAt: NOW.toISOString(),
      records: [],
      summary: { merges: 0 },
    },
    now: NOW,
  });
  const running = record("route", {
    ticketId: ready.id,
    gates: servedGates({ verify: "not-run" }),
  });
  const arrival = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "running",
    record: running,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(arrival.route, ["notice", "workshop"]);

  const verifying = {
    ...running,
    state: "verifying",
    gates: servedGates({ verify: "pending" }),
  };
  const toAssay = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "verifying",
    record: verifying,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(toAssay.route, ["workshop", "assay"]);

  const failed = {
    ...verifying,
    state: "completed",
    verify: { state: "failed", steps: [{ command: "node --test", exitCode: 1 }] },
    gates: servedGates({ verify: "failed", merge: "pending" }),
  };
  const returned = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "completed",
    record: failed,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(returned.route, ["assay", "workshop"]);
  assert.equal(returned.parcel.marked, true);

  const resumed = {
    ...running,
    state: "needs_input",
    outcome: { changes: "empty", question: "Use the bounded option?" },
    gates: servedGates({ changes: "empty", verify: "skipped" }),
  };
  const toPorch = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "needs_input",
    outcome: resumed.outcome,
    record: resumed,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(toPorch.route, ["workshop", "cottage"]);

  const backToWork = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "resuming",
    record: { ...running, state: "resuming", outcome: { changes: "changed", question: null } },
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(backToWork.route, ["cottage", "workshop"]);

  const reviewing = {
    ...running,
    state: "reviewing",
    verify: { state: "passed" },
    gates: servedGates({ verify: "passed", review: "pending" }),
  };
  assert.deepEqual(store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "reviewing",
    record: reviewing,
    observedAt: NOW.getTime(),
  }).route, ["workshop", "assay"]);

  const mergeReady = {
    ...reviewing,
    state: "completed",
    review: {
      current: { verdict: "pass", reviewedHead: "abc", round: 1 },
      rounds: [{ verdict: "pass", reviewedHead: "abc", round: 1 }],
    },
    branchHead: "abc",
    gates: servedGates({ verify: "passed", review: "passed", merge: "pending" }),
  };
  const toHall = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "completed",
    record: mergeReady,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(toHall.route, ["assay", "hall"]);

  const merged = {
    ...mergeReady,
    merged: {
      commit: "abc1234",
      mergedAt: "2026-07-30T20:01:00.000Z",
    },
    gates: servedGates({
      verify: "passed",
      review: "passed",
      merge: "passed",
      main: "pending",
    }),
  };
  const archivedLater = store.applyEvent({
    type: "status",
    dispatchId: running.id,
    state: "completed",
    detail: "merged abc1234",
    record: merged,
    observedAt: NOW.getTime(),
  });
  assert.deepEqual(archivedLater.route, ["hall", "dock", "granary"]);
  assert.equal(store.village.granary.vestibule[0].label, "awaiting archive");
  assert.ok(archivedLater.vestibule.villager?.name, "the vestibule parcel has a carrier");
  assert.equal(store.village.parcels.some(({ id }) => id === running.id), false);

  const emitted = [];
  const unsubscribe = store.subscribe((_village, change) => emitted.push(change));
  for (const event of [
    { type: "post-merge", dispatchId: running.id, state: "running" },
    { type: "status", dispatchId: running.id, state: "completed", record: merged },
    { type: "usage", dispatchId: running.id, turns: 10, costUSD: 1.2 },
    { type: "exit", dispatchId: running.id, summary: "complete" },
  ]) {
    store.applyEvent(event);
  }
  unsubscribe();
  assert.equal(
    emitted.filter(({ kind }) => kind === "merged").length,
    0,
    "events on an already-merged record must not replay the merge journey",
  );
});

test("usage and message events create bounded labelled activity but cannot move a parcel", () => {
  const running = record("activity", { gates: servedGates({ verify: "not-run" }) });
  const store = new VillageStore({ dispatches: [running], now: NOW });
  const before = stationForRecord(store.recordById("activity"));
  const usage = store.applyEvent({
    type: "usage",
    dispatchId: "activity",
    turns: 3,
    costUSD: 0.8,
    observedAt: NOW.getTime(),
  });
  assert.equal(usage.kind, "activity");
  assert.equal(usage.stationId, before);
  assert.equal(usage.activity.label, "usage observed");
  assert.equal(usage.activity.until - usage.activity.observedAt, 3_200);
  assert.equal(stationForRecord(store.recordById("activity")), before);

  const message = store.applyEvent({
    type: "message",
    dispatchId: "activity",
    observedAt: NOW.getTime() + 1,
  });
  assert.equal(message.kind, "activity");
  assert.equal(message.activity.label, "message observed");
  assert.equal(stationForRecord(store.recordById("activity")), before);

  store.tickClock(new Date(NOW.getTime() + 3_300));
  assert.equal(store.village.parcels[0].activity, null);
});

test("only post-snapshot merges enter the vestibule; truncated old merges stay out", () => {
  const merged = record("local", {
    state: "completed",
    merged: {
      commit: "aaa1111",
      mergedAt: new Date(NOW.getTime() + 60_000).toISOString(),
    },
  });
  const truncatedOld = record("truncated-old", {
    state: "completed",
    merged: {
      commit: "bbb2222",
      mergedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    },
  });
  const store = new VillageStore({
    dispatches: [truncatedOld, merged],
    chronicle: {
      generatedAt: NOW.toISOString(),
      records: [],
      summary: { merges: 501 },
      truncated: true,
    },
    now: NOW,
  });
  assert.deepEqual(store.village.granary.vestibule.map(({ id }) => id), ["local"]);
  assert.equal(store.village.granary.records.length, 0);

  store.replace({
    dispatches: [truncatedOld, merged],
    chronicle: {
      generatedAt: "2026-07-31T08:00:00.000Z",
      records: [{ id: "local", title: "Local merge" }],
      summary: { merges: 5 },
    },
  });
  assert.equal(store.village.granary.vestibule.length, 0);
  assert.deepEqual(store.village.granary.records.map(({ id }) => id), ["local"]);
});

test("granary growth is aggregate, sparse, capped, and labelled at 10/25/50/100", () => {
  assert.deepEqual([0, 9, 10, 24, 25, 49, 50, 99, 100, 500].map((count) => ({
    count,
    level: granaryGrowth(count).level,
    threshold: granaryGrowth(count).threshold,
  })), [
    { count: 0, level: 0, threshold: 0 },
    { count: 9, level: 0, threshold: 0 },
    { count: 10, level: 1, threshold: 10 },
    { count: 24, level: 1, threshold: 10 },
    { count: 25, level: 2, threshold: 25 },
    { count: 49, level: 2, threshold: 25 },
    { count: 50, level: 3, threshold: 50 },
    { count: 99, level: 3, threshold: 50 },
    { count: 100, level: 4, threshold: 100 },
    { count: 500, level: 4, threshold: 100 },
  ]);
  assert.equal(granaryGrowth(500).decorations, 5);
  assert.match(granaryGrowth(25).plaque, /25 merges/);
});

test("town-hall dock consumes current main-health and acknowledgement only quiets the bell", () => {
  const village = buildVillage({
    mainHealth: {
      project: "atelier",
      state: "failed",
      checksTotal: 4,
      unresolvedFailures: [
        { id: "unacked", acknowledgedAt: null },
        { id: "acked", acknowledgedAt: NOW.toISOString() },
      ],
      running: [{ id: "running-check" }],
    },
    chronicle: {
      records: [],
      summary: { merges: 0 },
    },
    now: NOW,
  });
  assert.equal(village.hall.dock.state, "failed");
  assert.equal(village.hall.dock.checksTotal, 4);
  assert.equal(village.hall.dock.failures.length, 2);
  assert.ok(village.hall.dock.failures.every(({ scaffolded }) => scaffolded));
  assert.equal(village.hall.dock.running.length, 1);
  assert.equal(village.hall.dock.bellRinging, true);

  const acknowledged = buildVillage({
    mainHealth: {
      project: "atelier",
      state: "failed",
      checksTotal: 4,
      unresolvedFailures: [{ id: "acked", acknowledgedAt: NOW.toISOString() }],
      running: [],
    },
    now: NOW,
  });
  assert.equal(acknowledged.hall.dock.failures.length, 1);
  assert.equal(acknowledged.hall.dock.failures[0].scaffolded, true);
  assert.equal(acknowledged.hall.dock.bellRinging, false);
});

test("main-health events update the bell and acknowledgement responses quiet it without reload", () => {
  const merged = record("main-red", {
    state: "completed",
    merged: {
      commit: "abc1234",
      mergedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    },
  });
  const store = new VillageStore({
    dispatches: [merged],
    chronicle: {
      generatedAt: NOW.toISOString(),
      records: [{ id: merged.id, title: merged.title }],
      summary: { merges: 1 },
    },
    mainHealth: {
      project: "atelier",
      state: "passed",
      checksTotal: 1,
      unresolvedFailures: [],
      running: [],
    },
    now: NOW,
  });
  assert.equal(store.village.hall.dock.bellRinging, false);

  const failedRecord = {
    ...merged,
    postMerge: {
      state: "failed",
      commit: "abc1234",
      acknowledgedAt: null,
    },
  };
  const change = store.applyEvent({
    type: "post-merge",
    dispatchId: merged.id,
    state: "failed",
    record: failedRecord,
    mainHealth: {
      project: "atelier",
      state: "failed",
      checksTotal: 2,
      unresolvedFailures: [failedRecord],
      running: [],
    },
  });
  assert.notEqual(change.kind, "merged");
  assert.equal(store.village.hall.dock.bellRinging, true);

  store.applyMainHealthRecord({
    ...failedRecord,
    postMerge: {
      ...failedRecord.postMerge,
      acknowledgedAt: new Date(NOW.getTime() + 1_000).toISOString(),
    },
  });
  assert.equal(store.village.hall.dock.failures.length, 1, "ack keeps the marked parcel");
  assert.equal(store.village.hall.dock.failures[0].scaffolded, true, "ack keeps the scaffold");
  assert.equal(store.village.hall.dock.bellRinging, false);
});

test("R&D props derive only from artifact counts and never from titles", () => {
  const artifacts = Array.from({ length: 16 }, (_, index) => ({
    kind: index < 9 ? "spec" : "design",
    title: index === 0 ? "NO UPGRADE TOWER SECRET" : `Artifact ${index}`,
    path: `${index < 9 ? "docs/specs" : "docs/design"}/${index}.md`,
    updatedAt: NOW.toISOString(),
  }));
  const village = buildVillage({
    artifacts: { project: "atelier", generatedAt: NOW.toISOString(), artifacts },
    now: NOW,
  });
  assert.deepEqual(village.rnd.counts, { total: 16, specs: 9, designs: 7 });
  assert.deepEqual(village.rnd.props, { blueprints: 3, telescope: true, globe: true });

  const renamed = buildVillage({
    artifacts: {
      project: "atelier",
      artifacts: artifacts.map((artifact) => ({ ...artifact, title: "ordinary" })),
    },
    now: NOW,
  });
  assert.deepEqual(renamed.rnd.props, village.rnd.props);
});

test("stale review returns to the workshop while a current passing review reaches the hall", () => {
  const reviewed = record("stale", {
    state: "completed",
    branchHead: "new-head",
    verify: { state: "passed" },
    review: {
      current: { verdict: "pass", reviewedHead: "old-head" },
      rounds: [{ verdict: "pass", reviewedHead: "old-head" }],
    },
    gates: servedGates({ verify: "passed", review: "passed", merge: "pending" }),
  });
  assert.equal(reviewIsStale(reviewed), true);
  assert.equal(stationForRecord(reviewed), "workshop");
  assert.equal(stationForRecord({
    ...reviewed,
    review: {
      current: { verdict: "pass", reviewedHead: "new-head" },
      rounds: [{ verdict: "pass", reviewedHead: "new-head" }],
    },
  }), "hall");
});

test("the path topology contains only the real lifecycle connections and no R&D traffic", () => {
  assert.deepEqual(PATHS.map(({ from, to, via }) => [from, to, via ?? null]), [
    ["notice", "workshop", null],
    ["workshop", "assay", null],
    ["workshop", "cottage", null],
    ["assay", "hall", null],
    ["hall", "granary", "dock"],
  ]);
  assert.equal(PATHS.some(({ from, to }) => from === "rnd" || to === "rnd"), false);
  assert.equal(STATION_DEFINITIONS.length, 7);
});

test("THEMES R1-R6 remain structural in the redesigned entry and data source", async () => {
  const [entry, live, chrome, world] = await Promise.all([
    readFile(new URL("../entry.mjs", import.meta.url), "utf8"),
    readFile(new URL("../data/live.mjs", import.meta.url), "utf8"),
    readFile(new URL("../ui/chrome.mjs", import.meta.url), "utf8"),
    readFile(new URL("../world/world.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(entry, /visibilitychange/);
  assert.match(entry, /resyncFromServer/);
  assert.match(entry, /export async function dispose/);
  assert.match(world, /forceContextLoss/);
  assert.match(entry, /prefers-reduced-motion/);
  assert.match(live, /createThemeStream/);
  assert.match(live, /createThemeActionClient/);
  assert.doesNotMatch(`${entry}\n${chrome}`, /\.innerHTML\s*=/);
  assert.match(chrome, /textContent/);
});
