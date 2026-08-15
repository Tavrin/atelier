import assert from "node:assert/strict";
import test from "node:test";

import { createVillageActivity } from "../lifecycle.mjs";

test("mount then unmount leaves no village frame work or live timers", async () => {
  const frames = new Map();
  const timers = new Map();
  let nextId = 0;
  let themeFrameWork = 0;
  let timerWork = 0;
  const activity = createVillageActivity({
    requestAnimationFrameImpl(callback) {
      const id = ++nextId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrameImpl(id) {
      frames.delete(id);
    },
    setTimeoutImpl(callback) {
      const id = ++nextId;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutImpl(id) {
      timers.delete(id);
    },
  });

  activity.startFrame(() => {
    themeFrameWork += 1;
  });
  activity.timeout(() => {
    timerWork += 1;
  }, 30_000);
  const transition = activity.delay(1_900);
  const queuedBeforeUnmount = [...frames.values(), ...timers.values()];

  activity.dispose();
  for (const callback of queuedBeforeUnmount) callback(16);

  assert.equal(await transition, false, "an unmounted transition settles as cancelled");
  assert.equal(themeFrameWork, 0, "even an already-queued theme frame performs no work");
  assert.equal(timerWork, 0, "already-queued timer callbacks perform no work");
  assert.equal(frames.size, 0, "no requestAnimationFrame remains owned by the village");
  assert.equal(timers.size, 0, "no timeout remains owned by the village");
  assert.equal(activity.pendingTimers, 0);
});

test("an abort signal tears down the same activity boundary", () => {
  const controller = new AbortController();
  let cancelled;
  const activity = createVillageActivity({
    signal: controller.signal,
    requestAnimationFrameImpl() {
      return 17;
    },
    cancelAnimationFrameImpl(id) {
      cancelled = id;
    },
  });
  activity.startFrame(() => {});

  controller.abort();

  assert.equal(activity.active, false);
  assert.equal(cancelled, 17);
  assert.throws(() => activity.throwIfDisposed(), { name: "AbortError" });
});

test("activity disposal clears all ownership after individual cleanup failures", () => {
  const cleared = [];
  const disposed = [];
  let nextId = 0;
  const activity = createVillageActivity({
    requestAnimationFrameImpl() {
      return 41;
    },
    cancelAnimationFrameImpl() {
      throw new Error("frame cancel failed");
    },
    setTimeoutImpl() {
      return ++nextId;
    },
    clearTimeoutImpl(id) {
      cleared.push(id);
      if (id === 1) throw new Error("timer clear failed");
    },
  });
  activity.startFrame(() => {});
  activity.timeout(() => {}, 1, () => disposed.push(1));
  activity.timeout(() => {}, 1, () => disposed.push(2));

  let error;
  assert.throws(() => activity.dispose(), (caught) => {
    error = caught;
    return true;
  });

  assert.equal(error.name, "CozyVillageActivityCleanupError");
  assert.deepEqual(cleared, [1, 2]);
  assert.deepEqual(disposed, [1, 2]);
  assert.equal(activity.active, false);
  assert.equal(activity.pendingTimers, 0);
});
