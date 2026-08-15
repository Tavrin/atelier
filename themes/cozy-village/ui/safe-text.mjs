/**
 * R2 — contract strings reach the DOM as TEXT, never as markup.
 *
 * Re-exported from the core helper (`/theme-stream.mjs`) so the theme uses the
 * host's own definition rather than a lookalike that could drift from it. The
 * repo-relative path is the standalone-harness fallback, exactly as in
 * data/live.mjs.
 *
 * Everything this theme puts on screen that came off the wire — a villager's
 * question, an exit summary, a verify tail, a server error message — goes
 * through `textContent` or a text node. Nothing is ever interpolated into
 * markup, so a hostile string is displayed rather than executed.
 */
async function load() {
  try {
    return await import(/* @vite-ignore */ "/theme-stream.mjs");
  } catch {
    return await import("../../../ui/theme-stream.mjs");
  }
}

export const { safeText } = await load();
