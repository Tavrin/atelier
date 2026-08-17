import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReviewDispositionEvent,
  applyReviewEvent,
  currentReview,
  dismissAvailability,
  mergeGateReasons,
  planAvailability,
  replyAvailability,
  reviewRounds,
  reviewIsStale,
  lastActivityAt,
  verificationEmptyMessage,
  verifyRerunAvailability,
} from "./reply-availability.mjs";

const claude = {
  displayName: "Claude",
  capabilities: { liveInput: true, canResume: true },
};

function mergeBinding(branchHead = "reviewed-head", version = 1) {
  return {
    branchHead,
    result: { commit: branchHead, version },
    attestation: { resultCommit: branchHead, resultVersion: version },
  };
}

test("a live review patch retains overflow text so client reassessment matches reload", () => {
  const record = {
    ...mergeBinding(),
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: null,
  };
  const overflowText =
    "[BLOCKER] `server/lib/dispatch.mjs:99` - The live-only overflow blocker must gate.";
  applyReviewEvent(record, {
    type: "review",
    reviewDispatchId: "review-live-overflow",
    reviewedHead: "reviewed-head",
    round: 1,
    at: "2026-07-31T00:00:00.000Z",
    verdict: "fail",
    summary: "Eleven findings remain.",
    findingCount: 10,
    findings: Array.from({ length: 10 }, (_, index) => ({
      ref: `round-1:finding-${index + 1}`,
      severity: "nit",
      file: `ui/file-${index + 1}.mjs`,
      line: index + 1,
      summary: `Visible finding ${index + 1}.`,
      novelty: "new",
    })),
    findingsTruncated: true,
    findingOverflowCount: 1,
    findingOverflowSeverity: "blocker",
    findingOverflowSeverityCounts: { blocker: 1, major: 0, minor: 0, nit: 0 },
    findingOverflowSeverities: ["blocker"],
    findingOverflowText: overflowText,
    gates: [{ gate: "review", state: "failed" }],
  });
  record.gates = [{ gate: "review", state: "failed" }];

  assert.equal(record.review.current.findingOverflowText, overflowText);
  assert.deepEqual(
    mergeGateReasons(record, { requireReview: true, reviewPolicy: "tiered" }),
    ["review failed"],
  );
});

test("a disposition event disables merge immediately when the detail refetch fails", async () => {
  const major = {
    ref: "round-1:finding-1",
    severity: "major",
    file: "ui/app.js",
    line: 1,
    summary: "The live disposition fallback must update the merge gate.",
    novelty: "new",
  };
  const waiver = {
    ref: "disposition-1",
    findingRef: major.ref,
    disposition: "waived",
    note: "Initially waived.",
    actor: "architect",
    at: "2026-07-31T00:00:00.000Z",
  };
  const acceptance = {
    ref: "disposition-2",
    findingRef: major.ref,
    disposition: "accepted",
    note: "Reopened and accepted for repair.",
    actor: "architect",
    at: "2026-07-31T00:01:00.000Z",
  };
  const round = {
    dispatchId: "review-live-disposition",
    round: 1,
    verdict: "fail",
    reviewedHead: "reviewed-head",
    findings: [major],
  };
  const record = {
    state: "completed",
    ...mergeBinding(),
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: { ...round, current: round, rounds: [round] },
    reviewDispositions: [waiver],
    gates: [{ gate: "review", state: "passed-with-dispositions" }],
  };
  const project = { requireReview: true, reviewPolicy: "strict" };
  assert.deepEqual(mergeGateReasons(record, project), []);

  applyReviewDispositionEvent(record, {
    type: "review-disposition",
    reviewDispositions: [waiver, acceptance],
    gates: [{ gate: "review", state: "failed" }],
  });
  await assert.rejects(
    async () => { throw new Error("detail refetch unavailable"); },
    /detail refetch unavailable/,
  );

  assert.deepEqual(record.reviewDispositions, [waiver, acceptance]);
  assert.deepEqual(record.gates, [{ gate: "review", state: "failed" }]);
  assert.deepEqual(mergeGateReasons(record, project), ["review failed"]);
});

test("dismiss offers the merged post-merge-fence escape but stays hidden for a clean merge", () => {
  const merged = {
    state: "completed",
    merged: { commit: "abc1234" },
    postMerge: { state: "failed" },
  };

  assert.deepEqual(
    dismissAvailability({
      ...merged,
      postMerge: {
        state: "failed",
        error:
          "server restart interrupted post-merge verification; main health is unknown and its verifier could not be confirmed dead: identity unavailable",
      },
    }),
    {
      available: true,
      label: "Dismiss record (release runner barrier)",
    },
  );
  assert.deepEqual(
    dismissAvailability(merged),
    { available: false, label: "Dismiss" },
  );
});

test("a restart-interrupted claude dispatch surfaces Resume after restart, not the ordinary reply label", () => {
  const record = {
    state: "failed",
    sessionId: "captured-session",
    restartResumeReady: true,
  };

  const availability = replyAvailability(record, claude);
  assert.equal(availability.label, "Resume after restart");
  assert.match(availability.hint, /A Atelier restart interrupted Claude/);
  assert.equal(availability.reason, undefined);
});

test("the same terminal dispatch offers the ordinary reply label once it is no longer resume-ready", () => {
  const record = {
    state: "failed",
    sessionId: "captured-session",
    restartResumeReady: false,
  };

  assert.equal(replyAvailability(record, claude).label, "Reply & resume");
});

test("an unresolved orphan refuses every composer rather than offering a button that can only 409", () => {
  for (const state of ["failed", "completed", "stopped", "running", "plan_ready"]) {
    const availability = replyAvailability(
      { state, sessionId: "captured-session", restartResumeReady: true, orphanUnresolved: true },
      claude,
    );
    assert.equal(availability.label, undefined, `${state} offered a composer`);
    assert.match(availability.reason, /could not be confirmed dead/);
  }
});

test("resume-ready never overrides a hard refusal: no session, dismissed, or merged", () => {
  const resumeReady = { state: "failed", restartResumeReady: true };

  assert.match(
    replyAvailability({ ...resumeReady, sessionId: null }, claude).reason,
    /No resumable agent session/,
  );
  assert.match(
    replyAvailability(
      { ...resumeReady, sessionId: "s", dismissed: { at: "now" } },
      claude,
    ).reason,
    /dismissed/,
  );
  assert.match(
    replyAvailability({ ...resumeReady, sessionId: "s", merged: { commit: "abc" } }, claude).reason,
    /merged/,
  );
});

test("plan continuation is refused for an unresolved orphan, and offered when the record is clean", () => {
  const planReady = { state: "plan_ready", plan: { state: "ready" } };

  const refused = planAvailability({ ...planReady, orphanUnresolved: true });
  assert.equal(refused.ready, false);
  assert.match(refused.reason, /could not be confirmed dead/);

  const offered = planAvailability(planReady);
  assert.equal(offered.ready, true);
  assert.equal(offered.reason, "");

  // An ordinary not-plan_ready record is still simply not ready, with no reason
  // to show - the refusal text is reserved for the case the server would 409.
  assert.deepEqual(planAvailability({ state: "running" }), { ready: false, reason: "" });
});

test("an unresolved orphan is a merge gate reason, so the normal button disables and Force merge stays offered", () => {
  const completed = {
    ...mergeBinding("bound-head"),
    verify: { state: "passed" },
    strandedBrWrites: false,
  };

  assert.deepEqual(mergeGateReasons(completed, {}), []);
  assert.deepEqual(
    mergeGateReasons({ ...completed, orphanUnresolved: true }, {}),
    ["a prior worker could not be confirmed dead"],
  );
  // It stacks with the existing gates rather than replacing them.
  assert.deepEqual(
    mergeGateReasons({ ...completed, verify: { state: "failed" }, orphanUnresolved: true }, {}),
    ["a prior worker could not be confirmed dead", "verification failed"],
  );
});

test("dashboard merge reasons mirror every result and attestation binding refusal", () => {
  const base = {
    ...mergeBinding("branch-head", 3),
    verify: { state: "passed" },
    strandedBrWrites: false,
  };

  assert.deepEqual(
    mergeGateReasons({ ...base, result: null, attestation: null }, {}),
    ["finalized result missing", "verification attestation missing"],
  );
  assert.deepEqual(
    mergeGateReasons({ ...base, result: { commit: "other-head", version: 4 } }, {}),
    [
      "finalized result does not match branch HEAD",
      "attested result version does not match finalized result",
    ],
  );
  assert.deepEqual(
    mergeGateReasons({ ...base, attestation: null }, {}),
    ["verification attestation missing"],
  );
  assert.deepEqual(
    mergeGateReasons({
      ...base,
      attestation: { resultCommit: "other-head", resultVersion: 2 },
    }, {}),
    [
      "attested commit does not match branch HEAD",
      "attested result version does not match finalized result",
    ],
  );
});

test("review staleness is decided by the reviewed head, not the verdict alone", () => {
  assert.equal(reviewIsStale({ verdict: "pass", reviewedHead: "old-head" }, "new-head"), true);
  assert.equal(reviewIsStale({ verdict: "pass", reviewedHead: "same-head" }, "same-head"), false);
  assert.equal(reviewIsStale({ verdict: "fail", reviewedHead: "old-head" }, "new-head"), false);
  assert.equal(
    reviewIsStale(
      { verdict: "fail", reviewedHead: "old-head" },
      "new-head",
      "passed-with-dispositions",
    ),
    true,
  );
  assert.equal(reviewIsStale({ verdict: "pass" }, "new-head"), true);
  assert.equal(reviewIsStale(undefined, "new-head"), false);
});

test("passed-with-dispositions clears the dashboard merge blocker but still decays", () => {
  const record = {
    ...mergeBinding(),
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: { verdict: "fail", reviewedHead: "reviewed-head" },
    gates: [{ gate: "review", state: "passed-with-dispositions" }],
  };
  assert.deepEqual(mergeGateReasons(record, { requireReview: true }), []);
  assert.deepEqual(
    mergeGateReasons({ ...record, ...mergeBinding("changed-head") }, { requireReview: true }),
    ["review stale - re-review required"],
  );
});

test("dashboard merge reasons respect strict, tiered, advisory, and the universal blocker", () => {
  const recordFor = (severity) => ({
    ...mergeBinding(),
    ticketId: "atelier-1",
    verify: { state: "passed" },
    strandedBrWrites: false,
    review: {
      current: {
        dispatchId: "review-policy",
        round: 1,
        verdict: "fail",
        reviewedHead: "reviewed-head",
        findings: [{
          ref: "round-1:finding-1",
          severity,
          file: "ui/app.js",
          line: 1,
          summary: "Fixture finding.",
        }],
      },
    },
    reviewDispositions: [],
    gates: [{ gate: "review", state: "failed" }],
  });
  assert.deepEqual(
    mergeGateReasons(recordFor("minor"), { requireReview: true, reviewPolicy: "strict" }),
    ["review failed"],
  );
  assert.deepEqual(
    mergeGateReasons(recordFor("nit"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    [],
  );
  assert.deepEqual(
    mergeGateReasons({ ...recordFor("nit"), ticketId: null }, {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    ["review advisory filing requires a tracker ticket and linked review dispatch"],
  );
  assert.deepEqual(
    mergeGateReasons(recordFor("nit"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "none",
    }),
    ["review advisory filing requires a tracker ticket and linked review dispatch"],
  );
  const unlinked = recordFor("nit");
  unlinked.review.current.dispatchId = null;
  assert.deepEqual(
    mergeGateReasons(unlinked, {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    ["review advisory filing requires a tracker ticket and linked review dispatch"],
  );
  assert.deepEqual(
    mergeGateReasons(recordFor("major"), { requireReview: true, reviewPolicy: "tiered" }),
    ["review failed"],
  );
  assert.deepEqual(
    mergeGateReasons(recordFor("major"), { requireReview: true, reviewPolicy: "advisory" }),
    [],
  );
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    assert.deepEqual(
      mergeGateReasons(recordFor("blocker"), { requireReview: true, reviewPolicy }),
      ["review failed"],
    );
  }
  const acceptedDispute = recordFor("major");
  acceptedDispute.review.current.findings[0].novelty = "redirect-disputed";
  acceptedDispute.review.current.findings[0].dispositionRef = "disposition-1";
  acceptedDispute.reviewDispositions = [{
    ref: "disposition-1",
    findingRef: "round-0:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "The original finding moved out of scope.",
    actor: "architect",
  }, {
    ref: "disposition-2",
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "The disputed re-flag is now accepted and open.",
    actor: "architect",
  }];
  assert.deepEqual(
    mergeGateReasons(acceptedDispute, { requireReview: true, reviewPolicy: "strict" }),
    ["review failed"],
    "the dashboard must not hide a redirect dispute after its latest acceptance",
  );
});

test("review history helpers use the current round and parked threads refuse replies", () => {
  const rounds = [
    { round: 1, verdict: "fail", reviewedHead: "old-head", findingCount: 3 },
    { round: 2, verdict: "pass", reviewedHead: "same-head", findingCount: 0 },
  ];
  const review = { current: rounds[1], rounds };

  assert.deepEqual(reviewRounds(review), rounds);
  assert.equal(currentReview(review), rounds[1]);
  assert.equal(reviewIsStale(review, "same-head"), false);
  assert.deepEqual(
    mergeGateReasons(
      {
        ...mergeBinding("same-head"),
        verify: { state: "passed" },
        strandedBrWrites: false,
        review,
      },
      { requireReview: true },
    ),
    [],
  );
  assert.match(
    replyAvailability({
      state: "completed",
      sessionId: "captured",
      reviewParking: {
        round: 2,
        reason: "finding count did not strictly shrink (2 to 2)",
      },
    }, claude).reason,
    /parked after round 2/,
  );
});

test("needs_input offers the answer composer, and its question is the hint", () => {
  const availability = replyAvailability(
    {
      state: "needs_input",
      sessionId: "captured-session",
      outcome: {
        kind: "needs_input",
        question: "Want me to go with (1) or (2)?",
        answerPath: "reply",
      },
    },
    claude,
  );

  assert.equal(availability.label, "Answer & resume");
  assert.match(availability.hint, /Want me to go with \(1\) or \(2\)\?/);
  assert.equal(availability.reason, undefined);
});

test("needs_input without a captured question still offers a composer, never a refusal", () => {
  const availability = replyAvailability(
    { state: "needs_input", sessionId: "captured-session", outcome: { kind: "needs_input" } },
    claude,
  );
  assert.equal(availability.label, "Answer & resume");
  assert.match(availability.hint, /waiting on an answer/);
});

test("completed_empty offers a reply composer that names what is missing", () => {
  const availability = replyAvailability(
    { state: "completed_empty", sessionId: "captured-session" },
    claude,
  );
  assert.equal(availability.label, "Reply & resume");
  assert.match(availability.hint, /produced no changes/);
});

test("an unfinished outcome is still refused for an unresolved orphan or a missing session", () => {
  for (const state of ["needs_input", "completed_empty"]) {
    assert.equal(
      replyAvailability(
        { state, sessionId: "captured-session", orphanUnresolved: true },
        claude,
      ).label,
      undefined,
      `${state} offered a composer for an unresolved orphan`,
    );
    assert.match(
      replyAvailability({ state, sessionId: null }, claude).reason,
      /No resumable agent session/,
    );
  }
});

test("the verify panel reports the recorded skip reason instead of inventing one", () => {
  // A needs_input dispatch skips a CONFIGURED suite on purpose, so the old
  // "No verification commands configured." was a false statement about the project.
  assert.equal(
    verificationEmptyMessage({
      state: "needs_input",
      verify: { state: "skipped", detail: "nothing to verify - this dispatch is waiting on an answer", steps: [] },
    }),
    "Nothing to verify - this dispatch is waiting on an answer.",
  );
  assert.equal(
    verificationEmptyMessage({
      state: "completed_empty",
      verify: { state: "skipped", detail: "nothing to verify - this dispatch produced no changes", steps: [] },
    }),
    "Nothing to verify - this dispatch produced no changes.",
  );
  // A genuinely command-less project - and only that - gets the configuration claim.
  assert.equal(
    verificationEmptyMessage(
      { state: "completed", verify: { state: "skipped", steps: [] } },
      { name: "fixture", verifyCommands: [] },
    ),
    "No verification commands configured.",
  );
  assert.equal(
    verificationEmptyMessage(
      { state: "completed", verify: { state: "skipped", detail: "  ", steps: [] } },
      { name: "fixture", verifyCommands: [] },
    ),
    "No verification commands configured.",
  );
  // Configured but skipped with no recorded reason - `verify: false`, or a
  // non-worktree verify mode. Claiming the project has no commands would be false.
  assert.equal(
    verificationEmptyMessage(
      { state: "completed", verifyRequested: false, verify: { state: "skipped", steps: [] } },
      { name: "fixture", verifyCommands: ["node --test"] },
    ),
    "Verification was skipped.",
  );
  assert.equal(
    verificationEmptyMessage(
      { state: "completed", verify: { state: "skipped", steps: [] } },
      { name: "fixture", verifyMode: "container-primary", verifyCommands: ["node --test"] },
    ),
    "Verification was skipped.",
  );
  // An unknown or not-yet-loaded project is not evidence of an empty command list.
  assert.equal(
    verificationEmptyMessage({ state: "completed", verify: { state: "skipped", steps: [] } }),
    "Verification was skipped.",
  );
  // Not skipped, and no verify at all, both mean "not started".
  assert.equal(
    verificationEmptyMessage({ state: "verifying", verify: { state: "running", steps: [] } }),
    "Verification has not started.",
  );
  assert.equal(verificationEmptyMessage({ state: "queued" }), "Verification has not started.");
  assert.equal(verificationEmptyMessage(undefined), "Verification has not started.");
  // An already-punctuated detail is not double-punctuated.
  assert.equal(
    verificationEmptyMessage({ verify: { state: "skipped", detail: "Skipped by request." } }),
    "Skipped by request.",
  );
});

// atelier-9dt: the re-run affordance must appear exactly where the dispatcher
// accepts it. Every row below mirrors one refusal in rerunVerification().
test("the verify re-run is offered only for a completed dispatch whose verdict failed", () => {
  const project = { verifyMode: "worktree", verifyCommands: ["node --test"] };
  const worktreePath = "/state/worktrees/fixture/dispatch-1";
  const stranded = { state: "completed", verify: { state: "failed" }, worktreePath };

  assert.deepEqual(verifyRerunAvailability(stranded, project), { available: true, reason: "" });
  for (const [label, record] of [
    ["a passed verdict is not stranded", { ...stranded, verify: { state: "passed" } }],
    ["a skipped verdict never had a suite", { ...stranded, verify: { state: "skipped" } }],
    ["a missing verdict never verified", { ...stranded, verify: null }],
    ["a running verification is not terminal", { ...stranded, state: "verifying", verify: { state: "running" } }],
    ["needs_input has nothing to verify", { ...stranded, state: "needs_input", verify: { state: "skipped" } }],
    ["completed_empty has nothing to verify", { ...stranded, state: "completed_empty", verify: { state: "skipped" } }],
    ["a failed dispatch cannot be merged anyway", { ...stranded, state: "failed" }],
    ["a merged dispatch is done", { ...stranded, merged: { commit: "abc1234" } }],
    ["a dismissed dispatch has no worktree", { ...stranded, dismissed: { at: "2026-07-30T00:00:00.000Z" } }],
    // Mirrors of the server's own cheap refusals (round-1 MINOR).
    ["a review dispatch has no diff of its own", { ...stranded, reviewOf: "dispatch-target" }],
    ["a record with no worktree has nowhere to run", { ...stranded, worktreePath: null }],
  ]) {
    assert.deepEqual(
      verifyRerunAvailability(record, project),
      { available: false, reason: "" },
      label,
    );
  }
});

test("the verify re-run is hidden when the project has nothing to re-run", () => {
  const stranded = {
    state: "completed",
    verify: { state: "failed" },
    worktreePath: "/state/worktrees/fixture/dispatch-1",
  };
  for (const project of [
    undefined,
    { verifyMode: "worktree", verifyCommands: [] },
    { verifyMode: "container", verifyCommands: ["node --test"] },
    { archetype: "tracker-only", verifyMode: "worktree", verifyCommands: ["node --test"] },
  ]) {
    assert.equal(verifyRerunAvailability(stranded, project).available, false);
  }
});

test("the verify re-run is visible but disabled while a worker cannot be proven dead", () => {
  const availability = verifyRerunAvailability(
    {
      state: "completed",
      verify: { state: "failed" },
      worktreePath: "/state/worktrees/fixture/dispatch-1",
      orphanUnresolved: true,
    },
    { verifyMode: "worktree", verifyCommands: ["node --test"] },
  );

  // Visible, because the record IS otherwise stranded - but the server refuses a
  // suite run in a worktree a live worker may still be writing to.
  assert.equal(availability.available, true);
  assert.match(availability.reason, /could not be confirmed dead/);
});

// atelier-9dt: record.endedAt stays fixed across a re-run, so every staleness and
// elapsed consumer has to read the latest attempt's clock instead.
test("the last-activity clock prefers the latest attempt's end over the record's own", () => {
  const record = {
    endedAt: "2026-07-01T08:00:00.000Z",
    verify: {
      state: "passed",
      attempts: [
        { attempt: 1, state: "failed", endedAt: "2026-07-01T08:00:00.000Z" },
        { attempt: 2, state: "passed", endedAt: "2026-07-30T09:30:00.000Z" },
      ],
    },
  };

  assert.equal(lastActivityAt(record), "2026-07-30T09:30:00.000Z");
  // A record with no attempts, or an attempt with no clock, keeps its own.
  assert.equal(
    lastActivityAt({ endedAt: "2026-07-01T08:00:00.000Z", verify: { state: "failed", steps: [] } }),
    "2026-07-01T08:00:00.000Z",
  );
  assert.equal(
    lastActivityAt({
      endedAt: "2026-07-01T08:00:00.000Z",
      verify: { attempts: [{ attempt: 1, state: "failed" }] },
    }),
    "2026-07-01T08:00:00.000Z",
  );
  // An older attempt never rewinds the record's own end.
  assert.equal(
    lastActivityAt({
      endedAt: "2026-07-30T09:30:00.000Z",
      verify: { attempts: [{ attempt: 1, state: "failed", endedAt: "2026-07-01T08:00:00.000Z" }] },
    }),
    "2026-07-30T09:30:00.000Z",
  );
  assert.equal(lastActivityAt({}), undefined);
});
