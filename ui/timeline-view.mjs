const STAGE_ORDER = Object.freeze([
  "work",
  "execution",
  "verification",
  "review",
  "attention",
  "recovery",
  "merge",
  "main_health",
]);

const STATE_RANK = Object.freeze({ failed: 5, blocked: 4, pending: 3, unknown: 2, done: 1 });

export function timelineStageOrder(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  return index < 0 ? STAGE_ORDER.length : index;
}

export function timelineStageLabel(stage) {
  return String(stage || "unknown")
    .replaceAll("_", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function timelineEvidenceHref(evidence) {
  const http = typeof evidence?.http === "string" ? evidence.http : "";
  return http.startsWith("/api/") ? http : null;
}

export function timelineGroups(payload = {}) {
  const groups = new Map();
  for (const item of Array.isArray(payload.items) ? payload.items : []) {
    if (!item?.subject?.id) continue;
    const id = String(item.subject.id);
    if (!groups.has(id)) {
      groups.set(id, {
        id,
        project: item.subject.project ?? null,
        state: "done",
        steps: [],
      });
    }
    const group = groups.get(id);
    group.steps.push(item);
    if ((STATE_RANK[item.state] ?? 0) > (STATE_RANK[group.state] ?? 0)) {
      group.state = item.state;
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      steps: group.steps.slice().sort((left, right) =>
        timelineStageOrder(left.stage) - timelineStageOrder(right.stage) ||
        String(left.code).localeCompare(String(right.code))),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

