import { button, element } from "./components.mjs";

export function unresolvedMainFailures(records, projectName) {
  return records
    .filter((record) =>
      record.project === projectName &&
      record.postMerge?.state === "failed" &&
      !record.postMerge.resolvedAt)
    .sort((left, right) =>
      String(left.postMerge.queuedAt || left.postMerge.startedAt || "")
        .localeCompare(String(right.postMerge.queuedAt || right.postMerge.startedAt || "")));
}

export function activeMainVerifications(records, projectName) {
  return records
    .filter((record) =>
      record.project === projectName &&
      ["queued", "running"].includes(record.postMerge?.state))
    .sort((left, right) =>
      String(left.postMerge.queuedAt || left.postMerge.startedAt || "")
        .localeCompare(String(right.postMerge.queuedAt || right.postMerge.startedAt || "")));
}

export function renderProjectMainHealth(container, project, records, {
  dispatchHref,
  acknowledge,
} = {}) {
  container.replaceChildren();
  const failures = unresolvedMainFailures(records, project.name);
  for (const record of failures) {
    const health = record.postMerge;
    const commit = String(health.commit || record.merged?.commit || "unknown");
    const acknowledged = Boolean(health.acknowledgedAt);
    const alert = element(
      "section",
      `error-banner main-health-failure${acknowledged ? " main-health-acknowledged" : ""}`,
    );
    alert.dataset.dispatchId = record.id;
    const summary = element(
      "span",
      "main-health-summary",
      `MAIN IS RED: post-merge verification failed at ${commit.slice(0, 12)}. `,
    );
    const link = element("a", "main-health-dispatch-link", `Open dispatch ${record.id} →`);
    link.href = dispatchHref?.(record.id) || `#/dispatch/${encodeURIComponent(record.id)}`;
    const actions = element("span", "main-health-actions");
    if (acknowledged) {
      actions.append(element("span", "main-health-ack-label", "Acknowledged"));
    } else {
      const ack = button("Acknowledge", "button small main-health-ack");
      ack.addEventListener("click", async () => {
        ack.disabled = true;
        try {
          await acknowledge?.(record);
        } catch {
          ack.disabled = false;
        }
      });
      actions.append(ack);
    }
    alert.append(summary, link, actions);
    if (health.evidenceTail) {
      alert.append(element("pre", "main-health-evidence", health.evidenceTail));
    }
    container.append(alert);
  }

  for (const record of activeMainVerifications(records, project.name)) {
    const commit = String(record.postMerge.commit || record.merged?.commit || "unknown");
    const alert = element(
      "section",
      "info-banner main-health-running",
      `Checking merged tree ${commit.slice(0, 12)} in a detached verification worktree.`,
    );
    container.append(alert);
  }
}
