export function abortError(message = "Cozy Village work was aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function throwIfAborted(signal, message) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") {
    throw signal.reason;
  }
  throw abortError(message);
}

const abortRaceSlots = new Map();

function takeAbortRace(token) {
  const slot = abortRaceSlots.get(token);
  if (!slot) return undefined;
  abortRaceSlots.delete(token);
  slot.signal.removeEventListener?.("abort", slot.onAbort);
  return slot;
}

function abortRace(token) {
  const slot = takeAbortRace(token);
  if (!slot) return;
  slot.reject(abortError(slot.message));
}

function settleAbortRace(token, outcome, value) {
  const pending = abortRaceSlots.get(token);
  if (!pending) return;
  if (pending.signal.aborted) {
    abortRace(token);
    return;
  }
  const slot = takeAbortRace(token);
  slot?.[outcome](value);
}

/**
 * Detach an awaiting generation from provider-owned work on abort. The
 * callbacks registered on the original promise retain only an opaque token;
 * abort removes the registry slot synchronously, so late settlement cannot
 * recover the generation signal, wrapper capability, or mount graph.
 */
export function raceAbort(promise, signal, message) {
  throwIfAborted(signal, message);
  if (typeof signal?.addEventListener !== "function") return Promise.resolve(promise);

  return new Promise((resolve, reject) => {
    const token = Symbol("cozy-village-abort-race");
    const onAbort = () => abortRace(token);
    abortRaceSlots.set(token, { message, onAbort, reject, resolve, signal });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => settleAbortRace(token, "resolve", value),
      (error) => settleAbortRace(token, "reject", error),
    );
  });
}
