/**
 * THE DATA SEAM — the theme's only door to Atelier.
 *
 * Slice V is built ahead of slice S (the theme substrate). Everything the
 * village needs therefore arrives through ONE interface with two
 * implementations, chosen by a query parameter:
 *
 *   ?data=fixture   data/fixture.mjs — this repo's real history, on disk
 *   ?data=live      data/live.mjs    — /api/* + SSE (default when mounted)
 *
 * Integrating the substrate is a one-file swap: nothing outside data/ knows
 * which source it is talking to.
 *
 * THE INTERFACE
 *
 *   load()                → { project, projects, chronicle, dispatches, convoy,
 *                             board, queue, mainHealth, artifacts }
 *   selectProject(name)   → freshly loaded projection for that project
 *   subscribe(handler)    → unsubscribe;  handler(event) with Atelier's real SSE
 *                           event shapes ({ type, dispatchId, seq, ... })
 *   merge(dispatchId)     → the updated record  (throws on refusal)
 *   dismiss(dispatchId)   → the updated record
 *   reply(dispatchId, t)  → the updated record
 *   ackMainHealth(id)     → the updated record
 *   dashboardHref(id)     → a link back into the core dashboard
 *   describe()            → { mode, label, detail } for the provenance line
 *
 * Every source is REQUIRED to describe itself, because a demo that cannot
 * say whether it is showing real data is exactly the thing this program
 * refuses to ship.
 */

import { abortError } from "../abort.mjs";

export const DEFAULT_MODE = "live";
const TIME_PREVIEWS = new Map([
  ["noon", [12, 0]],
  ["dusk", [18, 30]],
  ["night", [23, 0]],
]);

export function resolveMode(search = globalThis.location?.search ?? "") {
  const param = new URLSearchParams(search).get("data");
  if (param === "fixture" || param === "live") return param;
  return DEFAULT_MODE;
}

/** Stable visual-QA clock positions; the corner labels them as previews. */
export function resolveTimePreview(
  search = globalThis.location?.search ?? "",
  base = new Date(),
) {
  const value = new URLSearchParams(search).get("time");
  const named = TIME_PREVIEWS.get(value);
  const matched = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value ?? "");
  const parts = named ?? (matched ? [Number(matched[1]), Number(matched[2])] : null);
  if (!parts) return null;
  const preview = new Date(base);
  preview.setHours(parts[0], parts[1], 0, 0);
  return preview;
}

/**
 * @param {object} options
 *   mode      "live" | "fixture"  (defaults to the ?data= param)
 *   project   project name for the live source
 *   baseUrl   origin override for the live source (standalone dev)
 */
const sourceCreationSlots = new Map();

function takeSourceCreation(token) {
  const slot = sourceCreationSlots.get(token);
  if (!slot) return undefined;
  sourceCreationSlots.delete(token);
  slot.signal?.removeEventListener?.("abort", slot.onAbort);
  return slot;
}

function abortSourceCreation(token) {
  const slot = takeSourceCreation(token);
  slot?.reject(abortError("Cozy Village source creation was aborted"));
}

function rejectSourceCreation(token, error) {
  const slot = takeSourceCreation(token);
  slot?.reject(error);
}

function completeSourceCreation(token, module) {
  const pending = sourceCreationSlots.get(token);
  if (!pending) return;
  if (pending.signal?.aborted) {
    abortSourceCreation(token);
    return;
  }
  const slot = takeSourceCreation(token);
  if (!slot) return;
  try {
    const factory = slot.mode === "fixture"
      ? module.createFixtureSource
      : module.createLiveSource;
    slot.resolve(factory(slot.options));
  } catch (error) {
    slot.reject(error);
  }
}

function startSourceImport(token) {
  if (!sourceCreationSlots.has(token)) return;
  const mode = sourceCreationSlots.get(token)?.mode;
  const modulePromise = mode === "fixture"
    ? import("./fixture.mjs")
    : import("./live.mjs");
  Promise.resolve(modulePromise).then(
    (module) => completeSourceCreation(token, module),
    (error) => rejectSourceCreation(token, error),
  );
}

export function createSource(options = {}) {
  const mode = options.mode ?? resolveMode();
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.reject(abortError("Cozy Village source creation was aborted"));
  }
  return new Promise((resolve, reject) => {
    const token = Symbol("cozy-village-source-creation");
    const onAbort = () => abortSourceCreation(token);
    sourceCreationSlots.set(token, { mode, onAbort, options, reject, resolve, signal });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    queueMicrotask(() => startSourceImport(token));
  });
}
