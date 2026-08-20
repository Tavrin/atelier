import assert from "node:assert/strict";
import test from "node:test";

import {
  RECOVERY_ACTIONS,
  RECOVERY_CONDITIONS,
  RECOVERY_LIMIT,
  RECOVERY_LIMITS,
  deepRecoveryFor,
  recoveryFor,
} from "./recovery.mjs";
import { REDACT_TEXT_PATTERNS, redactText } from "./stream.mjs";

const NOW = new Date("2026-08-20T10:00:00.000Z");

function cheap(input, options = {}) {
  return recoveryFor(input, { now: NOW, ...options });
}

function onlyCode(projection, code) {
  const matches = projection.conditions.filter((item) => item.code === code);
  assert.equal(matches.length, 1, `expected exactly one ${code} condition`);
  return matches[0];
}

const cheapCases = [
  {
    code: "merge_recovery_pending",
    input: {
      records: [{ id: "merge", project: "one", mergeRecoveryPending: true }],
      projects: [{ name: "one" }],
    },
    durable: true,
    restartSurvival: "reconciles",
    reportOnly: null,
    actions: ["merge", "dismiss"],
  },
  {
    code: "orphan_unresolved",
    input: { records: [{ id: "orphan", project: "one", orphanUnresolved: true }] },
    durable: true,
    restartSurvival: "reconciles",
    reportOnly: null,
    actions: ["dismiss"],
  },
  {
    code: "merge_audit_debt",
    input: {
      records: [{
        id: "audit",
        project: "one",
        mergeEventDebt: { event: { type: "merge", at: NOW.toISOString() } },
      }],
    },
    durable: true,
    restartSurvival: "reconciles",
    reportOnly: null,
    actions: ["merge"],
  },
  {
    code: "advisory_debt",
    input: {
      records: [{
        id: "advisory",
        project: "one",
        merged: { commit: "abc123" },
        review: {
          rounds: [{
            round: 2,
            advisoryFollowUps: [{ findingRef: "round-2:finding-1", filedAt: null }],
          }],
        },
      }],
    },
    durable: true,
    restartSurvival: "reconciles",
    reportOnly: true,
    actions: [],
  },
  {
    code: "persistence_degraded",
    input: {
      persistence: { degraded: true, targets: ["/state/dispatch/index.jsonl"] },
    },
    durable: false,
    restartSurvival: "in-memory",
    reportOnly: true,
    actions: [],
  },
  {
    code: "convoy_state_unpersisted",
    input: {
      convoys: [{ id: "convoy-one", project: "one" }],
      persistence: { degraded: true, targets: ["C:\\state\\convoys.json"] },
    },
    durable: false,
    restartSurvival: "in-memory",
    reportOnly: true,
    actions: [],
  },
  {
    code: "project_removed_record",
    input: {
      records: [{ id: "removed", project: "gone", projectRemoved: true }],
    },
    durable: true,
    restartSurvival: "manual",
    reportOnly: null,
    actions: ["dismiss"],
  },
];

for (const fixture of cheapCases) {
  test(`cheap recovery projects ${fixture.code}`, () => {
    const projection = cheap(fixture.input);
    const condition = onlyCode(projection, fixture.code);
    assert.equal(condition.severity, RECOVERY_CONDITIONS[fixture.code].severity);
    assert.equal(condition.durable, fixture.durable);
    assert.equal(condition.restartSurvival, fixture.restartSurvival);
    if (fixture.reportOnly) assert.equal(typeof condition.reportOnly, "string");
    else assert.equal(condition.reportOnly, null);
    assert.deepEqual(condition.actions, fixture.actions);
    assert.equal(condition.confirmed, true);
    assert.equal(projection.generatedAt, NOW.toISOString());
  });
}

test("deep recovery maps every GC dry-run inventory field", () => {
  const measuredAt = "2026-08-20T09:55:00.000Z";
  const projection = deepRecoveryFor({
    dryRun: true,
    generatedAt: measuredAt,
    dismissed: ["dispatch-old"],
    orphans: ["/state/worktrees/one/orphan"],
    codexJobs: ["0123456789abcdef01234567"],
    breakGlassAuthorizations: ["break-glass-old"],
    codexProcesses: {
      reported: [{ pid: 4321, reason: "ownership uncorroborated" }],
      reaped: [{ pid: 9876, signal: null }],
    },
    advisoryDebts: [{
      dispatchId: "dispatch-advisory",
      project: "one",
      findingRef: "round-1:finding-1",
    }],
    persistenceFailureTargets: ["/state/dispatch/index.jsonl"],
    warnings: ["orphan candidate retained: identity changed"],
    errors: ["project one: worktree list failed"],
  });

  assert.equal(projection.generatedAt, measuredAt);
  assert.equal(projection.dryRun, true);
  assert.deepEqual(
    [...new Set(projection.conditions.map((item) => item.code))].sort(),
    [
      "advisory_debt",
      "orphan_worktree",
      "persistence_degraded",
      "retained_candidate",
      "scan_error",
      "stale_codex_job",
      "stale_terminal_record",
      "terminal_break_glass",
      "unproven_process",
    ].sort(),
  );
  for (const code of [
    "stale_terminal_record",
    "orphan_worktree",
    "stale_codex_job",
    "terminal_break_glass",
  ]) {
    assert.deepEqual(onlyCode(projection, code).actions, ["doctor_gc"]);
  }
  for (const code of [
    "unproven_process",
    "advisory_debt",
    "persistence_degraded",
    "retained_candidate",
    "scan_error",
  ]) {
    const condition = onlyCode(projection, code);
    assert.equal(typeof condition.reportOnly, "string");
    assert.deepEqual(condition.actions, []);
  }
  assert.equal(
    projection.conditions.some((item) => item.subject.id === "9876"),
    false,
    "completed process reaps are action reports, not recovery conditions",
  );
});

test("deep recovery refuses a mutating GC result", () => {
  assert.throws(
    () => deepRecoveryFor({ dryRun: false }),
    /requires a dry-run GC result/,
  );
});

test("merge recovery offers merge only while its project remains registered", () => {
  const record = { id: "merge", project: "one", mergeRecoveryPending: true };
  const removed = onlyCode(cheap({ records: [record], projects: [] }), "merge_recovery_pending");
  assert.deepEqual(removed.actions, ["dismiss"]);
  assert.equal(removed.restartSurvival, "manual");
  assert.match(removed.detail, /dismiss.*re-register/i);

  const present = onlyCode(cheap({ records: [record], projects: [{ name: "one" }] }),
    "merge_recovery_pending");
  assert.deepEqual(present.actions, ["merge", "dismiss"]);
  assert.equal(present.restartSurvival, "reconciles");
});

test("only queue persistence degradation offers the existing queue retry", () => {
  const projection = cheap({
    persistence: {
      degraded: true,
      targets: ["/state/queue.json", "/state/dispatch/index.jsonl"],
    },
  });
  const queue = projection.conditions.find((item) => item.subject.id === "/state/queue.json");
  const index = projection.conditions.find(
    (item) => item.subject.id === "/state/dispatch/index.jsonl",
  );
  assert.deepEqual(queue.actions, ["queue_set"]);
  assert.equal(queue.reportOnly, null);
  assert.equal(queue.durable, false);
  assert.match(queue.detail, /re-attempts the queue\.json write/i);
  assert.match(queue.detail, /absence after a restart is not proof/i);
  assert.deepEqual(index.actions, []);
  assert.equal(typeof index.reportOnly, "string");
  assert.equal(index.durable, false);
});

test("advisory debt says only boot recovery retries it", () => {
  const advisory = onlyCode(cheap({
    records: [{
      id: "advisory",
      merged: { commit: "abc123" },
      review: {
        current: {
          advisoryFollowUps: [{ findingRef: "round-1:finding-1", filedAt: null }],
        },
      },
    }],
  }), "advisory_debt");
  assert.match(advisory.reportOnly, /boot recovery/i);
  assert.doesNotMatch(advisory.reportOnly, /repeat merge/i);
});

test("deep recovery redacts GC free text with the shared redactor", () => {
  const secret = "sk-ABCDEFGHIJKLMNOP";
  assert.ok(REDACT_TEXT_PATTERNS.length > 0);
  assert.equal(redactText(secret), "[redacted]");
  const projection = deepRecoveryFor({
    dryRun: true,
    codexProcesses: {
      reported: [{ pid: 4321, reason: `worker reported ${secret}` }],
    },
    warnings: [`candidate retained with ${secret}`],
    errors: [`scan failed with ${secret}`],
  }, { now: NOW });
  const error = onlyCode(projection, "scan_error");
  assert.match(error.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(secret));
  assert.ok(RECOVERY_LIMITS.some(({ topic, limit }) =>
    topic === "deep_scan_structural_fields" && /process IDs and worktree paths/i.test(limit)));
});

test("every report-only condition has an empty action list", () => {
  const shallow = cheap({
    records: [{
      id: "advisory",
      merged: { commit: "abc123" },
      review: {
        current: {
          round: 1,
          advisoryFollowUps: [{ findingRef: "round-1:finding-1", filedAt: null }],
        },
      },
    }],
    convoys: [{ id: "convoy-one", project: "one" }],
    persistence: {
      degraded: true,
      targets: ["/state/convoys.json", "/state/dispatch/index.jsonl"],
    },
  });
  const deep = deepRecoveryFor({
    dryRun: true,
    codexProcesses: { reported: [{ pid: 123 }] },
    advisoryDebts: [{ dispatchId: "deep-advisory" }],
    persistenceFailureTargets: ["/state/queue.json"],
    warnings: ["candidate retained"],
    errors: ["scan failed"],
  }, { now: NOW });
  const reportOnly = [...shallow.conditions, ...deep.conditions]
    .filter((item) => item.reportOnly !== null);
  assert.ok(reportOnly.length > 0);
  for (const condition of reportOnly) assert.deepEqual(condition.actions, []);
});

test("actions name only the specified existing routes", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(RECOVERY_ACTIONS).map(([id, action]) =>
      [id, action.http])),
    {
      merge: "POST /api/dispatch/:id/merge",
      dismiss: "POST /api/dispatch/:id/dismiss",
      reply: "POST /api/dispatch/:id/reply",
      verify_rerun: "POST /api/dispatch/:id/verify",
      queue_resume: "POST /api/projects/:project/queue",
      convoy_resume: "POST /api/convoys/:id/resume",
      queue_set: "POST /api/projects/:project/queue",
      doctor_gc: "POST /api/doctor/gc",
    },
  );

  const projections = cheapCases.map((fixture) => cheap(fixture.input));
  projections.push(deepRecoveryFor({
    dryRun: true,
    dismissed: ["old"],
    orphans: ["orphan"],
    codexJobs: ["job"],
    breakGlassAuthorizations: ["token"],
  }, { now: NOW }));
  for (const projection of projections) {
    for (const condition of projection.conditions) {
      for (const action of condition.actions) assert.ok(RECOVERY_ACTIONS[action]);
    }
  }
});

test("actions declare their mechanism-specific repeat semantics", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(RECOVERY_ACTIONS).map(([id, action]) =>
      [id, action.idempotent])),
    {
      merge: "effect",
      dismiss: "effect",
      reply: "no",
      verify_rerun: "state-refused",
      queue_resume: "state-refused",
      convoy_resume: "state-refused",
      queue_set: "effect",
      doctor_gc: "effect",
    },
  );
  assert.deepEqual(
    [...new Set(Object.values(RECOVERY_ACTIONS).map((action) => action.idempotent))].sort(),
    ["effect", "no", "state-refused"],
  );
});

test("persistence degradation is explicitly in-memory and absence after restart proves nothing", () => {
  const condition = onlyCode(cheap({
    persistence: { degraded: true, targets: ["/state/queue.json"] },
  }), "persistence_degraded");
  assert.equal(condition.durable, false);
  assert.equal(condition.restartSurvival, "in-memory");
  assert.match(condition.detail, /absence after a restart is not proof/i);
  assert.match(condition.detail, /merge and unattended queue drain are blocked/i);
  assert.match(condition.detail, /other dispatcher operations remain available/i);
});

const excludedFixtures = [
  {
    name: "a worktree path alone",
    record: { id: "worktree", worktreePath: "/state/worktrees/one/worktree" },
  },
  {
    name: "a claim-release warning",
    record: { id: "claim", warnings: ["claim release failed: tracker changed"] },
  },
  {
    name: "a tracker-move failure",
    record: { id: "move", trackerMoveFailure: { from: "old", to: "new" } },
  },
  {
    name: "a pending break-glass token",
    record: { id: "break-glass", pendingBreakGlassAuthorization: { tokenId: "pending" } },
  },
  {
    name: "stripped merge follow-up debt",
    record: { id: "follow-up", mergeFollowUpDebt: { closeTicket: true } },
  },
];

for (const fixture of excludedFixtures) {
  test(`cheap recovery does not infer a condition from ${fixture.name}`, () => {
    assert.deepEqual(cheap({ records: [fixture.record] }).conditions, []);
  });
}

test("conditions are bounded after severity and subject sorting", () => {
  const projection = cheap({
    records: [
      { id: "z-low", mergeEventDebt: { event: { type: "merge" } } },
      { id: "b-high", orphanUnresolved: true },
      { id: "a-high", mergeRecoveryPending: true },
    ],
  }, { limit: 2 });
  assert.equal(projection.truncated, true);
  assert.equal(projection.conditions.length, 2);
  assert.deepEqual(projection.conditions.map((item) => item.subject.id), ["a-high", "b-high"]);
  assert.equal(projection.counts.total, 3);
});

test("recovery vocabulary, actions, limits and deep scan contract are frozen and complete", () => {
  assert.equal(RECOVERY_LIMIT, 200);
  assert.equal(Object.isFrozen(RECOVERY_CONDITIONS), true);
  assert.equal(Object.isFrozen(RECOVERY_ACTIONS), true);
  for (const value of Object.values(RECOVERY_CONDITIONS)) assert.equal(Object.isFrozen(value), true);
  for (const value of Object.values(RECOVERY_ACTIONS)) assert.equal(Object.isFrozen(value), true);
  assert.ok(RECOVERY_LIMITS.length > 0);
  assert.equal(Object.isFrozen(RECOVERY_LIMITS), true);
  for (const entry of RECOVERY_LIMITS) {
    assert.equal(typeof entry.topic, "string");
    assert.ok(entry.topic.length > 0);
    assert.equal(typeof entry.limit, "string");
    assert.ok(entry.limit.length > 0);
  }

  const projection = cheap({});
  assert.deepEqual(projection.deepScan, {
    available: true,
    via: {
      http: "POST /api/doctor/gc",
      body: { dryRun: true },
      mcp: "atelier_doctor_gc",
    },
    cost: "on-demand only: awaits boot recovery, runs `git worktree list`, sweeps /proc",
  });
  assert.equal(projection.limits, RECOVERY_LIMITS);
});
