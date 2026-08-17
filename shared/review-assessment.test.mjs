import assert from "node:assert/strict";
import test from "node:test";

import { _reviewMergeAssessment } from "../server/lib/dispatch.mjs";
import { gatesFor } from "../server/lib/world-contract.mjs";
import { mergeGateReasons as dashboardMergeGateReasons } from "../ui/reply-availability.mjs";
import { mergeGateReasons as villageMergeGateReasons } from "../themes/cozy-village/state/gates.mjs";
import { assessReview } from "./review-assessment.mjs";

const PROJECT = Object.freeze({
  requireReview: true,
  reviewPolicy: "strict",
  tracker: "committed",
});
const RESULT_BINDING_REASONS = new Set([
  "merge recovery pending",
  "finalized result missing",
  "finalized result does not match branch HEAD",
  "verification attestation missing",
  "attested commit does not match branch HEAD",
  "attested result version does not match finalized result",
]);

function finding(index, severity = "nit", summary = `Finding ${index + 1}.`) {
  return {
    ref: `round-1:finding-${index + 1}`,
    severity,
    file: "shared/review-assessment.mjs",
    line: index + 1,
    summary,
    novelty: "new",
  };
}

function disposition(findingRef, index, kind = "waived") {
  return {
    ref: `disposition-${index + 1}`,
    findingRef,
    disposition: kind,
    ...(kind === "redirected" ? { redirectTicket: "atelier-follow-up" } : {}),
    note: `Disposition ${index + 1}.`,
    actor: "architect",
    at: `2026-07-31T00:0${index}:00.000Z`,
  };
}

function reviewedRecord(round, reviewDispositions = []) {
  const record = {
    id: "assessment-fixture",
    state: "completed",
    ticketId: "atelier-fixture",
    branchHead: "reviewed-head",
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: { ...round, current: round, rounds: [round] },
    reviewDispositions,
  };
  record.gates = gatesFor(record);
  return record;
}

function consumerEligibility(record, project = PROJECT) {
  const server = _reviewMergeAssessment(record, project).eligible;
  const dashboardReasons = dashboardMergeGateReasons(record, project);
  const villageReasons = villageMergeGateReasons(record, project);
  assert.deepEqual(villageReasons, dashboardReasons, "client merge-gate reasons drifted");
  const dashboard = dashboardReasons.every((reason) => RESULT_BINDING_REASONS.has(reason));
  const village = villageReasons.every((reason) => RESULT_BINDING_REASONS.has(reason));
  return { server, dashboard, village };
}

function overflowRecord(severity, { disposeOverflow = false } = {}) {
  const findings = Array.from({ length: 10 }, (_, index) => finding(index));
  const reviewDispositions = findings.map((entry, index) => disposition(entry.ref, index));
  if (disposeOverflow) {
    reviewDispositions.push({
      ...disposition("round-1:overflow-1", 10),
      at: "2026-07-31T00:10:00.000Z",
    });
  }
  return reviewedRecord({
    dispatchId: "review-overflow",
    round: 1,
    verdict: "fail",
    reviewedHead: "reviewed-head",
    findingCount: 10,
    findings,
    findingsTruncated: true,
    findingOverflowCount: 1,
    findingOverflowSeverity: severity,
    findingOverflowSeverityCounts: {
      blocker: severity === "blocker" ? 1 : 0,
      major: severity === "major" ? 1 : 0,
      minor: severity === "minor" ? 1 : 0,
      nit: severity === "nit" ? 1 : 0,
    },
    findingOverflowSeverities: [severity],
    findingOverflowText: `[${severity.toUpperCase()}] overflow.mjs:99 - Late finding.`,
  }, reviewDispositions);
}

test("server gate and both clients agree across overflow and disposition cases", () => {
  const openMajor = finding(0, "major");
  const cases = [{
    label: "clean pass",
    record: reviewedRecord({
      dispatchId: "review-pass",
      round: 1,
      verdict: "pass",
      reviewedHead: "reviewed-head",
      findings: [],
    }),
    expected: true,
    gate: "passed",
  }, {
    label: "open major",
    record: reviewedRecord({
      dispatchId: "review-major",
      round: 1,
      verdict: "fail",
      reviewedHead: "reviewed-head",
      findings: [openMajor],
    }),
    expected: false,
    gate: "failed",
  }, {
    label: "waived major",
    record: reviewedRecord({
      dispatchId: "review-major-waived",
      round: 1,
      verdict: "fail",
      reviewedHead: "reviewed-head",
      findings: [openMajor],
    }, [disposition(openMajor.ref, 0)]),
    expected: true,
    gate: "passed-with-dispositions",
  }, {
    label: "open overflow nit",
    record: overflowRecord("nit"),
    expected: false,
    gate: "failed",
  }, {
    label: "waived overflow nit",
    record: overflowRecord("nit", { disposeOverflow: true }),
    expected: true,
    gate: "passed-with-dispositions",
  }, {
    label: "waived overflow blocker",
    record: overflowRecord("blocker", { disposeOverflow: true }),
    expected: false,
    gate: "failed",
  }];

  for (const scenario of cases) {
    assert.equal(
      scenario.record.gates.find((gate) => gate.gate === "review")?.state,
      scenario.gate,
      `${scenario.label}: server gate`,
    );
    assert.deepEqual(
      consumerEligibility(scenario.record),
      {
        server: scenario.expected,
        dashboard: scenario.expected,
        village: scenario.expected,
      },
      scenario.label,
    );
  }
});

test("dashboard and village expose the same complete result-binding reasons", () => {
  const base = {
    branchHead: "branch-head",
    result: { commit: "branch-head", version: 3 },
    attestation: { resultCommit: "branch-head", resultVersion: 3 },
    verify: { state: "passed" },
    strandedBrWrites: false,
  };
  const cases = [{
    ...base,
    mergeRecoveryPending: true,
  }, {
    ...base,
    result: null,
    attestation: null,
  }, {
    ...base,
    result: { commit: "other-head", version: 4 },
  }, {
    ...base,
    attestation: { resultCommit: "other-head", resultVersion: 2 },
  }];

  for (const record of cases) {
    assert.deepEqual(
      villageMergeGateReasons(record, { requireReview: false }),
      dashboardMergeGateReasons(record, { requireReview: false }),
    );
  }
});

test("an overflow BLOCKER disables normal merge under every policy in core and both clients", () => {
  const record = overflowRecord("blocker", { disposeOverflow: true });
  assert.equal(record.gates.find((gate) => gate.gate === "review")?.state, "failed");
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const project = { ...PROJECT, reviewPolicy };
    assert.equal(_reviewMergeAssessment(record, project).eligible, false, `${reviewPolicy}: core`);
    const expected = [
      "finalized result missing",
      "verification attestation missing",
      "review failed",
    ];
    assert.deepEqual(dashboardMergeGateReasons(record, project), expected);
    assert.deepEqual(villageMergeGateReasons(record, project), expected);
  }
});

test("an upgraded legacy PASS with persisted MAJOR findings still gates strict merge", () => {
  const record = reviewedRecord({
    dispatchId: "review-legacy-pass",
    round: 1,
    verdict: "pass",
    reviewedHead: "reviewed-head",
    findingCount: 1,
    findingsText: "[MAJOR] server/legacy.mjs:41 - The persisted defect remains open.",
  });
  const assessment = assessReview(record, PROJECT);

  assert.deepEqual(assessment.findings.map(({ severity, file, line, summary }) => ({
    severity,
    file,
    line,
    summary,
  })), [{
    severity: "major",
    file: "server/legacy.mjs",
    line: 41,
    summary: "The persisted defect remains open.",
  }]);
  assert.equal(assessment.gateState, "failed");
  assert.equal(assessment.eligible, false);
  assert.deepEqual(consumerEligibility(record), {
    server: false,
    dashboard: false,
    village: false,
  });
});

test("an older waiver appended after a newer acceptance does not neutralize a direct finding", () => {
  const openMajor = finding(0, "major", "The accepted defect remains open.");
  const newerAcceptance = {
    ...disposition(openMajor.ref, 2, "accepted"),
    ref: "newer-acceptance",
    at: "2026-07-31T00:02:00.000Z",
  };
  const olderWaiverAppendedLater = {
    ...disposition(openMajor.ref, 1, "waived"),
    ref: "older-waiver",
    at: "2026-07-31T00:01:00.000Z",
  };
  const record = reviewedRecord({
    dispatchId: "review-direct-disposition-recency",
    round: 1,
    verdict: "fail",
    reviewedHead: "reviewed-head",
    findings: [openMajor],
  }, [newerAcceptance, olderWaiverAppendedLater]);

  const assessment = assessReview(record, PROJECT);
  assert.deepEqual(assessment.openFindings.map(({ ref }) => ref), [openMajor.ref]);
  assert.equal(assessment.gateState, "failed");
  assert.deepEqual(consumerEligibility(record), {
    server: false,
    dashboard: false,
    village: false,
  });
});

test("a redirected repeat in overflow position eleven stays redirect-disputed", () => {
  const overflowText =
    "[MINOR] `overflow.mjs:99` - The redirected overflow finding is unchanged.";
  const round = (roundNumber, visiblePrefix) => ({
    dispatchId: `review-overflow-lineage-${roundNumber}`,
    round: roundNumber,
    verdict: "fail",
    reviewedHead: "reviewed-head",
    findingCount: 10,
    findings: Array.from({ length: 10 }, (_, index) => ({
      ref: `round-${roundNumber}:finding-${index + 1}`,
      severity: "minor",
      file: `shared/${visiblePrefix}-${index + 1}.mjs`,
      line: index + 1,
      summary: `${visiblePrefix} visible finding ${index + 1}.`,
      novelty: "new",
    })),
    findingsTruncated: true,
    findingOverflowCount: 1,
    findingOverflowSeverity: "minor",
    findingOverflowSeverityCounts: { blocker: 0, major: 0, minor: 1, nit: 0 },
    findingOverflowSeverities: ["minor"],
    findingOverflowText: overflowText,
  });
  const rounds = [round(1, "prior"), round(2, "current")];
  const record = {
    review: { ...rounds[1], current: rounds[1], rounds },
    reviewDispositions: [{
      ref: "redirect-overflow",
      findingRef: "round-1:overflow-1",
      disposition: "redirected",
      redirectTicket: "atelier-overflow-follow-up",
      note: "Move only the unchanged overflow finding.",
      actor: "architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  };

  const assessment = assessReview(record, PROJECT);
  assert.equal(assessment.findings.length, 11);
  assert.deepEqual(
    {
      ref: assessment.findings[10].ref,
      file: assessment.findings[10].file,
      line: assessment.findings[10].line,
      novelty: assessment.findings[10].novelty,
      dispositionRef: assessment.findings[10].dispositionRef,
    },
    {
      ref: "round-2:overflow-1",
      file: "overflow.mjs",
      line: 99,
      novelty: "redirect-disputed",
      dispositionRef: "redirect-overflow",
    },
  );
  assert.equal(
    assessment.openFindings.some((finding) => finding.ref === "round-2:overflow-1"),
    false,
  );
});

test("four-step lineage resolution stays identical in the server and both clients", () => {
  const sharedFinding = {
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 40,
    summary: "The same lineage claim remains unresolved.",
  };
  const rounds = [1, 2, 3].map((round) => ({
    dispatchId: `review-lineage-${round}`,
    round,
    verdict: "fail",
    reviewedHead: "reviewed-head",
    findings: [{
      ...sharedFinding,
      ref: `round-${round}:finding-1`,
      ...(round > 1
        ? { novelty: "redirect-disputed", dispositionRef: "lineage-redirect" }
        : { novelty: "new" }),
    }],
  }));
  const record = {
    id: "lineage-fixture",
    state: "completed",
    ticketId: "atelier-lineage",
    branchHead: "reviewed-head",
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: { ...rounds.at(-1), current: rounds.at(-1), rounds },
    reviewDispositions: [],
  };
  const steps = [{
    ref: "lineage-redirect",
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "Redirect the original finding.",
    actor: "architect",
    at: "2026-07-31T00:00:00.000Z",
    expected: true,
  }, {
    ref: "lineage-round-two-waiver",
    findingRef: "round-2:finding-1",
    disposition: "waived",
    note: "Waive the round-two re-flag.",
    actor: "architect",
    at: "2026-07-31T00:01:00.000Z",
    expected: true,
  }, {
    ref: "lineage-round-three-settlement",
    findingRef: "round-3:finding-1",
    disposition: "refuted",
    note: "Settle the current re-flag.",
    actor: "architect",
    at: "2026-07-31T00:02:00.000Z",
    expected: true,
  }, {
    ref: "lineage-late-acceptance",
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "Later evidence reopens the original lineage.",
    actor: "architect",
    at: "2026-07-31T00:03:00.000Z",
    expected: false,
  }];

  for (const [index, step] of steps.entries()) {
    const { expected, ...nextDisposition } = step;
    record.reviewDispositions.push(nextDisposition);
    record.gates = gatesFor(record);
    assert.deepEqual(
      consumerEligibility(record),
      { server: expected, dashboard: expected, village: expected },
      `lineage step ${index + 1}`,
    );
    assert.equal(
      record.gates.find((gate) => gate.gate === "review")?.state,
      expected ? "passed-with-dispositions" : "failed",
      `lineage step ${index + 1}: gate`,
    );
  }
});
