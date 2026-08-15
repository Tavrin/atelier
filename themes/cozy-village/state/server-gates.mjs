/**
 * THE SERVER'S GATE PROJECTION — A FIXTURE-SIDE PORT.
 *
 * This mirrors the non-review projection half of
 * `server/lib/world-contract.mjs`. It exists for exactly ONE reason:
 *
 *   The fixture source has to play the server's role. The real server
 *   refreshes `gates` on every event it emits (`dispatch.mjs`), so a record
 *   that changes always arrives with a gate array that matches it. A fixture
 *   that mutated a record WITHOUT refreshing gates produced a village that
 *   contradicted itself — the parcel moved stations while the strip still
 *   read "verify pending", because `gatesOf` prefers `record.gates` and
 *   the stale array won.
 *
 * WHAT THIS IS NOT: it is not a second opinion about gates. Live records are
 * always projected by the real server; this copy is only ever applied to
 * fixture records, where there is no server to ask. `test/gates.test.mjs`
 * asserts it stays behaviourally identical to the real thing across the whole
 * fixture corpus. Review assessment itself is imported from the same shared
 * module as core, so that high-risk policy cannot rot into a divergent port.
 *
 * The theme's own `state/gates.mjs` port is a THIRD thing again: the
 * last-resort fallback for a server that sent no gates at all. Measured
 * against this projection on live data it agreed on only 67.5% of gate slots,
 * which is why it is never preferred.
 */

import {
  assessReview,
  reviewRoundsFor,
} from "../../../shared/review-assessment.mjs";

export { reviewRoundsFor };

const CHANGES_PENDING_STATES = new Set([
  "queued",
  "preparing",
  "resuming",
  "running",
  "plan_ready",
  "stopping",
]);

const PENDING_STATES = new Set(["queued", "preparing", "running", "pending", "resuming"]);
const PASSED_STATES = new Set(["pass", "passed"]);
const FAILED_STATES = new Set(["error", "fail", "failed", "malformed"]);
const SKIPPED_STATES = new Set(["skip", "skipped"]);

export const CHRONICLE_LIMIT = 500;

function gate(gateName, state, detail = undefined) {
  return { gate: gateName, state, ...(detail ?? {}) };
}

function mappedVerdict(value) {
  if (typeof value !== "string") return "unknown";
  if (value === "passed-with-dispositions") return value;
  if (PASSED_STATES.has(value)) return "passed";
  if (FAILED_STATES.has(value)) return "failed";
  if (SKIPPED_STATES.has(value)) return "skipped";
  if (PENDING_STATES.has(value)) return "pending";
  return "unknown";
}

function verifyVerdict(record) {
  const verify = record?.verify;
  if (!verify || typeof verify !== "object") return undefined;
  if (typeof verify.state === "string") return verify.state;
  if (!Array.isArray(verify.attempts) || verify.attempts.length === 0) return null;
  return verify.attempts.at(-1)?.state ?? null;
}

function changesGate(record) {
  const changes = record?.outcome?.changes;
  if (changes === "changed") return "passed";
  if (changes === "empty") return "empty";
  if (changes === "unknown") return "unknown";
  if (changes !== undefined && changes !== null) return "unknown";
  if (record?.state === "completed_empty") return "empty";
  if (record?.readOnly === true || record?.reviewOf) return "skipped";
  if (record?.merged) return "passed";
  const verify = verifyVerdict(record);
  if (verify && verify !== "skipped") return "passed";
  if (CHANGES_PENDING_STATES.has(record?.state)) return "pending";
  if (record?.outcome && typeof record.outcome === "object") return "unknown";
  if (["completed", "completed_empty", "needs_input", "failed"].includes(record?.state)) {
    return "unknown";
  }
  return "not-run";
}

function verifyGate(record) {
  const verdict = verifyVerdict(record);
  if (verdict !== undefined) return verdict === null ? "unknown" : mappedVerdict(verdict);
  if (record?.verifyRequested === false || record?.readOnly === true || record?.reviewOf) {
    return "skipped";
  }
  if (record?.merged) return "skipped";
  return "not-run";
}

function reviewGate(record) {
  return assessReview(record, { requireReview: true }).gateState;
}

function mergeGate(record) {
  if (record?.merged) return "passed";
  if (record?.dismissed) return "skipped";
  if (record?.state === "completed" && !record?.reviewOf && record?.readOnly !== true) {
    return "pending";
  }
  return "not-run";
}

function mainGate(record) {
  if (!record?.merged) return "not-run";
  if (!record?.postMerge) return "not-run";
  const verdict = mappedVerdict(record.postMerge.state);
  if (
    verdict === "passed" &&
    (
      !Array.isArray(record.postMerge.steps) ||
      !record.postMerge.steps.some((step) => Number(step?.exitCode) === 0)
    )
  ) {
    return "not-run";
  }
  return verdict;
}

// The one five-gate projection used by every public record. Each gate reports
// its own observed verdict; a forced merge can therefore show failed verify or
// review gates alongside a passed merge gate without rewriting history.
export function gatesFor(record) {
  const mergeAudit = record?.merged &&
    typeof record.merged.forcedBy === "string" &&
    typeof record.merged.reason === "string" &&
    typeof record.merged.dispositionRef === "string"
    ? {
        forcedBy: record.merged.forcedBy,
        reason: record.merged.reason,
        dispositionRef: record.merged.dispositionRef,
      }
    : undefined;
  return [
    gate("changes", changesGate(record)),
    gate("verify", verifyGate(record)),
    gate("review", reviewGate(record)),
    gate("merge", mergeGate(record), mergeAudit),
    gate("main", mainGate(record)),
  ];
}
