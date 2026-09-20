/**
 * ENGINE REGISTRY — the renderer-factory/engine-registry seam the embed
 * contract asks for. `entry.mjs` used to import
 * `createRenderer` and `createWorld` directly and wire them together itself;
 * that wiring is now behind one seam so a second engine can sit beside it
 * without `entry.mjs` knowing which one is live.
 *
 * The contract every engine returns: `{ world, describe }`.
 *   - `world` is exactly the shape `world/world.mjs` already returns — build,
 *     pick, dispose, render, the lot. `entry.mjs` never branches on engine.
 *   - `describe()` reports what actually ran: `{ backend, tier, gpu, notes }`,
 *     the same shape `world/renderer.mjs`'s `describe()` already returns, so
 *     the corner provenance line ("… · WEBGL · high tier") keeps meaning the
 *     same thing regardless of which engine drew the frame.
 *
 * 'three' is the default and the only production path — a pass-through to
 * the existing `renderer.mjs` + `world.mjs`, byte-for-byte unchanged. 'moss'
 * is opt-in only (`?engine=moss` or `context.engine === "moss"`) and MVP-
 * scoped; the MVP accepts known capability gaps (no shadows/GI/bloom/
 * sky-sphere-texture yet).
 *
 * TIMING CONTRACT — the default path must reproduce, byte-for-byte, the
 * pre-seam sequencing `entry.mjs` used to own directly: `await
 * createRenderer()` sits inside the caller's startup try/catch (so only
 * renderer-creation failures hit that catch/teardown boundary); `createWorld()`
 * is a SEPARATE, synchronous step the caller runs afterward, outside that
 * try, so a `createWorld()` throw is NOT caught by the renderer's
 * catch/teardown (same as before this seam existed). To keep that boundary
 * exact, every engine returns a `createWorld(delay)` FACTORY — not an
 * already-built `world` — so the caller decides when world construction
 * happens and which catch scope covers it. `renderer` is exposed too,
 * three-only, so the caller's abort-lost-the-race path can dispose exactly
 * what base disposed (the renderer, never a world that was never built).
 */
import { createRenderer } from "./renderer.mjs";
import { createWorld } from "./world.mjs";

export const DEFAULT_ENGINE_ID = "three";

async function mountThree({ canvas, generation, signal }) {
  const { renderer, capabilities, describe } = await createRenderer({
    canvas,
    generation,
    signal,
  });
  return {
    renderer,
    describe,
    createWorld: (delay) => createWorld({ renderer, capabilities, delay }),
  };
}

/* Loaded lazily: a page that never asks for `moss` should never pay to parse
   the adapter module, let alone fetch the ~18MB vendored wasm. Moss has no
   renderer/world split — `mountMossWorld` already awaits its own scene setup
   in full — so `createWorld` here is a trivial synchronous accessor over the
   already-built world, kept only so both engines share one caller-side shape. */
async function mountMoss(options) {
  const { mountMossWorld } = await import("./engines/moss-world.mjs");
  const { world, describe } = await mountMossWorld(options);
  return { renderer: undefined, describe, createWorld: () => world };
}

const ENGINES = {
  three: mountThree,
  moss: mountMoss,
};

/**
 * `query` is whatever `?engine=` said (or undefined); `config` is whatever
 * the host's mount context said. Query wins, because it is the one a link
 * can carry. Anything other than the literal string `"moss"` — including
 * absence — resolves to the unchanged default.
 */
export function resolveEngineId({ query, config } = {}) {
  const requested = query ?? config;
  return requested === "moss" && "moss" in ENGINES ? "moss" : DEFAULT_ENGINE_ID;
}

/**
 * Deliberately NOT `async`: an `async` wrapper here would add a microtask
 * hop of its own even though it does nothing but call through, moving
 * `entry.mjs`'s await one tick further from `createRenderer()` than the
 * pre-seam code was. Returning the factory's promise directly keeps this a
 * pass-through, not a boundary.
 */
export function mountEngine(engineId, options) {
  const factory = ENGINES[engineId] ?? ENGINES[DEFAULT_ENGINE_ID];
  return factory(options);
}
