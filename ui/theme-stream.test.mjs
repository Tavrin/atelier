import assert from "node:assert/strict";
import test from "node:test";

import { createThemeStream, safeText } from "./theme-stream.mjs";

class FakeEventSource {
  constructor(path) {
    this.path = path;
    this.closed = false;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = (this.listeners.get(type) ?? []).filter(
      (candidate) => candidate !== listener,
    );
    if (listeners.length > 0) this.listeners.set(type, listeners);
    else this.listeners.delete(type);
  }

  emit(type, data = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(data);
  }

  close() {
    this.closed = true;
  }
}

function harness(options = {}) {
  const sources = [];
  const timers = [];
  const delays = [];
  const stream = createThemeStream({
    eventSourceFactory(path) {
      const source = new FakeEventSource(path);
      sources.push(source);
      return source;
    },
    setTimeoutImpl(callback, delay) {
      delays.push(delay);
      timers.push(callback);
      return callback;
    },
    clearTimeoutImpl(callback) {
      const index = timers.indexOf(callback);
      if (index >= 0) timers.splice(index, 1);
    },
    ...options,
  });
  return {
    delays,
    sources,
    stream,
    get pendingTimers() {
      return timers.length;
    },
    runTimer() {
      assert.ok(timers.length > 0, "expected a scheduled reconnect");
      timers.shift()();
    },
  };
}

test("theme stream keeps one aggregate source and LRU-evicts beyond the dispatch pool bound", () => {
  const subject = harness({ maxDispatchStreams: 3 });
  const noop = () => {};
  const unsubscribeA = subject.stream.subscribeDispatch("a", noop);
  subject.stream.subscribeDispatch("b", noop);
  subject.stream.subscribeDispatch("c", noop);
  const unsubscribeSecondA = subject.stream.subscribeDispatch("a", () => {});
  subject.stream.subscribeDispatch("d", noop);

  assert.deepEqual(subject.sources.map(({ path }) => path), [
    "/api/dispatches/events",
    "/api/dispatch/a/events",
    "/api/dispatch/b/events",
    "/api/dispatch/c/events",
    "/api/dispatch/d/events",
  ]);
  assert.equal(subject.sources[0].closed, false, "aggregate stream is never part of the LRU pool");
  assert.equal(subject.sources[1].closed, false, "recently touched dispatch remains subscribed");
  assert.equal(subject.sources[2].closed, true, "least-recent dispatch is evicted");
  assert.equal(subject.sources[3].closed, false);
  assert.equal(subject.sources[4].closed, false);

  unsubscribeA();
  assert.equal(subject.sources[1].closed, false, "another handler still owns the reused source");
  unsubscribeSecondA();
  assert.equal(subject.sources[1].closed, true);
  subject.stream.close();
});

test("theme stream optionally follows board events and closes that source", async () => {
  const events = [];
  const subject = harness({
    onBoardEvent(event) {
      events.push(event);
    },
  });

  assert.deepEqual(subject.sources.map(({ path }) => path), [
    "/api/dispatches/events",
    "/api/board/events",
  ]);
  subject.sources[1].emit("open");
  subject.sources[1].emit("board", {
    data: JSON.stringify({ type: "board", project: "atelier" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "board", project: "atelier" }]);

  subject.stream.close();
  assert.equal(subject.sources[0].closed, true);
  assert.equal(subject.sources[1].closed, true);
});

test("theme stream close attempts every source and reports all failures", () => {
  const sources = [];
  const stream = createThemeStream({
    onBoardEvent() {},
    eventSourceFactory(path) {
      const source = new FakeEventSource(path);
      source.close = () => {
        source.closed = true;
        throw new Error(`close failed: ${path}`);
      };
      sources.push(source);
      return source;
    },
  });

  let error;
  assert.throws(() => stream.close(), (caught) => {
    error = caught;
    return true;
  });

  assert.equal(error.name, "ThemeStreamCleanupError");
  assert.equal(error.failures.length, 2);
  assert.ok(sources.every(({ closed }) => closed), "all source closes were attempted");
});

test("theme stream construction closes earlier sources when a later EventSource throws", () => {
  const sources = [];
  assert.throws(
    () => createThemeStream({
      onBoardEvent() {},
      eventSourceFactory(path) {
        if (path === "/api/board/events") throw new Error("board constructor failed");
        const source = new FakeEventSource(path);
        sources.push(source);
        return source;
      },
    }),
    /board constructor failed/,
  );
  assert.equal(sources.length, 1);
  assert.equal(sources[0].path, "/api/dispatches/events");
  assert.equal(sources[0].closed, true, "the aggregate source is rolled back");
});

test("theme stream resyncs on initial open to close the snapshot-to-subscribe gap", async () => {
  let serverBoard = "snapshot";
  let observedBoard = serverBoard;
  const subject = harness({
    onBoardEvent() {},
    resync(scope) {
      if (scope.kind === "board") observedBoard = serverBoard;
    },
  });

  serverBoard = "changed-before-subscribe-open";
  subject.sources[1].emit("open");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(observedBoard, "changed-before-subscribe-open");
  subject.stream.close();
});

test("theme stream resyncs before delivering events from a reconnected source", async () => {
  const order = [];
  let finishResync;
  let resyncCount = 0;
  const subject = harness({
    onAggregateEvent(event) {
      order.push(`event:${event.seq}`);
    },
    resync() {
      resyncCount += 1;
      if (resyncCount === 1) return undefined;
      order.push("resync:start");
      return new Promise((resolve) => {
        finishResync = () => {
          order.push("resync:end");
          resolve();
        };
      });
    },
  });
  const initial = subject.sources[0];
  initial.emit("open");
  await new Promise((resolve) => setImmediate(resolve));
  initial.emit("status", { data: '{"seq":1}' });
  initial.emit("error", new Error("offline"));
  subject.runTimer();

  const reconnected = subject.sources[1];
  reconnected.emit("open");
  reconnected.emit("status", { data: '{"seq":2}' });
  await Promise.resolve();
  assert.deepEqual(order, ["event:1", "resync:start"]);

  finishResync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["event:1", "resync:start", "resync:end", "event:2"]);
  subject.stream.close();
});

test("theme stream reconnect backoff is exponentially bounded", () => {
  const subject = harness({ backoffBaseMs: 10, backoffMaxMs: 25 });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    subject.sources.at(-1).emit("error", new Error("still offline"));
    subject.runTimer();
  }

  assert.deepEqual(subject.delays, [10, 20, 25, 25]);
  subject.stream.close();
});

test("closing a degraded theme stream cancels reconnect work and every EventSource", () => {
  const subject = harness({ onBoardEvent() {} });
  subject.sources[0].emit("error", new Error("offline"));
  subject.sources[1].emit("error", new Error("board offline"));
  assert.equal(subject.pendingTimers, 2);

  subject.stream.close();

  assert.equal(subject.pendingTimers, 0);
  assert.ok(subject.sources.every(({ closed }) => closed), "aggregate and board sources are closed");
});

test("failed resync retries with bounded backoff and preserves buffered events", async () => {
  const delivered = [];
  const degraded = [];
  let attempts = 0;
  const subject = harness({
    backoffBaseMs: 10,
    backoffMaxMs: 25,
    onAggregateEvent(event) {
      delivered.push(event.seq);
    },
    onError(error, scope) {
      degraded.push([error.message, scope.kind]);
    },
    async resync() {
      attempts += 1;
      if (attempts === 1) throw new Error("snapshot unavailable");
    },
  });

  subject.sources[0].emit("open");
  subject.sources[0].emit("status", { data: '{"seq":1}' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subject.sources[0].closed, true);
  assert.deepEqual(subject.delays, [10]);
  assert.deepEqual(delivered, []);
  assert.deepEqual(degraded, [["snapshot unavailable", "aggregate"]]);

  subject.runTimer();
  subject.sources[1].emit("open");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 2);
  assert.deepEqual(delivered, [1]);
  subject.stream.close();
});

test("safeText creates inert text for contract strings", () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createTextNode(value) {
      return { nodeType: 3, textContent: value };
    },
  };
  try {
    const node = safeText('<img src=x onerror="boom">');
    assert.deepEqual(node, {
      nodeType: 3,
      textContent: '<img src=x onerror="boom">',
    });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
});
