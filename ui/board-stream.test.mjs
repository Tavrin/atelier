import assert from "node:assert/strict";
import test from "node:test";

import { createBoardStreamGate } from "./board-stream.mjs";

test("board stream initial open resyncs the bootstrap-to-subscribe gap", async () => {
  let serverState = ["bootstrap"];
  let visibleState = [...serverState];
  const gate = createBoardStreamGate({
    resync: async () => {
      visibleState = [...serverState];
    },
    apply(event) {
      visibleState = [...event.state];
    },
  });

  serverState = ["changed-before-subscribe"];
  assert.equal(await gate.open(), true);
  assert.deepEqual(visibleState, ["changed-before-subscribe"]);
  gate.close();
});

test("board reconnect refetches missed state before applying later events", async () => {
  let serverState = ["initial"];
  let visibleState = [...serverState];
  let finishResync;
  const appliedEvents = [];
  const gate = createBoardStreamGate({
    resync: () => new Promise((resolve) => {
      finishResync = () => {
        visibleState = [...serverState];
        resolve();
      };
    }),
    apply(event) {
      appliedEvents.push(event.id);
      visibleState = [...event.state];
    },
  });

  const initialOpen = gate.open();
  finishResync();
  assert.equal(await initialOpen, true);
  serverState = ["changed-while-disconnected"];
  gate.error();
  const reconnect = gate.open();
  gate.event({ id: "after-reconnect", state: ["event-after-resync"] });

  assert.deepEqual(visibleState, ["initial"]);
  assert.deepEqual(appliedEvents, []);
  finishResync();
  assert.deepEqual(
    visibleState,
    ["changed-while-disconnected"],
    "the reconnect refetch restores the missed board change",
  );
  assert.equal(await reconnect, true);
  assert.deepEqual(appliedEvents, ["after-reconnect"]);
  assert.deepEqual(visibleState, ["event-after-resync"]);
  gate.close();
});

test("failed board resync retries while connected and preserves queued events", async () => {
  const callbacks = new Map();
  const delays = new Map();
  let timerId = 0;
  const timers = {
    setTimeout(callback, delay) {
      timerId += 1;
      callbacks.set(timerId, callback);
      delays.set(timerId, delay);
      return timerId;
    },
    clearTimeout(id) {
      callbacks.delete(id);
      delays.delete(id);
    },
  };
  let attempts = 0;
  const visible = { snapshot: null, events: [] };
  const gate = createBoardStreamGate({
    timers,
    retryBaseMs: 20,
    retryMaxMs: 40,
    async resync() {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary snapshot failure");
      visible.snapshot = "current";
    },
    apply(event) {
      visible.events.push(event.id);
    },
  });

  await assert.rejects(gate.open(), /temporary snapshot failure/);
  gate.event({ id: "queued-during-retry" });
  assert.deepEqual(visible, { snapshot: null, events: [] });
  assert.equal(callbacks.size, 1);
  const retryId = [...callbacks.keys()][0];
  assert.equal(delays.get(retryId), 20);
  await callbacks.get(retryId)();

  assert.equal(attempts, 2);
  assert.deepEqual(visible, {
    snapshot: "current",
    events: ["queued-during-retry"],
  });
  gate.close();
});

test("one degraded project neither blocks healthy events nor grows its pending queue", async () => {
  const callbacks = new Map();
  let timerId = 0;
  const timers = {
    setTimeout(callback) {
      timerId += 1;
      callbacks.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
  };
  const attempts = new Map();
  const applied = [];
  let broken = true;
  const gate = createBoardStreamGate({
    keys: () => ["broken", "healthy"],
    keyFor: (event) => event.project,
    timers,
    retryBaseMs: 20,
    retryMaxMs: 40,
    async resync(project) {
      attempts.set(project, (attempts.get(project) ?? 0) + 1);
      if (project === "broken" && broken) throw new Error("broken state endpoint");
    },
    apply(event) {
      applied.push(event.id);
    },
  });

  assert.equal(await gate.open(), false, "the aggregate open reports a degraded lane");
  gate.event({ id: "healthy-flows", project: "healthy" });
  gate.event({ id: "broken-old", project: "broken" });
  gate.event({ id: "broken-latest", project: "broken" });

  assert.deepEqual(applied, ["healthy-flows"]);
  assert.equal(callbacks.size, 1, "only the failing project owns a retry");

  broken = false;
  const retryId = [...callbacks.keys()][0];
  await callbacks.get(retryId)();

  assert.deepEqual(applied, ["healthy-flows", "broken-latest"]);
  assert.deepEqual(Object.fromEntries(attempts), { broken: 2, healthy: 1 });
  gate.close();
});
