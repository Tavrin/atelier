// The pure availability contracts behind the dispatch detail actions - reply,
// plan, merge and dismiss - extracted from app.js so they are assertable without a DOM.
// Each answers the same question: will the server accept this action, and if
// not, what does the operator need to be told? A control the server would 409
// must never be offered as enabled (atelier-tzw).
import {
  assessReview,
  currentReviewFor,
  reviewRoundsFor,
} from "../shared/review-assessment.mjs";

const DISMISSIBLE_STATES = new Set([
  "completed",
  "completed_empty",
  "needs_input",
  "failed",
  "stopped",
  "prepare_failed",
  "rejected",
]);

export function dismissAvailability(record) {
  if (!record || !DISMISSIBLE_STATES.has(record.state) || record.dismissed) {
    return { available: false, label: "Dismiss" };
  }
  // Boot records this exact error only when the post-merge verifier's process
  // fence could not be cleared. Although the ticket is already merged, dismiss
  // remains the documented operator escape that reaps/clears the fence and
  // releases the per-project verifier barrier.
  const releasesRunnerBarrier = Boolean(
    record.merged &&
    record.postMerge?.state === "failed" &&
    String(record.postMerge.error || "").includes("verifier could not be confirmed dead"),
  );
  if (record.merged && !releasesRunnerBarrier) {
    return { available: false, label: "Dismiss" };
  }
  return {
    available: true,
    label: releasesRunnerBarrier
      ? "Dismiss record (release runner barrier)"
      : "Dismiss",
  };
}

export function replyAvailability(record, agent) {
  if (record.dismissed) {
    return { reason: "Replies are unavailable after this dispatch is dismissed." };
  }
  if (record.merged) {
    return { reason: "Replies are unavailable after this dispatch is merged." };
  }
  if (record.reviewParking && !record.reviewOf) {
    return {
      reason:
        `This review thread was parked after round ${record.reviewParking.round}: ${record.reviewParking.reason}. Start a fresh dispatch and inspect the salvage branch.`,
    };
  }
  if (!agent) {
    return { reason: "Agent capabilities are unavailable for this dispatch." };
  }
  // The server refuses every resume path for an unresolved orphan, so offering
  // any composer here would be a button that can only 409 (atelier-tzw round 4).
  // Sits above the state branches deliberately: the refusal holds whatever state
  // the record is in.
  if (record.orphanUnresolved) {
    return {
      reason:
        "A prior worker for this dispatch could not be confirmed dead - dismiss it, or wait for Atelier to prove the worker gone.",
    };
  }
  if (record.state === "running") {
    return agent.capabilities?.liveInput
      ? { label: "Send now", hint: `Send live input to ${agent.displayName}.` }
      : { reason: `${agent.displayName} does not accept live input.` };
  }
  // needs_input and completed_empty are replyable for the same reason the server
  // accepts them: reply & resume IS the recovery path for a dispatch that stopped
  // to ask or produced nothing (atelier-8r6).
  if (["completed", "completed_empty", "needs_input", "failed", "stopped"].includes(record.state)) {
    if (!agent.capabilities?.canResume) {
      return { reason: `${agent.displayName} cannot resume terminal dispatches.` };
    }
    if (!record.sessionId) {
      return { reason: "No resumable agent session was captured for this dispatch." };
    }
    if (record.restartResumeReady) {
      return {
        label: "Resume after restart",
        hint: `A Atelier restart interrupted ${agent.displayName} - resume the captured session in this worktree.`,
      };
    }
    if (record.state === "needs_input") {
      return {
        label: "Answer & resume",
        hint: record.outcome?.question
          ? `Answer "${record.outcome.question}" to resume the captured ${agent.displayName} session.`
          : `This dispatch is waiting on an answer - reply to resume the captured ${agent.displayName} session.`,
      };
    }
    if (record.state === "completed_empty") {
      return {
        label: "Reply & resume",
        hint: `This dispatch produced no changes - reply with direction to resume the captured ${agent.displayName} session.`,
      };
    }
    return {
      label: "Reply & resume",
      hint: `Continue the captured ${agent.displayName} session in this worktree.`,
    };
  }
  const reasons = {
    queued: "Replies become available once the dispatch is running.",
    preparing: "Replies become available once the agent is running.",
    resuming: "Wait for the resumed agent session to start.",
    verifying: "Replies are unavailable while verification is running.",
    stopping: "Replies are unavailable while the dispatch is stopping.",
    plan_ready: "Approve or revise the plan before sending general replies.",
    prepare_failed: "This dispatch did not reach a resumable agent session.",
    rejected: "Rejected dispatches cannot be resumed.",
  };
  return { reason: reasons[record.state] || `Replies are unavailable while dispatch is ${record.state}.` };
}

// When the dispatch was last worked on. `record.endedAt` is deliberately fixed
// across a verification re-run (the queue outcome is keyed to it), so an elapsed
// display reading it alone stops telling the truth the moment a dispatch is
// re-verified. Attempts carry their own clock and the latest one wins - the same
// rule GC eligibility uses server-side (atelier-9dt).
export function lastActivityAt(record) {
  const parsed = (value) => Date.parse(value || "");
  const candidates = [record?.endedAt, record?.verify?.attempts?.at(-1)?.endedAt]
    .filter((value) => Number.isFinite(parsed(value)));
  if (candidates.length === 0) return record?.endedAt ?? undefined;
  return candidates.reduce((latest, value) => (parsed(value) > parsed(latest) ? value : latest));
}

export function reviewRounds(review) {
  return reviewRoundsFor({ review });
}

export function currentReview(review) {
  return currentReviewFor({ review });
}

// Apply the server's live review patch with the same complete round shape a
// reload would return. Keeping this pure makes SSE/reload parity directly
// testable without booting the DOM-heavy dashboard module.
export function applyReviewEvent(record, event) {
  const rounds = reviewRounds(record.review).map((round) => ({ ...round }));
  let index = event.reviewDispatchId
    ? rounds.findIndex((round) => round.dispatchId === event.reviewDispatchId)
    : -1;
  if (index === -1 && Number.isInteger(event.round)) {
    index = rounds.findIndex((round) => round.round === event.round);
  }
  const round = {
    ...(index === -1 ? {} : rounds[index]),
    dispatchId: event.reviewDispatchId ?? null,
    reviewedHead: event.reviewedHead || null,
    round: Number.isInteger(event.round) ? event.round : index === -1 ? rounds.length + 1 : index + 1,
    at: event.at || (index === -1 ? new Date().toISOString() : rounds[index].at),
    verdict: event.verdict,
    summary: event.summary || "",
    findingCount: Number.isInteger(event.findingCount) ? event.findingCount : null,
    ...(Array.isArray(event.findings) ? { findings: event.findings } : {}),
    ...(event.findingsTruncated === true
      ? {
          findingsTruncated: true,
          findingOverflowCount: event.findingOverflowCount,
          findingOverflowSeverity: event.findingOverflowSeverity,
          findingOverflowSeverityCounts: event.findingOverflowSeverityCounts,
          findingOverflowSeverities: event.findingOverflowSeverities,
          findingOverflowText: event.findingOverflowText,
        }
      : {}),
  };
  if (index === -1) rounds.push(round);
  else rounds[index] = round;
  const current = rounds.at(-1);
  record.review = { ...current, current, rounds };
  if (event.reviewParking) record.reviewParking = event.reviewParking;
}

// Disposition events carry the post-mutation history and freshly derived gates.
// Apply both before the detail view's best-effort refetch so a failed request
// cannot briefly leave the normal merge action enabled against stale state.
export function applyReviewDispositionEvent(record, event) {
  record.reviewDispositions = event.reviewDispositions ?? record.reviewDispositions ?? [];
  if (Array.isArray(event.gates)) record.gates = event.gates;
}

export function reviewIsStale(review, branchHead, reviewGateState = undefined) {
  const current = review?.current ??
    (Array.isArray(review) ? review.at(-1) : review?.rounds?.at(-1) ?? review);
  const accepted = current?.verdict === "pass" || reviewGateState === "passed-with-dispositions";
  return accepted && (
    !current.reviewedHead ||
    !branchHead ||
    current.reviewedHead !== branchHead
  );
}

function reviewAdvisoryPrerequisitesMissing(record, project, assessment) {
  if (assessment.advisories.length === 0) return false;
  const review = currentReview(record.review);
  return (
    !record.ticketId ||
    project?.tracker === "none" ||
    typeof review?.dispatchId !== "string" ||
    !review.dispatchId.trim()
  );
}

// Plan continuation is a spawn, so it passes the same server-side gate as a
// resume: an unresolved orphan is refused outright. Anything else is the ordinary
// plan_ready check.
export function planAvailability(record) {
  if (record.orphanUnresolved) {
    return {
      ready: false,
      reason:
        "A prior worker for this dispatch could not be confirmed dead - dismiss it, or wait for Atelier to prove the worker gone.",
    };
  }
  if (record.state !== "plan_ready" || record.plan?.state !== "ready") {
    return { ready: false, reason: "" };
  }
  return { ready: true, reason: "" };
}

// The verification panel's empty state. Three different facts, three different
// sentences - the panel used to state the third for all of them.
//
// 1. A verification skipped WITH a recorded reason shows that reason (a
//    needs_input or completed_empty dispatch skips a CONFIGURED suite on purpose,
//    atelier-8r6).
// 2. A verification skipped without one - `verify: false`, or a non-worktree verify
//    mode - was still skipped, and that is all that can honestly be said.
// 3. Only a project we can SEE has no commands gets the configuration claim.
export function verificationEmptyMessage(record, project) {
  if (record?.verify?.state !== "skipped") return "Verification has not started.";
  const detail = String(record.verify.detail || "").trim();
  if (detail) {
    return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}${/[.!?]$/.test(detail) ? "" : "."}`;
  }
  return Array.isArray(project?.verifyCommands) && project.verifyCommands.length === 0
    ? "No verification commands configured."
    : "Verification was skipped.";
}

// atelier-9dt. The re-run-verify control mirrors the server's eligibility gate
// exactly, because a control the server would 409 must never be offered: only a
// COMPLETED dispatch whose verdict FAILED is stranded, and only a project with
// worktree verification commands has anything to re-run. `available` drives
// visibility (the affordance is meaningless on every other record), `reason`
// explains a refusal the operator can act on.
// Two server gates are deliberately NOT mirrored, because the record cannot
// answer them: whether the worktree still exists ON DISK, and whether a SIBLING
// record for the same ticket fences an unproven worker. Both are server-side
// knowledge, so the control stays offered and the 409 explains itself rather
// than the mirror guessing.
export function verifyRerunAvailability(record, project) {
  if (!record || record.state !== "completed" || record.verify?.state !== "failed") {
    return { available: false, reason: "" };
  }
  if (record.merged) return { available: false, reason: "" };
  if (record.dismissed) return { available: false, reason: "" };
  // A review dispatch is a read-only audit record: it has no diff to re-verify.
  if (record.reviewOf) return { available: false, reason: "" };
  // No recorded worktree at all is knowable from the record, and there is
  // nothing to run the suite in.
  if (!record.worktreePath) return { available: false, reason: "" };
  if (project?.archetype === "tracker-only") return { available: false, reason: "" };
  if (project?.verifyMode !== "worktree" || !(project?.verifyCommands?.length > 0)) {
    return { available: false, reason: "" };
  }
  // Same refusal as every other spawn-shaped action: the suite would run in a
  // worktree a live worker may still be writing to.
  if (record.orphanUnresolved) {
    return {
      available: true,
      reason:
        "A prior worker for this dispatch could not be confirmed dead - dismiss it, or wait for Atelier to prove the worker gone.",
    };
  }
  return { available: true, reason: "" };
}

export function mergeGateReasons(record, project) {
  const reasons = [];
  // A worker Atelier cannot prove dead is a merge gate the server enforces and
  // force genuinely overrides, so it belongs in this list rather than as a
  // separate refusal: the normal button disables, Force merge stays offered.
  if (record.orphanUnresolved) {
    reasons.push("a prior worker could not be confirmed dead");
  }
  if (record.verify?.state !== "passed") {
    reasons.push(`verification ${record.verify?.state || "missing"}`);
  }
  if (record.strandedBrWrites) reasons.push("stranded tracker writes");
  if (record.mergeRecoveryPending) reasons.push("merge recovery pending");
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
  if (project?.requireReview) {
    const review = currentReview(record.review);
    const reviewState = record.gates?.find?.((gate) => gate.gate === "review")?.state ?? (
      review?.verdict === "pass" ? "passed" : review?.verdict
    );
    const assessment = assessReview(record, project, { reviewGateState: reviewState });
    const acceptedState = assessment.eligible ? "passed-with-dispositions" : reviewState;
    if (reviewIsStale(record.review, record.branchHead, acceptedState)) {
      reasons.push("review stale - re-review required");
    } else if (!assessment.eligible) {
      reasons.push(`review ${assessment.gateState || reviewState || "missing"}`);
    } else if (reviewAdvisoryPrerequisitesMissing(record, project, assessment)) {
      reasons.push("review advisory filing requires a tracker ticket and linked review dispatch");
    }
  }
  return reasons;
}
