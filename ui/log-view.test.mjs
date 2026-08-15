import assert from "node:assert/strict";
import test from "node:test";

import {
  logEventRow,
  logEventSummary,
  logQueryString,
  logResultLabel,
} from "./log-view.mjs";

test("logQueryString drops blank filters and keeps the ones set", () => {
  assert.equal(logQueryString(), "");
  assert.equal(logQueryString({ kind: "", project: "   ", limit: undefined }), "");
  assert.equal(
    logQueryString({ kind: "queue.drain,queue.park", project: "atelier", limit: 50 }),
    "?kind=queue.drain%2Cqueue.park&project=atelier&limit=50",
  );
  assert.equal(logQueryString({ since: "2026-07-30T00:00:00.000Z" }), "?since=2026-07-30T00%3A00%3A00.000Z");
});

test("logResultLabel distinguishes a complete result from a scan-truncated search", () => {
  assert.equal(logResultLabel(1, false), "1 event");
  assert.equal(logResultLabel(12, true), "12 events - search truncated; narrow your filter");
});

test("logEventSummary shows the decision payload without the identity columns", () => {
  assert.equal(
    logEventSummary({
      v: 1,
      ts: "2026-07-30T10:00:00.000Z",
      seq: 12,
      source: "server",
      kind: "queue.drain",
      project: "atelier",
      decision: "skipped",
      reason: "budget",
      spentUSD: 1.25,
      budgetUSD: 1,
    }),
    "decision=skipped reason=budget spentUSD=1.25 budgetUSD=1",
  );
  assert.equal(
    logEventSummary({ kind: "queue.settings", changes: { enabled: { from: true, to: false } } }),
    'changes={"enabled":{"from":true,"to":false}}',
  );
  assert.equal(logEventSummary({ kind: "service.stop" }), "");
  assert.equal(
    logEventSummary({ kind: "dispatch.transition", failureKind: null, to: "failed" }),
    "to=failed",
    "null payload fields are noise, not information",
  );
});

test("logEventRow shapes a table row and falls back on a missing actor", () => {
  const row = logEventRow({
    v: 1,
    ts: "2026-07-30T10:00:00.000Z",
    seq: 7,
    source: "server",
    kind: "queue.drain",
    project: "atelier",
    decision: "picked",
    ticketId: "atelier-1",
  });
  assert.equal(row.seq, 7);
  assert.equal(row.kind, "queue.drain");
  assert.equal(row.project, "atelier");
  assert.equal(row.actor, "dispatcher");
  assert.equal(row.summary, "decision=picked ticketId=atelier-1");
  assert.ok(row.time.length > 0);

  assert.equal(logEventRow({ kind: "queue.settings", actor: "ui" }).actor, "ui");
  assert.equal(
    logEventRow({ kind: "dispatch.hook", source: "dispatch" }).actor,
    "dispatch",
    "a future non-server source is shown as itself rather than as the dispatcher",
  );
  const malformed = logEventRow({});
  assert.equal(malformed.kind, "unknown");
  assert.equal(malformed.seq, null);
  assert.equal(malformed.project, "");
});
