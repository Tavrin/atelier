import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { ATTENTION_ACTIONS } from "./attention.mjs";
import { MCP_TOOLS } from "./mcp.mjs";
import { AGENT_UI_CAPABILITY_MANIFEST } from "./parity.mjs";
import { RECOVERY_ACTIONS } from "./recovery.mjs";
import {
  TIMELINE_COVERAGE,
  TIMELINE_LIMIT,
  TIMELINE_LIMITS,
  TIMELINE_PROOFS,
  TIMELINE_STAGES,
  dispatchTimelineFor,
  timelineFor,
} from "./timeline.mjs";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const PROJECT = Object.freeze({
  name: "fixture",
  requireReview: false,
  reviewPolicy: "strict",
  tracker: "committed",
});

function record(id, overrides = {}) {
  return {
    id,
    project: "fixture",
    ticketId: `ticket-${id}`,
    branch: `atelier/${id}`,
    state: "completed",
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:02:00.000Z",
    verify: null,
    result: null,
    attestation: null,
    review: null,
    reviewOf: null,
    merged: null,
    postMerge: null,
    ...overrides,
  };
}

function input(records, overrides = {}) {
  return {
    records,
    projects: [PROJECT],
    queues: [],
    convoys: [],
    persistence: {},
    ...overrides,
  };
}

function project(records, overrides = {}) {
  return timelineFor(input(records, overrides), { now: NOW });
}

function compact(result) {
  return result.items.map(({ stage, state }) => [stage, state]);
}

const success = record("success", {
  result: { commit: "abc123", tree: "tree123", version: 1 },
  verify: {
    state: "passed",
    attempts: [{ attempt: 1, state: "passed", endedAt: "2026-08-20T10:03:00.000Z" }],
  },
  attestation: {
    attempt: 1,
    resultCommit: "abc123",
    resultTree: "tree123",
    resultVersion: 1,
  },
  review: {
    rounds: [{
      round: 1,
      verdict: "pass",
      dispatchId: "review-success",
      reviewedHead: "abc123",
      at: "2026-08-20T10:04:00.000Z",
    }],
  },
  merged: {
    commit: "merge123",
    resultCommit: "abc123",
    mergedAt: "2026-08-20T10:05:00.000Z",
  },
  postMerge: {
    state: "passed",
    commit: "merge123",
    endedAt: "2026-08-20T10:06:00.000Z",
  },
});

const journeys = [
  {
    name: "successful dispatch through green main health",
    input: input([success]),
    expected: [
      ["work", "done"],
      ["execution", "done"],
      ["verification", "done"],
      ["review", "done"],
      ["merge", "done"],
      ["main_health", "done"],
    ],
  },
  {
    name: "needs input",
    input: input([record("input", {
      state: "needs_input",
      outcome: { question: "Which API should be preserved?" },
    })]),
    expected: [["work", "done"], ["execution", "blocked"], ["attention", "blocked"]],
  },
  {
    name: "failed recoverable dispatch",
    input: input([record("orphan", {
      state: "failed",
      orphanUnresolved: true,
      exitSummary: "worker exit unproven",
    })]),
    expected: [["work", "done"], ["execution", "failed"], ["recovery", "blocked"]],
  },
  {
    name: "unresolved post-merge main-health failure",
    input: input([record("main-red", {
      merged: { commit: "main-red-merge", mergedAt: "2026-08-20T10:05:00.000Z" },
      postMerge: {
        state: "failed",
        commit: "main-red-merge",
        endedAt: "2026-08-20T10:06:00.000Z",
        error: "main is red",
      },
    })]),
    expected: [
      ["work", "done"],
      ["execution", "done"],
      ["attention", "blocked"],
      ["merge", "done"],
      ["main_health", "failed"],
    ],
  },
  {
    name: "same subject in attention and routine recovery",
    input: input([record("both", {
      state: "needs_input",
      mergeRecoveryPending: true,
      outcome: { question: "Continue recovery?" },
    })]),
    expected: [
      ["work", "done"],
      ["execution", "blocked"],
      ["attention", "blocked"],
      ["recovery", "blocked"],
    ],
  },
];

const linkageFixtures = [
  {
    name: "convoy pair",
    input: input([
      record("convoy-a", { ticketId: "convoy-ticket-a", batchId: "convoy-1", batchKind: "convoy" }),
      record("convoy-b", { ticketId: "convoy-ticket-b", batchId: "convoy-1", batchKind: "convoy" }),
    ], {
      convoys: [{
        id: "convoy-1",
        currentDispatchId: "convoy-b",
        ticketIds: ["convoy-ticket-a", "convoy-ticket-b"],
      }],
    }),
  },
  {
    name: "bakeoff batch",
    input: input([
      record("bakeoff-a", { batchId: "bakeoff-1", batchKind: "bakeoff" }),
      record("bakeoff-b", { batchId: "bakeoff-1", batchKind: "bakeoff" }),
    ]),
  },
  {
    name: "parked queue ticket",
    input: input([record("parked", { ticketId: "ticket-parked" })], {
      queues: [{
        project: "fixture",
        queue: {
          parkedTickets: [{ ticketId: "ticket-parked", lastDispatchId: "parked" }],
        },
      }],
    }),
  },
  {
    name: "batch without kind",
    input: input([
      record("batch-a", { batchId: "batch-1", batchKind: null }),
      record("batch-b", { batchId: "batch-1", batchKind: null }),
    ]),
  },
];

const projectionFixtures = [
  ...journeys.map(({ name, input: fixtureInput }) => ({ name, input: fixtureInput })),
  ...linkageFixtures,
];

for (const journey of journeys) {
  test(`operator journey: ${journey.name}`, () => {
    const result = timelineFor(journey.input, { now: NOW });
    assert.deepEqual(compact(result), journey.expected);
    assert.equal(result.generatedAt, NOW.toISOString());
    assert.equal(result.truncated, false);
    assert.equal(result.counts.total, journey.expected.length);
    for (const item of result.items) {
      assert.ok(item.evidence.length >= 2, `${item.stage} has navigable evidence`);
      assert.ok(item.evidence.every(({ http, mcp }) => http.startsWith("/api/") && mcp));
      assert.ok(item.unknown.includes("no immutable evidence-store reference exists"));
    }
  });
}

test("successful journey exposes exact licensed links", () => {
  const result = project([success]);
  const links = Object.fromEntries(result.items.map((item) => [item.stage, item.links]));
  assert.deepEqual(links.execution, [{
    relation: "dispatch-result",
    to: { kind: "commit", id: "abc123" },
    proof: "content-identity",
    detail: "The finalized result stores this exact commit identity.",
  }]);
  assert.equal(links.verification[0].proof, "content-identity");
  assert.deepEqual(links.review.map(({ relation, proof }) => ({ relation, proof })), [
    { relation: "review-tree", proof: "content-identity" },
    { relation: "reviewer-dispatch", proof: "stored-identifier" },
    { relation: "review-verification", proof: "association" },
  ]);
  assert.match(links.review[2].detail, /same tree, not that the review followed/);
  assert.equal(links.merge[0].proof, "containment");
  assert.equal(links.main_health[0].proof, "containment");
});

test("attention and recovery evidence reaches the record and event stream that justified it", () => {
  const result = timelineFor(journeys.at(-1).input, { now: NOW });
  for (const stage of ["attention", "recovery"]) {
    const item = result.items.find((candidate) => candidate.stage === stage);
    assert.deepEqual(item.evidence.slice(0, 2).map(({ kind }) => kind), [
      "dispatch-record",
      "dispatch-events",
    ]);
    assert.deepEqual(item.links.map(({ relation, proof }) => ({ relation, proof })), [{
      relation: `${stage}-subject`,
      proof: "containment",
    }]);
  }
});

test("no-fabrication canary covers every dangerous sibling branch", () => {
  const records = [
    record("first", {
      ticketId: "ticket-shared",
      branch: "same-branch",
      startedAt: "2026-08-20T10:00:00.000Z",
    }),
    record("second", {
      ticketId: "ticket-shared",
      branch: "same-branch",
      startedAt: "2026-08-20T10:00:00.001Z",
    }),
  ];
  const links = project(records).items.flatMap((item) => item.links)
    .filter((link) => link.to.kind === "dispatch" && ["first", "second"].includes(link.to.id));
  assert.equal(links.length, 2);
  assert.ok(links.every((link) => link.relation === "same-ticket"));
  assert.ok(links.every((link) => link.proof === "association"));
  assert.ok(links.every((link) => /not causal/i.test(link.detail)));
  assert.equal(links.some((link) =>
    ["containment", "stored-identifier", "content-identity"].includes(link.proof)), false);

  for (const link of links) {
    assert.deepEqual(link.evidence.map(({ kind }) => kind), [
      "dispatch-record",
      "dispatch-events",
    ]);
    assert.ok(link.evidence.every(({ http }) => http.includes(link.to.id)));
  }

  const projected = Object.fromEntries(linkageFixtures.map((fixture) => [
    fixture.name,
    timelineFor(fixture.input, { now: NOW }),
  ]));
  const convoyLinks = projected["convoy pair"].items.flatMap((item) => item.links)
    .filter(({ relation }) => relation === "convoy-member");
  assert.equal(convoyLinks.length, 2);
  assert.ok(convoyLinks.every(({ proof }) => proof === "stored-identifier"));
  assert.equal(projected["convoy pair"].items.some((item) =>
    item.unknown.some((unknown) => /past membership is unknown/.test(unknown))), false);

  const bakeoffLinks = projected["bakeoff batch"].items.flatMap((item) => item.links)
    .filter(({ relation }) => relation === "bakeoff-sibling");
  assert.equal(bakeoffLinks.length, 2);
  assert.ok(bakeoffLinks.every(({ proof }) => proof === "stored-identifier"));

  assert.ok(projected["parked queue ticket"].items.flatMap((item) => item.links)
    .some(({ relation, proof }) => relation === "queue-last-dispatch" && proof === "stored-identifier"));

  const sameBatchLinks = projected["batch without kind"].items.flatMap((item) => item.links)
    .filter(({ relation }) => relation === "same-batch");
  assert.equal(sameBatchLinks.length, 2);
  assert.ok(sameBatchLinks.every(({ detail }) => /no more specific batch relationship/.test(detail)));
});

test("every fixture link uses the closed proof vocabulary", () => {
  for (const fixture of projectionFixtures) {
    for (const item of timelineFor(fixture.input, { now: NOW }).items) {
      for (const link of item.links) {
        assert.equal(Object.hasOwn(TIMELINE_PROOFS, link.proof), true, `${fixture.name}: ${link.proof}`);
      }
    }
  }
  assert.deepEqual(Object.keys(TIMELINE_PROOFS), [
    "containment",
    "stored-identifier",
    "content-identity",
    "association",
    "unknown",
  ]);
});

test("timeline actions copy existing authority without adding commands", () => {
  for (const journey of journeys) {
    for (const item of timelineFor(journey.input, { now: NOW }).items) {
      for (const action of item.actions ?? []) {
        const table = item.stage === "attention" ? ATTENTION_ACTIONS : RECOVERY_ACTIONS;
        assert.ok(table[action.key], `unknown ${item.stage} action ${action.key}`);
        assert.equal(action.http, table[action.key].http);
        assert.equal(action.mcp, table[action.key].mcp);
      }
    }
  }
});

test("projection is pure by construction and does not admit hidden probe dependencies", async () => {
  let gcCalls = 0;
  let persistenceCalls = 0;
  const dispatcher = {
    gc() {
      gcCalls += 1;
      throw new Error("gc must not run");
    },
    persistenceStatus() {
      persistenceCalls += 1;
      return {};
    },
  };
  const projectionInput = input([record("pure")], {
    persistence: dispatcher.persistenceStatus(),
  });
  timelineFor(projectionInput, { now: NOW });
  dispatchTimelineFor(projectionInput, { now: NOW, dispatchId: "pure" });
  assert.equal(gcCalls, 0);
  assert.equal(persistenceCalls, 1);

  const source = await readFile(new URL("./timeline.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:(?:fs|child_process)|resourceProjector|\.gc\s*\(/);
  assert.match(source, /attentionFor\(/);
  assert.match(source, /recoveryFor\(/);
});

test("timeline bounds construction and clamps over-limit callers", () => {
  const records = Array.from({ length: TIMELINE_LIMIT + 1 }, (_, index) =>
    record(`dispatch-${String(index).padStart(3, "0")}`));
  const result = timelineFor(input(records), { now: NOW, limit: TIMELINE_LIMIT + 500 });
  assert.equal(result.items.length, TIMELINE_LIMIT);
  assert.equal(result.counts.total, TIMELINE_LIMIT * 2);
  assert.equal(result.truncated, true);
  const empty = timelineFor(input(records), { now: NOW, limit: 0 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.truncated, true);
});

test("timeline indexes siblings once and selects newest records before building steps", () => {
  let ticketReads = 0;
  const records = Array.from({ length: 300 }, (_, index) => {
    const candidate = record(`dispatch-${String(index).padStart(3, "0")}`);
    Object.defineProperty(candidate, "ticketId", {
      enumerable: true,
      get() {
        ticketReads += 1;
        return "shared-ticket";
      },
    });
    return candidate;
  });
  const empty = timelineFor(input(records), { now: NOW, limit: 0 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.truncated, true);
  assert.ok(ticketReads < records.length * 10, `ticketId read ${ticketReads} times`);

  const newest = record("newest", { startedAt: "2026-08-20T11:00:00.000Z" });
  const endedFallback = record("ended-fallback", {
    startedAt: null,
    endedAt: "2026-08-20T10:30:00.000Z",
  });
  const old = record("old", { startedAt: "2026-08-20T09:00:00.000Z" });
  const bounded = timelineFor(input([old, endedFallback, newest]), { now: NOW, limit: 4 });
  assert.deepEqual(bounded.items.map((item) => item.subject.id), [
    "newest",
    "newest",
    "ended-fallback",
    "ended-fallback",
  ]);
  assert.deepEqual(bounded.items.map((item) => item.stage), [
    "work",
    "execution",
    "work",
    "execution",
  ]);
});

test("an attempt-less attestation never fabricates attempt-specific links", () => {
  const legacy = record("legacy-attestation", {
    result: { commit: "result-head" },
    verify: {
      state: "passed",
      attempts: [
        { attempt: 1, state: "failed", endedAt: "2026-08-20T10:03:00.000Z" },
        { attempt: 2, state: "passed", endedAt: "2026-08-20T10:04:00.000Z" },
      ],
    },
    attestation: { resultCommit: "result-head", resultTree: "tree-head" },
    review: {
      rounds: [{ round: 1, verdict: "pass", reviewedHead: "result-head" }],
    },
  });
  const result = project([legacy]);
  const relations = result.items.flatMap((item) => item.links.map((link) => link.relation));
  assert.equal(relations.filter((relation) => relation === "verification-result").length, 0);
  assert.equal(relations.filter((relation) => relation === "review-verification").length, 0);
  assert.ok(result.items.flatMap((item) => item.unknown)
    .some((unknown) => /does not record which verification attempt produced it/.test(unknown)));
});

test("a running top-level verification rerun is projected after its archived attempt", () => {
  const result = project([record("rerun", {
    state: "verifying",
    verify: {
      attempt: 2,
      state: "running",
      startedAt: "2026-08-20T10:04:00.000Z",
      attempts: [{ attempt: 1, state: "failed", endedAt: "2026-08-20T10:03:00.000Z" }],
    },
  })]);
  assert.deepEqual(result.items.filter(({ stage }) => stage === "verification")
    .map(({ code, state }) => ({ code, state })), [
    { code: "verification-attempt-1", state: "failed" },
    { code: "verification-attempt-2", state: "pending" },
  ]);
});

test("dispatch drill-down keeps target attention and recovery beyond unrelated inner limits", () => {
  const unrelated = Array.from({ length: TIMELINE_LIMIT }, (_, index) => record(
    `a-${String(index).padStart(3, "0")}`,
    { state: "needs_input", outcome: { question: "Continue?" } },
  ));
  const target = record("z-target", {
    state: "needs_input",
    outcome: { question: "Repair?" },
    mergeRecoveryPending: true,
  });
  const result = dispatchTimelineFor(input([...unrelated, target]), {
    now: NOW,
    dispatchId: "z-target",
  });
  assert.ok(result.items.some(({ stage }) => stage === "attention"));
  assert.ok(result.items.some(({ stage }) => stage === "recovery"));
});

test("dispatch drill-down filters by stored id and returns null for an unknown id", () => {
  const projectionInput = input([record("one"), record("two")]);
  const result = dispatchTimelineFor(projectionInput, { now: NOW, dispatchId: "two" });
  assert.equal(result.dispatchId, "two");
  assert.ok(result.items.every((item) => item.subject.id === "two"));
  assert.equal(dispatchTimelineFor(projectionInput, { now: NOW, dispatchId: "missing" }), null);
});

test("vocabularies and coverage disclosures are frozen and MCP parity is read-only", () => {
  assert.equal(TIMELINE_LIMIT, 200);
  assert.equal(Object.isFrozen(TIMELINE_STAGES), true);
  assert.ok(Object.values(TIMELINE_STAGES).every(Object.isFrozen));
  assert.equal(Object.isFrozen(TIMELINE_PROOFS), true);
  assert.ok(Object.values(TIMELINE_PROOFS).every(Object.isFrozen));
  assert.equal(Object.isFrozen(TIMELINE_COVERAGE), true);
  assert.ok(TIMELINE_COVERAGE.every(Object.isFrozen));
  assert.equal(Object.isFrozen(TIMELINE_LIMITS), true);
  assert.ok(TIMELINE_LIMITS.every(Object.isFrozen));
  assert.deepEqual(TIMELINE_LIMITS.map(({ topic }) => topic), [
    "full_history_read",
    "credential_shaped_path_redaction",
    "sibling_scan_cost",
    "immutable_evidence_store",
  ]);
  assert.match(
    TIMELINE_COVERAGE.find(({ relation }) => relation === "convoy-member").detail,
    /Wave 1C adversarial review/,
  );
  assert.deepEqual(
    [...new Set(TIMELINE_COVERAGE.map(({ proof }) => proof))].sort(),
    ["association", "containment", "content-identity", "stored-identifier", "unknown"],
  );
  const tool = MCP_TOOLS.find(({ name }) => name === "atelier_timeline");
  const capability = AGENT_UI_CAPABILITY_MANIFEST.find(({ tool: name }) =>
    name === "atelier_timeline");
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required ?? [], []);
  assert.equal(tool.inputSchema.properties.limit.minimum, 0);
  assert.deepEqual(capability.http, ["GET /api/timeline", "GET /api/timeline/:dispatchId"]);
  assert.equal(capability.readOnlyHint, true);
});
