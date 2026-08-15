const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 5_000;

export function createBoardStreamGate({
  resync,
  apply,
  keys,
  keyFor = (event) => event?.project,
  timers = globalThis,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
}) {
  if (typeof resync !== "function" || typeof apply !== "function") {
    throw new TypeError("board stream callbacks must be functions");
  }
  if (keys !== undefined && (typeof keys !== "function" || typeof keyFor !== "function")) {
    throw new TypeError("keyed board stream selectors must be functions");
  }

  let connected = false;
  const singleKey = Symbol("board-stream");
  const lanes = new Map();

  function laneFor(key) {
    let lane = lanes.get(key);
    if (!lane) {
      lane = {
        needsResync: true,
        syncing: false,
        revision: 0,
        pending: undefined,
        retryTimer: undefined,
        retryAttempt: 0,
      };
      lanes.set(key, lane);
    }
    return lane;
  }

  function clearRetry(lane) {
    if (lane.retryTimer !== undefined) timers.clearTimeout(lane.retryTimer);
    lane.retryTimer = undefined;
  }

  function scheduleRetry(key, lane) {
    if (!connected || lane.retryTimer !== undefined) return;
    const exponent = Math.min(lane.retryAttempt, 30);
    const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** exponent));
    lane.retryAttempt += 1;
    lane.retryTimer = timers.setTimeout(() => {
      lane.retryTimer = undefined;
      return attemptResync(key, lane).catch(() => false);
    }, delay);
    lane.retryTimer?.unref?.();
  }

  async function attemptResync(key, lane = laneFor(key)) {
    if (!connected) return false;
    clearRetry(lane);
    lane.needsResync = true;
    lane.syncing = true;
    const currentRevision = ++lane.revision;
    try {
      await resync(keys === undefined ? undefined : key);
    } catch (error) {
      if (connected && lane.revision === currentRevision) {
        lane.needsResync = true;
        lane.syncing = false;
        scheduleRetry(key, lane);
      }
      throw error;
    }
    if (!connected || lane.revision !== currentRevision) return false;

    lane.needsResync = false;
    lane.syncing = false;
    lane.retryAttempt = 0;
    const pending = lane.pending;
    lane.pending = undefined;
    if (pending !== undefined) apply(pending);
    return true;
  }

  function reset({ clearPending }) {
    for (const lane of lanes.values()) {
      lane.needsResync = true;
      lane.syncing = false;
      lane.revision += 1;
      if (clearPending) lane.pending = undefined;
      clearRetry(lane);
    }
  }

  return {
    error() {
      connected = false;
      reset({ clearPending: true });
    },

    async open() {
      connected = true;
      if (keys === undefined) return attemptResync(singleKey);
      const projectKeys = [...new Set(keys())];
      const results = await Promise.allSettled(
        projectKeys.map((key) => attemptResync(key)),
      );
      return results.every(({ status }) => status === "fulfilled");
    },

    close() {
      connected = false;
      reset({ clearPending: true });
    },

    event(event) {
      const key = keys === undefined ? singleKey : keyFor(event);
      if (key === undefined || key === null) return;
      const knownLane = lanes.has(key);
      const lane = laneFor(key);
      if (lane.needsResync || lane.syncing) {
        // Board events are invalidations, not deltas. One latest event is
        // enough to refresh the current snapshot after a degraded retry.
        lane.pending = event;
        if (keys !== undefined && connected && !knownLane) {
          void attemptResync(key, lane).catch(() => false);
        }
        return;
      }
      apply(event);
    },
  };
}
