const severityRank = Object.freeze({ high: 3, medium: 2, low: 1 });

function freezeTable(table) {
  return Object.freeze(Object.fromEntries(
    Object.entries(table).map(([key, value]) => [key, Object.freeze(value)]),
  ));
}

export const RECOVERY_CONDITIONS = freezeTable({
  merge_recovery_pending: {
    severity: "high",
    label: "Merge recovery pending",
    durable: true,
    restartSurvival: "reconciles",
  },
  orphan_unresolved: {
    severity: "high",
    label: "Worker death unresolved",
    durable: true,
    restartSurvival: "reconciles",
  },
  merge_audit_debt: {
    severity: "medium",
    label: "Merge audit event pending",
    durable: true,
    restartSurvival: "reconciles",
  },
  advisory_debt: {
    severity: "medium",
    label: "Review advisory filing pending",
    durable: true,
    restartSurvival: "reconciles",
  },
  persistence_degraded: {
    severity: "high",
    label: "Persistence degraded",
    durable: false,
    restartSurvival: "in-memory",
  },
  convoy_state_unpersisted: {
    severity: "high",
    label: "Convoy state may be unpersisted",
    durable: false,
    restartSurvival: "in-memory",
  },
  project_removed_record: {
    severity: "high",
    label: "Dispatch project removed",
    durable: true,
    restartSurvival: "manual",
  },
  stale_terminal_record: {
    severity: "low",
    label: "Stale terminal dispatch",
    durable: true,
    restartSurvival: "manual",
  },
  orphan_worktree: {
    severity: "high",
    label: "Orphan worktree",
    durable: true,
    restartSurvival: "manual",
  },
  stale_codex_job: {
    severity: "medium",
    label: "Stale Codex job artifact",
    durable: true,
    restartSurvival: "manual",
  },
  terminal_break_glass: {
    severity: "low",
    label: "Terminal break-glass authorization",
    durable: true,
    restartSurvival: "manual",
  },
  unproven_process: {
    severity: "high",
    label: "Unproven Codex process",
    durable: false,
    restartSurvival: "unknown",
  },
  retained_candidate: {
    severity: "medium",
    label: "GC candidate retained",
    durable: false,
    restartSurvival: "unknown",
  },
  scan_error: {
    severity: "high",
    label: "Recovery scan error",
    durable: false,
    restartSurvival: "unknown",
  },
});

export const RECOVERY_ACTIONS = freezeTable({
  merge: {
    label: "Merge",
    http: "POST /api/dispatch/:id/merge",
    mcp: "atelier_merge",
    cli: "atelier merge",
    humanOnly: false,
    idempotent: "effect",
  },
  dismiss: {
    label: "Dismiss",
    http: "POST /api/dispatch/:id/dismiss",
    mcp: "atelier_dismiss",
    cli: null,
    humanOnly: false,
    idempotent: "effect",
  },
  reply: {
    label: "Reply and resume",
    http: "POST /api/dispatch/:id/reply",
    mcp: "atelier_reply",
    cli: "atelier reply",
    humanOnly: false,
    idempotent: "no",
  },
  verify_rerun: {
    label: "Rerun verification",
    http: "POST /api/dispatch/:id/verify",
    mcp: "atelier_verify_rerun",
    cli: null,
    humanOnly: false,
    idempotent: "state-refused",
  },
  queue_resume: {
    label: "Resume queue ticket",
    http: "POST /api/projects/:project/queue",
    mcp: "atelier_queue_resume",
    cli: null,
    humanOnly: false,
    idempotent: "state-refused",
  },
  convoy_resume: {
    label: "Resume convoy",
    http: "POST /api/convoys/:id/resume",
    mcp: "atelier_convoy_resume",
    cli: null,
    humanOnly: false,
    idempotent: "state-refused",
  },
  doctor_gc: {
    label: "Run doctor GC",
    http: "POST /api/doctor/gc",
    mcp: "atelier_doctor_gc",
    cli: "atelier doctor --gc",
    humanOnly: false,
    idempotent: "effect",
  },
});

export const RECOVERY_LIMIT = 200;

export const RECOVERY_LIMITS = Object.freeze([
  Object.freeze({
    topic: "pending_break_glass",
    limit: "Pending break-glass authorizations are not enumerable at this HEAD.",
  }),
  Object.freeze({
    topic: "tracker_claim",
    limit: "A current tracker claim cannot be confirmed without a br read, which this projection does not perform.",
  }),
  Object.freeze({
    topic: "merged_artifact_cleanup",
    limit: "Merged-artifact cleanup residue is observable only through the on-demand deep tier.",
  }),
  Object.freeze({
    topic: "tracker_move",
    limit: "Tracker-move failure has no durable move-intent state to project.",
  }),
  Object.freeze({
    topic: "persistence_degradation",
    limit: "Persistence degradation is in memory; its absence after restart does not prove the underlying write failure was repaired.",
  }),
  Object.freeze({
    topic: "merge_follow_up_ticket_close",
    limit: "Merge follow-up ticket-close debt is not projectable because mergeFollowUpDebt is stripped by exposedRecord(); boot and a repeat merge drain it automatically.",
  }),
  Object.freeze({
    topic: "deep_scan_freshness",
    limit: "The deep tier is a point-in-time scan and goes stale as soon as an action runs.",
  }),
]);

const DEEP_SCAN = Object.freeze({
  available: true,
  via: Object.freeze({
    http: "POST /api/doctor/gc",
    body: Object.freeze({ dryRun: true }),
    mcp: "atelier_doctor_gc",
  }),
  cost: "on-demand only: awaits boot recovery, runs `git worktree list`, sweeps /proc",
});

function isoTimestamp(value) {
  return new Date(value).toISOString();
}

function normalizedLimit(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  return value;
}

function recordSubject(record) {
  return {
    kind: "dispatch",
    id: String(record.id),
    ...(record.project ? { project: record.project } : {}),
  };
}

function reviewRounds(record) {
  const review = record?.review;
  if (Array.isArray(review)) return review;
  if (!review || typeof review !== "object") return [];
  if (Array.isArray(review.rounds) && review.rounds.length > 0) return review.rounds;
  if (review.current && typeof review.current === "object") return [review.current];
  const { rounds: _rounds, current: _current, ...flat } = review;
  return Object.keys(flat).length > 0 ? [flat] : [];
}

function condition(code, subject, detail, evidence, { actions = [], reportOnly = null,
  confirmed = true } = {}) {
  const vocabulary = RECOVERY_CONDITIONS[code];
  return {
    code,
    severity: vocabulary.severity,
    subject,
    detail,
    evidence,
    durable: vocabulary.durable,
    confirmed,
    restartSurvival: vocabulary.restartSurvival,
    actions: reportOnly ? [] : [...actions],
    reportOnly,
  };
}

function persistenceDetail(target) {
  return `Writes to ${target} are degraded. Merge and unattended queue drain are blocked, but other dispatcher operations remain available. Because this signal is in memory, its absence after a restart is not proof that the underlying write failure was repaired.`;
}

function countsFor(conditions) {
  const bySeverity = {};
  const byCode = {};
  for (const item of conditions) {
    bySeverity[item.severity] = (bySeverity[item.severity] ?? 0) + 1;
    byCode[item.code] = (byCode[item.code] ?? 0) + 1;
  }
  return { bySeverity, byCode, total: conditions.length };
}

function sortedAndBounded(conditions, limit) {
  const sorted = conditions.slice().sort((left, right) =>
    (severityRank[right.severity] ?? 0) - (severityRank[left.severity] ?? 0) ||
    String(left.subject.id).localeCompare(String(right.subject.id)) ||
    left.code.localeCompare(right.code));
  return {
    conditions: sorted.slice(0, limit),
    truncated: sorted.length > limit,
    counts: countsFor(sorted),
  };
}

function projectionFor(conditions, generatedAt, limit, extra = {}) {
  const bounded = sortedAndBounded(conditions, limit);
  return {
    generatedAt,
    conditions: bounded.conditions,
    counts: bounded.counts,
    truncated: bounded.truncated,
    deepScan: DEEP_SCAN,
    limits: RECOVERY_LIMITS,
    ...extra,
  };
}

function convoyPersistenceTarget(target) {
  return /(^|[\\/])convoys\.json(?:$|\s|\()/.test(String(target));
}

export function recoveryFor({ records = [], projects: _projects = [], convoys = [],
  persistence = {} } = {}, { now = new Date(), limit = RECOVERY_LIMIT } = {}) {
  const conditions = [];
  for (const record of records) {
    const subject = recordSubject(record);
    if (record.mergeRecoveryPending === true) {
      conditions.push(condition(
        "merge_recovery_pending",
        subject,
        "A durable merge intent has not yet reconciled to a completed merge.",
        { mergeRecoveryPending: true },
        { actions: ["merge", "dismiss"] },
      ));
    }
    if (record.orphanUnresolved === true) {
      conditions.push(condition(
        "orphan_unresolved",
        subject,
        "Atelier could not prove the dispatch worker exited, so operator resolution is required.",
        { orphanUnresolved: true },
        { actions: ["dismiss"] },
      ));
    }
    if (record.mergeEventDebt?.event) {
      conditions.push(condition(
        "merge_audit_debt",
        subject,
        "The merge completed with a durable audit event still waiting to be written.",
        { event: record.mergeEventDebt.event },
        { actions: ["merge"] },
      ));
    }
    if (record.merged) {
      for (const round of reviewRounds(record)) {
        for (const followUp of Array.isArray(round.advisoryFollowUps)
          ? round.advisoryFollowUps
          : []) {
          if (followUp?.filedAt) continue;
          conditions.push(condition(
            "advisory_debt",
            subject,
            "A merged review advisory has not finished filing in the tracker.",
            {
              reviewRound: round.round ?? null,
              findingRef: followUp?.findingRef ?? null,
              followUpTicketId: followUp?.ticketId ?? null,
              attempts: Number.isInteger(followUp?.attempts) ? followUp.attempts : 0,
            },
            { reportOnly: "No direct resolver exists; boot recovery and a repeat merge retry it." },
          ));
        }
      }
    }
    if (record.projectRemoved === true && !record.merged && !record.dismissed) {
      conditions.push(condition(
        "project_removed_record",
        subject,
        "This unresolved dispatch refers to a project that is no longer registered; dismiss it or re-register the project.",
        { projectRemoved: true },
        { actions: ["dismiss"] },
      ));
    }
  }

  const persistenceTargets = persistence.degraded === true && Array.isArray(persistence.targets)
    ? persistence.targets
    : [];
  for (const target of persistenceTargets) {
    conditions.push(condition(
      "persistence_degraded",
      { kind: "persistence", id: String(target) },
      persistenceDetail(target),
      { target },
      { reportOnly: "No clear existing command repairs this write failure." },
    ));
  }
  if (persistenceTargets.some(convoyPersistenceTarget)) {
    for (const convoy of convoys) {
      conditions.push(condition(
        "convoy_state_unpersisted",
        {
          kind: "convoy",
          id: String(convoy.id),
          ...(convoy.project ? { project: convoy.project } : {}),
        },
        "The current convoy snapshot may exist only in memory because its shared persistence target rejected a write.",
        { target: persistenceTargets.find(convoyPersistenceTarget) },
        { reportOnly: "No clear existing command repairs convoy persistence." },
      ));
    }
  }

  return projectionFor(
    conditions,
    isoTimestamp(now),
    normalizedLimit(limit),
  );
}

function itemId(item, fallback) {
  if (item && typeof item === "object") {
    return String(item.id ?? item.dispatchId ?? item.jobId ?? item.tokenId ?? item.pid ??
      item.path ?? fallback);
  }
  return String(item ?? fallback);
}

function itemProject(item) {
  return item && typeof item === "object" && item.project
    ? { project: item.project }
    : {};
}

function gcMeasurement(gcResult, now) {
  return gcResult.generatedAt ?? gcResult.measuredAt ?? gcResult.at ?? gcResult.now ?? now;
}

export function deepRecoveryFor(gcResult, { now = new Date(), limit = RECOVERY_LIMIT } = {}) {
  if (!gcResult || gcResult.dryRun !== true) {
    throw new TypeError("deep recovery classification requires a dry-run GC result");
  }
  const conditions = [];
  for (const item of gcResult.dismissed ?? []) {
    conditions.push(condition(
      "stale_terminal_record",
      { kind: "dispatch", id: itemId(item, "unknown"), ...itemProject(item) },
      "Doctor GC found a terminal dispatch beyond the retention horizon.",
      { candidate: item },
      { actions: ["doctor_gc"] },
    ));
  }
  for (const item of gcResult.orphans ?? []) {
    conditions.push(condition(
      "orphan_worktree",
      { kind: "worktree", id: itemId(item, "unknown"), ...itemProject(item) },
      "Doctor GC found an Atelier worktree with no protected live owner.",
      { candidate: item },
      { actions: ["doctor_gc"] },
    ));
  }
  for (const item of gcResult.codexJobs ?? []) {
    conditions.push(condition(
      "stale_codex_job",
      { kind: "codex-job", id: itemId(item, "unknown") },
      "Doctor GC found a terminal Codex job artifact beyond the retention horizon.",
      { candidate: item },
      { actions: ["doctor_gc"] },
    ));
  }
  for (const item of gcResult.breakGlassAuthorizations ?? []) {
    conditions.push(condition(
      "terminal_break_glass",
      { kind: "break-glass", id: itemId(item, "unknown") },
      "Doctor GC found a terminal break-glass authorization beyond the retention horizon.",
      { candidate: item },
      { actions: ["doctor_gc"] },
    ));
  }
  for (const item of gcResult.codexProcesses?.reported ?? []) {
    conditions.push(condition(
      "unproven_process",
      { kind: "process", id: itemId(item, "unknown"), ...itemProject(item) },
      "A Codex-shaped process was reported, but Atelier could not corroborate ownership and may not signal it.",
      { process: item },
      { reportOnly: "Process ownership is not corroborated; no Atelier command may signal it." },
    ));
  }
  for (const item of gcResult.advisoryDebts ?? []) {
    conditions.push(condition(
      "advisory_debt",
      {
        kind: "dispatch",
        id: itemId(item, "unknown"),
        ...itemProject(item),
      },
      "A merged review advisory has not finished filing in the tracker.",
      { debt: item },
      { reportOnly: "No direct resolver exists; boot recovery and a repeat merge retry it." },
    ));
  }
  for (const target of gcResult.persistenceFailureTargets ?? []) {
    conditions.push(condition(
      "persistence_degraded",
      { kind: "persistence", id: String(target) },
      persistenceDetail(target),
      { target },
      { reportOnly: "No clear existing command repairs this write failure." },
    ));
  }
  for (const [index, warning] of (gcResult.warnings ?? []).entries()) {
    conditions.push(condition(
      "retained_candidate",
      { kind: "gc-warning", id: itemId(warning, `warning-${index + 1}`) },
      "Doctor GC deliberately retained a candidate because its identity or filesystem safety checks did not pass.",
      { warning },
      { reportOnly: "The candidate failed GC safety checks; force deletion is not offered." },
    ));
  }
  for (const [index, error] of (gcResult.errors ?? []).entries()) {
    conditions.push(condition(
      "scan_error",
      { kind: "gc-scan", id: itemId(error, `error-${index + 1}`) },
      "Part of the recovery inventory could not be scanned.",
      { error },
      { reportOnly: "The scan did not establish a safe recovery action." },
    ));
  }

  return projectionFor(
    conditions,
    isoTimestamp(gcMeasurement(gcResult, now)),
    normalizedLimit(limit),
    { dryRun: true },
  );
}
