/**
 * THE FIVE GATES — one vocabulary, used identically in the world and the UI.
 *
 * The World Contract's projection is `gatesFor(record)`:
 *
 *   [{ gate: "changes"|"verify"|"review"|"merge"|"main",
 *      state: "passed"|"passed-with-dispositions"|"failed"|"pending"|
 *             "skipped"|"not-run"|"unknown" }]
 *
 * The SERVER owns that derivation (slice S, derived exactly once). This module
 * therefore does two separable things, and never confuses them:
 *
 *   1. `gatesOf(record)` PREFERS `record.gates` - the server's projection - and
 *      only falls back to the local port below when the field is absent. When
 *      the substrate lands, the fallback stops being reached and nothing else
 *      in the theme changes.
 *
 *   2. `stripFor(record)` adds PRESENTATION detail derived from the record's
 *      own named fields, never from the gate state. Two details exist:
 *
 *        empty      `outcome.changes === "empty"` - the gate ran and found
 *                   nothing to carry forward. This is NOT a failure: an agent
 *                   that stops to ask you a question produces an empty diff
 *                   and has done nothing wrong. Drawing it as failed would
 *                   slander it. The contract vocabulary cannot express it, so
 *                   it is carried beside the state, not smuggled into it.
 *                   (Reported upstream as a Track-B §5.2 gap, per direction E.)
 *
 *        awaiting   the merge gate is pending and NOTHING machine-checkable
 *                   is left to run - so the remaining blocker is you. This is
 *                   the strip's only gold, and it lights on exactly the same
 *                   condition as the notice-board lantern.
 *
 * Because detail is derived independently of state, integrating the server's
 * projection cannot contradict it.
 *
 * Pure module: no DOM or three.js; review assessment is shared with core.
 */

import { assessReview } from "../../../shared/review-assessment.mjs";

export const GATE_ORDER = ["changes", "verify", "review", "merge", "main"];

export const GATE_LABEL = {
  changes: "Changes",
  verify: "Verify",
  review: "Review",
  merge: "Merge",
  main: "Main",
};

/**
 * Structure, never colour. Every state is a distinct GEOMETRY, so the strip
 * survives greyscale, colour-blindness and a printed page unchanged.
 */
export const GATE_GEOMETRY = {
  passed: { mark: "solid", says: "passed" },
  "passed-with-dispositions": {
    mark: "split-solid",
    says: "passed with human dispositions",
  },
  failed: { mark: "broken", says: "failed" },
  pending: { mark: "sweep", says: "in progress" },
  skipped: { mark: "dashed", says: "skipped — not passed" },
  "not-run": { mark: "hollow", says: "not run" },
  unknown: { mark: "hatched", says: "could not be determined" },
  /* S3 gave the contract a word for this. The changes gate reports `empty`
     when a run completed and carried no diff, which is categorically neither
     a pass nor a failure — and the theme no longer has to annotate its way
     out of a `failed` bar it disagreed with. A RING, so the geometry says
     "ran, and the result was nothing" without any of the broken bar's
     accusation. */
  empty: { mark: "ring", says: "ran, carried nothing — not a failure" },
};

/* ── honest presentation helpers ───────────────────────────────────────── */

/**
 * `review.rounds` is an APPEND-ONLY ARRAY on a live record
 * (`reviewState()` returns `{ ...current, current, rounds }`) but the
 * chronicle projection serves a COUNT. Read both without guessing.
 */
export function roundCount(review) {
  if (!review) return 0;
  if (Array.isArray(review.rounds)) return review.rounds.length;
  if (typeof review.rounds === "number") return review.rounds;
  return review.current ? 1 : 0;
}

/**
 * `verify.attempts` is likewise an array on a live record and a count in the
 * chronicle. `verify.attempt` is the 1-based index of the current one.
 */
export function attemptCount(verify) {
  if (!verify) return 0;
  if (Array.isArray(verify.attempts)) return verify.attempts.length;
  if (typeof verify.attempts === "number") return verify.attempts;
  return typeof verify.attempt === "number" ? verify.attempt : 0;
}

function reviewHeadState(review, branchHead, reviewGateState = undefined) {
  // Only a merge-eligible review decays. An ordinary fail never goes stale.
  const current = review?.current ?? review;
  if (current?.verdict !== "pass" && reviewGateState !== "passed-with-dispositions") {
    return "not-eligible";
  }
  const reviewedHead = current.reviewedHead ?? review?.reviewedHead;
  if (!reviewedHead || !branchHead) return "unknown";
  return reviewedHead === branchHead ? "current" : "stale";
}

export function reviewIsStale(review, branchHead, reviewGateState = undefined) {
  return reviewHeadState(review, branchHead, reviewGateState) === "stale";
}

function reviewAdvisoryPrerequisitesMissing(record, project, assessment) {
  if (assessment.advisories.length === 0) return false;
  const review = record.review?.current ?? record.review;
  return (
    !record.ticketId ||
    project?.tracker === "none" ||
    typeof review?.dispatchId !== "string" ||
    !review.dispatchId.trim()
  );
}

export function mergeGateReasons(record, project = {}) {
  const requireReview = project.requireReview !== false;
  const reasons = [];

  /* NO RE-DERIVATION WHERE THE SERVER SPEAKS.
     The verify and review verdicts are gates, and the substrate projects them
     once in `gatesFor`. Reading them back off the raw record here would give
     the village a second, quietly divergent opinion of the same fact - the
     exact failure the no-rederivation rule exists to prevent. So the gate
     states are taken from the server whenever it sent them, and the raw
     fields are consulted ONLY as the fixture-path fallback.

     The conditions below that are NOT gates - an unconfirmed prior worker,
     stranded tracker writes, a review that predates the current head - have
     no projection to defer to, so they stay derived here and say so. */
  const served = Array.isArray(record?.gates) && record.gates.length ? record.gates : null;
  const stateOf = (name) => served?.find((g) => g.gate === name)?.state;

  if (record.orphanUnresolved) reasons.push("a prior worker could not be confirmed dead");

  const verifyState = served ? stateOf("verify") : portVerify(record);
  if (verifyState !== "passed") reasons.push(`verification ${verifyState || "missing"}`);

  if (record.strandedBrWrites) reasons.push("stranded tracker writes");
  if (record.mergeRecoveryPending) reasons.push("merge recovery pending");
  if (record.persistenceDegraded) {
    reasons.push(record.persistenceDetail || "persistence degraded - run atelier doctor for targets");
  }
  if (!record.result?.commit) {
    reasons.push("finalized result missing");
  } else if (record.result.commit !== record.branchHead) {
    reasons.push("finalized result does not match branch HEAD");
  }
  if (!record.attestation) {
    reasons.push("verification attestation missing");
  } else {
    if (record.attestation.resultCommit !== record.branchHead) {
      reasons.push("attested commit does not match branch HEAD");
    }
    if (record.attestation.resultVersion !== record.result?.version) {
      reasons.push("attested result version does not match finalized result");
    }
  }
  const reviewState = served ? stateOf("review") : portReview(record);
  const reviewAssessment = assessReview(record, project, { reviewGateState: reviewState });
  const acceptedState = reviewAssessment.eligible ? "passed-with-dispositions" : reviewState;
  const headState = requireReview
    ? reviewHeadState(record.review, record.branchHead, acceptedState)
    : "not-eligible";
  if (headState === "unknown") reasons.push("review head unknown — re-review required");
  else if (headState === "stale") reasons.push("review stale — re-review required");

  if (requireReview) {
    if (!reviewAssessment.eligible) {
      reasons.push(`review ${reviewAssessment.gateState || reviewState || "missing"}`);
    } else if (reviewAdvisoryPrerequisitesMissing(record, project, reviewAssessment)) {
      reasons.push("review advisory filing requires a tracker ticket and linked review dispatch");
    }
  }
  return reasons;
}

/* ── the local port: used ONLY when the server has not sent `gates` ─────── */

function portChanges(r) {
  /* `empty` is contract vocabulary as of S3, so the fallback port speaks it
     too. It used to answer `not-run` here — the only state that did not
     accuse an empty run of failing — and that was a workaround for a missing
     word, not a reading of the record. Keeping it would now make the port
     disagree with the server about a case the server can finally express,
     which is exactly the drift the port is quarantined to prevent. */
  if (r.state === "completed_empty") return "empty";
  if (r.outcome == null) return "not-run";
  if (r.outcome.changes === "changed") return "passed";
  if (r.outcome.changes === "empty") return "empty";
  if (r.outcome.changes === "unknown") return "unknown";
  return "not-run";
}

function portVerify(r) {
  if (r.verify == null) return "not-run";
  switch (r.verify.state) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "not-run":
    case undefined:
    case null:
      return "not-run";
    default:
      return "pending";
  }
}

function portReview(r) {
  const assessment = assessReview(r, { requireReview: true });
  const headState = reviewHeadState(r.review, r.branchHead, assessment.gateState);
  if (headState === "unknown") return "unknown";
  if (headState === "stale") return "pending";
  return assessment.gateState === "not-run" ? "not-run" : assessment.gateState;
}

function portMerge(r) {
  if (r.merged) return "passed";
  if (r.dismissed) return "skipped";
  return "pending";
}

function portMain(r) {
  if (!r.merged) return "not-run";
  if (r.postMerge == null) return "not-run";
  switch (r.postMerge.state) {
    case "passed": {
      /* atelier-kg5: a main check that ran ZERO commands is not a pass — it
         never ran, and `steps` is the only witness that anything executed.
         Counting steps is not enough on its own, though: a step that exited
         NON-ZERO is a witness that something ran and failed, and calling that
         a pass is the same bug wearing a different hat. The substrate is
         strict here (`world-contract.mjs` wants a step that exited 0) and this
         fallback now matches it, so a record arriving with no projection is
         not judged more leniently than one that has one. */
      const steps = r.postMerge.steps ?? [];
      return steps.some((step) => Number(step?.exitCode) === 0) ? "passed" : "not-run";
    }
    case "failed":
      return "failed";
    case "skipped":
      // The server writes "skipped" for a project with no verify commands -
      // the zero-check case. Nothing was checked, so nothing passed.
      return "not-run";
    case "queued":
    case "running":
      return "pending";
    default:
      return "unknown";
  }
}

/** The local port of the server's `gatesFor`. Fallback only. */
export function portGatesFor(record, project = {}) {
  const changes = portChanges(record);
  const mergeAudit = record?.merged?.forcedBy
    ? {
        forcedBy: record.merged.forcedBy,
        reason: record.merged.reason,
        dispositionRef: record.merged.dispositionRef,
      }
    : {};
  return [
    { gate: "changes", state: changes },
    { gate: "verify", state: portVerify(record) },
    { gate: "review", state: portReview(record) },
    { gate: "merge", state: portMerge(record), ...mergeAudit },
    { gate: "main", state: portMain(record) },
  ];
}

/**
 * The server's projection when it exists, the port when it does not.
 * `record.gatesSource` reports which, so the UI can say so out loud.
 */
export function gatesOf(record, project = {}) {
  if (Array.isArray(record?.gates) && record.gates.length) {
    return { gates: record.gates, source: "server" };
  }
  return { gates: portGatesFor(record, project), source: "theme-port" };
}

/**
 * Is the human the only remaining blocker on the merge? Derived from
 * `mergeGateReasons()` exactly as Atelier derives it - there is no stored
 * `awaiting_merge` state, and if that helper drifts, this drifts with it.
 */
export function awaitingMerge(record, project = {}) {
  if (!record) return false;
  if (record.merged || record.dismissed || record.reviewOf) return false;
  if (record.state !== "completed") return false;
  return mergeGateReasons(record, project).length === 0;
}

/**
 * The renderable strip: contract state + presentation detail, per slot.
 * `detail` is derived from named record fields only, never from `state`.
 */
export function stripFor(record, project = {}) {
  const { gates, source } = gatesOf(record, project);
  const isEmpty = record?.outcome?.changes === "empty";
  const awaiting = awaitingMerge(record, project);

  return {
    source,
    slots: GATE_ORDER.map((gate) => {
      const found = gates.find((g) => g.gate === gate);
      const state = found?.state ?? "unknown";
      const geometry = GATE_GEOMETRY[state] ?? GATE_GEOMETRY.unknown;
      const detail =
        gate === "changes" && isEmpty
          ? "empty"
          : gate === "merge" && awaiting
            ? "awaiting"
            : null;
      return {
        gate,
        label: GATE_LABEL[gate],
        state,
        mark: geometry.mark,
        detail,
        says:
          detail === "empty"
            ? "ran, carried nothing — not a failure"
            : detail === "awaiting"
              ? "waiting on you"
              : geometry.says,
      };
    }),
  };
}

/** A one-line text rendering of the strip. The accessible mirror, and the tests'. */
export function stripText(strip) {
  return strip.slots.map((s) => `${s.label}:${s.detail ?? s.state}`).join(" ");
}

/**
 * What Atelier CANNOT determine about this dispatch. Every entry names a real
 * field that came back indeterminate - never an inference from silence,
 * because Atelier has no heartbeat, no lastSeen and no liveness ping to be
 * silent on. (`": heartbeat"` in the codebase is an SSE keepalive: transport,
 * not agents.)
 */
export function unknownsOf(record) {
  const out = [];
  if (!record) return out;
  if (record.orphanUnresolved) {
    out.push({ field: "orphanUnresolved", says: "Atelier could not prove the worker died." });
  }
  if (record.outcome?.changes === "unknown") {
    out.push({ field: "outcome.changes", says: "Could not compare this branch against its base." });
  }
  if (record.outcome?.finalMessage === "unavailable") {
    out.push({ field: "outcome.finalMessage", says: "The last words could not be retrieved." });
  }
  if (typeof record.postMerge?.error === "string" && record.postMerge.error.includes("unknown")) {
    out.push({ field: "postMerge.error", says: "Main health went unknown mid-check." });
  }
  return out;
}

/**
 * The one thing a human owes this dispatch, if any. These are exactly the two
 * things that put a record on the notice board, and nothing else ever does.
 */
export function decisionOwed(record, project = {}) {
  if (!record) return null;
  if (record.state === "needs_input" && record.outcome?.question) {
    return { kind: "question", text: record.outcome.question, verb: "Answer & resume" };
  }
  if (record.state === "plan_ready" && record.plan?.text) {
    return { kind: "plan", text: record.plan.text, verb: "Approve or revise" };
  }
  if (awaitingMerge(record, project)) {
    return { kind: "merge", text: record.exitSummary ?? null, verb: "Merge" };
  }
  return null;
}
