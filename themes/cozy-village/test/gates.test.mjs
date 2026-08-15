/**
 * THE GATE PROJECTION.
 *
 * The strip is the one place in the village where a claim is made in words.
 * Everything here guards against the strip saying something the record does
 * not support: a pass that never ran, an empty diff drawn as a failure, a
 * merge that looks like it is waiting on you when a machine is still working,
 * or a cost figure invented out of a lane that does not report one.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHRONICLE_LIMIT as SERVER_CHRONICLE_LIMIT,
  gatesFor,
  reviewRoundsFor as serverReviewRoundsFor,
} from "../../../server/lib/world-contract.mjs";
import { createFixtureSource } from "../data/fixture.mjs";
import {
  attemptCount,
  awaitingMerge,
  gatesOf,
  mergeGateReasons,
  portGatesFor,
  roundCount,
  stripFor,
  stripText,
} from "../state/gates.mjs";
import {
  CHRONICLE_LIMIT as VENDORED_CHRONICLE_LIMIT,
  gatesFor as vendoredGatesFor,
  reviewRoundsFor as vendoredReviewRoundsFor,
} from "../state/server-gates.mjs";
import { buildVillage, recomputeStats } from "../state/village.mjs";

function freshFixture() {
  return createFixtureSource({ scripted: false }).load();
}

/** A record with every gate cleanly passed and you as the only thing left. */
function mergeReady(patch = {}) {
  return {
    id: "x1",
    state: "completed",
    branchHead: "aaa1111",
    outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
    verify: { state: "passed", attempt: 1, attempts: [{ attempt: 1, state: "passed" }] },
    review: {
      verdict: "pass",
      reviewedHead: "aaa1111",
      current: { verdict: "pass", reviewedHead: "aaa1111", round: 1 },
      rounds: [{ round: 1, verdict: "pass" }],
    },
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    ...patch,
  };
}

const slot = (record, gate, project) =>
  stripFor(record, project).slots.find((s) => s.gate === gate);

const gateState = (record, gate, project) =>
  portGatesFor(record, project).find((g) => g.gate === gate).state;

/* ──────────────────────────────────────────────────────────────────────────
   1. THE SERVER OWNS THE DERIVATION; THE PORT IS A FALLBACK
   ────────────────────────────────────────────────────────────────────────*/

test("gatesOf prefers the server's projection and says so", () => {
  const served = [
    { gate: "changes", state: "passed" },
    { gate: "verify", state: "skipped" },
    { gate: "review", state: "unknown" },
    { gate: "merge", state: "pending" },
    { gate: "main", state: "not-run" },
  ];
  // Fields that the local port would read differently: if the port ever won,
  // verify would read "passed" and review "passed" here.
  const record = mergeReady({ gates: served });

  const projection = gatesOf(record);
  assert.equal(projection.source, "server");
  assert.deepEqual(projection.gates, served);
  assert.equal(
    stripText(stripFor(record)),
    "Changes:passed Verify:skipped Review:unknown Merge:pending Main:not-run",
  );
  // No second opinion: the merge readiness follows the SERVED verify/review
  // states, so the gold `awaiting` detail cannot contradict the strip it sits
  // on. Deriving it from the raw fields here would light "waiting on you" over
  // a skipped verify gate.
  assert.equal(slot(record, "merge").detail, null);
  assert.deepEqual(mergeGateReasons(record), ["verification skipped", "review unknown"]);
});

test("the awaiting detail lights when the served gates say every machine is done", () => {
  const record = mergeReady({
    gates: [
      { gate: "changes", state: "passed" },
      { gate: "verify", state: "passed" },
      { gate: "review", state: "passed" },
      { gate: "merge", state: "pending" },
      { gate: "main", state: "not-run" },
    ],
  });

  assert.deepEqual(mergeGateReasons(record), []);
  assert.equal(awaitingMerge(record), true);
  assert.equal(slot(record, "merge").detail, "awaiting");
  assert.equal(slot(record, "merge").says, "waiting on you");
});

test("the village fails closed when an eligible review head is unknown", () => {
  const missingReviewedHead = mergeReady({
    review: {
      verdict: "pass",
      reviewedHead: null,
      current: { verdict: "pass", reviewedHead: null, round: 1 },
      rounds: [{ round: 1, verdict: "pass", reviewedHead: null }],
    },
  });
  const missingBranchHead = mergeReady({ branchHead: null });

  for (const record of [missingReviewedHead, missingBranchHead]) {
    assert.equal(gateState(record, "review"), "unknown");
    assert.deepEqual(mergeGateReasons(record), [
      "review head unknown — re-review required",
      "review unknown",
    ]);
    assert.equal(awaitingMerge(record), false);
  }

  const servedWithoutHead = mergeReady({
    branchHead: null,
    gates: [
      { gate: "changes", state: "passed" },
      { gate: "verify", state: "passed" },
      { gate: "review", state: "passed" },
      { gate: "merge", state: "pending" },
      { gate: "main", state: "not-run" },
    ],
  });
  assert.deepEqual(
    mergeGateReasons(servedWithoutHead),
    ["review head unknown — re-review required"],
    "a served pass cannot supply the missing reviewed/tree identity evidence",
  );
  assert.equal(awaitingMerge(servedWithoutHead), false);
});

test("passed-with-dispositions is merge-ready and remains distinct in every projection", () => {
  const review = {
    verdict: "fail",
    reviewedHead: "aaa1111",
    current: {
      round: 1,
      verdict: "fail",
      reviewedHead: "aaa1111",
      findings: [{
        ref: "round-1:finding-1",
        severity: "major",
        file: "server/lib/dispatch.mjs",
        line: 1,
        summary: "The human must adjudicate this claim.",
        novelty: "new",
      }],
    },
    rounds: [],
  };
  const reviewDispositions = [{
    ref: "disposition-1",
    findingRef: "round-1:finding-1",
    disposition: "refuted",
    note: "Mechanical evidence disproves the finding.",
    actor: "architect",
    at: "2026-07-31T00:00:00.000Z",
  }];
  const raw = mergeReady({ review, reviewDispositions });
  assert.equal(gatesFor(raw).find((gate) => gate.gate === "review").state, "passed-with-dispositions");
  assert.equal(
    vendoredGatesFor(raw).find((gate) => gate.gate === "review").state,
    "passed-with-dispositions",
  );
  assert.equal(gateState(raw, "review"), "passed-with-dispositions");

  const served = mergeReady({
    review,
    reviewDispositions,
    gates: gatesFor(raw),
  });
  assert.deepEqual(mergeGateReasons(served), []);
  assert.equal(awaitingMerge(served), true);
  assert.equal(slot(served, "review").mark, "split-solid");
  assert.equal(slot(served, "review").says, "passed with human dispositions");

  served.branchHead = "changed-head";
  assert.deepEqual(mergeGateReasons(served), [
    "review stale — re-review required",
  ]);

  const acceptedDispute = mergeReady({
    review: {
      ...review,
      current: {
        ...review.current,
        findings: [{
          ...review.current.findings[0],
          novelty: "redirect-disputed",
          dispositionRef: "disposition-1",
        }],
      },
    },
    reviewDispositions: [{
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
      note: "The disputed re-flag is accepted and open again.",
      actor: "architect",
    }],
  });
  assert.equal(
    gatesFor(acceptedDispute).find((gate) => gate.gate === "review").state,
    "failed",
  );
  assert.equal(
    vendoredGatesFor(acceptedDispute).find((gate) => gate.gate === "review").state,
    "failed",
  );
});

test("village merge policy permits tiered MINOR/NIT but never a BLOCKER", () => {
  const reviewed = (severity) => mergeReady({
    ticketId: "atelier-1",
    review: {
      verdict: "fail",
      reviewedHead: "aaa1111",
      current: {
        dispatchId: "review-policy",
        round: 1,
        verdict: "fail",
        reviewedHead: "aaa1111",
        findings: [{
          ref: "round-1:finding-1",
          severity,
          file: "ui/app.js",
          line: 1,
          summary: "Fixture finding.",
        }],
      },
    },
    gates: [
      { gate: "changes", state: "passed" },
      { gate: "verify", state: "passed" },
      { gate: "review", state: "failed" },
      { gate: "merge", state: "pending" },
      { gate: "main", state: "not-run" },
    ],
  });
  assert.deepEqual(
    mergeGateReasons(reviewed("nit"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    [],
  );
  assert.equal(
    awaitingMerge(reviewed("minor"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    true,
  );
  const advisoryPrerequisiteReason =
    "review advisory filing requires a tracker ticket and linked review dispatch";
  assert.deepEqual(
    mergeGateReasons(reviewed("nit"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "none",
    }),
    [advisoryPrerequisiteReason],
  );
  assert.equal(
    awaitingMerge(reviewed("nit"), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "none",
    }),
    false,
  );
  assert.deepEqual(
    mergeGateReasons(mergeReady({
      ...reviewed("nit"),
      ticketId: null,
    }), {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    [advisoryPrerequisiteReason],
  );
  const unlinked = reviewed("nit");
  unlinked.review.current.dispatchId = null;
  assert.deepEqual(
    mergeGateReasons(unlinked, {
      requireReview: true,
      reviewPolicy: "tiered",
      tracker: "committed",
    }),
    [advisoryPrerequisiteReason],
  );
  assert.deepEqual(
    mergeGateReasons(reviewed("major"), { requireReview: true, reviewPolicy: "advisory" }),
    [],
  );
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    assert.deepEqual(
      mergeGateReasons(reviewed("blocker"), { requireReview: true, reviewPolicy }),
      ["review failed"],
    );
  }
});

test("mergeGateReasons reads the served gates, not the raw fields beneath them", () => {
  /* The substrate derives verify and review ONCE. If the theme re-derived them
     from the raw record it would hold a second, quietly divergent opinion of
     the same fact - measured parity between the local port and the server was
     only 67.5% across 750 live slots, so the divergence is not hypothetical. */
  const gates = (verify, review) => [
    { gate: "changes", state: "passed" },
    { gate: "verify", state: verify },
    { gate: "review", state: review },
    { gate: "merge", state: "pending" },
    { gate: "main", state: "not-run" },
  ];

  // Raw fields say the work is done; the server says verify failed. Server wins.
  const serverBlocks = mergeReady({ gates: gates("failed", "passed") });
  assert.deepEqual(mergeGateReasons(serverBlocks), ["verification failed"]);
  assert.equal(awaitingMerge(serverBlocks), false);

  // Raw fields say verify failed; the server says it passed. Server wins again -
  // the point is deference, not pessimism.
  const serverClears = mergeReady({ verify: { state: "failed" }, gates: gates("passed", "passed") });
  assert.deepEqual(mergeGateReasons(serverClears), []);
  assert.equal(awaitingMerge(serverClears), true);

  // Without a projection the port speaks, and then the raw field is the truth.
  const unserved = mergeReady({ verify: { state: "failed" } });
  assert.deepEqual(mergeGateReasons(unserved), ["verification failed"]);

  // Blockers with NO gate to defer to stay locally derived, and still bite
  // through a projection that says everything passed.
  const stranded = mergeReady({ strandedBrWrites: true, gates: gates("passed", "passed") });
  assert.deepEqual(mergeGateReasons(stranded), ["stranded tracker writes"]);
  const orphaned = mergeReady({ orphanUnresolved: true, gates: gates("passed", "passed") });
  assert.deepEqual(mergeGateReasons(orphaned), ["a prior worker could not be confirmed dead"]);
});

/* ──────────────────────────────────────────────────────────────────────────
   1b. THE VENDORED COPY IS THE SERVER'S PROJECTION, NOT A SECOND OPINION

   `state/server-gates.mjs` is a hand-copied duplicate of the server's
   projection, used by the fixture to play the server's role. Its own header
   says THIS FILE asserts it cannot rot into a divergent port - so this is the
   test that makes that sentence true. A vendored copy nobody diffs is exactly
   the "second quietly divergent opinion" the no-rederivation rule forbids.
   ────────────────────────────────────────────────────────────────────────*/

/** Records chosen to reach every branch of the projection, not just the happy ones. */
function projectionCorpus() {
  const merged = { commit: "abc1234", mergedAt: "2026-07-30T20:05:00.000Z" };
  const round = (verdict) => ({ verdict, reviewedHead: "aaa1111", at: "2026-07-30T16:00:00.000Z" });
  const records = [];

  for (const changes of ["changed", "empty", "unknown", "wat", undefined, null]) {
    for (const state of ["running", "completed", "needs_input", "plan_ready", "failed", "queued", undefined]) {
      records.push({ id: `c-${changes}-${state}`, state, outcome: changes === undefined ? undefined : { changes } });
    }
  }
  for (const verify of [
    undefined,
    null,
    { state: "passed" },
    { state: "failed" },
    { state: "skipped" },
    { state: "running" },
    { state: "wat" },
    { attempts: [] },
    { attempts: [{ state: "failed" }, { state: "passed" }] },
  ]) {
    records.push({ id: "v", state: "completed", outcome: { changes: "changed" }, verify });
    records.push({ id: "v-merged", state: "completed", outcome: { changes: "changed" }, verify, merged });
  }
  for (const review of [
    undefined,
    null,
    round("pass"),
    round("fail"),
    round("malformed"),
    round("skipped"),
    round("running"),
    { current: round("pass"), rounds: [round("fail"), round("pass")] },
    { rounds: [] },
    [round("fail"), round("pass")],
  ]) {
    records.push({ id: "r", state: "completed", outcome: { changes: "changed" }, review });
  }
  records.push({
    id: "r-dispositioned",
    state: "completed",
    outcome: { changes: "changed" },
    review: {
      current: {
        round: 1,
        verdict: "fail",
        findings: [{ ref: "round-1:finding-1", severity: "minor" }],
      },
      rounds: [],
    },
    reviewDispositions: [{
      ref: "disposition-1",
      findingRef: "round-1:finding-1",
      disposition: "waived",
      actor: "architect",
      note: "Explicit waiver.",
      at: "2026-07-31T00:00:00.000Z",
    }],
  });
  for (const postMerge of [
    undefined,
    null,
    { state: "passed", steps: [] },
    { state: "passed", steps: [{ exitCode: 0 }] },
    { state: "passed", steps: [{ exitCode: 1 }] },
    { state: "passed" },
    { state: "failed", steps: [{ exitCode: 1 }] },
    { state: "skipped" },
    { state: "queued" },
    { state: "running" },
    { state: "wat" },
  ]) {
    records.push({ id: "pm", state: "completed", outcome: { changes: "changed" }, merged, postMerge });
    records.push({ id: "pm-unmerged", state: "completed", outcome: { changes: "changed" }, postMerge });
  }
  for (const extra of [
    { merged },
    {
      merged: {
        ...merged,
        forcedBy: "architect",
        reason: "Explicit override.",
        dispositionRef: "ticket-comment-75",
      },
    },
    { dismissed: { at: "2026-07-30T20:00:00.000Z" } },
    { reviewOf: "1d90b7c4" },
    { readOnly: true },
    { verifyRequested: false },
    {},
  ]) {
    records.push({ id: "x", state: "completed", outcome: { changes: "changed" }, ...extra });
  }
  records.push({}, { id: "bare" }, { id: "null-outcome", outcome: null });
  return records;
}

test("the vendored server projection agrees with the real one, record for record", async () => {
  const { chronicle, dispatches } = await freshFixture();
  const corpus = [...dispatches, ...chronicle.records, ...projectionCorpus()];
  assert.ok(corpus.length > 100, `too small a corpus to prove anything: ${corpus.length}`);

  for (const record of corpus) {
    assert.deepEqual(
      vendoredGatesFor(record),
      gatesFor(record),
      `vendored copy diverged on ${record?.id ?? "<anonymous>"}: ${JSON.stringify(record).slice(0, 160)}`,
    );
    assert.deepEqual(vendoredReviewRoundsFor(record), serverReviewRoundsFor(record), `reviewRoundsFor: ${record?.id}`);
  }

  assert.equal(VENDORED_CHRONICLE_LIMIT, SERVER_CHRONICLE_LIMIT);
  // The fixture corpus alone must reach every gate state, or "agrees" would be
  // a claim about a handful of shapes rather than about the projection.
  const seen = new Set(corpus.flatMap((r) => gatesFor(r).map((g) => g.state)));
  /* `empty` joined the vocabulary in S3: the changes gate now reports a
     completed run that carried no diff as its own state rather than as
     `failed`. The list is exhaustive on purpose — a new state that no fixture
     exercises should fail here rather than quietly ride along unprojected. */
  assert.deepEqual(
    [...seen].sort(),
    [
      "empty",
      "failed",
      "not-run",
      "passed",
      "passed-with-dispositions",
      "pending",
      "skipped",
      "unknown",
    ],
    "the corpus never exercised some gate state",
  );
});

test("gatesOf falls back to the theme port when the server sent no gates", () => {
  const record = mergeReady();
  const absent = gatesOf(record);
  assert.equal(absent.source, "theme-port");
  assert.deepEqual(absent.gates, portGatesFor(record));
  assert.deepEqual(absent.gates.map((g) => g.state), ["passed", "passed", "passed", "pending", "not-run"]);
  assert.equal(stripFor(record).source, "theme-port");

  // An empty array is not a projection; it must fall back rather than render
  // five unknowns.
  assert.equal(gatesOf(mergeReady({ gates: [] })).source, "theme-port");
});

/* ──────────────────────────────────────────────────────────────────────────
   2. atelier-kg5 — A CHECK THAT RAN ZERO COMMANDS IS NOT A PASS
   ────────────────────────────────────────────────────────────────────────*/

test("a post-merge pass with zero steps is not-run, never passed", () => {
  const merged = { commit: "abc1234", mergedAt: "2026-07-30T20:05:00.000Z" };
  const exitedNonZeroProbe = () => ({
    merged,
    postMerge: { state: "passed", steps: [{ command: "node --test", exitCode: 1 }] },
  });

  // The control first: with the merge present and a real step, this IS a pass.
  // Without it, the assertions below could pass merely because `!merged`
  // short-circuits main to not-run, and reverting atelier-kg5 would go unnoticed.
  const ran = { merged, postMerge: { state: "passed", steps: [{ command: "node --test", exitCode: 0 }] } };
  assert.equal(gateState(ran, "main"), "passed");

  const noSteps = { merged, postMerge: { state: "passed", steps: [] } };
  assert.equal(gateState(noSteps, "main"), "not-run");
  assert.equal(slot(noSteps, "main").mark, "hollow");
  assert.equal(slot(noSteps, "main").says, "not run");

  const missingSteps = { merged, postMerge: { state: "passed" } };
  assert.equal(gateState(missingSteps, "main"), "not-run");

  // The server writes "skipped" for a project with no verify commands. Nothing
  // was checked, so nothing passed.
  const skipped = { merged, postMerge: { state: "skipped", steps: [] } };
  assert.equal(gateState(skipped, "main"), "not-run");
  assert.notEqual(gateState(skipped, "main"), "skipped");

  // And the states that do carry a verdict still carry it.
  assert.equal(gateState({ merged, postMerge: { state: "failed", steps: [] } }, "main"), "failed");
  assert.equal(gateState({ merged, postMerge: { state: "running" } }, "main"), "pending");
  assert.equal(gateState({ merged, postMerge: { state: "queued" } }, "main"), "pending");
  assert.equal(gateState({ merged, postMerge: { state: "wat" } }, "main"), "unknown");

  /* The substrate must hold the same line, or integrating it would quietly
     restore the pass this rule exists to refuse. Checked against the server's
     own projection, not a copy of its intent. */
  const mainOf = (record) => gatesFor(record).find((g) => g.gate === "main").state;
  assert.equal(mainOf(ran), "passed");
  assert.equal(mainOf(noSteps), "not-run");
  assert.equal(mainOf(missingSteps), "not-run");

  /* A VOCABULARY DIFFERENCE, NOT AN HONESTY ONE — and the server's word wins.
     For a deliberately skipped post-merge check the substrate says "skipped"
     where the theme port says "not-run". Both refuse to call it a pass, which
     is the whole of atelier-kg5; "skipped" is strictly MORE informative, because
     it distinguishes "we chose not to check" from "we have no data". The theme
     draws whichever word arrived and never rewrites it, so the assertion here
     is the invariant that actually matters. */
  assert.equal(mainOf(skipped), "skipped");
  assert.notEqual(mainOf(skipped), "passed");
  // Neither vocabulary may ever let an unchecked main read as healthy.
  for (const record of [noSteps, missingSteps, skipped, exitedNonZeroProbe()]) {
    assert.notEqual(mainOf(record), "passed");
    assert.notEqual(gateState(record, "main"), "passed");
  }

  /* This case caught the port being SHALLOWER than the substrate: it counted
     steps without reading their exit codes, so a post-merge check that ran and
     exited 1 was drawn as a passing main — the atelier-kg5 bug wearing a
     different hat, in the fallback path. The port now reads exit codes too, so
     a record arriving with no projection is judged no more leniently than one
     that has one. Both must say not-run. */
  const exitedNonZero = { merged, postMerge: { state: "passed", steps: [{ command: "node --test", exitCode: 1 }] } };
  assert.equal(mainOf(exitedNonZero), "not-run");
  assert.equal(gateState(exitedNonZero, "main"), "not-run");
});

/* ──────────────────────────────────────────────────────────────────────────
   3. AN EMPTY DIFF IS NOT A FAILURE
   ────────────────────────────────────────────────────────────────────────*/

test("an empty diff is carried as its own state, never drawn as a failure", () => {
  /* An agent that stops to ask a question produces an empty diff and has done
     nothing wrong. This used to have no word in the contract, so the theme's
     fallback port answered `not-run` — the only state that did not accuse it —
     and carried the truth in the detail beside it.

     S3 gave the contract the word. The state IS `empty` now, on both the
     server's projection and this port, and the detail agrees with it instead
     of compensating for it. What has not changed, and must not: it is not a
     failure, it is not a pass, and the geometry never shows a broken bar. */
  const record = { state: "completed", outcome: { kind: "completed_empty", changes: "empty" } };
  const changes = slot(record, "changes");

  assert.notEqual(changes.state, "failed");
  assert.notEqual(changes.state, "passed", "carrying nothing is not a pass either");
  assert.equal(changes.state, "empty");
  assert.equal(changes.detail, "empty");
  assert.equal(changes.says, "ran, carried nothing — not a failure");
  assert.equal(changes.mark, "ring", "no broken mark: the geometry must not accuse it either");
  assert.match(stripText(stripFor(record)), /^Changes:empty /);

  // `completed_empty` with no outcome block at all reaches the same state:
  // the contract lists both spellings and the port must read both.
  assert.equal(slot({ state: "completed_empty" }, "changes").state, "empty");

  // "unknown" is a different thing and must stay different: Atelier could not
  // compare the branch at all.
  const unknown = slot({ outcome: { changes: "unknown" } }, "changes");
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.detail, null);
  assert.equal(unknown.says, "could not be determined");
});

/* ──────────────────────────────────────────────────────────────────────────
   4. awaitingMerge — YOU ARE THE ONLY REMAINING BLOCKER
   ────────────────────────────────────────────────────────────────────────*/

test("awaitingMerge is true only when every machine gate is done", () => {
  const record = mergeReady();
  assert.equal(awaitingMerge(record), true);
  assert.deepEqual(mergeGateReasons(record), []);
  assert.equal(slot(record, "merge").detail, "awaiting");
  assert.equal(slot(record, "merge").says, "waiting on you");
});

test("each merge blocker holds the gate on its own", () => {
  // Reasons speak the GATE vocabulary, not the raw field's - the same words
  // the strip shows - so the sentence on the card and the mark above it can
  // never disagree about what blocked the merge.
  const blocked = [
    [{ orphanUnresolved: true }, "a prior worker could not be confirmed dead"],
    [{ verify: { state: "failed" } }, "verification failed"],
    [{ verify: { state: "running" } }, "verification pending"],
    [{ verify: null }, "verification not-run"],
    [{ verify: { state: "skipped" } }, "verification skipped"],
    [{ strandedBrWrites: true }, "stranded tracker writes"],
    // A pass decays when the branch moves under it; a fail never goes stale.
    [{ branchHead: "bbb2222" }, "review stale — re-review required"],
    [{ review: { verdict: "fail", current: { verdict: "fail", reviewedHead: "aaa1111" } } }, "review failed"],
    [{ review: null }, "review not-run"],
  ];

  for (const [patch, reason] of blocked) {
    const record = mergeReady(patch);
    const reasons = mergeGateReasons(record);
    assert.ok(reasons.includes(reason), `${JSON.stringify(patch)} did not report: ${reason}`);
    assert.equal(awaitingMerge(record), false, `${JSON.stringify(patch)} still read as merge-ready`);
    assert.equal(slot(record, "merge").detail, null, "the gold `awaiting` detail must not light");
  }

  // Pinned exactly, so no assertion above is passing on a coincidence. A stale
  // review reports twice on purpose: it is stale, and it is therefore no longer
  // a pass - two different things to fix.
  assert.deepEqual(mergeGateReasons(mergeReady({ strandedBrWrites: true })), ["stranded tracker writes"]);
  assert.deepEqual(mergeGateReasons(mergeReady({ branchHead: "bbb2222" })), [
    "review stale — re-review required",
    "review pending",
  ]);

  // A stale review only blocks where review is required at all.
  assert.equal(awaitingMerge(mergeReady({ branchHead: "bbb2222" }), { requireReview: false }), true);
  assert.deepEqual(mergeGateReasons(mergeReady({ review: null }), { requireReview: false }), []);
});

test("awaitingMerge is false for anything already decided or still running", () => {
  assert.equal(awaitingMerge(mergeReady({ merged: { commit: "abc1234" } })), false);
  assert.equal(awaitingMerge(mergeReady({ dismissed: { at: "2026-07-30T20:00:00.000Z" } })), false);
  assert.equal(awaitingMerge(mergeReady({ reviewOf: "1d90b7c4" })), false, "a review dispatch is not merged by you");
  assert.equal(awaitingMerge(mergeReady({ state: "running" })), false);
  assert.equal(awaitingMerge(mergeReady({ state: "needs_input" })), false);
  assert.equal(awaitingMerge(null), false);

  // ...and each of those still has no blocking reason, which is exactly why
  // `awaitingMerge` cannot be replaced by "reasons are empty".
  assert.deepEqual(mergeGateReasons(mergeReady({ merged: { commit: "abc1234" } })), []);
  assert.equal(slot(mergeReady({ merged: { commit: "abc1234" } }), "merge").state, "passed");
  assert.equal(slot(mergeReady({ dismissed: { at: "x" } }), "merge").state, "skipped");
});

/* ──────────────────────────────────────────────────────────────────────────
   5. TWO WIRE SHAPES, ONE COUNT
   ────────────────────────────────────────────────────────────────────────*/

test("roundCount and attemptCount read both the live array and the chronicle number", async () => {
  const fixture = await freshFixture();
  const live = (id) => fixture.dispatches.find((r) => r.id === id);
  const chronicled = (predicate) => fixture.chronicle.records.find(predicate);

  // Live records: append-only arrays.
  assert.ok(Array.isArray(live("d904ce38").review.rounds));
  assert.equal(roundCount(live("d904ce38").review), 2);
  assert.ok(Array.isArray(live("6b2e40f1").verify.attempts));
  assert.equal(attemptCount(live("6b2e40f1").verify), 2);

  // The array must be READ, not coincidentally agreed with. On a live record
  // `attempts.length` and `attempt` normally match, so only a record where
  // they disagree proves which one the helper actually consulted.
  assert.equal(attemptCount({ attempts: [{}, {}, {}], attempt: 1 }), 3);
  assert.equal(roundCount({ rounds: [{}, {}, {}], current: { verdict: "pass" } }), 3);

  // Chronicle projection: the same fields arrive as counts.
  const threeRounds = chronicled((r) => r.review?.rounds === 3);
  assert.equal(typeof threeRounds.review.rounds, "number");
  assert.equal(roundCount(threeRounds.review), 3);
  const twoAttempts = chronicled((r) => r.verify?.attempts === 2);
  assert.equal(typeof twoAttempts.verify.attempts, "number");
  assert.equal(attemptCount(twoAttempts.verify), 2);

  // The remaining shapes, stated explicitly so a regression cannot hide in one.
  assert.equal(roundCount(null), 0);
  assert.equal(roundCount({}), 0);
  assert.equal(roundCount({ current: { verdict: "pass" } }), 1, "a current round with no history is one round");
  assert.equal(attemptCount(null), 0);
  assert.equal(attemptCount({ attempt: 2 }), 2, "the 1-based index of the current attempt");
  assert.equal(attemptCount({}), 0);

  // Both shapes must agree through the parcel projection, not only the helper.
  const village = buildVillage({ ...fixture, now: new Date("2026-07-30T20:00:00Z") });
  assert.equal(village.parcels.find((parcel) => parcel.id === "d904ce38").rounds, 2);
  assert.equal(village.parcels.find((parcel) => parcel.id === "6b2e40f1").attempts, 2);
  assert.equal(roundCount(threeRounds.review), 3);
});

/* ──────────────────────────────────────────────────────────────────────────
   6. COST HONESTY — AN ABSENCE IS NOT A ZERO
   ────────────────────────────────────────────────────────────────────────*/

test("a codex record never contributes to a spend figure, even carrying a number", () => {
  // `reportsCost:false` is a capability, not a missing value. A number arriving
  // on this lane must still not be spent.
  const codex = {
    id: "cx1",
    lane: "codex",
    model: "gpt-5.4-codex",
    state: "running",
    startedAt: "2026-07-30T14:41:09.794Z",
    costUSD: 12.5,
    turns: 9,
    diff: { insertions: 40, deletions: 6, files: 3 },
  };
  const claude = { ...codex, id: "cl1", lane: "claude", model: "sonnet" };

  const village = buildVillage({
    dispatches: [codex, claude],
    chronicle: {
      records: [
        { ...codex, merged: { commit: "1111111", mergedAt: "2026-07-30T15:00:00.000Z" }, mergedAt: "2026-07-30T15:00:00.000Z" },
        { ...claude, merged: { commit: "2222222", mergedAt: "2026-07-30T16:00:00.000Z" }, mergedAt: "2026-07-30T16:00:00.000Z" },
      ],
      stats: {},
    },
    now: new Date("2026-07-30T20:00:00Z"),
  });

  const codexParcel = village.parcels.find((parcel) => parcel.id === "cx1");
  assert.equal(codexParcel.villager.id, "alder");
  assert.equal(codexParcel.costUSD, null, "a 0 or a stray number here would read as 'free'");
  assert.equal(codexParcel.turns, null);

  // The control: the same number on a lane that does keep a tab IS printed.
  const claudeParcel = village.parcels.find((parcel) => parcel.id === "cl1");
  assert.equal(claudeParcel.costUSD, 12.5);
  assert.equal(claudeParcel.turns, 9);

  // ...and only the reporting lane reaches the ledger.
  const stats = recomputeStats({
    records: [
      { ...codex, merged: { commit: "1111111" } },
      { ...claude, merged: { commit: "2222222" } },
    ],
  }, [codex, claude]);
  assert.equal(stats.merges, 2);
  assert.equal(stats.spendMergedUSD, 12.5);
  assert.equal(stats.costPerMergeUSD, 12.5, "averaged over reporting merges only, not over all merges");
  assert.equal(stats.unlandedSpendUSD, 12.5);
});

test("every live codex parcel in the fixture reports its cost as unavailable", async () => {
  const fixture = await freshFixture();
  const village = buildVillage({ ...fixture, now: new Date("2026-07-30T20:00:00Z") });

  const alder = village.parcels.find((parcel) => parcel.id === "72af1b05");
  assert.equal(alder.villager.id, "alder");
  assert.equal(alder.costUSD, null);
  assert.equal(alder.turns, null);

  const codex = village.parcels.filter((parcel) => parcel.record.lane === "codex");
  assert.ok(codex.length > 0, "the fixture must contain a live codex parcel");
  for (const parcel of codex) {
    assert.equal(parcel.costUSD, null, parcel.id);
    assert.equal(parcel.turns, null, parcel.id);
    assert.equal(parcel.villager.caps.reportsCost, false);
  }

  const claude = village.parcels.filter((parcel) => parcel.record.lane === "claude");
  assert.ok(claude.length > 0, "the fixture must contain a live claude parcel");
  assert.ok(claude.every((parcel) => parcel.villager.caps.reportsCost));
});
