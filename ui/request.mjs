// One request-options helper for the browser UI. The server derives identity
// from the signed session; this module only carries the per-session CSRF proof.

import { isThemeId } from "./actor.mjs";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const CSRF_SLOT = "__atelierCsrfToken";

export function setAtelierCsrfToken(token) {
  if (typeof token !== "string" || !token) throw new TypeError("Invalid Atelier CSRF token");
  globalThis[CSRF_SLOT] = token;
}

export function atelierRequestOptions(options = {}, actor = "ui") {
  const request = { ...options };
  const headers = new Headers(options.headers || {});
  const method = String(options.method ?? "GET").toUpperCase();
  if (MUTATING_METHODS.has(method)) {
    headers.set("X-Atelier-Actor", actor);
    if (globalThis[CSRF_SLOT]) headers.set("X-Atelier-CSRF", globalThis[CSRF_SLOT]);
  }
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
