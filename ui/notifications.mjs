const TERMINAL_STATES = new Set([
  "completed",
  "completed_empty",
  "needs_input",
  "failed",
  "stopped",
  "prepare_failed",
  "rejected",
]);

function currentPostMergeFailure(record, commit) {
  const health = record?.postMerge;
  return health?.state === "failed" &&
    !health.resolvedAt &&
    !health.acknowledgedAt &&
    String(health.commit || record?.merged?.commit || "unknown") === commit;
}

export function createDesktopNotifier({
  getNotificationApi,
  getPermission,
  isEnabled,
  fetchRecord,
  logger = console,
}) {
  const notifiedDispatches = new Set();
  const notifiedPostMergeFailures = new Set();

  const canNotify = () => isEnabled() && getPermission() === "granted";
  const show = (title, options) => {
    const NotificationApi = getNotificationApi();
    return new NotificationApi(title, options);
  };

  function markNotified(id) {
    if (id) notifiedDispatches.add(id);
  }

  function markHistoricalDispatches(records) {
    for (const record of records) {
      if (TERMINAL_STATES.has(record.state)) markNotified(record.id);
    }
  }

  async function notifyTerminalDispatch(event, fallbackRecord) {
    if (event.type !== "status" || !TERMINAL_STATES.has(event.state)) return;
    const id = event.dispatchId || fallbackRecord?.id;
    if (!id || notifiedDispatches.has(id) || !canNotify()) return;
    let record = fallbackRecord;
    try {
      record = await fetchRecord(id);
    } catch {
      // Terminal status events carry enough information for a minimal notification.
    }
    const verifyState = record?.verify?.state;
    const suffix = verifyState ? ` · verify ${verifyState}` : "";
    // A needs_input dispatch is the one terminal state the operator must answer,
    // so the question travels with the alert (atelier-8r6). The status event carries
    // it even when the record fetch above failed.
    const question = event.state === "needs_input"
      ? String(event.outcome?.question || record?.outcome?.question || "")
      : "";
    try {
      show(`Atelier: ${record?.project || "Unknown project"}`, {
        body: `${id} ${event.state}${suffix}${question ? `\n${question}` : ""}`,
      });
      notifiedDispatches.add(id);
    } catch {
      // Notification construction can throw in headless or restricted browsers.
    }
  }

  async function notifyPostMergeFailure(event, fallbackRecord) {
    if (event.type !== "post-merge" || event.phase !== "end" || event.state !== "failed") return;
    const id = event.dispatchId || fallbackRecord?.id;
    const commit = String(event.commit || fallbackRecord?.postMerge?.commit || "unknown");
    const identity = `${id || "unknown"}:${commit}`;
    if (!id || notifiedPostMergeFailures.has(identity) || !canNotify()) return;
    notifiedPostMergeFailures.add(identity);

    let record;
    try {
      record = await fetchRecord(id);
    } catch (error) {
      notifiedPostMergeFailures.delete(identity);
      logger.warn?.(
        `Atelier skipped MAIN IS RED notification for ${id}: current dispatch state unavailable`,
        error,
      );
      return;
    }
    if (!currentPostMergeFailure(record, commit)) {
      notifiedPostMergeFailures.delete(identity);
      return;
    }

    try {
      const evidence = String(event.evidenceTail || record.postMerge.evidenceTail || "").slice(-800);
      show(`Atelier: ${record.project || "Unknown project"} MAIN IS RED`, {
        body: `${id} main@${commit.slice(0, 12)} failed post-merge verification${evidence ? `\n${evidence}` : ""}`,
      });
    } catch {
      notifiedPostMergeFailures.delete(identity);
      // Notification construction can throw in headless or restricted browsers.
    }
  }

  return {
    markHistoricalDispatches,
    markNotified,
    notifyTerminalDispatch,
    notifyPostMergeFailure,
  };
}
