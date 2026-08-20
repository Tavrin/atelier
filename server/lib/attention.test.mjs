import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ATTENTION_ACTIONS,
  ATTENTION_EXCLUSIONS,
  ATTENTION_LIMIT,
  ATTENTION_REASONS,
  attentionFor,
} from "./attention.mjs";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const PROJECT = Object.freeze({
  name: "fixture",
  requireReview: false,
  reviewPolicy: "strict",
  tracker: "committed",
});

function binding(head = "abc") {
  return {
    branchHead: head,
    verify: { state: "passed", endedAt: "2026-08-20T10:01:00.000Z" },
    result: { commit: head, version: 1 },
    attestation: { resultCommit: head, resultVersion: 1 },
  };
}

function record(id, overrides = {}) {
  return {
    id,
    project: "fixture",
    ticketId: `ticket-${id}`,
    state: "completed",
    startedAt: "2026-08-20T10:00:00.000Z",
    endedAt: "2026-08-20T10:02:00.000Z",
    review: null,
    reviewOf: null,
    reviewParking: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    executionProfileRefusal: null,
    ...binding(),
    ...overrides,
  };
}

function projection({ records = [], projects = [PROJECT], queues = [], convoys = [] } = {}, options = {}) {
  return attentionFor({ records, projects, queues, convoys, persistence: {} }, { now: NOW, ...options });
}

function entryWithReason(result, code) {
  return result.entries.find((entry) => entry.reasons.some((reason) => reason.code === code));
}

function assertReason(fixture, code, actions) {
  const result = projection(fixture);
  const entry = entryWithReason(result, code);
  assert.ok(entry, `${code} was not projected`);
  assert.equal(entry.severity, ATTENTION_REASONS[code].severity);
  assert.deepEqual(entry.actions, actions);
  return entry;
}

test("exports frozen reason, action, and exclusion vocabularies", () => {
  assert.equal(ATTENTION_LIMIT, 200);
  assert.equal(Object.isFrozen(ATTENTION_REASONS), true);
  assert.equal(Object.isFrozen(ATTENTION_ACTIONS), true);
  assert.equal(Object.isFrozen(ATTENTION_EXCLUSIONS), true);
  assert.ok(Object.values(ATTENTION_REASONS).every(Object.isFrozen));
  assert.ok(Object.values(ATTENTION_ACTIONS).every(Object.isFrozen));
  assert.ok(ATTENTION_EXCLUSIONS.every(Object.isFrozen));
  assert.deepEqual(ATTENTION_ACTIONS.reply_accept_profile, {
    label: "Accept execution profile and reply",
    http: "POST /api/dispatch/:id/reply",
    mcp: null,
    cli: "atelier reply --accept-execution-profile",
    humanOnly: true,
  });
  assert.equal(Object.values(ATTENTION_ACTIONS).some((action) => action.label === "Force"), false);
});

test("projects every dispatch reason with its severity and existing actions", () => {
  assertReason({ records: [record("input", {
    state: "needs_input",
    outcome: { question: "Which API should I preserve?" },
  })] }, "needs_input", ["reply", "dismiss"]);

  assertReason({ records: [record("plan", { state: "plan_ready", plan: { state: "ready" } })] },
    "plan_ready", ["plan_approve", "plan_revise"]);
  assertReason({ records: [record("empty", { state: "completed_empty" })] },
    "completed_empty", ["reply", "dismiss"]);
  assertReason({ records: [record("failed", { state: "failed", verify: null })] },
    "failed_unresolved", ["reply", "dismiss"]);

  const restart = assertReason({ records: [record("restart", {
    state: "failed",
    verify: null,
    restartResumeReady: true,
    restartResumeConflict: { dispatchId: "other" },
  })] }, "restart_resume_ready", ["reply", "dismiss"]);
  assert.deepEqual(
    restart.reasons.find((reason) => reason.code === "restart_resume_ready")
      .evidence.restartResumeConflict,
    { dispatchId: "other" },
  );

  assertReason({ records: [record("verify", { verify: { state: "failed" } })] },
    "verify_failed", ["verify_rerun", "reply", "dismiss"]);
  assertReason({
    projects: [{ ...PROJECT, requireReview: true }],
    records: [record("review-missing", { result: null })],
  }, "review_missing", ["review", "dismiss"]);
  assertReason({
    projects: [{ ...PROJECT, requireReview: true }],
    records: [record("review-error", {
      review: { current: { verdict: "error", reviewedHead: "abc", at: "2026-08-20T10:03:00.000Z" } },
    })],
  }, "review_errored", ["review", "dismiss"]);
  assertReason({
    projects: [{ ...PROJECT, requireReview: true }],
    records: [record("review-block", {
      review: {
        current: {
          round: 1,
          verdict: "fail",
          reviewedHead: "abc",
          at: "2026-08-20T10:03:00.000Z",
          findings: [{ ref: "finding-1", severity: "major", file: "x.mjs", line: 1, summary: "Broken" }],
        },
      },
      reviewDispositions: [{
        findingRef: "finding-1",
        disposition: "accepted",
        actor: "operator",
        note: "Accepted for later work",
        at: "2026-08-20T10:04:00.000Z",
      }],
    })],
  }, "review_blocking", ["review_disposition", "reply", "review"]);
  assertReason({
    projects: [{ ...PROJECT, requireReview: true }],
    records: [record("review-stale", {
      review: { current: { verdict: "pass", reviewedHead: "old", at: "2026-08-20T10:03:00.000Z" } },
    })],
  }, "review_stale", ["review", "dismiss"]);
  const parked = assertReason({ records: [record("review-parked", {
    result: null,
    reviewParking: { state: "parked", at: "2026-08-20T10:04:00.000Z", reason: "round cap" },
  })] }, "review_parked", ["dismiss"]);
  assert.equal(
    parked.reasons.find((reason) => reason.code === "review_parked").evidence.guidance,
    "start_replacement",
  );

  assertReason({ records: [record("merge")] }, "merge_ready", ["merge", "dismiss"]);
  assertReason({ records: [record("main", {
    merged: { commit: "abc" },
    postMerge: { state: "failed", endedAt: "2026-08-20T10:05:00.000Z", error: "main red" },
  })] }, "main_health_failed", ["main_health_ack"]);
  assertReason({ records: [record("profile", {
    state: "failed",
    verify: null,
    executionProfileRefusal: { at: "2026-08-20T10:05:00.000Z", detail: "profile changed" },
  })] }, "execution_profile_refusal", ["reply", "dismiss", "reply_accept_profile"]);
  assertReason({ records: [record("removed", {
    state: "completed_empty",
    projectRemoved: true,
  })] }, "project_removed", ["reply", "dismiss"]);
});

test("projects queue, convoy, and bakeoff reasons with their existing actions", () => {
  assertReason({
    queues: [{ project: "fixture", queue: { enabled: true, parkedTickets: [{ ticketId: "parked" }] } }],
  }, "queue_ticket_parked", ["queue_resume"]);
  assertReason({
    queues: [{
      project: "fixture",
      queue: { enabled: false, consecutiveFailures: 3, failureLimit: 2, parkedTickets: [] },
    }],
  }, "queue_circuit_breaker", ["queue_enable"]);
  assertReason({
    convoys: [{ id: "convoy-1", project: "fixture", state: "paused" }],
  }, "convoy_paused", ["convoy_resume", "convoy_cancel"]);
  assertReason({
    records: [
      record("bake-a", { batchKind: "bakeoff", batchId: "batch-1" }),
      record("bake-b", { batchKind: "bakeoff", batchId: "batch-1", result: null }),
    ],
  }, "bakeoff_selection", ["merge", "dismiss"]);
});

test("convoy, queue, and bakeoff subjects absorb member dispatch reasons in precedence order", () => {
  const records = [
    record("convoy-member", { state: "needs_input" }),
    record("queue-member", { state: "failed", verify: null }),
    record("bake-a", { batchKind: "bakeoff", batchId: "batch-1" }),
    record("bake-b", { batchKind: "bakeoff", batchId: "batch-1", state: "completed_empty" }),
  ];
  const result = projection({
    records,
    convoys: [{
      id: "convoy-1",
      project: "fixture",
      state: "paused",
      currentDispatchId: "convoy-member",
    }],
    queues: [{
      project: "fixture",
      queue: {
        enabled: true,
        parkedTickets: [{ ticketId: "queue-ticket", lastDispatchId: "queue-member" }],
      },
    }],
  });

  assert.equal(result.entries.some((entry) => entry.key === "dispatch:convoy-member"), false);
  assert.equal(result.entries.some((entry) => entry.key === "dispatch:queue-member"), false);
  assert.equal(result.entries.some((entry) => entry.key === "dispatch:bake-a"), false);
  assert.equal(result.entries.some((entry) => entry.key === "dispatch:bake-b"), false);
  assert.ok(result.entries.find((entry) => entry.key === "convoy:convoy-1")
    .reasons.some((reason) => reason.code === "needs_input" && reason.evidence.dispatchId === "convoy-member"));
  assert.ok(result.entries.find((entry) => entry.key === "queue:fixture:queue-ticket")
    .reasons.some((reason) => reason.code === "failed_unresolved" && reason.evidence.dispatchId === "queue-member"));
  assert.ok(result.entries.find((entry) => entry.key === "bakeoff:batch-1")
    .reasons.some((reason) => reason.code === "completed_empty" && reason.evidence.dispatchId === "bake-b"));
});

test("higher-precedence convoy absorption prevents the same dispatch riding queue and bakeoff entries", () => {
  const shared = record("shared", { batchKind: "bakeoff", batchId: "batch-1" });
  const result = projection({
    records: [shared, record("sibling", { batchKind: "bakeoff", batchId: "batch-1" })],
    convoys: [{
      id: "convoy-1",
      project: "fixture",
      state: "paused",
      currentDispatchId: "shared",
    }],
    queues: [{
      project: "fixture",
      queue: { enabled: true, parkedTickets: [{ ticketId: "shared-ticket", lastDispatchId: "shared" }] },
    }],
  });
  const occurrences = result.entries.flatMap((entry) => entry.reasons)
    .filter((reason) => reason.code === "merge_ready" && reason.evidence.dispatchId === "shared");
  assert.equal(occurrences.length, 1);
  assert.equal(result.entries.find((entry) => entry.key === "convoy:convoy-1")
    .reasons.includes(occurrences[0]), true);
});

test("three simultaneous dispatch reasons collapse into one entry", () => {
  const result = projection({ records: [record("multi", {
    state: "failed",
    verify: null,
    restartResumeReady: true,
    executionProfileRefusal: { detail: "profile changed" },
  })] });
  assert.equal(result.entries.length, 1);
  assert.deepEqual(
    result.entries[0].reasons.map(({ code }) => code).sort(),
    ["execution_profile_refusal", "failed_unresolved", "restart_resume_ready"],
  );
});

test("dedup proof projects every needs-human class exactly once per distinct subject", () => {
  const passedReview = { current: { verdict: "pass", reviewedHead: "abc" } };
  const records = [
    record("input", { state: "needs_input" }),
    record("plan", { state: "plan_ready" }),
    record("empty", { state: "completed_empty" }),
    record("failure", { state: "failed", verify: null, restartResumeReady: true }),
    record("verify", { verify: { state: "failed" } }),
    record("review-missing", { verify: { state: "failed" } }),
    record("review-error", {
      review: { current: { verdict: "error", reviewedHead: "abc" } },
    }),
    record("review-block", {
      review: { current: {
        verdict: "fail",
        reviewedHead: "abc",
        findings: [{ severity: "major", file: "x", line: 1, summary: "broken" }],
      } },
    }),
    record("review-stale", {
      review: { current: { verdict: "pass", reviewedHead: "old" } },
    }),
    record("review-parked", { verify: { state: "failed" }, reviewParking: { state: "parked" } }),
    record("merge", { review: passedReview }),
    record("main", { merged: { commit: "abc" }, postMerge: { state: "failed" } }),
    record("profile", { state: "failed", verify: null, executionProfileRefusal: { detail: "changed" } }),
    record("removed", { state: "completed_empty", projectRemoved: true }),
    record("queue-member", { state: "failed", verify: null }),
    record("convoy-member", { state: "needs_input" }),
    record("bake-a", { batchKind: "bakeoff", batchId: "batch-all", review: passedReview }),
    record("bake-b", { batchKind: "bakeoff", batchId: "batch-all", verify: { state: "failed" } }),
  ];
  const result = projection({
    records,
    projects: [{ ...PROJECT, requireReview: true }],
    queues: [
      { project: "fixture", queue: {
        enabled: false,
        consecutiveFailures: 2,
        failureLimit: 2,
        parkedTickets: [{ ticketId: "parked", lastDispatchId: "queue-member" }],
      } },
    ],
    convoys: [{
      id: "convoy-all",
      project: "fixture",
      state: "paused",
      currentDispatchId: "convoy-member",
    }],
  });
  const keys = result.entries.map(({ key }) => key);
  assert.equal(keys.length, new Set(keys).size);
  assert.equal(result.entries.length, 18);
  assert.deepEqual(
    Object.keys(ATTENTION_REASONS).filter((code) => result.counts.byReason[code] === 0),
    [],
  );
});

test("excluded states produce no attention", () => {
  const tieredAdvisory = record("advisory", {
    result: null,
    review: { current: {
      verdict: "pass",
      reviewedHead: "abc",
      dispatchId: "review-child",
      findings: [{ severity: "minor", file: "x", line: 1, summary: "advice" }],
    } },
  });
  const inactiveRecords = [
    ...["queued", "preparing", "resuming", "running", "verifying", "stopping", "stopped"]
      .map((state) => record(state, { state, verify: null })),
    record("dismissed", { state: "failed", verify: null, dismissed: { at: NOW.toISOString() } }),
    record("review-child", { reviewOf: "target" }),
    record("acknowledged", {
      merged: { commit: "abc" },
      postMerge: { state: "failed", acknowledgedAt: NOW.toISOString() },
    }),
    record("live-review", {
      review: { current: { verdict: "running", reviewedHead: "old" } },
    }),
    tieredAdvisory,
    record("recovery", { state: "stopped", orphanUnresolved: true, mergeRecoveryPending: true }),
  ];
  const result = projection({
    records: inactiveRecords,
    projects: [{ ...PROJECT, requireReview: true, reviewPolicy: "tiered" }],
    queues: [
      { project: "budget", queue: {
        enabled: true,
        budget: { exceeded: true },
        unpricedDispatches: { exceeded: true },
        parkedTickets: [],
      } },
      { project: "intentional", queue: {
        enabled: false,
        consecutiveFailures: 0,
        failureLimit: 2,
        parkedTickets: [],
      } },
    ],
    convoys: [{
      id: "capacity",
      project: "fixture",
      state: "running",
      currentDispatchId: null,
      reason: "waiting for dispatch capacity",
    }],
  });
  assert.deepEqual(result.entries, []);
  assert.equal(result.counts.total, 0);
});

test("severity and oldest-since ordering is deterministic and truncation is explicit", () => {
  const result = projection({ records: [
    record("medium-new", { endedAt: "2026-08-20T11:00:00.000Z" }),
    record("high-new", { state: "needs_input", endedAt: "2026-08-20T11:00:00.000Z" }),
    record("high-old", { state: "failed", verify: null, endedAt: "2026-08-20T09:00:00.000Z" }),
    record("critical", {
      merged: { commit: "abc" },
      postMerge: { state: "failed", endedAt: "2026-08-20T11:30:00.000Z" },
    }),
  ] }, { limit: 3 });
  assert.deepEqual(result.entries.map(({ key }) => key), [
    "dispatch:critical",
    "dispatch:high-old",
    "dispatch:high-new",
  ]);
  assert.equal(result.entries.length, 3);
  assert.equal(result.counts.total, 4);
  assert.equal(result.truncated, true);
  assert.equal(result.generatedAt, NOW.toISOString());
  assert.equal(result.excluded, ATTENTION_EXCLUSIONS);
});

test("legacy rejected and flat review records remain projectable", () => {
  const rejected = assertReason({ records: [record("legacy-rejected", {
    state: "rejected",
    verify: null,
  })] }, "failed_unresolved", ["dismiss"]);
  assert.equal(rejected.reasons[0].evidence.state, "rejected");

  const flat = assertReason({
    projects: [{ ...PROJECT, requireReview: true }],
    records: [record("legacy-review", {
      review: {
        verdict: "fail",
        reviewedHead: "abc",
        findingsText: "[MAJOR] legacy.mjs:7 - still broken",
      },
    })],
  }, "review_blocking", ["review_disposition", "reply", "review"]);
  assert.equal(flat.reasons.some((reason) => reason.code === "review_missing"), false);
});

test("attention module has no filesystem or child-process imports", async () => {
  const source = await readFile(new URL("./attention.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:(?:fs|child_process)(?:\/[^"']*)?["']/);
});
