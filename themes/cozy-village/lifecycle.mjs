/**
 * Own every unit of scheduled village work behind one disposable boundary.
 * A cancelled browser callback may still be delivered by a test double (or by
 * an already-queued task), so callbacks also check the boundary at execution.
 */
import { raceAbort } from "./abort.mjs";

export function createVillageActivity({
  signal,
  requestAnimationFrameImpl = globalThis.requestAnimationFrame,
  cancelAnimationFrameImpl = globalThis.cancelAnimationFrame,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  let active = true;
  let frameId;
  const timers = new Map();
  const lifetime = new AbortController();

  function abortError() {
    const error = new Error("Cozy Village mount was aborted");
    error.name = "AbortError";
    return error;
  }

  function throwIfDisposed() {
    if (!active) throw abortError();
  }

  function timeout(callback, delay, onDispose) {
    if (!active) {
      onDispose?.();
      return undefined;
    }
    let id;
    id = setTimeoutImpl(() => {
      timers.delete(id);
      if (active) callback();
    }, delay);
    timers.set(id, { onDispose });
    return id;
  }

  function clearTimer(id) {
    const record = timers.get(id);
    if (!record) return;
    timers.delete(id);
    clearTimeoutImpl(id);
    record.onDispose?.();
  }

  function delay(ms) {
    return new Promise((resolve) => {
      timeout(() => resolve(true), ms, () => resolve(false));
    });
  }

  function race(promise) {
    return raceAbort(promise, lifetime.signal, "Cozy Village mount was aborted");
  }

  function startFrame(callback) {
    if (!active || typeof requestAnimationFrameImpl !== "function") return;
    const tick = (now) => {
      if (!active) return;
      callback(now);
      if (active) frameId = requestAnimationFrameImpl(tick);
    };
    frameId = requestAnimationFrameImpl(tick);
  }

  function dispose() {
    if (!active) return;
    active = false;
    const failures = [];
    const attempt = (step, cleanup) => {
      try {
        cleanup();
      } catch (error) {
        failures.push({
          step,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    };
    attempt("activity.abort", () => lifetime.abort());
    const pendingFrame = frameId;
    frameId = undefined;
    if (pendingFrame !== undefined && typeof cancelAnimationFrameImpl === "function") {
      attempt("activity.frame", () => cancelAnimationFrameImpl(pendingFrame));
    }
    for (const [id, record] of timers) {
      attempt("activity.timer", () => clearTimeoutImpl(id));
      attempt("activity.timer-callback", () => record.onDispose?.());
    }
    timers.clear();
    attempt("activity.signal-listener", () =>
      signal?.removeEventListener?.("abort", dispose));
    if (failures.length > 0) {
      const error = new AggregateError(
        failures.map((failure) => failure.error),
        "Cozy Village activity cleanup failed",
      );
      error.name = "CozyVillageActivityCleanupError";
      error.failures = failures;
      throw error;
    }
  }

  if (signal?.aborted) dispose();
  else signal?.addEventListener?.("abort", dispose, { once: true });

  return {
    get active() {
      return active;
    },
    get pendingTimers() {
      return timers.size;
    },
    clearTimer,
    delay,
    dispose,
    race,
    startFrame,
    throwIfDisposed,
    timeout,
  };
}
