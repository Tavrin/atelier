import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptBoardGeneration,
  boardProjection,
  convoyEligibility,
  convoyPickerProjection,
  nextBoardGeneration,
  nonReadyIssueLabel,
  parkedTicketsFrom,
  replaceReadyConsumers,
  ticketCreationState,
} from "./ready-projection.mjs";

test("a new readyIssues projection replaces both the board and convoy eligibility", () => {
  const observed = { board: [], convoy: [] };
  const consumers = {
    replaceBoard(_payload, readyIssues) {
      observed.board.push(readyIssues.map(({ id }) => id));
    },
    replaceConvoyEligibility(readyIssues) {
      observed.convoy.push({
        ids: readyIssues.map(({ id }) => id),
        disabled: convoyEligibility(readyIssues, { full: true }).disabled,
      });
    },
  };

  replaceReadyConsumers({
    readyIssues: [{ id: "atelier-old-a" }, { id: "atelier-old-b" }],
  }, consumers);
  replaceReadyConsumers({
    readyIssues: [{ id: "atelier-new" }],
  }, consumers);

  assert.deepEqual(observed, {
    board: [["atelier-old-a", "atelier-old-b"], ["atelier-new"]],
    convoy: [
      { ids: ["atelier-old-a", "atelier-old-b"], disabled: false },
      { ids: ["atelier-new"], disabled: true },
    ],
  });
});

test("degraded labels distinguish tracker failure from readiness failure", () => {
  const observed = [];
  const consumers = {
    replaceBoard(payload, readyIssues) {
      const projection = boardProjection(payload);
      observed.push({
        issues: projection.issues.map(({ id }) => id),
        ready: readyIssues.map(({ id }) => id),
        degraded: projection.readyDegraded,
      });
    },
    replaceConvoyEligibility() {},
  };
  const issues = [
    { id: "atelier-open", status: "open" },
    { id: "atelier-progress", status: "in_progress" },
  ];

  replaceReadyConsumers({
    issues: [],
    readyIssues: [],
    tracker: "none",
    degraded: true,
  }, consumers);
  replaceReadyConsumers({
    issues,
    readyIssues: [],
    tracker: "committed",
    degraded: true,
  }, consumers);
  replaceReadyConsumers({
    issues,
    readyIssues: [issues[0]],
    tracker: "committed",
    degraded: false,
  }, consumers);

  assert.deepEqual(observed, [
    {
      issues: [],
      ready: [],
      degraded: {
        label: "Tracker unavailable",
        detail: "Tracker issues and readiness are unavailable.",
      },
    },
    {
      issues: ["atelier-open", "atelier-progress"],
      ready: [],
      degraded: {
        label: "Readiness unavailable",
        detail: "br ready is unavailable; tracker issues remain visible.",
      },
    },
    {
      issues: ["atelier-open", "atelier-progress"],
      ready: ["atelier-open"],
      degraded: null,
    },
  ]);
});

test("ticket creation is replaced only when the tracker authority is unavailable", () => {
  assert.deepEqual(
    ticketCreationState({
      issues: [],
      readyIssues: [],
      tracker: "none",
      degraded: true,
    }),
    {
      available: false,
      label: "Tracker unavailable",
      detail: "Ticket creation is unavailable until Atelier can detect this project's tracker.",
    },
  );
  assert.deepEqual(
    ticketCreationState({
      issues: [{ id: "atelier-open", status: "open" }],
      readyIssues: [],
      tracker: "committed",
      degraded: true,
    }),
    { available: true },
    "readiness degradation does not disable a healthy tracker mutation",
  );
  assert.deepEqual(
    ticketCreationState({
      issues: [],
      readyIssues: [],
      tracker: "committed",
      degraded: false,
    }),
    { available: true },
    "a healthy tracker retains ticket creation",
  );
});

test("a slow stale board response cannot make a newly parked ticket ready again", async () => {
  const requested = new Map();
  const applied = new Map();
  const observedReady = [];
  let resolveSlow;
  const slowPayload = new Promise((resolvePromise) => {
    resolveSlow = resolvePromise;
  });
  const consumers = {
    replaceBoard(_payload, readyIssues) {
      observedReady.push(readyIssues.map(({ id }) => id));
    },
    replaceConvoyEligibility() {},
  };
  const applyRequest = async (payloadPromise) => {
    const generation = nextBoardGeneration(requested, "atelier");
    const payload = await payloadPromise;
    if (!acceptBoardGeneration(applied, "atelier", generation)) return false;
    replaceReadyConsumers(payload, consumers);
    return true;
  };

  const stale = applyRequest(slowPayload);
  await applyRequest(Promise.resolve({
    issues: [{ id: "atelier-parked", status: "open" }],
    readyIssues: [],
  }));
  resolveSlow({
    issues: [{ id: "atelier-parked", status: "open" }],
    readyIssues: [{ id: "atelier-parked", status: "open" }],
  });

  assert.equal(await stale, false);
  assert.deepEqual(observedReady, [[]]);
});

test("non-ready tickets identify deferred and parked causes without false blocking labels", () => {
  const now = Date.parse("2026-07-31T10:00:00.000Z");
  const deferred = {
    id: "atelier-deferred",
    status: "open",
    defer_until: "2026-07-31T10:01:00.000Z",
  };
  const parked = { id: "atelier-parked", status: "open" };

  assert.equal(nonReadyIssueLabel(deferred, { now }), "Deferred");
  assert.equal(
    nonReadyIssueLabel(parked, {
      parkedTickets: [{ ticketId: parked.id, parked: true }],
      now,
    }),
    "Parked",
  );
  assert.equal(
    nonReadyIssueLabel({ id: "atelier-unknown", status: "open" }, { now }),
    "Not ready",
  );
  assert.equal(
    nonReadyIssueLabel({
      id: "atelier-blocked",
      status: "open",
      dependencies: [{ depends_on_id: "atelier-prerequisite" }],
    }, {
      issues: [{ id: "atelier-prerequisite", status: "open" }],
      now,
    }),
    "Dependency blocked",
  );
  assert.equal(
    nonReadyIssueLabel({ id: "atelier-pinned", status: "open", pinned: true }, { now }),
    "Pinned",
  );
  assert.equal(
    nonReadyIssueLabel({
      id: "atelier-template",
      status: "open",
      issue_type: "template",
    }, { now }),
    "Template",
  );
  assert.equal(
    nonReadyIssueLabel({ id: "atelier-wisp", status: "open", issue_type: "wisp" }, { now }),
    "Excluded",
  );
});

test("parking while a convoy picker is open disables its existing ticket row", () => {
  const openedTicketIds = ["atelier-first", "atelier-parked"];
  assert.deepEqual(
    convoyPickerProjection(openedTicketIds, openedTicketIds.map((id) => ({ id }))),
    [
      { ticketId: "atelier-first", ready: true },
      { ticketId: "atelier-parked", ready: true },
    ],
  );

  assert.deepEqual(
    convoyPickerProjection(openedTicketIds, [{ id: "atelier-first" }]),
    [
      { ticketId: "atelier-first", ready: true },
      { ticketId: "atelier-parked", ready: false },
    ],
    "the existing modal rows are reconciled in place instead of reopening the picker",
  );
});

test("a board refresh updates a later-parked ticket label without a route reload", () => {
  const issue = { id: "atelier-later-parked", status: "open" };
  let parkedTickets = [];
  assert.equal(nonReadyIssueLabel(issue, { parkedTickets }), "Not ready");

  parkedTickets = parkedTicketsFrom({
    parkedTickets: [{ ticketId: issue.id, parked: true }],
  }, parkedTickets);

  assert.equal(nonReadyIssueLabel(issue, { parkedTickets }), "Parked");
});
