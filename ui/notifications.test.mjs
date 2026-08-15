import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopNotifier } from "./notifications.mjs";

function fixture(record, { fetchRecord = async () => record } = {}) {
  const calls = [];
  const warnings = [];
  class NotificationStub {
    constructor(title, options) {
      calls.push({ title, ...options });
    }
  }
  const notifier = createDesktopNotifier({
    getNotificationApi: () => NotificationStub,
    getPermission: () => "granted",
    isEnabled: () => true,
    fetchRecord,
    logger: { warn: (...values) => warnings.push(values) },
  });
  return { calls, notifier, warnings };
}

const failureEvent = {
  type: "post-merge",
  phase: "end",
  state: "failed",
  dispatchId: "dispatch-1",
  commit: "abcdef1234567890",
  evidenceTail: "not ok 1 - combined suite failed",
};

test("desktop notifier ignores a replayed post-merge failure resolved by a later pass", async () => {
  const { calls, notifier } = fixture({
    id: "dispatch-1",
    project: "atelier",
    postMerge: {
      state: "failed",
      commit: failureEvent.commit,
      resolvedAt: "2026-07-22T12:00:00.000Z",
      resolvedBy: "fedcba9876543210",
    },
  });

  await notifier.notifyPostMergeFailure(failureEvent);

  assert.deepEqual(calls, []);
});

test("desktop notifier ignores an acknowledged current post-merge failure", async () => {
  const { calls, notifier } = fixture({
    id: "dispatch-1",
    project: "atelier",
    postMerge: {
      state: "failed",
      commit: failureEvent.commit,
      acknowledgedAt: "2026-07-22T12:00:00.000Z",
    },
  });

  await notifier.notifyPostMergeFailure(failureEvent);

  assert.deepEqual(calls, []);
});

test("desktop notifier raises MAIN IS RED once for a current post-merge failure", async () => {
  const { calls, notifier } = fixture({
    id: "dispatch-1",
    project: "atelier",
    postMerge: {
      state: "failed",
      commit: failureEvent.commit,
      evidenceTail: failureEvent.evidenceTail,
    },
  });

  await notifier.notifyPostMergeFailure(failureEvent);
  await notifier.notifyPostMergeFailure(failureEvent);

  assert.deepEqual(calls, [{
    title: "Atelier: atelier MAIN IS RED",
    body: "dispatch-1 main@abcdef123456 failed post-merge verification\nnot ok 1 - combined suite failed",
  }]);
});

test("desktop notifier fails closed when current post-merge state cannot be fetched", async () => {
  const fallbackRecord = {
    id: "dispatch-1",
    project: "atelier",
    postMerge: { state: "failed", commit: failureEvent.commit },
  };
  const { calls, notifier, warnings } = fixture(fallbackRecord, {
    fetchRecord: async () => {
      throw new Error("API unavailable");
    },
  });

  await notifier.notifyPostMergeFailure(failureEvent, fallbackRecord);

  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /current dispatch state unavailable/);
});

test("desktop notifier reserves post-merge dedup before concurrent record fetches", async () => {
  let resolveRecord;
  let fetchCalls = 0;
  const recordPromise = new Promise((resolvePromise) => {
    resolveRecord = resolvePromise;
  });
  const current = {
    id: "dispatch-1",
    project: "atelier",
    postMerge: { state: "failed", commit: failureEvent.commit },
  };
  const { calls, notifier } = fixture(current, {
    fetchRecord: async () => {
      fetchCalls += 1;
      return recordPromise;
    },
  });

  const first = notifier.notifyPostMergeFailure(failureEvent);
  const replay = notifier.notifyPostMergeFailure(failureEvent);
  assert.equal(fetchCalls, 1);
  resolveRecord(current);
  await Promise.all([first, replay]);

  assert.equal(calls.length, 1);
});

test("desktop notifier raises one terminal dispatch notification", async () => {
  const { calls, notifier } = fixture({
    id: "dispatch-1",
    project: "atelier",
    verify: { state: "passed" },
  });
  const event = {
    type: "status",
    state: "completed",
    dispatchId: "dispatch-1",
  };

  await notifier.notifyTerminalDispatch(event);
  await notifier.notifyTerminalDispatch(event);

  assert.deepEqual(calls, [{
    title: "Atelier: atelier",
    body: "dispatch-1 completed · verify passed",
  }]);
});

test("desktop notifier marks persisted terminal history without touching a global set", async () => {
  const { calls, notifier } = fixture({
    id: "historical-dispatch",
    project: "atelier",
    verify: { state: "passed" },
  });
  notifier.markHistoricalDispatches([
    { id: "historical-dispatch", state: "completed" },
    { id: "still-running", state: "running" },
  ]);

  await notifier.notifyTerminalDispatch({
    type: "status",
    state: "completed",
    dispatchId: "historical-dispatch",
  });

  assert.deepEqual(calls, []);
});

test("desktop notifier carries the needs_input question so the operator can answer it", async () => {
  const record = {
    id: "dispatch-9",
    project: "atelier",
    state: "needs_input",
    verify: { state: "skipped" },
    outcome: { kind: "needs_input", question: "Want me to go with (1) or (2)?" },
  };
  const { calls, notifier } = fixture(record);

  await notifier.notifyTerminalDispatch({
    type: "status",
    state: "needs_input",
    dispatchId: "dispatch-9",
    outcome: record.outcome,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "Atelier: atelier");
  assert.match(calls[0].body, /needs_input/);
  assert.match(calls[0].body, /verify skipped/);
  assert.match(calls[0].body, /Want me to go with \(1\) or \(2\)\?/);
});

test("desktop notifier still reports needs_input when the record fetch fails", async () => {
  const { calls, notifier } = fixture(undefined, {
    fetchRecord: async () => {
      throw new Error("offline");
    },
  });

  await notifier.notifyTerminalDispatch({
    type: "status",
    state: "needs_input",
    dispatchId: "dispatch-10",
    outcome: { kind: "needs_input", question: "Which schema?" },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /Which schema\?/);
});

test("desktop notifier treats completed_empty as terminal and notifies once", async () => {
  const record = { id: "dispatch-11", project: "atelier", state: "completed_empty" };
  const { calls, notifier } = fixture(record);

  await notifier.notifyTerminalDispatch({
    type: "status",
    state: "completed_empty",
    dispatchId: "dispatch-11",
  });
  await notifier.notifyTerminalDispatch({
    type: "status",
    state: "completed_empty",
    dispatchId: "dispatch-11",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /completed_empty/);
});
