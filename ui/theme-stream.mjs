export const DEFAULT_MAX_DISPATCH_STREAMS = 3;
export const THEME_STREAM_BACKOFF_BASE_MS = 250;
export const THEME_STREAM_BACKOFF_MAX_MS = 10_000;

export const THEME_STREAM_EVENT_TYPES = Object.freeze([
  "status",
  "message",
  "reply",
  "plan",
  "usage",
  "exit",
  "review",
  "review-disposition",
  "verify-rerun",
  "verify",
  "verify-output",
  "post-merge",
]);

function streamCleanupError(failures) {
  const error = new AggregateError(
    failures.map((failure) => failure.error),
    "Theme stream cleanup failed",
  );
  error.name = "ThemeStreamCleanupError";
  error.failures = failures;
  return error;
}

export function safeText(value) {
  return document.createTextNode(String(value ?? ""));
}

function parseEvent(message) {
  try {
    return JSON.parse(message.data);
  } catch {
    return undefined;
  }
}

function createReconnectingStream(path, handlers, {
  scope,
  eventTypes = THEME_STREAM_EVENT_TYPES,
  resync,
  onError,
  eventSourceFactory,
  setTimeoutImpl,
  clearTimeoutImpl,
  backoffBaseMs,
  backoffMaxMs,
}) {
  let source;
  let reconnectTimer;
  let retry = 0;
  let closed = false;
  let generation = 0;
  let syncing = false;
  let pending = [];
  const listenerRecords = [];

  function listen(target, type, listener) {
    target.addEventListener(type, listener);
    listenerRecords.push({ target, type, listener });
  }

  function removeListeners(target, failures = []) {
    for (let index = listenerRecords.length - 1; index >= 0; index -= 1) {
      const record = listenerRecords[index];
      if (record.target !== target) continue;
      listenerRecords.splice(index, 1);
      try {
        target.removeEventListener?.(record.type, record.listener);
      } catch (error) {
        failures.push({ step: `${scope.kind}.event-listener`, error });
      }
    }
    return failures;
  }

  function deliver(event, message) {
    for (const handler of handlers) handler(event, message);
  }

  function scheduleReconnect(error) {
    if (closed || reconnectTimer !== undefined) return;
    const current = source;
    source = undefined;
    const failures = removeListeners(current);
    try {
      current?.close();
    } catch (closeError) {
      failures.push({ step: `${scope.kind}.event-source`, error: closeError });
    }
    syncing = false;
    if (failures.length > 0) onError?.(streamCleanupError(failures), scope);
    onError?.(error, scope);
    const delay = Math.min(backoffBaseMs * (2 ** retry), backoffMaxMs);
    retry += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function connect() {
    if (closed) return;
    const currentGeneration = ++generation;
    syncing = true;
    let current;
    try {
      current = eventSourceFactory(path);
      source = current;

      listen(current, "open", () => {
        if (closed || source !== current || generation !== currentGeneration) return;
        Promise.resolve()
          .then(() => resync(scope))
          .then(() => {
            if (closed || source !== current || generation !== currentGeneration) return;
            retry = 0;
            syncing = false;
            const queued = pending;
            pending = [];
            for (const [event, message] of queued) deliver(event, message);
          })
          .catch((error) => {
            if (closed || source !== current || generation !== currentGeneration) return;
            scheduleReconnect(error);
          });
      });
      listen(current, "error", (error) => {
        if (source !== current || generation !== currentGeneration) return;
        scheduleReconnect(error);
      });
      for (const type of eventTypes) {
        listen(current, type, (message) => {
          if (closed || source !== current || generation !== currentGeneration) return;
          const event = parseEvent(message);
          if (event === undefined) return;
          if (syncing) pending.push([event, message]);
          else deliver(event, message);
        });
      }
    } catch (error) {
      const failures = removeListeners(current);
      try {
        current?.close?.();
      } catch (closeError) {
        failures.push({ step: `${scope.kind}.event-source`, error: closeError });
      }
      if (source === current) source = undefined;
      if (failures.length > 0) {
        failures.unshift({ step: `${scope.kind}.connect`, error });
        throw streamCleanupError(failures);
      }
      throw error;
    }
  }

  connect();
  return {
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      const timer = reconnectTimer;
      reconnectTimer = undefined;
      pending = [];
      const current = source;
      source = undefined;
      const failures = removeListeners(current);
      try {
        if (timer !== undefined) clearTimeoutImpl(timer);
      } catch (error) {
        failures.push({ step: `${scope.kind}.reconnect-timer`, error });
      }
      try {
        current?.close();
      } catch (error) {
        failures.push({ step: `${scope.kind}.event-source`, error });
      }
      if (failures.length > 0) throw streamCleanupError(failures);
    },
  };
}

export function createThemeStream({
  onAggregateEvent = () => {},
  onBoardEvent,
  resync = async () => {},
  onError,
  maxDispatchStreams = DEFAULT_MAX_DISPATCH_STREAMS,
  eventSourceFactory = (path) => new EventSource(path),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  backoffBaseMs = THEME_STREAM_BACKOFF_BASE_MS,
  backoffMaxMs = THEME_STREAM_BACKOFF_MAX_MS,
} = {}) {
  if (!Number.isInteger(maxDispatchStreams) || maxDispatchStreams < 1) {
    throw new TypeError("maxDispatchStreams must be a positive integer");
  }
  if (
    !Number.isFinite(backoffBaseMs) ||
    !Number.isFinite(backoffMaxMs) ||
    backoffBaseMs < 0 ||
    backoffMaxMs < backoffBaseMs
  ) {
    throw new TypeError("theme stream backoff bounds are invalid");
  }
  if (
    typeof onAggregateEvent !== "function" ||
    (onBoardEvent !== undefined && typeof onBoardEvent !== "function") ||
    typeof resync !== "function"
  ) {
    throw new TypeError("theme stream callbacks must be functions");
  }

  const connectionOptions = {
    resync,
    onError,
    eventSourceFactory,
    setTimeoutImpl,
    clearTimeoutImpl,
    backoffBaseMs,
    backoffMaxMs,
  };
  const aggregateHandlers = new Set([onAggregateEvent]);
  let aggregate;
  let board;
  try {
    aggregate = createReconnectingStream(
      "/api/dispatches/events",
      aggregateHandlers,
      {
        ...connectionOptions,
        scope: Object.freeze({ kind: "aggregate" }),
      },
    );
    board = onBoardEvent === undefined
      ? null
      : createReconnectingStream(
          "/api/board/events",
          new Set([onBoardEvent]),
          {
            ...connectionOptions,
            scope: Object.freeze({ kind: "board" }),
            eventTypes: Object.freeze(["board"]),
          },
        );
  } catch (error) {
    const failures = [{ step: "stream.construct", error }];
    for (const [step, connection] of [
      ["board.connection", board],
      ["aggregate.connection", aggregate],
    ]) {
      try {
        connection?.close();
      } catch (cleanupError) {
        failures.push(...(cleanupError.failures ?? [{ step, error: cleanupError }]));
      }
    }
    if (failures.length > 1) throw streamCleanupError(failures);
    throw error;
  }
  const dispatches = new Map();
  let closed = false;

  function touch(id, entry) {
    dispatches.delete(id);
    dispatches.set(id, entry);
  }

  function evictOldest() {
    const oldest = dispatches.entries().next().value;
    if (!oldest) return;
    const [id, entry] = oldest;
    dispatches.delete(id);
    entry.connection.close();
  }

  return {
    subscribeDispatch(dispatchId, onEvent) {
      if (closed) throw new Error("Theme stream is closed");
      if (typeof dispatchId !== "string" || !dispatchId) {
        throw new TypeError("dispatchId must be a non-empty string");
      }
      if (typeof onEvent !== "function") {
        throw new TypeError("dispatch event handler must be a function");
      }

      let entry = dispatches.get(dispatchId);
      if (!entry) {
        if (dispatches.size >= maxDispatchStreams) evictOldest();
        const handlers = new Set();
        entry = {
          handlers,
          connection: createReconnectingStream(
            `/api/dispatch/${encodeURIComponent(dispatchId)}/events`,
            handlers,
            {
              ...connectionOptions,
              scope: Object.freeze({ kind: "dispatch", dispatchId }),
            },
          ),
        };
      }
      entry.handlers.add(onEvent);
      touch(dispatchId, entry);

      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        const failures = [];
        try {
          entry.handlers.delete(onEvent);
        } catch (error) {
          failures.push({ step: "dispatch.handlers", error });
        }
        if (
          failures.length === 0 &&
          entry.handlers.size > 0 &&
          dispatches.get(dispatchId) === entry
        ) {
          return;
        }
        dispatches.delete(dispatchId);
        try {
          entry.connection.close();
        } catch (error) {
          failures.push(...(error.failures ?? [{ step: "dispatch.connection", error }]));
        }
        if (failures.length > 0) throw streamCleanupError(failures);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      const failures = [];
      const close = (step, connection) => {
        try {
          connection?.close();
        } catch (error) {
          failures.push(...(error.failures ?? [{ step, error }]));
        }
      };
      close("aggregate.connection", aggregate);
      close("board.connection", board);
      for (const entry of dispatches.values()) close("dispatch.connection", entry.connection);
      dispatches.clear();
      if (failures.length > 0) throw streamCleanupError(failures);
    },
  };
}
