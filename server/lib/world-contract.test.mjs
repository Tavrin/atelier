import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  aggregateChronicles,
  artifactsForProject,
  CHRONICLE_LIMIT,
  chronicleFor,
  gatesFor,
  readyIssuesFor,
} from "./world-contract.mjs";

test("readyIssuesFor maps the tracker-ready snapshot and removes Atelier-parked tickets", () => {
  const issues = [
    {
      id: "atelier-child",
      status: "open",
      dependencies: [{ depends_on_id: "atelier-epic", dependency_type: "parent-child" }],
    },
    {
      id: "atelier-related",
      status: "open",
      dependencies: [{ depends_on_id: "atelier-open", dependency_type: "related" }],
    },
    { id: "atelier-parked", status: "open" },
    { id: "atelier-deferred", status: "open", defer_until: "2026-08-30T12:00:00.000Z" },
    { id: "atelier-epic", status: "open", issue_type: "epic" },
    { id: "atelier-open", status: "open" },
  ];

  assert.deepEqual(
    readyIssuesFor(
      issues,
      new Set(["atelier-related", "atelier-child", "atelier-parked", "atelier-missing"]),
      [{ ticketId: "atelier-parked", parked: true }],
    )
      .map(({ id }) => id),
    ["atelier-related", "atelier-child"],
  );
  assert.equal(
    readyIssuesFor(issues, new Set(["atelier-parked"]))
      .some(({ id }) => id === "atelier-parked"),
    true,
    "parking is an explicit queue input, not inferred from tracker fields",
  );
});

test("artifactsForProject indexes only markdown under fixed docs roots and freezes the result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs", "specs", "nested"), { recursive: true });
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await writeFile(
    join(root, "docs", "specs", "nested", "alpha.md"),
    "preface\n\n## Alpha specification\n",
  );
  await writeFile(
    join(root, "docs", "design", "beta.md"),
    "# Beta design #\n",
  );
  await writeFile(join(root, "docs", "design", "ignored.txt"), "# Not markdown\n");

  const generatedAt = "2026-07-30T20:00:00.000Z";
  const snapshot = artifactsForProject({ name: "fixture", path: root }, { generatedAt });
  assert.equal(snapshot.generatedAt, generatedAt);
  assert.deepEqual(snapshot.artifacts.map(({ kind, title, path }) => ({ kind, title, path })), [
    { kind: "design", title: "Beta design", path: "docs/design/beta.md" },
    { kind: "spec", title: "Alpha specification", path: "docs/specs/nested/alpha.md" },
  ]);
  assert.ok(snapshot.artifacts.every(({ updatedAt }) => !Number.isNaN(Date.parse(updatedAt))));
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.artifacts), true);

  await writeFile(join(root, "docs", "specs", "later.md"), "# Later\n");
  assert.equal(snapshot.artifacts.some(({ title }) => title === "Later"), false);
});

test("artifactsForProject rejects symlink traversal from either docs root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-artifact-escape-"));
  const outside = await mkdtemp(join(tmpdir(), "atelier-artifact-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, "docs", "specs"), { recursive: true });
  await mkdir(join(root, "docs", "design"), { recursive: true });
  await writeFile(join(outside, "secret.md"), "# Outside\n");
  await symlink(outside, join(root, "docs", "specs", "escape"));

  assert.throws(
    () => artifactsForProject({ name: "fixture", path: root }),
    /must not use symbolic links/,
  );

  await rm(join(root, "docs", "specs", "escape"));
  await rm(join(root, "docs", "design"), { recursive: true });
  await symlink(outside, join(root, "docs", "design"));
  assert.throws(
    () => artifactsForProject({ name: "fixture", path: root }),
    /root must not be a symbolic link/,
  );
});

function states(record) {
  return Object.fromEntries(gatesFor(record).map(({ gate, state }) => [gate, state]));
}

test("gatesFor covers flat legacy, multi-round, needs_input, forced, and merged-main-red corpus shapes", () => {
  assert.deepEqual(states({
    id: "legacy",
    state: "completed",
    outcome: null,
    verify: { state: "passed", steps: [] },
    review: { verdict: "pass", reviewedHead: "abc" },
    merged: { mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: { state: "passed", steps: [{ exitCode: 0 }] },
  }), {
    changes: "passed",
    verify: "passed",
    review: "passed",
    merge: "passed",
    main: "passed",
  });

  assert.equal(states({
    state: "completed",
    outcome: { changes: "changed" },
    verify: {
      attempts: [{ state: "failed" }, { state: "passed" }],
    },
    review: {
      current: { verdict: "fail", round: 2 },
      rounds: [{ verdict: "pass", round: 1 }, { verdict: "fail", round: 2 }],
    },
  }).review, "failed");

  assert.deepEqual(states({
    state: "needs_input",
    outcome: { kind: "needs_input", changes: "empty" },
    verify: { state: "skipped", steps: [] },
  }), {
    changes: "empty",
    verify: "skipped",
    review: "not-run",
    merge: "not-run",
    main: "not-run",
  });

  assert.deepEqual(states({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "failed" },
    review: { verdict: "fail" },
    merged: { forced: true, mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: { state: "skipped" },
  }), {
    changes: "passed",
    verify: "failed",
    review: "failed",
    merge: "passed",
    main: "skipped",
  });

  assert.equal(states({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "passed" },
    review: { verdict: "pass" },
    merged: { mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: { state: "failed" },
  }).main, "failed");
});

test("gatesFor distinguishes passed-with-dispositions and carries the force audit triple", () => {
  const adjudicated = {
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "passed" },
    review: {
      current: {
        round: 2,
        verdict: "fail",
        findings: [{
          ref: "round-2:finding-1",
          severity: "major",
          file: "server/lib/dispatch.mjs",
          line: 20,
          summary: "A human ruling is required.",
          novelty: "new",
        }],
      },
      rounds: [],
    },
    reviewDispositions: [{
      ref: "disposition-1",
      findingRef: "round-2:finding-1",
      disposition: "refuted",
      note: "Mechanical evidence disproves the claim.",
      actor: "architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  };
  assert.equal(states(adjudicated).review, "passed-with-dispositions");

  const missingActor = structuredClone(adjudicated);
  delete missingActor.reviewDispositions[0].actor;
  assert.equal(states(missingActor).review, "failed", "malformed adjudication fails closed");

  const disposedBlocker = structuredClone(adjudicated);
  disposedBlocker.review.current.findings[0].severity = "blocker";
  disposedBlocker.review.current.findings[0].ref = "round-2:finding-1";
  assert.equal(
    states(disposedBlocker).review,
    "failed",
    "a valid disposition never turns a BLOCKER into passed-with-dispositions",
  );

  const acceptedDispute = structuredClone(adjudicated);
  acceptedDispute.review.current.findings[0] = {
    ...acceptedDispute.review.current.findings[0],
    novelty: "redirect-disputed",
    dispositionRef: "disposition-1",
  };
  acceptedDispute.reviewDispositions = [{
    ref: "disposition-1",
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "Move the original finding out of scope.",
    actor: "architect",
    at: "2026-07-31T00:00:00.000Z",
  }, {
    ref: "disposition-2",
    findingRef: "round-2:finding-1",
    disposition: "accepted",
    note: "The disputed re-flag is accepted and open again.",
    actor: "architect",
    at: "2026-07-31T00:01:00.000Z",
  }];
  assert.equal(
    states(acceptedDispute).review,
    "failed",
    "the latest acceptance reopens a redirect-disputed finding",
  );

  const settledLineage = structuredClone(adjudicated);
  const lineageFinding = {
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 40,
    summary: "The same lineage claim remains unresolved.",
  };
  settledLineage.review = { rounds: [
    { round: 1, verdict: "fail", findings: [{ ...lineageFinding }] },
    {
      round: 2,
      verdict: "fail",
      findings: [{
        ...lineageFinding,
        novelty: "redirect-disputed",
        dispositionRef: "lineage-r1-redirect",
      }],
    },
    {
      round: 3,
      verdict: "fail",
      findings: [{
        ...lineageFinding,
        novelty: "redirect-disputed",
        dispositionRef: "lineage-r2-waiver",
      }],
    },
  ] };
  settledLineage.reviewDispositions = [{
    ref: "lineage-r1-redirect",
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "Redirect round one.",
    actor: "architect",
    at: "2026-07-31T00:00:00.000Z",
  }, {
    ref: "lineage-r2-waiver",
    findingRef: "round-2:finding-1",
    disposition: "waived",
    note: "Waive round two.",
    actor: "architect",
    at: "2026-07-31T00:01:00.000Z",
  }, {
    ref: "lineage-r3-settlement",
    findingRef: "round-3:finding-1",
    disposition: "waived",
    note: "Settle round three.",
    actor: "architect",
    at: "2026-07-31T00:02:00.000Z",
  }];
  assert.equal(states(settledLineage).review, "passed-with-dispositions");
  settledLineage.reviewDispositions.push({
    ref: "lineage-later-r1-acceptance",
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "Later acceptance reopens the whole lineage.",
    actor: "architect",
    at: "2026-07-31T00:03:00.000Z",
  });
  assert.equal(
    states(settledLineage).review,
    "failed",
    "a later round-one acceptance reopens the settled round-three finding",
  );

  const forced = {
    ...adjudicated,
    merged: {
      commit: "abc123",
      mergedAt: "2026-07-31T00:01:00.000Z",
      forcedBy: "maintainer",
      reason: "The open finding is consciously waived.",
      dispositionRef: "ticket-comment-75",
      targetSha: "abc123",
      tokenId: "break-glass-75",
      mintedAt: "2026-08-18T10:00:00.000Z",
      consumedAt: "2026-08-18T10:01:00.000Z",
      resultVersion: 3,
      attestation: { resultCommit: "abc123", resultVersion: 3 },
    },
  };
  assert.deepEqual(
    gatesFor(forced).find((gate) => gate.gate === "merge"),
    {
      gate: "merge",
      state: "bypassed",
      forcedBy: "maintainer",
      reason: "The open finding is consciously waived.",
      dispositionRef: "ticket-comment-75",
      targetSha: "abc123",
      tokenId: "break-glass-75",
      mintedAt: "2026-08-18T10:00:00.000Z",
      consumedAt: "2026-08-18T10:01:00.000Z",
      resultVersion: 3,
      attestation: { resultCommit: "abc123", resultVersion: 3 },
    },
  );
});

test("gatesFor reports an empty-diff outcome as empty, never failed", () => {
  assert.equal(states({
    state: "completed_empty",
    outcome: { kind: "completed_empty", changes: "empty" },
    verify: { state: "skipped", steps: [] },
  }).changes, "empty");
  assert.equal(
    states({ state: "completed_empty", outcome: null }).changes,
    "empty",
    "the terminal empty state remains honest when an older record lacks outcome detail",
  );
  assert.deepEqual(states({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "failed" },
  }), {
    changes: "passed",
    verify: "failed",
    review: "not-run",
    merge: "pending",
    main: "not-run",
  }, "a real failed verdict remains failed while the other gate shapes stay unchanged");
});

test("gatesFor aligns real no-command and zero-check main shapes with main-health", () => {
  const noCommands = gatesFor({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "passed" },
    merged: { mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: { state: "skipped", steps: [] },
  }).find(({ gate }) => gate === "main");
  assert.equal(noCommands.state, "skipped");

  const commandsButZeroChecks = gatesFor({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "passed" },
    merged: { mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: { state: "passed", steps: [] },
  }).find(({ gate }) => gate === "main");
  assert.equal(commandsButZeroChecks.state, "not-run");
  assert.notEqual(commandsButZeroChecks.state, "passed");

  const missingPostMerge = gatesFor({
    state: "completed",
    outcome: { changes: "changed" },
    verify: { state: "passed" },
    merged: { mergedAt: "2026-07-21T00:00:00.000Z" },
    postMerge: null,
  }).find(({ gate }) => gate === "main");
  assert.equal(missingPostMerge.state, "not-run", "missing data is the negative control");
});

test("chronicleFor is chronological, bounded, and derives the scorecard statistics", () => {
  const records = Array.from({ length: CHRONICLE_LIMIT + 2 }, (_, index) => ({
    id: `dispatch-${index}`,
    project: "atelier",
    ticketId: `atelier-${index}`,
    branch: `atelier/theme-work-${index}-dispatch-${index}`,
    costUSD: 2,
    review: index % 2 === 0
      ? { rounds: [{ round: 1, verdict: "pass" }] }
      : { rounds: [{ round: 1, verdict: "fail" }, { round: 2, verdict: "pass" }] },
    merged: {
      mergedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    },
    postMerge: { state: index === 0 ? "failed" : "passed" },
  }));
  records.push({
    id: "unlanded",
    project: "atelier",
    branch: "atelier/unlanded-unlanded",
    costUSD: 7,
    merged: null,
  });
  records.push({
    id: "review-child",
    project: "atelier",
    reviewOf: "dispatch-0",
    costUSD: 100,
    merged: null,
  });

  const result = chronicleFor(records, "atelier", {
    generatedAt: "2026-07-30T00:00:00.000Z",
  });

  assert.equal(result.records.length, CHRONICLE_LIMIT);
  assert.equal(result.truncated, true);
  assert.equal(result.records[0].id, "dispatch-2");
  assert.equal(result.records.at(-1).id, `dispatch-${CHRONICLE_LIMIT + 1}`);
  assert.deepEqual(result.records.at(-1), {
    id: `dispatch-${CHRONICLE_LIMIT + 1}`,
    ticketId: `atelier-${CHRONICLE_LIMIT + 1}`,
    title: `theme-work-${CHRONICLE_LIMIT + 1}`,
    mergedAt: records[CHRONICLE_LIMIT + 1].merged.mergedAt,
    costUSD: 2,
    rounds: 2,
    postMerge: "passed",
    diff: null,
  });
  assert.deepEqual(result.summary, {
    merges: CHRONICLE_LIMIT + 2,
    forcedMerges: 0,
    firstPassReviews: (CHRONICLE_LIMIT + 2) / 2,
    reviewedMerges: CHRONICLE_LIMIT + 2,
    reviewPassRate: 0.5,
    finalRoundSeverityDistribution: { blocker: 0, major: 0, minor: 0, nit: 0 },
    finalRoundSeverityDistributionByOutcome: {
      merged: { blocker: 0, major: 0, minor: 0, nit: 0 },
      gated: { blocker: 0, major: 0, minor: 0, nit: 0 },
      parked: { blocker: 0, major: 0, minor: 0, nit: 0 },
      dismissed: { blocker: 0, major: 0, minor: 0, nit: 0 },
    },
    costPerMergeUSD: ((CHRONICLE_LIMIT + 2) * 2 + 7) / (CHRONICLE_LIMIT + 2),
    unlandedSpendUSD: 7,
  });
});

test("chronicleFor scores first-pass review over reviewed merges only", () => {
  const record = (id, minute, rounds) => ({
    id,
    project: "atelier",
    review: rounds ? { rounds } : undefined,
    merged: {
      commit: id.padEnd(40, id.at(-1)),
      mergedAt: `2026-07-30T10:${String(minute).padStart(2, "0")}:00.000Z`,
    },
  });

  const result = chronicleFor([
    record("first-pass", 1, [{ round: 1, verdict: "pass" }]),
    record(
      "retry",
      2,
      [{ round: 1, verdict: "fail" }, { round: 2, verdict: "pass" }],
    ),
    record("git-backfill", 3, null),
  ], "atelier");

  assert.equal(result.summary.merges, 3);
  assert.equal(result.summary.firstPassReviews, 1);
  assert.equal(result.summary.reviewedMerges, 2);
  assert.equal(result.summary.reviewPassRate, 0.5);
});

test("chronicleFor counts only successful one-round reviews as first-pass", () => {
  const merged = (id, minute, round, reviewDispositions = []) => ({
    id,
    project: "atelier",
    review: { rounds: [{ round: 1, ...round }] },
    reviewDispositions,
    merged: {
      commit: id.padEnd(40, id.at(-1)),
      mergedAt: `2026-07-30T10:${String(minute).padStart(2, "0")}:00.000Z`,
    },
  });

  const result = chronicleFor([
    merged("pass", 1, { verdict: "pass" }),
    merged("tiered-fail", 2, {
      verdict: "fail",
      findings: [{ ref: "round-1:finding-1", severity: "minor" }],
    }),
    merged("disposition-pass", 3, {
      verdict: "fail",
      findings: [{ ref: "round-1:finding-1", severity: "minor" }],
    }, [{
      ref: "disposition-1",
      findingRef: "round-1:finding-1",
      disposition: "waived",
      actor: "fixture-architect",
      note: "Explicitly waived for this merge.",
    }]),
  ], "atelier");

  assert.equal(result.summary.reviewedMerges, 3);
  assert.equal(result.summary.firstPassReviews, 2);
  assert.equal(result.summary.reviewPassRate, 2 / 3);
});

test("chronicleFor counts final-round severity across every reviewed outcome", () => {
  const merged = (id, minute, rounds) => ({
    id,
    project: "atelier",
    review: { rounds },
    merged: {
      commit: id.padEnd(40, id.at(-1)),
      mergedAt: `2026-07-30T11:${String(minute).padStart(2, "0")}:00.000Z`,
    },
  });
  const result = chronicleFor([
    merged("two-round", 1, [{
      round: 1,
      verdict: "fail",
      findings: [{ severity: "blocker" }, { severity: "nit" }],
    }, {
      round: 2,
      verdict: "fail",
      findings: [{ severity: "major" }, { severity: "nit" }, { severity: "nit" }],
    }]),
    merged("first-pass", 2, [{
      round: 1,
      verdict: "pass",
      findings: [{ severity: "minor" }, { severity: "nit" }],
    }]),
    {
      id: "gated",
      project: "atelier",
      review: { rounds: [{
        round: 1,
        verdict: "fail",
        findings: [{ severity: "blocker" }],
      }] },
      merged: null,
    },
    {
      id: "parked",
      project: "atelier",
      review: { rounds: [{
        round: 1,
        verdict: "fail",
        findings: [{ severity: "minor" }],
      }] },
      reviewParking: { state: "parked" },
      merged: null,
    },
    {
      id: "dismissed",
      project: "atelier",
      review: { rounds: [{
        round: 1,
        verdict: "fail",
        findings: [{ severity: "nit" }],
      }] },
      dismissed: { at: "2026-07-30T12:00:00.000Z" },
      merged: null,
    },
  ], "atelier");

  assert.deepEqual(result.summary.finalRoundSeverityDistribution, {
    blocker: 1,
    major: 1,
    minor: 2,
    nit: 4,
  });
  assert.deepEqual(result.summary.finalRoundSeverityDistributionByOutcome, {
    merged: { blocker: 0, major: 1, minor: 1, nit: 3 },
    gated: { blocker: 1, major: 0, minor: 0, nit: 0 },
    parked: { blocker: 0, major: 0, minor: 1, nit: 0 },
    dismissed: { blocker: 0, major: 0, minor: 0, nit: 1 },
  });
});

test("chronicleFor counts every overflow severity including NIT", () => {
  const result = chronicleFor([{
    id: "overflow-gated",
    project: "atelier",
    review: { rounds: [{
      round: 1,
      verdict: "fail",
      findings: Array.from({ length: 10 }, () => ({ severity: "minor" })),
      findingsTruncated: true,
      findingOverflowCount: 4,
      findingOverflowSeverity: "blocker",
      findingOverflowSeverityCounts: { blocker: 1, major: 1, minor: 0, nit: 2 },
      findingOverflowSeverities: ["nit", "blocker", "major", "nit"],
      findingOverflowText: [
        "[NIT] overflow.mjs:11 - Nit one.",
        "[BLOCKER] overflow.mjs:12 - Blocker.",
        "[MAJOR] overflow.mjs:13 - Major.",
        "[NIT] overflow.mjs:14 - Nit two.",
      ].join("\n"),
    }] },
    merged: null,
  }], "atelier");

  assert.deepEqual(result.summary.finalRoundSeverityDistribution, {
    blocker: 1,
    major: 1,
    minor: 10,
    nit: 2,
  });
  assert.deepEqual(result.summary.finalRoundSeverityDistributionByOutcome.gated, {
    blocker: 1,
    major: 1,
    minor: 10,
    nit: 2,
  });
});

test("chronicleFor exposes forced merge provenance without backfilling old merges", () => {
  const result = chronicleFor([{
    id: "forced-merge",
    project: "atelier",
    title: "Forced with an audit trail",
    costUSD: 100,
    review: { rounds: [{ round: 1, verdict: "fail" }] },
    merged: {
      commit: "abc123",
      mergedAt: "2026-07-31T00:00:00.000Z",
      forcedBy: "maintainer",
      reason: "Human authority accepted the remaining risk.",
      dispositionRef: "ticket-comment-75",
    },
  }, {
    id: "legacy-merge",
    project: "atelier",
    title: "Older merge",
    costUSD: 4,
    review: { rounds: [{ round: 1, verdict: "pass" }] },
    merged: {
      commit: "def456",
      mergedAt: "2026-07-30T00:00:00.000Z",
    },
  }, {
    id: "unlanded",
    project: "atelier",
    costUSD: 2,
    merged: null,
  }], "atelier");
  const forced = result.records.find((record) => record.id === "forced-merge");
  assert.equal(forced.forcedBy, "maintainer");
  assert.equal(forced.reason, "Human authority accepted the remaining risk.");
  assert.equal(forced.dispositionRef, "ticket-comment-75");
  assert.equal(
    Object.hasOwn(result.records.find((record) => record.id === "legacy-merge"), "forcedBy"),
    false,
  );
  assert.equal(result.summary.merges, 1);
  assert.equal(result.summary.forcedMerges, 1);
  assert.equal(result.summary.reviewedMerges, 1);
  assert.equal(result.summary.firstPassReviews, 1);
  assert.equal(result.summary.costPerMergeUSD, 6);
});

test("chronicleFor backfills durable merge history without duplicating recorded commits", () => {
  const recorded = {
    id: "dispatch-recorded",
    project: "atelier",
    branch: "atelier/recorded-dispatch-recorded",
    costUSD: 2,
    merged: {
      commit: "a".repeat(40),
      mergedAt: "2026-07-29T10:00:00.000Z",
    },
  };
  const result = chronicleFor([recorded], "atelier", {
    historyRecords: [{
      id: "dispatch-recorded",
      project: "atelier",
      title: "duplicate from git",
      merged: {
        commit: "a".repeat(40),
        mergedAt: "2026-07-29T10:00:00.000Z",
      },
    }, {
      id: "history-only",
      project: "atelier",
      ticketId: "atelier-old",
      title: "older durable merge",
      merged: {
        commit: "b".repeat(40),
        mergedAt: "2026-07-28T10:00:00.000Z",
      },
    }],
    diffStatsForRecords: (records) => new Map(
      records.map((record) => [
        record.merged.commit,
        record.id === "history-only"
          ? { files: 3, insertions: 21, deletions: 4 }
          : { files: 1, insertions: 2, deletions: 0 },
      ]),
    ),
  });

  assert.equal(result.summary.merges, 2);
  assert.equal(result.summary.firstPassReviews, 0);
  assert.equal(result.summary.reviewedMerges, 0);
  assert.equal(result.summary.reviewPassRate, null);
  assert.deepEqual(result.records.map(({ id, title, diff }) => ({ id, title, diff })), [{
    id: "history-only",
    title: "older durable merge",
    diff: { files: 3, insertions: 21, deletions: 4 },
  }, {
    id: "dispatch-recorded",
    title: "recorded",
    diff: { files: 1, insertions: 2, deletions: 0 },
  }]);
});

test("aggregateChronicles merges registered project ledgers chronologically at the shared bound", () => {
  const generatedAt = "2026-07-30T08:00:00.000Z";
  const records = Array.from({ length: CHRONICLE_LIMIT + 2 }, (_, index) => ({
    id: `dispatch-${index}`,
    ticketId: `ticket-${index}`,
    title: `work-${index}`,
    mergedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    costUSD: index,
    rounds: 1,
    postMerge: "passed",
  }));
  const chronicles = new Map([
    ["alpha", {
      project: "alpha",
      generatedAt,
      records: records.filter((_, index) => index % 2 === 0),
      truncated: false,
    }],
    ["beta", {
      project: "beta",
      generatedAt,
      records: records.filter((_, index) => index % 2 === 1),
      truncated: false,
    }],
  ]);

  const result = aggregateChronicles(chronicles, { generatedAt });

  assert.equal(result.generatedAt, generatedAt);
  assert.equal(result.records.length, CHRONICLE_LIMIT);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.records[0], {
    ...records[2],
    project: "alpha",
  });
  assert.deepEqual(result.records.at(-1), {
    ...records.at(-1),
    project: "beta",
  });
  assert.equal(
    result.records.some((record) => record.id === "dispatch-0"),
    false,
    "the oldest over-bound record is the negative control",
  );
});
