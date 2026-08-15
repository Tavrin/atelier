// One request-options helper for the browser UI. Every state-changing request
// is attributed as a human UI action in the forensic event log; read-only
// requests remain ordinary GETs.

import { isThemeId } from "./actor.mjs";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function atelierRequestOptions(options = {}, actor = "ui") {
  const request = { ...options };
  const headers = new Headers(options.headers || {});
  const method = String(options.method ?? "GET").toUpperCase();
  if (MUTATING_METHODS.has(method)) headers.set("X-Atelier-Actor", actor);
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    request.body = JSON.stringify(options.body);
  }
  request.headers = headers;
  return request;
}

// Theme bundles import this client instead of issuing raw fetches. It preserves
// the core request encoding while giving every mutation durable provenance.
export function createThemeActionClient(themeId, { fetchImpl = globalThis.fetch } = {}) {
  if (!isThemeId(themeId)) throw new TypeError("Invalid theme id");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  return (path, options = {}) => {
    if (typeof path !== "string" || !path.startsWith("/api/")) {
      throw new TypeError("Theme actions must target a same-origin /api/ path");
    }
    return fetchImpl(path, atelierRequestOptions(options, `theme:${themeId}`));
  };
}
