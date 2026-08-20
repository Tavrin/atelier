import { ATTENTION_ACTIONS, attentionFor } from "./attention.mjs";
import { RECOVERY_ACTIONS, recoveryFor } from "./recovery.mjs";

function frozenTable(entries) {
  return Object.freeze(Object.fromEntries(entries.map(([key, value]) => [
    key,
    Object.freeze(value),
  ])));
}

export const TIMELINE_STAGES = frozenTable([
  ["work", { order: 0, label: "Work" }],
  ["execution", { order: 1, label: "Execution" }],
  ["verification", { order: 2, label: "Verification" }],
  ["review", { order: 3, label: "Review" }],
  ["attention", { order: 4, label: "Attention" }],
  ["recovery", { order: 5, label: "Recovery" }],
  ["merge", { order: 6, label: "Merge" }],
  ["main_health", { order: 7, label: "Main health" }],
]);

export const TIMELINE_PROOFS = frozenTable([
  ["containment", { label: "Contained on the durable record" }],
  ["stored-identifier", { label: "Linked by a stored identifier" }],
  ["content-identity", { label: "Linked by an exact stored content identity" }],
  ["association", { label: "Associated, not causal" }],
  ["unknown", { label: "Not establishable at this HEAD" }],
]);

function coverage(relation, proof, detail, evidence) {
  return Object.freeze({ relation, proof, detail, evidence });
}

export const TIMELINE_COVERAGE = Object.freeze([
  coverage("dispatch-lifecycle", "containment", "Lifecycle and state history live on one durable dispatch record.", "dispatch.mjs:510-534"),
  coverage("dispatch-verification", "containment", "Verification attempts live in record.verify, including attempts[].", "dispatch.mjs:593,5150-5194"),
  coverage("verification-result", "content-identity", "The attestation stores the exact result commit and tree that merge validates.", "dispatch.mjs:5594-5606,11167-11196"),
  coverage("dispatch-result", "content-identity", "record.result stores the finalized commit, tree, base and version.", "dispatch.mjs:6212-6222"),
  coverage("review-target", "stored-identifier", "A reviewer dispatch stores its target in reviewOf.", "dispatch.mjs:606,3311-3319"),
  coverage("reviewer-dispatch", "stored-identifier", "A target review round stores the reviewer dispatch id.", "dispatch.mjs:3421-3422"),
  coverage("review-tree", "content-identity", "A review round stores the exact reviewedHead sha.", "dispatch.mjs:628-658,3399"),
  coverage("dispatch-merge", "containment", "Merge metadata lives in record.merged.", "dispatch.mjs:11453-11461"),
  coverage("merge-main-health", "containment", "The post-merge outcome lives on the same dispatch record.", "dispatch.mjs:5729-5736"),
  coverage("main-health-acknowledgement", "stored-identifier", "Acknowledgement is keyed by the dispatch id and logs that id and commit.", "dispatch.mjs:6006-6011; attention.mjs:93-96"),
  coverage("bakeoff-sibling", "stored-identifier", "Bakeoff siblings share the durable batchId minted for the batch.", "dispatch.mjs:521-523,8510-8524"),
  coverage("convoy-current-dispatch", "stored-identifier", "A convoy stores only its currentDispatchId.", "dispatch.mjs:2885-2899,12656"),
  coverage("queue-last-dispatch", "stored-identifier", "A parked queue attempt stores lastDispatchId.", "dispatch.mjs:2716-2724"),
  coverage("attention-subject", "containment", "Attention is a pure projection whose dispatch subject id is the record id.", "attention.mjs:213-220"),
  coverage("recovery-subject", "containment", "Recovery is a pure projection whose dispatch subject id is the record id.", "recovery.mjs:223-229"),
  coverage("event-dispatch", "stored-identifier", "Operational events carry dispatchId as a first-class filter field.", "event-log.mjs:68; dispatch.mjs:3034-3035"),
  coverage("review-verification", "association", "reviewedHead equality proves the same tree, not that the review followed or consumed a verification attempt.", "dispatch.mjs:3466-3472"),
  coverage("same-ticket", "association", "A ticket id is caller-supplied and may be shared by multiple dispatches; this is not causal.", "dispatch.mjs:7892-7909,7981"),
  coverage("convoy-past-dispatch", "association", "Past convoy membership is recoverable only through ticket ids, which are non-causal associations.", "dispatch.mjs:12651-12666"),
  coverage("main-health-cause", "association", "A failed main tip contains everything merged before it, so this change is not established as the cause.", "dispatch.mjs:5729-5736"),
  coverage("same-branch", "association", "A branch name is a name, not an identity, and is never rendered as a link.", "LINKAGE-COVERAGE-2026-08-20.md:2"),
  coverage("event-adjacency", "association", "Adjacency or ordering in an event log is never rendered as a link.", "LINKAGE-COVERAGE-2026-08-20.md:2"),
  coverage("command-causation", "unknown", "No durable CMDID links command invocations to records or events at this HEAD.", "LINKAGE-COVERAGE-2026-08-20.md:3"),
  coverage("evidence-store-reference", "unknown", "No production writer mints immutable evidence-store references.", "docs/EVIDENCE-STORE.md:6"),
  coverage("transition-actor", "unknown", "The actor behind a transition is absent from the record and survives only in the global event log.", "dispatch.mjs:8061; event-log.mjs:68"),
  coverage("review-finding-code", "unknown", "A review finding has no durable code anchor beyond its round's reviewedHead.", "dispatch.mjs:628-658"),
  coverage("workflow-identity", "unknown", "Workflow, IntegrationRun and writer-lease identities do not exist at this HEAD.", "LINKAGE-COVERAGE-2026-08-20.md:3"),
  coverage("live-exit-event", "unknown", "The durable exit event type has no live emit call site.", "dispatch.mjs:280-289"),
]);

export const TIMELINE_LIMIT = 200;

const NO_EVIDENCE_STORE = "no immutable evidence-store reference exists";
const ACTIVE_STATES = new Set(["queued", "preparing", "resuming", "running", "verifying", "stopping"]);
const FAILED_STATES = new Set(["failed", "prepare_failed", "rejected"]);
const BLOCKED_STATES = new Set(["needs_input", "plan_ready", "completed_empty", "stopped"]);

function normalizedLimit(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  return Math.min(value, TIMELINE_LIMIT);
}

function isoTimestamp(value) {
  return new Date(value).toISOString();
}

function storedTimestamp(...values) {
  return values.find((value) => Number.isFinite(Date.parse(value ?? ""))) ?? null;
}

function subjectFor(record) {
  return {
    kind: "dispatch",
    id: String(record.id),
    ...(record.project ? { project: record.project } : {}),
  };
}

function encoded(value) {
  return encodeURIComponent(String(value));
}

function evidenceFor(record, { diff = false, logs = false, label = "Dispatch record" } = {}) {
  const id = encoded(record.id);
  return [
    { kind: "dispatch-record", label, http: `/api/dispatch/${id}`, mcp: "atelier_dispatch" },
    { kind: "dispatch-events", label: "Per-dispatch event stream", http: `/api/dispatch/${id}/events`, mcp: "atelier_dispatch_tail" },
    ...(diff
      ? [{ kind: "dispatch-diff", label: "Dispatch diff", http: `/api/dispatch/${id}/diff`, mcp: "atelier_dispatch_diff" }]
      : []),
    ...(logs
      ? [{ kind: "operational-log", label: "Operational events for this dispatch", http: `/api/logs?dispatchId=${id}`, mcp: "atelier_logs" }]
      : []),
  ];
}

function actionDetails(keys, table) {
  return keys.map((key) => ({ key, ...table[key] })).filter((action) => action.label);
}

function step(record, stage, code, label, at, state, {
  links = [],
  evidence = evidenceFor(record),
  unknown = [],
  actions = [],
} = {}) {
  return {
    stage,
    code,
    label,
    at,
    state,
    subject: subjectFor(record),
    links,
    evidence,
    unknown: [...new Set([NO_EVIDENCE_STORE, ...unknown])],
    ...(actions.length > 0 ? { actions } : {}),
  };
}

function executionState(state) {
  if (state === "completed") return "done";
  if (FAILED_STATES.has(state)) return "failed";
  if (BLOCKED_STATES.has(state)) return "blocked";
  if (ACTIVE_STATES.has(state)) return "pending";
  return "unknown";
}

function verdictState(state) {
  if (["passed", "pass", "completed", "succeeded", "success"].includes(state)) return "done";
  if (["failed", "fail", "error", "errored"].includes(state)) return "failed";
  if (["running", "pending", "queued"].includes(state)) return "pending";
  if (["skipped", "blocked", "parked"].includes(state)) return "blocked";
  return "unknown";
}

function reviewRounds(record) {
  if (Array.isArray(record?.review)) return record.review;
  if (!record?.review || typeof record.review !== "object") return [];
  if (Array.isArray(record.review.rounds) && record.review.rounds.length > 0) {
    return record.review.rounds;
  }
  if (record.review.current && typeof record.review.current === "object") {
    return [record.review.current];
  }
  const { rounds: _rounds, current: _current, ...flat } = record.review;
  return Object.keys(flat).length > 0 ? [flat] : [];
}

function verifyAttempts(record) {
  if (Array.isArray(record.verify?.attempts) && record.verify.attempts.length > 0) {
    return record.verify.attempts;
  }
  return record.verify ? [record.verify] : [];
}

function attemptId(record, attempt, index) {
  return `${record.id}:verify:${attempt?.attempt ?? index + 1}`;
}

function workStep(record, records, queues, convoys) {
  const links = [];
  const unknown = ["no durable command identity links this work to the command that requested it"];
  if (record.ticketId != null) {
    links.push({
      relation: "same-ticket",
      to: { kind: "ticket", id: String(record.ticketId) },
      proof: "association",
      detail: "The dispatch stores this caller-supplied ticket id, but multiple dispatches may share it; this association is not causal.",
    });
    for (const other of records) {
      if (other?.id === record.id || other?.ticketId !== record.ticketId) continue;
      links.push({
        relation: "same-ticket",
        to: { kind: "dispatch", id: String(other.id) },
        proof: "association",
        detail: "The dispatches share a ticket, but multiple dispatches may share it; this association is not causal.",
      });
    }
  }
  if (record.batchId != null) {
    for (const other of records) {
      if (other?.id === record.id || other?.batchId !== record.batchId) continue;
      links.push({
        relation: "bakeoff-sibling",
        to: { kind: "dispatch", id: String(other.id) },
        proof: "stored-identifier",
        detail: `Both records store batchId ${record.batchId}.`,
      });
    }
  }
  for (const item of queues) {
    for (const parked of item?.queue?.parkedTickets ?? []) {
      if (parked?.lastDispatchId !== record.id) continue;
      links.push({
        relation: "queue-last-dispatch",
        to: { kind: "queue_ticket", id: String(parked.ticketId) },
        proof: "stored-identifier",
        detail: "The parked queue attempt stores this dispatch as lastDispatchId.",
      });
    }
  }
  for (const convoy of convoys) {
    if (convoy?.currentDispatchId === record.id) {
      links.push({
        relation: "convoy-current-dispatch",
        to: { kind: "convoy", id: String(convoy.id) },
        proof: "stored-identifier",
        detail: "The convoy stores this record as currentDispatchId.",
      });
    } else if (record.ticketId != null && convoy?.ticketIds?.includes(record.ticketId)) {
      unknown.push(`convoy ${convoy.id} past membership is unknown; ticketId is not causal`);
    }
  }
  return step(
    record,
    "work",
    record.ticketId == null ? "ticket-unknown" : "ticket",
    record.ticketId == null ? "Ticket unknown" : `Ticket ${record.ticketId}`,
    null,
    record.ticketId == null ? "unknown" : "done",
    { links, unknown, evidence: evidenceFor(record, { logs: true }) },
  );
}

function executionStep(record) {
  const links = [];
  if (record.result?.commit) {
    links.push({
      relation: "dispatch-result",
      to: { kind: "commit", id: String(record.result.commit) },
      proof: "content-identity",
      detail: "The finalized result stores this exact commit identity.",
    });
  }
  return step(record, "execution", "dispatch-lifecycle", "Dispatch execution", storedTimestamp(record.startedAt), executionState(record.state), {
    links,
    evidence: evidenceFor(record, { logs: true }),
    unknown: [
      "the actor behind each lifecycle transition is not stored on the dispatch record",
      "exit is not a live per-dispatch event type at this HEAD",
    ],
  });
}

function verificationSteps(record) {
  return verifyAttempts(record).map((attempt, index) => {
    const links = [];
    const number = attempt?.attempt ?? index + 1;
    if (
      record.attestation?.resultCommit &&
      (record.attestation.attempt == null || record.attestation.attempt === number)
    ) {
      links.push({
        relation: "verification-result",
        to: { kind: "commit", id: String(record.attestation.resultCommit) },
        proof: "content-identity",
        detail: "The attestation stores this exact result commit and tree identity.",
      });
    }
    return step(record, "verification", `verification-attempt-${number}`, `Verification attempt ${number}`, storedTimestamp(attempt?.endedAt, attempt?.startedAt), verdictState(attempt?.state), {
      links,
      evidence: evidenceFor(record, { diff: true, label: "Dispatch record verification and attestation" }),
    });
  });
}

function reviewSteps(record, recordsById) {
  const rounds = reviewRounds(record).map((round, index) => {
    const links = [];
    if (round?.reviewedHead) {
      links.push({
        relation: "review-tree",
        to: { kind: "commit", id: String(round.reviewedHead) },
        proof: "content-identity",
        detail: "The review round stores this exact reviewedHead content identity.",
      });
    }
    const reviewerId = round?.reviewDispatchId ?? round?.dispatchId;
    if (reviewerId) {
      links.push({
        relation: "reviewer-dispatch",
        to: { kind: "dispatch", id: String(reviewerId) },
        proof: "stored-identifier",
        detail: "The review round stores the reviewer dispatch id.",
      });
    }
    const attestation = record.attestation;
    const attempts = verifyAttempts(record);
    const matchingIndex = attempts.findIndex((attempt, attemptIndex) =>
      round?.reviewedHead &&
      attestation?.resultCommit === round.reviewedHead &&
      (attestation.attempt == null || attestation.attempt === (attempt?.attempt ?? attemptIndex + 1)));
    if (matchingIndex >= 0) {
      links.push({
        relation: "review-verification",
        to: { kind: "verification-attempt", id: attemptId(record, attempts[matchingIndex], matchingIndex) },
        proof: "association",
        detail: "reviewedHead sha proves the same tree, not that the review followed or consumed this verification attempt.",
      });
    }
    const number = round?.round ?? index + 1;
    return step(record, "review", `review-round-${number}`, `Review round ${number}`, storedTimestamp(round?.at), verdictState(round?.verdict ?? round?.state), {
      links,
      evidence: evidenceFor(record, { diff: true, label: "Dispatch record review rounds" }),
      unknown: ["review findings have no durable code anchor beyond reviewedHead"],
    });
  });

  if (record.reviewOf != null) {
    const target = recordsById.get(record.reviewOf);
    const links = [{
      relation: "review-target",
      to: { kind: "dispatch", id: String(record.reviewOf) },
      proof: "stored-identifier",
      detail: "This reviewer dispatch stores the target id in reviewOf.",
    }];
    if (record.reviewedHead) {
      links.push({
        relation: "review-tree",
        to: { kind: "commit", id: String(record.reviewedHead) },
        proof: "content-identity",
        detail: "The reviewer dispatch stores this exact reviewedHead content identity.",
      });
    }
    if (record.reviewedHead && target?.attestation?.resultCommit === record.reviewedHead) {
      const attempts = verifyAttempts(target);
      const matchingIndex = attempts.findIndex((attempt, index) =>
        target.attestation.attempt == null || target.attestation.attempt === (attempt?.attempt ?? index + 1));
      if (matchingIndex >= 0) {
        links.push({
          relation: "review-verification",
          to: { kind: "verification-attempt", id: attemptId(target, attempts[matchingIndex], matchingIndex) },
          proof: "association",
          detail: "reviewedHead sha proves the same tree, not that the review followed or consumed this verification attempt.",
        });
      }
    }
    rounds.push(step(record, "review", "review-dispatch", "Review dispatch", storedTimestamp(record.endedAt, record.startedAt), executionState(record.state), {
      links,
      evidence: evidenceFor(record, { diff: true, label: "Reviewer dispatch record" }),
      unknown: ["review findings have no durable code anchor beyond reviewedHead"],
    }));
  }
  return rounds;
}

function attentionSteps(record, projection) {
  const entries = projection.entries ?? [];
  const result = [];
  for (const entry of entries) {
    const belongs = entry?.subject?.kind === "dispatch" && entry.subject.id === record.id;
    const reasons = (entry?.reasons ?? []).filter((reason) =>
      belongs || reason?.evidence?.dispatchId === record.id);
    for (const reason of reasons) {
      result.push(step(record, "attention", reason.code, reason.detail || reason.code, reason.since ?? null, "blocked", {
        links: [{
          relation: "attention-subject",
          to: { kind: "dispatch", id: String(record.id) },
          proof: "containment",
          detail: "Attention classified this same exposed dispatch record.",
        }],
        evidence: evidenceFor(record, { logs: true, label: "Dispatch record justifying attention" }),
        actions: actionDetails(entry.actions ?? [], ATTENTION_ACTIONS),
      }));
    }
  }
  return result;
}

function recoverySteps(record, projection) {
  return (projection.conditions ?? [])
    .filter((condition) => condition?.subject?.kind === "dispatch" && condition.subject.id === record.id)
    .map((condition) => step(record, "recovery", condition.code, condition.detail || condition.code, null, "blocked", {
      links: [{
        relation: "recovery-subject",
        to: { kind: "dispatch", id: String(record.id) },
        proof: "containment",
        detail: "Recovery classified this same exposed dispatch record.",
      }],
      evidence: evidenceFor(record, { logs: true, label: "Dispatch record justifying recovery" }),
      actions: actionDetails(condition.actions ?? [], RECOVERY_ACTIONS),
    }));
}

function mergeStep(record) {
  if (!record.merged) return [];
  const identity = record.merged.resultCommit ?? record.merged.commit;
  return [step(record, "merge", "dispatch-merge", "Merged", storedTimestamp(record.merged.mergedAt), "done", {
    links: identity ? [{
      relation: "dispatch-merge",
      to: { kind: "commit", id: String(identity) },
      proof: "containment",
      detail: "The merge and its result identity are contained on record.merged.",
    }] : [],
    evidence: evidenceFor(record, { diff: true, logs: true, label: "Dispatch record merge metadata" }),
  })];
}

function mainHealthStep(record) {
  if (!record.postMerge) return [];
  const identity = record.postMerge.mergeCommit ?? record.postMerge.commit ?? record.merged?.commit;
  return [step(record, "main_health", "merge-main-health", "Main health", storedTimestamp(record.postMerge.endedAt, record.postMerge.startedAt), verdictState(record.postMerge.state), {
    links: identity ? [{
      relation: "merge-main-health",
      to: { kind: "commit", id: String(identity) },
      proof: "containment",
      detail: "The post-merge outcome and this main-tip identity are contained on the same dispatch record.",
    }] : [],
    evidence: evidenceFor(record, { logs: true, label: "Dispatch record post-merge outcome" }),
    unknown: [
      "a main-health failure on this record does not prove this change caused it; the tip contains everything merged before it",
    ],
  })];
}

function countsFor(items) {
  const byStage = Object.fromEntries(Object.keys(TIMELINE_STAGES).map((stage) => [stage, 0]));
  const byState = { done: 0, failed: 0, pending: 0, blocked: 0, unknown: 0 };
  for (const item of items) {
    byStage[item.stage] += 1;
    byState[item.state] += 1;
  }
  return {
    byStage,
    byState,
    dispatches: new Set(items.map((item) => item.subject.id)).size,
    total: items.length,
  };
}

export function timelineFor(input = {}, {
  now = new Date(),
  limit = TIMELINE_LIMIT,
  dispatchId,
} = {}) {
  const records = (Array.isArray(input.records) ? input.records : [])
    .filter((record) => record && typeof record.id === "string")
    .filter((record) => dispatchId === undefined || record.id === dispatchId);
  const allRecords = Array.isArray(input.records) ? input.records : [];
  const projects = Array.isArray(input.projects) ? input.projects : [];
  const queues = Array.isArray(input.queues) ? input.queues : [];
  const convoys = Array.isArray(input.convoys) ? input.convoys : [];
  const persistence = input.persistence && typeof input.persistence === "object"
    ? input.persistence
    : {};
  const recordsById = new Map(allRecords.map((record) => [record?.id, record]));
  const routineInput = { records: allRecords, projects, queues, convoys, persistence };
  const attention = attentionFor(routineInput, { now, limit: TIMELINE_LIMIT });
  const recovery = recoveryFor(routineInput, { now, limit: TIMELINE_LIMIT });
  const items = [];
  for (const record of records) {
    items.push(
      workStep(record, allRecords, queues, convoys),
      executionStep(record),
      ...verificationSteps(record),
      ...reviewSteps(record, recordsById),
      ...attentionSteps(record, attention),
      ...recoverySteps(record, recovery),
      ...mergeStep(record),
      ...mainHealthStep(record),
    );
  }
  items.sort((left, right) =>
    left.subject.id.localeCompare(right.subject.id) ||
    TIMELINE_STAGES[left.stage].order - TIMELINE_STAGES[right.stage].order ||
    left.code.localeCompare(right.code));
  const boundedLimit = normalizedLimit(limit);
  return {
    generatedAt: isoTimestamp(now),
    items: items.slice(0, boundedLimit),
    counts: countsFor(items),
    truncated: items.length > boundedLimit,
    coverage: TIMELINE_COVERAGE,
  };
}

export function dispatchTimelineFor(input = {}, options = {}) {
  const dispatchId = options.dispatchId;
  if (typeof dispatchId !== "string" || dispatchId.length === 0) {
    throw new TypeError("dispatchId must be a non-empty string");
  }
  if (!(input.records ?? []).some((record) => record?.id === dispatchId)) return null;
  return { dispatchId, ...timelineFor(input, { ...options, dispatchId }) };
}
