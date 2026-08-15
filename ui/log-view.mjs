// Pure helpers for the event-log view (atelier-e5x). Kept out of app.js so the
// query building and row shaping are unit-testable without a DOM, the same split
// agent-selection.mjs and reply-availability.mjs use.

// Fields that are either the event's identity (rendered in their own column) or
// schema plumbing. Everything else is the decision's payload and belongs in the
// summary, so a new event kind needs no change here to be readable.
const IDENTITY_FIELDS = new Set(["v", "ts", "seq", "source", "kind", "project", "actor"]);

/**
 * Build the /api/logs query string for a filter form.
 *
 * @param {object} [filters] raw filter values, blanks ignored
 * @returns {string} query string including "?", or "" when unfiltered
 */
export function logQueryString(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    params.set(key, text);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function logResultLabel(count, truncated = false) {
  const total = Number.isInteger(count) && count >= 0 ? count : 0;
  const label = `${total} event${total === 1 ? "" : "s"}`;
  return truncated ? `${label} - search truncated; narrow your filter` : label;
}

/**
 * The payload of an event, minus its identity fields, as a compact one-line
 * summary an operator can scan.
 *
 * @param {object} [event] stored event
 * @returns {string} summary text, "" when the event carries no payload
 */
export function logEventSummary(event = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(event)) {
    if (IDENTITY_FIELDS.has(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      parts.push(`${key}=${JSON.stringify(value)}`);
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

/**
 * One table row's worth of an event.
 *
 * @param {object} [event] stored event
 * @returns {{seq: number|null, time: string, kind: string, project: string, actor: string, summary: string}} row
 */
export function logEventRow(event = {}) {
  const at = new Date(event.ts ?? "");
  return {
    seq: Number.isInteger(event.seq) ? event.seq : null,
    time: Number.isFinite(at.getTime()) ? at.toLocaleTimeString() : String(event.ts ?? ""),
    kind: String(event.kind ?? "unknown"),
    project: String(event.project ?? ""),
    // The dispatcher is the actor for anything it decided on its own; only
    // operator- or agent-driven events carry one explicitly.
    actor: String(event.actor ?? (event.source === "server" ? "dispatcher" : event.source ?? "")),
    summary: logEventSummary(event),
  };
}
