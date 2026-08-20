import {
  assessReview,
  currentReviewFor,
} from "../../shared/review-assessment.mjs";
import { mergeGateReasons } from "../../ui/reply-availability.mjs";

function frozenVocabulary(entries) {
  return Object.freeze(Object.fromEntries(entries.map(([code, value]) => [
    code,
    Object.freeze(value),
  ])));
}

export const ATTENTION_REASONS = frozenVocabulary([
  ["needs_input", { severity: "high", label: "Needs input" }],
  ["plan_ready", { severity: "medium", label: "Plan ready" }],
  ["completed_empty", { severity: "medium", label: "Completed without an outcome" }],
  ["failed_unresolved", { severity: "high", label: "Failed and unresolved" }],
  ["restart_resume_ready", { severity: "high", label: "Ready to resume after restart" }],
  ["verify_failed", { severity: "high", label: "Verification failed" }],
  ["review_missing", { severity: "medium", label: "Required review missing" }],
  ["review_errored", { severity: "high", label: "Review errored" }],
  ["review_blocking", { severity: "high", label: "Review blocks merge" }],
  ["review_stale", { severity: "medium", label: "Review is stale" }],
  ["review_parked", { severity: "high", label: "Review trajectory parked" }],
  ["merge_ready", { severity: "medium", label: "Ready for merge decision" }],
  ["bakeoff_selection", { severity: "medium", label: "Bakeoff needs a winner" }],
  ["main_health_failed", { severity: "critical", label: "Main health failed" }],
  ["execution_profile_refusal", { severity: "high", label: "Execution profile refused" }],
  ["queue_ticket_parked", { severity: "medium", label: "Queue ticket parked" }],
  ["queue_circuit_breaker", { severity: "high", label: "Queue circuit breaker open" }],
  ["convoy_paused", { severity: "medium", label: "Convoy paused" }],
  ["project_removed", { severity: "high", label: "Project removed" }],
]);

export const ATTENTION_ACTIONS = frozenVocabulary([
  ["reply", {
    label: "Reply",
    http: "POST /api/dispatch/:id/reply",
    mcp: "atelier_reply",
    cli: "atelier reply",
    humanOnly: false,
  }],
  ["plan_approve", {
    label: "Approve plan",
    http: "POST /api/dispatch/:id/plan",
    mcp: "atelier_plan_action",
    cli: "atelier plan",
    humanOnly: false,
  }],
  ["plan_revise", {
    label: "Revise plan",
    http: "POST /api/dispatch/:id/plan",
    mcp: "atelier_plan_action",
    cli: "atelier plan",
    humanOnly: false,
  }],
  ["review", {
    label: "Run review",
    http: "POST /api/dispatch/:id/review",
    mcp: "atelier_review",
    cli: null,
    humanOnly: false,
  }],
  ["review_disposition", {
    label: "Disposition findings",
    http: "POST /api/dispatch/:id/review-disposition",
    mcp: "atelier_review_disposition",
    cli: null,
    humanOnly: false,
  }],
  ["verify_rerun", {
    label: "Re-run verification",
    http: "POST /api/dispatch/:id/verify",
    mcp: "atelier_verify_rerun",
    cli: null,
    humanOnly: false,
  }],
  ["merge", {
    label: "Merge",
    http: "POST /api/dispatch/:id/merge",
    mcp: "atelier_merge",
    cli: "atelier merge",
    humanOnly: false,
  }],
  ["dismiss", {
    label: "Dismiss",
    http: "POST /api/dispatch/:id/dismiss",
    mcp: "atelier_dismiss",
    cli: null,
    humanOnly: false,
  }],
  ["main_health_ack", {
    label: "Acknowledge main health failure",
    http: "POST /api/dispatch/:id/ack-main-health",
    mcp: "atelier_main_health_ack",
    cli: null,
    humanOnly: false,
  }],
  ["queue_resume", {
    label: "Resume queued ticket",
    http: "POST /api/projects/:project/queue",
    mcp: "atelier_queue_resume",
    cli: null,
    humanOnly: false,
  }],
  ["queue_enable", {
    label: "Enable queue",
    http: "POST /api/projects/:project/queue",
    mcp: "atelier_queue_set",
    cli: null,
    humanOnly: false,
  }],
  ["convoy_resume", {
    label: "Resume convoy",
    http: "POST /api/convoys/:id/resume",
    mcp: "atelier_convoy_resume",
    cli: null,
    humanOnly: false,
  }],
  ["convoy_cancel", {
    label: "Cancel convoy",
    http: "POST /api/convoys/:id/cancel",
    mcp: "atelier_convoy_cancel",
    cli: null,
    humanOnly: false,
  }],
  ["reply_accept_profile", {
    label: "Accept execution profile and reply",
    http: "POST /api/dispatch/:id/reply",
    mcp: null,
    cli: "atelier reply --accept-execution-profile",
    humanOnly: true,
  }],
]);

export const ATTENTION_EXCLUSIONS = Object.freeze([
  Object.freeze({
    condition: "active_dispatch",
    reason: "Queued, preparing, resuming, running, and verifying dispatches are active work.",
  }),
  Object.freeze({
    condition: "stopping_or_stopped",
    reason: "Stopping and stopped dispatches do not require a decision on their own.",
  }),
  Object.freeze({
    condition: "live_review",
    reason: "Pending and running reviews are active work.",
  }),
  Object.freeze({
    condition: "dismissed_dispatch",
    reason: "Dismissal resolves ordinary dispatch attention.",
  }),
  Object.freeze({
    condition: "unresolved_orphan",
    reason: "An unresolved orphan belongs to Recovery Center, where reply is refused until fencing is resolved.",
  }),
  Object.freeze({
    condition: "review_dispatch",
    reason: "Review-target dispatches are audit evidence, not merge candidates.",
  }),
  Object.freeze({
    condition: "acknowledged_main_failure",
    reason: "Acknowledged main failures remain health debt but no longer await a decision.",
  }),
  Object.freeze({
    condition: "tiered_review_advisory",
    reason: "Tiered MINOR and NIT findings are merge-eligible advisories.",
  }),
  Object.freeze({
    condition: "budget_cap",
    reason: "Budget caps reset or clear without a human decision.",
  }),
  Object.freeze({
    condition: "unpriced_dispatch_cap",
    reason: "Unpriced-dispatch caps reset or clear without a human decision.",
  }),
  Object.freeze({
    condition: "concurrency_wait",
    reason: "Concurrency and capacity waits clear when capacity becomes available.",
  }),
  Object.freeze({
    condition: "intentionally_disabled_queue",
    reason: "A disabled queue is attention only when its failure circuit breaker is established.",
  }),
  Object.freeze({
    condition: "repair_debt",
    reason: "Recovery, orphan, persistence, cleanup, and advisory debt belong to Recovery Center.",
  }),
  Object.freeze({
    condition: "resource_measurement",
    reason: "Disk, process, and log sizing belong to Resource Visibility.",
  }),
]);

export const ATTENTION_LIMIT = 200;

const FAILURE_STATES = new Set(["failed", "prepare_failed", "rejected"]);
const LIVE_REVIEW_STATES = new Set(["pending", "running", "queued"]);
const SEVERITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });

function validTimestamp(...values) {
  return values.find((value) => Number.isFinite(Date.parse(value ?? ""))) ?? null;
}

function earliestTimestamp(values) {
  const valid = values.filter((value) => Number.isFinite(Date.parse(value ?? "")));
  if (valid.length === 0) return null;
  return valid.reduce((earliest, value) =>
    Date.parse(value) < Date.parse(earliest) ? value : earliest);
}

function dispatchSubject(record) {
  return {
    kind: "dispatch",
    id: record.id,
    project: record.project,
    ...(record.ticketId != null ? { ticketId: record.ticketId } : {}),
  };
}

function makeReason(code, detail, since, evidence = {}) {
  return { code, detail, since: validTimestamp(since), evidence };
}

function makeEntry(key, subject, reasons = [], actions = []) {
  return { key, subject, reasons: [...reasons], actions: [...actions] };
}

function addReason(situation, code, detail, since, evidence, actions) {
  situation.reasons.push(makeReason(code, detail, since, evidence));
  situation.actions.push(...actions);
}

function addMainHealthReason(situation, record, recordAt, evidence) {
  if (
    record.postMerge?.state !== "failed" ||
    record.postMerge.resolvedAt ||
    record.postMerge.acknowledgedAt
  ) return;
  addReason(
    situation,
    "main_health_failed",
    record.postMerge.error || record.postMerge.evidenceTail || "Post-merge verification failed.",
    validTimestamp(record.postMerge.endedAt, record.postMerge.startedAt, recordAt),
    {
      ...evidence,
      commit: record.postMerge.commit ?? record.merged?.commit ?? null,
    },
    ["main_health_ack"],
  );
}

function recordSituations(records, projectsByName) {
  const situations = new Map();
  const mergeReady = new Set();

  for (const record of records) {
    if (
      !record ||
      typeof record.id !== "string" ||
      record.reviewOf != null
    ) continue;
    const project = projectsByName.get(record.project) ?? {};
    const situation = makeEntry(`dispatch:${record.id}`, dispatchSubject(record));
    const recordAt = validTimestamp(record.endedAt, record.startedAt);
    const evidence = { dispatchId: record.id, state: record.state ?? null };

    if (record.dismissed != null) {
      addMainHealthReason(situation, record, recordAt, evidence);
      if (situation.reasons.length > 0) situations.set(record.id, situation);
      continue;
    }

    if (record.state === "needs_input") {
      const question = typeof record.outcome?.question === "string"
        ? record.outcome.question
        : null;
      addReason(
        situation,
        "needs_input",
        question || "The dispatch is waiting for input.",
        recordAt,
        { ...evidence, question },
        ["reply", "dismiss"],
      );
    }
    if (record.state === "plan_ready") {
      addReason(
        situation,
        "plan_ready",
        "The proposed plan needs approval or revision.",
        recordAt,
        evidence,
        ["plan_approve", "plan_revise"],
      );
    }
    if (record.state === "completed_empty") {
      addReason(
        situation,
        "completed_empty",
        "The dispatch completed without producing an outcome.",
        recordAt,
        evidence,
        ["reply", "dismiss"],
      );
    }
    if (FAILURE_STATES.has(record.state) && record.orphanUnresolved !== true) {
      addReason(
        situation,
        "failed_unresolved",
        record.exitSummary || `The dispatch ended in ${record.state}.`,
        recordAt,
        evidence,
        [...(record.state === "failed" ? ["reply"] : []), "dismiss"],
      );
      if (record.restartResumeReady === true) {
        addReason(
          situation,
          "restart_resume_ready",
          "The interrupted dispatch can be resumed from its captured session.",
          recordAt,
          {
            ...evidence,
            restartResumeReady: true,
            ...(record.restartResumeConflict != null
              ? { restartResumeConflict: record.restartResumeConflict }
              : {}),
          },
          ["reply", "dismiss"],
        );
      }
    }
    if (
      record.state === "completed" &&
      record.verify?.state === "failed" &&
      !record.merged
    ) {
      addReason(
        situation,
        "verify_failed",
        record.verify.detail || "Verification failed.",
        validTimestamp(record.verify.endedAt, record.verify.attempts?.at(-1)?.endedAt, recordAt),
        { ...evidence, verifyState: "failed" },
        ["verify_rerun", "reply", "dismiss"],
      );
    }

    const reviewTarget = record.state === "completed" && !record.merged && !record.reviewOf;
    if (reviewTarget && project.requireReview === true) {
      const current = currentReviewFor(record);
      if (!current) {
        addReason(
          situation,
          "review_missing",
          "This completed dispatch has no current required review round.",
          recordAt,
          evidence,
          ["review", "dismiss"],
        );
      } else if (!LIVE_REVIEW_STATES.has(current.verdict)) {
        const reviewAt = validTimestamp(current.at, recordAt);
        const reviewEvidence = {
          ...evidence,
          verdict: current.verdict ?? null,
          reviewedHead: current.reviewedHead ?? null,
          branchHead: record.branchHead ?? null,
        };
        if (current.verdict === "error") {
          addReason(
            situation,
            "review_errored",
            current.summary || "The current review round errored.",
            reviewAt,
            reviewEvidence,
            ["review", "dismiss"],
          );
        }
        const assessment = assessReview(record, project);
        if (!assessment.eligible && (
          assessment.blockers.length > 0 || assessment.openFindings.length > 0
        )) {
          addReason(
            situation,
            "review_blocking",
            assessment.reason || "Open review findings block merge.",
            reviewAt,
            {
              ...reviewEvidence,
              openFindingCount: assessment.openFindings.length,
              blockerCount: assessment.blockers.length,
            },
            ["review_disposition", "reply", "review"],
          );
        }
        if (current.reviewedHead !== record.branchHead) {
          addReason(
            situation,
            "review_stale",
            "The required review does not match the current branch HEAD.",
            reviewAt,
            reviewEvidence,
            ["review", "dismiss"],
          );
        }
      }
    }

    if (record.reviewParking?.state === "parked") {
      addReason(
        situation,
        "review_parked",
        `${record.reviewParking.reason || "The review trajectory was parked."} Start a replacement dispatch and inspect the salvage branch.`,
        validTimestamp(record.reviewParking.at, recordAt),
        {
          ...evidence,
          round: record.reviewParking.round ?? null,
          reasonCode: record.reviewParking.reasonCode ?? null,
          guidance: "start_replacement",
        },
        ["dismiss"],
      );
    }

    if (
      record.state === "completed" &&
      !record.merged &&
      !record.reviewOf &&
      mergeGateReasons(record, project).length === 0
    ) {
      mergeReady.add(record.id);
      addReason(
        situation,
        "merge_ready",
        "All recorded merge gates pass; choose whether to merge or dismiss.",
        recordAt,
        { ...evidence, blockingReasons: [] },
        ["merge", "dismiss"],
      );
    }

    addMainHealthReason(situation, record, recordAt, evidence);

    if (record.executionProfileRefusal != null) {
      addReason(
        situation,
        "execution_profile_refusal",
        record.executionProfileRefusal.detail || "The recorded execution profile was refused.",
        validTimestamp(record.executionProfileRefusal.at, recordAt),
        {
          ...evidence,
          operation: record.executionProfileRefusal.operation ?? null,
        },
        ["reply_accept_profile"],
      );
    }

    if (situation.reasons.length > 0 && record.projectRemoved === true) {
      addReason(
        situation,
        "project_removed",
        `Project ${record.project} is no longer registered.`,
        recordAt,
        evidence,
        ["dismiss"],
      );
    }
    if (situation.reasons.length > 0) situations.set(record.id, situation);
  }

  return { situations, mergeReady };
}

function appendDispatchSituation(entry, situation) {
  if (!situation) return;
  entry.reasons.push(...situation.reasons.map((reason) => ({
    ...reason,
    evidence: { ...reason.evidence, dispatchId: situation.subject.id },
  })));
  entry.actions.push(...situation.actions);
}

function finalizeEntry(entry) {
  const reasons = [...entry.reasons].sort((left, right) =>
    (Number.isFinite(Date.parse(left.since ?? ""))
      ? Date.parse(left.since)
      : Number.POSITIVE_INFINITY) -
      (Number.isFinite(Date.parse(right.since ?? ""))
        ? Date.parse(right.since)
        : Number.POSITIVE_INFINITY) ||
    left.code.localeCompare(right.code) ||
    String(left.evidence?.dispatchId ?? "").localeCompare(
      String(right.evidence?.dispatchId ?? ""),
    ));
  const severity = reasons.reduce((highest, reason) => {
    const candidate = ATTENTION_REASONS[reason.code].severity;
    return SEVERITY_RANK[candidate] > SEVERITY_RANK[highest] ? candidate : highest;
  }, "low");
  return {
    key: entry.key,
    subject: entry.subject,
    severity,
    since: earliestTimestamp(reasons.map((reason) => reason.since)),
    reasons,
    actions: entry.actions.filter((action, index) => entry.actions.indexOf(action) === index),
  };
}

function entryOrder(left, right) {
  const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
  if (severity !== 0) return severity;
  const leftAt = Number.isFinite(Date.parse(left.since ?? ""))
    ? Date.parse(left.since)
    : Number.POSITIVE_INFINITY;
  const rightAt = Number.isFinite(Date.parse(right.since ?? ""))
    ? Date.parse(right.since)
    : Number.POSITIVE_INFINITY;
  return leftAt - rightAt || left.key.localeCompare(right.key);
}

function attentionCounts(entries) {
  const bySeverity = Object.fromEntries(Object.keys(SEVERITY_RANK).map((key) => [key, 0]));
  const byReason = Object.fromEntries(Object.keys(ATTENTION_REASONS).map((key) => [key, 0]));
  for (const entry of entries) {
    bySeverity[entry.severity] += 1;
    for (const reason of entry.reasons) byReason[reason.code] += 1;
  }
  return { bySeverity, byReason, total: entries.length };
}

export function attentionFor(input = {}, options = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const queues = Array.isArray(input.queues) ? input.queues : [];
  const convoys = Array.isArray(input.convoys) ? input.convoys : [];
  const projectsByName = new Map(projects.map((project) => [project.name, project]));
  const { situations, mergeReady } = recordSituations(records, projectsByName);
  const recordsById = new Map(records.map((record) => [record?.id, record]));
  const absorbed = new Set();
  const entries = [];

  for (const convoy of convoys) {
    if (!convoy || convoy.state !== "paused" || typeof convoy.id !== "string") continue;
    const entry = makeEntry(
      `convoy:${convoy.id}`,
      { kind: "convoy", id: convoy.id, project: convoy.project },
      [makeReason(
        "convoy_paused",
        convoy.reason || "The convoy is paused.",
        validTimestamp(convoy.updatedAt, convoy.createdAt),
        { convoyId: convoy.id, currentDispatchId: convoy.currentDispatchId ?? null },
      )],
      ["convoy_resume", "convoy_cancel"],
    );
    if (
      typeof convoy.currentDispatchId === "string" &&
      !absorbed.has(convoy.currentDispatchId)
    ) {
      absorbed.add(convoy.currentDispatchId);
      appendDispatchSituation(entry, situations.get(convoy.currentDispatchId));
    }
    entries.push(entry);
  }

  for (const item of queues) {
    const project = item?.project;
    const queue = item?.queue;
    if (typeof project !== "string" || !queue || typeof queue !== "object") continue;
    for (const parked of Array.isArray(queue.parkedTickets) ? queue.parkedTickets : []) {
      if (!parked || typeof parked.ticketId !== "string") continue;
      const entry = makeEntry(
        `queue:${project}:${parked.ticketId}`,
        { kind: "queue_ticket", id: parked.ticketId, project, ticketId: parked.ticketId },
        [makeReason(
          "queue_ticket_parked",
          parked.parkReason || "The queue parked this ticket after repeated failures.",
          validTimestamp(parked.parkedAt, parked.lastFailureAt),
          {
            project,
            ticketId: parked.ticketId,
            lastDispatchId: parked.lastDispatchId ?? null,
            attempts: parked.attempts ?? null,
          },
        )],
        ["queue_resume"],
      );
      if (typeof parked.lastDispatchId === "string" && !absorbed.has(parked.lastDispatchId)) {
        absorbed.add(parked.lastDispatchId);
        appendDispatchSituation(entry, situations.get(parked.lastDispatchId));
      }
      entries.push(entry);
    }
    if (
      queue.enabled === false &&
      Number.isFinite(queue.consecutiveFailures) &&
      Number.isFinite(queue.failureLimit) &&
      queue.failureLimit > 0 &&
      queue.consecutiveFailures >= queue.failureLimit
    ) {
      entries.push(makeEntry(
        `queue:${project}`,
        { kind: "queue", id: project, project },
        [makeReason(
          "queue_circuit_breaker",
          queue.lastError || "The queue disabled itself after reaching its failure limit.",
          validTimestamp(queue.lastFailureAt),
          {
            project,
            consecutiveFailures: Number(queue.consecutiveFailures),
            failureLimit: Number(queue.failureLimit),
          },
        )],
        ["queue_enable"],
      ));
    }
  }

  const bakeoffs = new Map();
  for (const record of records) {
    if (
      record?.batchKind !== "bakeoff" ||
      typeof record.batchId !== "string"
    ) continue;
    const siblings = bakeoffs.get(record.batchId) ?? [];
    siblings.push(record);
    bakeoffs.set(record.batchId, siblings);
  }
  for (const [batchId, siblings] of bakeoffs) {
    const candidates = siblings.filter((record) => record.dismissed == null && !record.merged);
    if (candidates.length < 2 || !candidates.some((record) => mergeReady.has(record.id))) continue;
    const project = candidates[0].project;
    const readyIds = candidates
      .filter((record) => mergeReady.has(record.id))
      .map((record) => record.id);
    const entry = makeEntry(
      `bakeoff:${batchId}`,
      { kind: "bakeoff", id: batchId, project },
      [makeReason(
        "bakeoff_selection",
        "Multiple bakeoff attempts remain; select a merge-ready winner.",
        earliestTimestamp(candidates.map((record) => validTimestamp(record.endedAt, record.startedAt))),
        { batchId, dispatchIds: siblings.map((record) => record.id), mergeReadyDispatchIds: readyIds },
      )],
      ["merge", "dismiss"],
    );
    for (const record of siblings) {
      if (absorbed.has(record.id)) continue;
      absorbed.add(record.id);
      appendDispatchSituation(entry, situations.get(record.id));
    }
    entries.push(entry);
  }

  for (const [recordId, situation] of situations) {
    if (!absorbed.has(recordId) && recordsById.has(recordId)) entries.push(situation);
  }

  const finalized = entries.map(finalizeEntry).sort(entryOrder);
  const requestedLimit = options.limit ?? ATTENTION_LIMIT;
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : ATTENTION_LIMIT;
  const now = options.now ?? new Date();
  return {
    generatedAt: new Date(now).toISOString(),
    entries: finalized.slice(0, limit),
    counts: attentionCounts(finalized),
    truncated: finalized.length > limit,
    excluded: ATTENTION_EXCLUSIONS,
  };
}
