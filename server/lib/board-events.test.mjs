import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createBoardEvents } from "./board-events.mjs";

function timerStub() {
  const timeouts = new Map();
  const timeoutDelays = new Map();
  const intervals = new Map();
  let id = 0;
  return {
    timeouts,
    timeoutDelays,
    intervals,
    setTimeout(callback, delay) {
      id += 1;
      timeouts.set(id, callback);
      timeoutDelays.set(id, delay);
      return id;
    },
    clearTimeout(timer) {
      timeouts.delete(timer);
      timeoutDelays.delete(timer);
    },
    setInterval(callback) {
      id += 1;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(timer) {
      intervals.delete(timer);
    },
    runTimeout(timer) {
      const callback = timeouts.get(timer);
      timeouts.delete(timer);
      timeoutDelays.delete(timer);
      callback();
    },
  };
}

function registry() {
  return {
    projects: [{
      name: "tracked",
      path: "/fixture/tracked",
      archetype: "full",
      tracker: "committed",
    }],
  };
}

test("board watcher debounces repeated file notifications into one event", () => {
  const timers = timerStub();
  const watchers = [];
  const boardEvents = createBoardEvents({
    registry: registry(),
    timers,
    loadProjectIssues: async () => [],
    watchFile(path, listener) {
      const watcher = new EventEmitter();
      watcher.path = path;
      watcher.listener = listener;
      watcher.close = () => {};
      watchers.push(watcher);
      return watcher;
    },
  });
  const events = [];
  boardEvents.onEvent((event) => events.push(event));

  watchers[0].listener("change");
  watchers[0].listener("change");
  assert.equal(timers.timeouts.size, 1);
  [...timers.timeouts.values()][0]();

  assert.deepEqual(events, [{ type: "board", project: "tracked" }]);
  assert.match(watchers[0].path, /tracked[/\\]\.beads$/);
  boardEvents.close();
});

test("board events can explicitly invalidate a project after queue parking changes", () => {
  const timers = timerStub();
  const boardEvents = createBoardEvents({
    registry: registry(),
    timers,
    loadProjectIssues: async () => [],
    watchFile() {
      const watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    },
  });
  const events = [];
  boardEvents.onEvent((event) => events.push(event));

  boardEvents.notify("tracked");
  boardEvents.notify("missing");

  assert.deepEqual(events, [{ type: "board", project: "tracked" }]);
  boardEvents.close();
});

test("board events fire at the earliest future defer boundary without a tracker write", async () => {
  const timers = timerStub();
  let currentTime = Date.parse("2026-07-31T10:00:00.000Z");
  const boardEvents = createBoardEvents({
    registry: registry(),
    timers,
    now: () => currentTime,
    loadProjectIssues: async () => [
      { id: "tracked-later", status: "open", defer_until: "2026-07-31T10:00:05.000Z" },
      { id: "tracked-first", status: "open", defer_until: "2026-07-31T10:00:01.000Z" },
      { id: "tracked-closed", status: "closed", defer_until: "2026-07-31T10:00:00.500Z" },
    ],
    watchFile() {
      const watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    },
  });
  const events = [];
  boardEvents.onEvent((event) => events.push(event));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(timers.timeouts.size, 1);
  const firstTimer = [...timers.timeouts.keys()][0];
  assert.equal(timers.timeoutDelays.get(firstTimer), 1_000);

  currentTime += 1_000;
  timers.runTimeout(firstTimer);
  assert.deepEqual(events, [{ type: "board", project: "tracked" }]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(timers.timeouts.size, 1);
  const secondTimer = [...timers.timeouts.keys()][0];
  assert.equal(timers.timeoutDelays.get(secondTimer), 4_000);
  boardEvents.close();
  assert.equal(timers.timeouts.size, 0);
});

test("deferred boundary scheduling retries a transient tracker read failure", async () => {
  const timers = timerStub();
  let currentTime = Date.parse("2026-07-31T10:00:00.000Z");
  let reads = 0;
  const boardEvents = createBoardEvents({
    registry: registry(),
    timers,
    now: () => currentTime,
    deferRetryBaseMs: 100,
    deferRetryMaxMs: 400,
    loadProjectIssues: async () => {
      reads += 1;
      if (reads === 1) throw new Error("tracker temporarily locked");
      return [{
        id: "tracked-deferred",
        status: "open",
        defer_until: "2026-07-31T10:00:00.050Z",
      }];
    },
    watchFile() {
      const watcher = new EventEmitter();
      watcher.close = () => {};
      return watcher;
    },
  });
  const events = [];
  boardEvents.onEvent((event) => events.push(event));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(timers.timeouts.size, 1);
  const retryTimer = [...timers.timeouts.keys()][0];
  assert.equal(timers.timeoutDelays.get(retryTimer), 100);
  currentTime += 100;
  timers.runTimeout(retryTimer);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(reads, 2);
  assert.deepEqual(events, [{ type: "board", project: "tracked" }]);
  assert.equal(timers.timeouts.size, 0);
  boardEvents.close();
});

test("board watcher errors fall back silently to signature polling", async () => {
  const timers = timerStub();
  const signatures = [
    { mtimeMs: 10, size: 20 },
    { mtimeMs: 11, size: 24 },
  ];
  const boardEvents = createBoardEvents({
    registry: registry(),
    timers,
    loadProjectIssues: async () => [],
    watchFile() {
      throw Object.assign(new Error("watch unavailable"), { code: "ENOSPC" });
    },
    statFile: async () => signatures.shift(),
  });
  const events = [];
  boardEvents.onEvent((event) => events.push(event));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(timers.intervals.size, 1);
  await [...timers.intervals.values()][0]();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  [...timers.timeouts.values()][0]();

  assert.deepEqual(events, [{ type: "board", project: "tracked" }]);
  boardEvents.close();
});
