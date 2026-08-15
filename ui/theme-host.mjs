export const THEME_DISPOSE_TIMEOUT_MS = 2_000;

export function shouldReturnToDashboard(event, themeActive) {
  return Boolean(themeActive && event?.key === "Escape" && !event.defaultPrevented);
}

const canvasContexts = new WeakMap();
const contextTrackingVisitors = new Set();
let restoreContextTracking;

function contextKind(type) {
  const normalized = String(type ?? "").toLowerCase();
  if (["webgl", "webgl2", "experimental-webgl"].includes(normalized)) return "webgl";
  if (normalized === "webgpu") return "webgpu";
  if (normalized === "2d") return "2d";
  return normalized || "unknown";
}

function beginCanvasContextTracking(visit) {
  const prototype = globalThis.HTMLCanvasElement?.prototype;
  const original = prototype?.getContext;
  if (typeof original !== "function") return () => {};

  if (contextTrackingVisitors.size === 0) {
    const wrapped = function trackedCanvasGetContext(type, ...args) {
      const context = original.call(this, type, ...args);
      if (context) {
        canvasContexts.set(this, { context, kind: contextKind(type) });
        for (const visitor of contextTrackingVisitors) visitor(this);
      }
      return context;
    };
    try {
      prototype.getContext = wrapped;
      restoreContextTracking = () => {
        if (prototype.getContext === wrapped) prototype.getContext = original;
      };
    } catch {
      restoreContextTracking = undefined;
      return () => {};
    }
  }

  contextTrackingVisitors.add(visit);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    contextTrackingVisitors.delete(visit);
    if (contextTrackingVisitors.size === 0) {
      restoreContextTracking?.();
      restoreContextTracking = undefined;
    }
  };
}

function collectCanvases(node, visit) {
  if (!node) return;
  if (String(node.tagName || "").toLowerCase() === "canvas") visit(node);
  for (const canvas of node.querySelectorAll?.("canvas") ?? []) visit(canvas);
}

function collectMutationCanvases(records, visit) {
  for (const record of records) {
    for (const node of record.addedNodes ?? []) collectCanvases(node, visit);
  }
}

export function trackThemeCanvases(
  root,
  {
    MutationObserverImpl = globalThis.MutationObserver,
    contextRecordForCanvas = (canvas) => canvasContexts.get(canvas),
  } = {},
) {
  const canvases = new Map();
  const track = (canvas) => {
    if (canvases.has(canvas)) return;
    const state = {
      canvas,
      confirmed: false,
      attempted: false,
      confirm: undefined,
      lost: undefined,
      onContextLost() {
        state.confirmed = true;
        state.confirm?.();
      },
      onContextRestored() {
        state.confirmed = false;
      },
    };
    canvas.addEventListener?.("webglcontextlost", state.onContextLost);
    canvas.addEventListener?.("webglcontextrestored", state.onContextRestored);
    canvases.set(canvas, state);
  };
  const finishContextTracking = beginCanvasContextTracking(track);
  collectCanvases(root, track);
  const observer = typeof MutationObserverImpl === "function"
    ? new MutationObserverImpl((records) => collectMutationCanvases(records, track))
    : null;
  observer?.observe(root, { childList: true, subtree: true });

  const refresh = () => {
    collectMutationCanvases(observer?.takeRecords?.() ?? [], track);
    collectCanvases(root, track);
  };

  return {
    refresh,
    async release({
      waitMs = 100,
      setTimeoutImpl = globalThis.setTimeout,
      clearTimeoutImpl = globalThis.clearTimeout,
    } = {}) {
      const failures = [];
      const attempt = (step, operation) => {
        try {
          return operation();
        } catch (caught) {
          failures.push(teardownFailure(step, caught));
          return undefined;
        }
      };
      attempt("canvas-tracker.refresh", refresh);
      const awaitingConfirmation = [];
      for (const state of canvases.values()) {
        state.confirmed = false;
        state.lost = new Promise((resolve) => {
          state.confirm = resolve;
        });
        const record = attempt(
          "canvas-context.lookup",
          () => contextRecordForCanvas(state.canvas),
        );
        state.kind = record?.kind ?? (state.confirmed ? "webgl" : "uninitialized");
        state.attempted = state.kind === "webgl";
        if (state.attempted) {
          const forced = forceReleaseWebGlContext(record?.context);
          if (forced.error) failures.push(teardownFailure("canvas-context.force-release", forced.error));
          if (forced.requested && !state.confirmed) awaitingConfirmation.push(state);
        }
      }
      let timeout;
      if (awaitingConfirmation.length > 0) {
        try {
          await Promise.race([
            Promise.all(awaitingConfirmation.map(({ lost }) => lost)),
            new Promise((resolve) => {
              timeout = setTimeoutImpl(resolve, waitMs);
            }),
          ]);
        } catch (caught) {
          failures.push(teardownFailure("canvas-context.confirmation-wait", caught));
        }
      }
      if (timeout !== undefined) attempt("canvas-context.confirmation-timeout", () => clearTimeoutImpl(timeout));
      attempt("canvas-tracker.observer", () => observer?.disconnect());
      attempt("canvas-tracker.prototype", finishContextTracking);
      let unconfirmedCount = 0;
      let attempted = 0;
      let confirmed = 0;
      for (const state of canvases.values()) {
        if (state.attempted) attempted += 1;
        if (state.attempted && state.confirmed) confirmed += 1;
        else if (state.attempted) unconfirmedCount += 1;
        const canvas = state.canvas;
        attempt("canvas-contextlost-listener", () =>
          canvas.removeEventListener?.("webglcontextlost", state.onContextLost));
        attempt("canvas-contextrestored-listener", () =>
          canvas.removeEventListener?.("webglcontextrestored", state.onContextRestored));
        attempt("canvas.remove", () => canvas.remove?.());
        canvasContexts.delete(canvas);
        state.canvas = undefined;
        state.confirm = undefined;
        state.lost = undefined;
      }
      const canvasCount = canvases.size;
      canvases.clear();
      return {
        attempted,
        confirmed,
        releasedWithoutConfirmation: canvasCount - attempted,
        unconfirmedCount,
        failures,
      };
    },
    finish() {
      let known;
      try {
        refresh();
        known = new Set(canvases.keys());
      } finally {
        observer?.disconnect();
        finishContextTracking();
        for (const state of canvases.values()) {
          state.canvas?.removeEventListener?.("webglcontextlost", state.onContextLost);
          state.canvas?.removeEventListener?.("webglcontextrestored", state.onContextRestored);
          if (state.canvas) canvasContexts.delete(state.canvas);
          state.canvas = undefined;
          state.confirm = undefined;
          state.lost = undefined;
        }
        canvases.clear();
      }
      return known ?? new Set();
    },
  };
}

function forceReleaseWebGlContext(context) {
  try {
    const extension = context?.getExtension?.("WEBGL_lose_context");
    if (!extension?.loseContext) return { requested: false, error: undefined };
    extension.loseContext();
    return { requested: true, error: undefined };
  } catch (error) {
    return { requested: false, error };
  }
}

function releaseKnownCanvases(canvases) {
  const failures = [];
  let unconfirmedCount = 0;
  let attempted = 0;
  for (const canvas of canvases) {
    const record = canvasContexts.get(canvas);
    if (record?.kind === "webgl") {
      attempted += 1;
      unconfirmedCount += 1;
      const forced = forceReleaseWebGlContext(record.context);
      if (forced.error) failures.push(teardownFailure("canvas-context.force-release", forced.error));
    }
    try {
      canvas.remove?.();
    } catch (caught) {
      failures.push(teardownFailure("canvas.remove", caught));
    }
    canvasContexts.delete(canvas);
  }
  return {
    attempted,
    confirmed: 0,
    releasedWithoutConfirmation: canvases.size - attempted,
    unconfirmedCount,
    failures,
  };
}

function teardownFailure(step, caught) {
  return {
    step,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

function aggregateTeardownFailures(failures, message = "Theme cleanup failed") {
  if (failures.length === 0) return undefined;
  const detail = failures.map((failure) => `${failure.step}: ${failure.error.message}`).join("; ");
  const error = new AggregateError(
    failures.map((failure) => failure.error),
    `${message}: ${detail}`,
  );
  error.name = "ThemeTeardownError";
  error.failures = failures;
  return error;
}

function disposalHooks(cleanup, dispose) {
  const hooks = [];
  if (typeof cleanup === "function") hooks.push({ step: "theme.cleanup", hook: cleanup });
  if (typeof dispose === "function" && dispose !== cleanup) {
    hooks.push({ step: "theme.dispose", hook: dispose });
  }
  return hooks;
}

const hookWaitSlots = new Map();

function takeHookWait(token) {
  const slot = hookWaitSlots.get(token);
  if (!slot) return undefined;
  hookWaitSlots.delete(token);
  slot.signal.removeEventListener("abort", slot.onAbort);
  return slot;
}

function settleHookWait(token, status, error) {
  const slot = takeHookWait(token);
  slot?.resolve({ status, step: slot.step, error });
}

function waitForHook({ step, hook }, signal) {
  return new Promise((resolve) => {
    const token = Symbol("theme-dispose-hook");
    const onAbort = () => settleHookWait(token, "timed-out", signal.reason);
    hookWaitSlots.set(token, { onAbort, resolve, signal, step });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let work;
    try {
      work = hook();
    } catch (error) {
      settleHookWait(token, "rejected", error);
      return;
    }
    Promise.resolve(work).then(
      () => settleHookWait(token, "fulfilled"),
      (error) => settleHookWait(token, "rejected", error),
    );
  });
}

async function awaitHooks(hooks, {
  timeoutMs,
  setTimeoutImpl,
  clearTimeoutImpl,
}) {
  if (hooks.length === 0) return [];
  const timeoutController = new AbortController();
  let timeout;
  try {
    const waits = hooks.map((hook) => waitForHook(hook, timeoutController.signal));
    try {
      timeout = setTimeoutImpl(() => {
        timeoutController.abort(new Error(`Theme dispose timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    } catch (error) {
      timeoutController.abort(error);
    }
    const results = await Promise.all(waits);
    return results
      .filter((result) => result.status !== "fulfilled")
      .map((result) => teardownFailure(result.step, result.error));
  } finally {
    if (timeout !== undefined) clearTimeoutImpl(timeout);
  }
}

export async function teardownTheme({
  root,
  cleanup,
  dispose,
  canvasTracker,
  timeoutMs = THEME_DISPOSE_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  contextLossWaitMs = 100,
  clearRoot = true,
}) {
  const failures = [];
  let contextLosses;
  const tracker = canvasTracker ?? trackThemeCanvases(root, { MutationObserverImpl: null });
  try {
    failures.push(...await awaitHooks(disposalHooks(cleanup, dispose), {
      timeoutMs,
      setTimeoutImpl,
      clearTimeoutImpl,
    }));
  } catch (caught) {
    failures.push(teardownFailure("theme.hook-wait", caught));
  }
  try {
    if (typeof tracker.release === "function") {
      const released = await tracker.release({
        waitMs: contextLossWaitMs,
        setTimeoutImpl,
        clearTimeoutImpl,
      });
      failures.push(...(released.failures ?? []));
      contextLosses = {
        attempted: released.attempted ?? 0,
        confirmed: released.confirmed ?? 0,
        releasedWithoutConfirmation: released.releasedWithoutConfirmation ?? 0,
        unconfirmedCount: released.unconfirmedCount ?? released.unconfirmed?.length ?? 0,
      };
    } else {
      const canvases = tracker.finish?.() ?? new Set(root.querySelectorAll?.("canvas") ?? []);
      contextLosses = releaseKnownCanvases(canvases);
      failures.push(...contextLosses.failures);
      delete contextLosses.failures;
    }
  } catch (caught) {
    failures.push(teardownFailure("canvas-tracker.release", caught));
    let canvases = new Set();
    try {
      canvases = tracker.finish?.() ?? new Set(root.querySelectorAll?.("canvas") ?? []);
    } catch (fallbackError) {
      failures.push(teardownFailure("canvas-tracker.finish", fallbackError));
    }
    contextLosses = releaseKnownCanvases(canvases);
    failures.push(...contextLosses.failures);
    delete contextLosses.failures;
  }
  if (contextLosses.unconfirmedCount > 0) {
    failures.push(teardownFailure(
      "canvas-context.confirmation",
      new Error(
        `Theme WebGL context loss was not confirmed for ${contextLosses.unconfirmedCount} canvas(es)`,
      ),
    ));
  }
  if (clearRoot) {
    try {
      root.replaceChildren();
    } catch (caught) {
      failures.push(teardownFailure("theme-root.clear", caught));
    }
  }
  return {
    error: aggregateTeardownFailures(failures),
    failures,
    contextLosses,
  };
}
