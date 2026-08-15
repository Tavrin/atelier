export function readyIssuesFrom(payload) {
  return Array.isArray(payload?.readyIssues) ? payload.readyIssues : [];
}

function trackerUnavailable(payload) {
  const tracker = String(payload?.tracker ?? "").toLowerCase();
  return !tracker || tracker === "none" || tracker === "unknown";
}

function readyDegradedProjection(payload) {
  if (payload?.degraded !== true) return null;
  return trackerUnavailable(payload)
    ? {
        label: "Tracker unavailable",
        detail: "Tracker issues and readiness are unavailable.",
      }
    : {
        label: "Readiness unavailable",
        detail: "br ready is unavailable; tracker issues remain visible.",
      };
}

export function ticketCreationState(payload) {
  if (payload?.degraded !== true || !trackerUnavailable(payload)) return { available: true };
  return {
    available: false,
    label: "Tracker unavailable",
    detail: "Ticket creation is unavailable until Atelier can detect this project's tracker.",
  };
}

export function boardProjection(payload) {
  return {
    issues: Array.isArray(payload?.issues) ? payload.issues : [],
    readyIssues: readyIssuesFrom(payload),
    readyDegraded: readyDegradedProjection(payload),
  };
}

export function parkedTicketsFrom(payload, fallback = []) {
  return Array.isArray(payload?.parkedTickets) ? payload.parkedTickets : fallback;
}

export function nextBoardGeneration(generations, projectName) {
  const generation = (generations.get(projectName) ?? 0) + 1;
  generations.set(projectName, generation);
  return generation;
}

export function acceptBoardGeneration(appliedGenerations, projectName, generation) {
  if (generation < (appliedGenerations.get(projectName) ?? 0)) return false;
  appliedGenerations.set(projectName, generation);
  return true;
}

function parkedTicketId(ticket) {
  return typeof ticket === "string" ? ticket : ticket?.ticketId ?? ticket?.id;
}

function dependencyId(dependency) {
  if (typeof dependency === "string") return dependency;
  return dependency?.depends_on_id ?? dependency?.id ?? dependency?.issue_id;
}

export function nonReadyIssueLabel(
  issue,
  { issues = [], parkedTickets = [], now = Date.now() } = {},
) {
  const parkedIds = new Set(
    (Array.isArray(parkedTickets) ? parkedTickets : [])
      .map(parkedTicketId)
      .filter(Boolean),
  );
  if (parkedIds.has(issue?.id)) return "Parked";

  const deferredUntil = typeof issue?.defer_until === "string"
    ? Date.parse(issue.defer_until)
    : NaN;
  if (!Number.isNaN(deferredUntil) && deferredUntil > now) return "Deferred";

  if (issue?.pinned === true) return "Pinned";
  const issueType = String(issue?.issue_type ?? "").toLowerCase();
  if (issueType === "template") return "Template";
  if (issue?.ephemeral === true || issue?.excluded === true || issueType === "wisp") {
    return "Excluded";
  }

  const byId = issues instanceof Map
    ? issues
    : new Map(
      (Array.isArray(issues) ? issues : [])
        .filter((candidate) => typeof candidate?.id === "string")
        .map((candidate) => [candidate.id, candidate]),
    );
  const dependencyBlocked = (Array.isArray(issue?.dependencies) ? issue.dependencies : [])
    .some((dependency) => {
      const relation = typeof dependency === "object" && dependency
        ? String(dependency.dependency_type ?? dependency.type ?? "").toLowerCase()
        : "";
      if (relation === "related" || relation === "parent-child") return false;
      const prerequisiteId = dependencyId(dependency);
      if (!prerequisiteId) return true;
      const prerequisite = byId.get(prerequisiteId);
      return (prerequisite?.status ?? dependency?.status) !== "closed";
    });
  return dependencyBlocked ? "Dependency blocked" : "Not ready";
}

export function convoyPickerProjection(ticketIds, readyIssues) {
  const readyIds = new Set(
    (Array.isArray(readyIssues) ? readyIssues : [])
      .map((issue) => issue?.id)
      .filter(Boolean),
  );
  return ticketIds.map((ticketId) => ({
    ticketId,
    ready: readyIds.has(ticketId),
  }));
}

export function convoyEligibility(readyIssues, { full } = {}) {
  const disabled = !full || !Array.isArray(readyIssues) || readyIssues.length < 2;
  return {
    disabled,
    title: disabled
      ? "A convoy requires at least two ready tickets in a full project."
      : "Dispatch selected ready tickets sequentially after each merge.",
  };
}

/**
 * Keep every ready-work consumer on the same server snapshot.
 *
 * The board and convoy controls are deliberately updated together so an SSE
 * replacement cannot leave one of them holding the previous eligibility set.
 */
export function replaceReadyConsumers(payload, {
  replaceBoard,
  replaceConvoyEligibility,
}) {
  const readyIssues = readyIssuesFrom(payload);
  replaceBoard(payload, readyIssues);
  replaceConvoyEligibility(readyIssues);
  return readyIssues;
}
