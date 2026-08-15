/**
 * COZY VILLAGE — theme entry.
 *
 * The World Contract mounts this module full-viewport and calls `mount(el)`.
 * Everything below is wiring: the state store, the three.js world, the chrome,
 * the SSE feed and one frame loop. No Atelier knowledge lives here that is not
 * already in state/ or data/.
 *
 * @typedef {object} MountContext
 * @property {string}  [project]   project name to show
 * @property {string}  [baseUrl]   API origin (standalone dev)
 * @property {"live"|"fixture"} [mode]
 * @property {unknown} [generation] opaque host token owned by this mount
 * @property {AbortSignal} [signal] aborted synchronously when the host unmounts
 * @property {"three"|"moss"} [engine] world engine; default stays "three".
 *   `?engine=moss` on the page URL wins over this (see resolveEngineId).
 */

import { createSource, resolveTimePreview } from "./data/source.mjs";
import { createVillageActivity } from "./lifecycle.mjs";
import { safeText } from "./ui/safe-text.mjs";
import { VillageStore } from "./state/village.mjs";
import { mountEngine, resolveEngineId } from "./world/engine.mjs";
import {
  buildCard,
  buildLedger,
  buildLegend,
  buildNoticeList,
  buildPanel,
  buildParcelList,
  buildStationList,
  buildTour,
  formatUSD,
} from "./ui/chrome.mjs";

const HERE = new URL(".", import.meta.url);
const SEEN_KEY = "cozy-village:seen-tour";

/**
 * R4. Live instances keyed by the host's generation token, so a stale module
 * `dispose(generation)` can reach its own renderer without touching a newer
 * mount of the same cached entry module.
 *
 * The host force-releases contexts as a fallback; that is containment, not
 * lifecycle. A WebGL context, a requestAnimationFrame loop and an SSE
 * connection are ours to release, and we release them.
 */
const liveInstances = new Map();
const terminalFailures = new Map();

function cleanupFailure(step, caught) {
  return {
    step,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

function cleanupError(failures, message = "Cozy Village cleanup failed") {
  const detail = failures.map((failure) => `${failure.step}: ${failure.error.message}`).join("; ");
  const error = new AggregateError(
    failures.map((failure) => failure.error),
    `${message}: ${detail}`,
  );
  error.name = "CozyVillageCleanupError";
  error.failures = failures;
  return error;
}

function detachedCleanupError(error) {
  const failures = (error.failures ?? [cleanupFailure("signal-teardown", error)])
    .map((failure) => cleanupFailure(
      failure.step,
      new Error(failure.error?.message ?? String(failure.error)),
    ));
  return cleanupError(failures);
}

export async function dispose(generation) {
  const generations = generation === undefined
    ? new Set([...terminalFailures.keys(), ...liveInstances.keys()])
    : new Set([generation]);
  const failures = [];
  for (const currentGeneration of generations) {
    const earlier = terminalFailures.get(currentGeneration);
    terminalFailures.delete(currentGeneration);
    if (earlier) {
      failures.push(...(earlier.failures ?? [cleanupFailure("signal-teardown", earlier)]));
    }
    const teardown = liveInstances.get(currentGeneration);
    if (!teardown) continue;
    try {
      /* `teardown` (below) is async and its returned promise settles only
         once the renderer's own disposal chain has finished — awaiting it
         here is what lets a disposal failure actually reach `failures`
         instead of becoming an unhandled rejection nobody sees. */
      await teardown();
    } catch (error) {
      failures.push(...(error.failures ?? [cleanupFailure("instance-teardown", error)]));
    }
  }
  if (failures.length > 0) throw cleanupError(failures);
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

let stylesheetUsers = 0;
let stylesheetLink;

function acquireStylesheet() {
  const href = new URL("theme.css", HERE).href;
  stylesheetLink = document.querySelector(`link[data-cozy-village]`) ?? stylesheetLink;
  if (!stylesheetLink) {
    stylesheetLink = document.createElement("link");
    stylesheetLink.rel = "stylesheet";
    stylesheetLink.href = href;
    stylesheetLink.dataset.cozyVillage = "true";
    document.head.appendChild(stylesheetLink);
  }
  stylesheetUsers += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    stylesheetUsers = Math.max(0, stylesheetUsers - 1);
    if (stylesheetUsers === 0) {
      const link = stylesheetLink;
      stylesheetLink = undefined;
      link?.remove();
    }
  };
}

/** How long the village will wait for its own face before drawing without it. */
const FONT_TIMEOUT_MS = 1500;

/**
 * Resolve once the vendored humanist face is usable, or once waiting for it
 * has stopped being worth it. Never rejects: the village opens either way.
 */
async function fontReady(activity) {
  if (!document.fonts?.load) return;
  try {
    await activity.race(
      Promise.race([
        Promise.all([
          document.fonts.load('600 32px "Ubuntu Sans derivative Cozy Village"'),
          document.fonts.load('italic 400 32px "Ubuntu Sans derivative Cozy Village"'),
        ]),
        activity.delay(FONT_TIMEOUT_MS),
      ]),
    );
  } catch {
    // A missing face is a downgrade in typography, never a failure to mount.
  }
}

/** @param {HTMLElement} host @param {MountContext} context */
export async function mount(host, context = {}) {
  const generation = context.generation ?? Symbol("cozy-village-mount");
  const controller = new AbortController();
  const releaseStylesheet = acquireStylesheet();
  const activity = createVillageActivity({ signal: controller.signal });
  let observer;
  let unsubscribe;
  let world;
  let onHostAbort;

  const reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  /* `?motion=off` forces the reduced path without touching OS settings, so the
     reduced-motion rendering is reviewable — and linkable — by someone who
     does not have the accessibility preference set. It can only ever turn
     motion OFF: `?motion=on` must not be able to override a person who has
     asked their operating system for less of it. */
  const motionParam = new URLSearchParams(globalThis.location?.search ?? "").get("motion");
  let reduced = reducedQuery.matches || motionParam === "off";
  const previewNow = resolveTimePreview();
  const engineParam = new URLSearchParams(globalThis.location?.search ?? "").get("engine");
  const engineId = resolveEngineId({ query: engineParam, config: context.engine });

  /* ── DOM ─────────────────────────────────────────────────────────────── */
  const root = el("div", "cv-root");
  root.dataset.rail = "shown";
  const canvas = el("canvas", "cv-canvas");
  const grain = el("div", "cv-grain");
  const rail = el("aside", "cv-rail");
  const corner = el("div", "cv-corner");
  const card = el("div", "cv-card");
  const toast = el("div", "cv-toast");
  const tour = buildTour();
  const legend = buildLegend();
  root.append(canvas, grain, rail, corner, legend, card, toast, tour.element);
  host.replaceChildren(root);

  /* `teardown` caches and returns the SAME in-flight promise across every
     call, until disposal settles — not just "is async". The host aborts
     `context.signal` BEFORE it invokes the `cleanup`/`dispose` hooks it got
     back from `mount()` (`ui/app.js`'s `queueThemeTeardown`:
     `lifecycle.controller?.abort()` runs first, `teardownThemeLifecycle` —
     which calls `cleanup()` — after). That abort fires `onHostAbort`
     SYNCHRONOUSLY, which starts `performTeardown()` running: it completes
     every synchronous step (listeners, DOM removal, `liveInstances`
     bookkeeping) before it ever reaches an `await`. If `teardown()` itself
     re-ran that guard-and-return dance on a second call, the LATER
     `cleanup()` call from the host's hook would hit an already-guarded no-op
     and resolve immediately — the host would think teardown finished before
     Moss's disposal chain had even started awaiting. Caching the promise
     here means every caller — the abort listener, the returned `cleanup`,
     `dispose(generation)` — is handed the ONE promise that only settles once
     disposal (synchronous for the three engine, `scene.dispose().then(
     renderer.dispose())` for Moss) actually has. */
  let teardownPromise;
  function teardown() {
    if (!teardownPromise) teardownPromise = performTeardown();
    return teardownPromise;
  }

  async function performTeardown() {
    const failures = [];
    const instanceWorld = world;
    let disposalWork;
    /* Shared by the synchronous `attempt()` steps below AND the awaited
       world-disposal step at the end: a nested `AggregateError` (the shape
       `world.mjs`'s own `dispose()` throws when several of ITS sub-steps
       fail) gets flattened into the individual sub-failures, prefixed with
       this step's name, rather than collapsed into one opaque
       "world cleanup failed" entry that loses which resource actually
       failed. */
    const recordFailure = (step, error) => {
      if (Array.isArray(error?.failures)) {
        failures.push(...error.failures.map((failure) => ({
          step: `${step}.${failure.step}`,
          error: failure.error instanceof Error
            ? failure.error
            : new Error(String(failure.error)),
        })));
      } else {
        failures.push(cleanupFailure(step, error));
      }
    };
    const attempt = (step, cleanup, complete) => {
      try {
        cleanup();
      } catch (error) {
        recordFailure(step, error);
      } finally {
        try {
          complete?.();
        } catch (error) {
          failures.push(cleanupFailure(`${step}.release`, error));
        }
      }
    };
    try {
      attempt("host-signal-listener", () =>
        context.signal?.removeEventListener?.("abort", onHostAbort));
      attempt("activity", () => activity.dispose());
      attempt("mount-signal", () => controller.abort());
      if (unsubscribe) {
        const current = unsubscribe;
        attempt("source.unsubscribe", current, () => {
          if (unsubscribe === current) unsubscribe = undefined;
        });
      }
      if (observer) {
        const current = observer;
        attempt("resize-observer", () => current.disconnect(), () => {
          if (observer === current) observer = undefined;
        });
      }
      attempt("visibility-listener", () =>
        document.removeEventListener("visibilitychange", onVisibility));
      attempt("pointermove-listener", () =>
        canvas.removeEventListener("pointermove", onCanvasPointerMove));
      attempt("pointerdown-listener", () =>
        canvas.removeEventListener("pointerdown", onPointerDown));
      attempt("pointerup-listener", () =>
        canvas.removeEventListener("pointerup", onPointerUp));
      attempt("wheel-listener", () => canvas.removeEventListener("wheel", onWheel));
      attempt("keyboard-listener", () => window.removeEventListener("keydown", onKey));
      if (world) {
        const current = world;
        try {
          disposalWork = Promise.resolve(current.dispose());
        } catch (error) {
          disposalWork = Promise.reject(error);
        }
        if (world === current) world = undefined;
      }
    } finally {
      attempt("debug-handle", () => {
        if (window.__village?.world === instanceWorld) delete window.__village;
      });
      attempt("root.remove", () => root.remove());
      attempt("stylesheet.release", releaseStylesheet);
      unsubscribe = undefined;
      observer = undefined;
      world = undefined;
      if (liveInstances.get(generation) === teardown) liveInstances.delete(generation);
    }
    if (disposalWork) {
      try {
        await disposalWork;
      } catch (error) {
        recordFailure("world.dispose", error);
      }
    }
    if (failures.length > 0) throw cleanupError(failures);
  }
  teardown.unmount = teardown;
  liveInstances.set(generation, teardown);
  /** Fire-and-forget `teardown()`, routing any rejection to `terminalFailures`
   * so `dispose(generation)` can still surface it later instead of it
   * becoming an unhandled rejection — the same contract `onHostAbort` always
   * had, now shared with every synchronous call site below. */
  function triggerTeardown() {
    return teardown().catch((error) => {
      terminalFailures.set(generation, detachedCleanupError(error));
    });
  }
  onHostAbort = () => {
    void triggerTeardown();
  };
  if (context.signal?.aborted) onHostAbort();
  else context.signal?.addEventListener?.("abort", onHostAbort, { once: true });

  function requireActive() {
    try {
      activity.throwIfDisposed();
    } catch (error) {
      void triggerTeardown();
      throw error;
    }
  }

  /* ── data ────────────────────────────────────────────────────────────── */
  requireActive();
  const source = await activity.race(
    createSource({ ...context, signal: controller.signal }),
  );
  requireActive();
  let data;
  try {
    requireActive();
    data = await activity.race(source.load());
    requireActive();
    if (previewNow) data.now = previewNow;
  } catch (error) {
    if (!activity.active || error?.name === "AbortError") {
      void triggerTeardown();
      throw error;
    }
    /* R2. `error.message` is a CONTRACT STRING — it comes off the wire, from a
       server response body this theme does not control. It reached the DOM
       through innerHTML here, which is the precise pattern R2 forbids: a
       failure message is exactly the payload an attacker gets to influence.
       Built as text nodes now, so markup in it stays inert and is displayed
       rather than executed. */
    const card = el("div", "cv-tour-card");
    card.style.cssText = "position:absolute;top:2rem;left:2rem;max-width:32rem";
    card.appendChild(el("h3", null, "The village cannot reach Atelier."));
    card.appendChild(el("p", null, String(error?.message ?? error)));
    const hint = el("p");
    hint.append(
      safeText("Open with "),
      el("code", null, "?data=fixture"),
      safeText(" to view this repository's real merge history without a server."),
    );
    card.appendChild(hint);
    root.appendChild(card);
    return teardown;
  }

  const store = new VillageStore(data);
  let projectOptions = data.projects ?? [data.project];

  /* The signboards are baked into canvas textures ONCE, at build time. A
     canvas silently uses whatever face is ready when `fillText` runs, so
     building before the webfont arrives bakes the fallback into a texture
     nothing ever redraws — the chrome would switch to the real face and the
     village would keep the wrong one forever. Bounded, and failure-tolerant:
     a font that never loads must not be able to stop the village opening. */
  requireActive();
  await fontReady(activity);
  requireActive();

  /* ── renderer + world ────────────────────────────────────────────────── */
  /* TIMING CONTRACT (see world/engine.mjs's header): only the renderer-
     creation half of engine mount sits inside this try, matching what
     `entry.mjs` did before the engine seam existed — `createRenderer()`
     awaited here, `createWorld()` called synchronously afterward, OUTSIDE
     this try. A `createWorld()` throw is therefore NOT caught by this
     catch/teardown boundary, same as base. */
  let engineResult;
  try {
    requireActive();
    engineResult = await activity.race(mountEngine(engineId, {
      canvas,
      generation,
      signal: controller.signal,
    }));
    if (!activity.active) {
      /* Base disposed the renderer directly here — `createWorld()` was
         never reached on this path. Three exposes `renderer` so that stays
         true; Moss has no separate renderer stage, so its `createWorld()`
         is a trivial accessor over the scene it already finished building,
         and disposing that is the equivalent full release. */
      if (engineResult.renderer) {
        engineResult.renderer.dispose?.();
        engineResult.renderer.forceContextLoss?.();
      } else {
        engineResult.createWorld(activity.delay)?.dispose?.();
      }
      requireActive();
    }
  } catch (error) {
    void triggerTeardown();
    throw error;
  }
  const { createWorld: buildWorldFor, describe: describeRenderer } = engineResult;
  world = buildWorldFor(activity.delay);
  /* H2: Moss's `build()` is genuinely async (awaited bitmap uploads, seven
     sequential station builders) — awaiting it here means `mount()` only
     resolves once the scene is actually committed, not merely started. */
  await world.build(store.village);
  world.setMotion(!reduced);

  const panel = buildPanel({
    onAction: (action, target) => runAction(action, target),
    dashboardHref: (id) => source.dashboardHref(id),
  });
  root.appendChild(panel.element);

  /* ── the rail ────────────────────────────────────────────────────────── */

  let projectSwitching = false;

  function renderRail() {
    const v = store.village;
    rail.replaceChildren();

    const projectPicker = el("label", "cv-project-picker");
    projectPicker.appendChild(el("span", "cv-eyebrow", "Project"));
    const projectSelect = el("select", "cv-project-select");
    projectSelect.setAttribute("aria-label", "Village project");
    for (const project of projectOptions) {
      const option = el("option");
      option.value = project.name;
      option.textContent = Number.isFinite(project.chronicleRecords)
        ? `${project.name} · ${project.chronicleRecords} merges`
        : project.name;
      projectSelect.appendChild(option);
    }
    projectSelect.value = v.project.name;
    projectSelect.disabled = projectSwitching || typeof source.selectProject !== "function";
    projectSelect.addEventListener("change", () => {
      void switchProject(projectSelect.value);
    });
    projectPicker.appendChild(projectSelect);
    rail.appendChild(projectPicker);

    /* THE 3-SECOND READ, in words. */
    const owed = el("section", "cv-owed");
    owed.dataset.lit = String(v.decisionsOwed > 0);
    owed.appendChild(el("p", "cv-eyebrow", "Village now"));
    owed.appendChild(el("div", "cv-owed-count", String(v.parcels.length)));
    owed.appendChild(
      el(
        "div",
        "cv-owed-label",
        `${v.stats.ready} ready · ${v.workshop.parcels.length} at work · ` +
          `${v.assay.parcels.length} in assay · ${v.hall.mergeQueue.length} awaiting merge`,
      ),
    );
    if (v.mainHealth.owed) {
      owed.appendChild(el("p", "cv-card-alert", "Main has an unacknowledged failure at the test dock."));
    } else if (v.quiet) {
      owed.appendChild(el("p", "cv-owed-quiet", "A quiet village. Nothing is in flight."));
    }
    rail.appendChild(owed);

    const stations = el("section");
    stations.appendChild(el("h3", "cv-eyebrow", "Seven stations"));
    stations.appendChild(buildStationList(v, { onSelect: select }));
    rail.appendChild(stations);

    if (v.board.papers.length || v.board.warning) {
      const section = el("section");
      section.appendChild(el("h3", "cv-eyebrow", "Ready at the notice board"));
      if (v.board.warning) {
        section.appendChild(el("p", "cv-card-alert", v.board.warnings.join(" · ")));
      }
      section.appendChild(buildNoticeList(v, { onSelect: select }));
      rail.appendChild(section);
    }

    if (v.parcels.length) {
      const section = el("section");
      section.appendChild(el("h3", "cv-eyebrow", `Dispatch parcels · ${v.parcels.length}`));
      section.appendChild(buildParcelList(v, { onSelect: select }));
      rail.appendChild(section);
    }

    rail.appendChild(buildLedger(v));

    const help = el("div");
    help.style.cssText = "display:flex;gap:0.4rem;flex-wrap:wrap;padding-bottom:0.5rem";
    const tourBtn = el("button", "cv-btn", "How to read this");
    tourBtn.addEventListener("click", () => tour.open());
    const viewBtn = el("button", "cv-btn", world.framing === "village" ? "Closer to the green" : "See the whole village");
    viewBtn.addEventListener("click", () => {
      world.frameCamera(world.framing === "village" ? "green" : "village");
      renderRail();
    });
    help.append(tourBtn, viewBtn);
    rail.appendChild(help);
  }

  function renderCorner() {
    const v = store.village;
    corner.replaceChildren();
    const clock = el("div", "cv-corner-line");
    clock.appendChild(el("span", null, previewNow ? "Clock preview" : "Clock"));
    clock.appendChild(el("b", null, v.clock.hhmm));
    clock.appendChild(el("span", null, v.clock.phase));
    corner.appendChild(clock);

    if (v.season.convoyLabel) {
      const season = el("div", "cv-corner-line");
      season.appendChild(el("span", null, "Season"));
      season.appendChild(el("b", null, v.season.name));
      season.appendChild(el("span", null, `${v.season.convoyLabel} · ${v.season.convoyProgress}`));
      corner.appendChild(season);
    }

    const health = el("div", "cv-corner-line");
    health.appendChild(el("span", null, "Main"));
    health.appendChild(el("b", null, v.mainHealth.state));
    if (v.mainHealth.unresolved) {
      health.appendChild(el("span", null, `${v.mainHealth.unresolved} marked at test dock`));
    }
    corner.appendChild(health);

    const spend = el("div", "cv-corner-line");
    spend.appendChild(el("span", null, "Unlanded"));
    spend.appendChild(el("b", null, formatUSD(v.stats.unlandedSpendUSD)));
    spend.appendChild(el("span", null, "spent, not yet merged"));
    corner.appendChild(spend);

    /* A demo that cannot say whether it is showing real data is exactly the
       thing this program refuses to ship, so the source always names itself. */
    const described = source.describe();
    const rendered = describeRenderer();
    const provenance = el(
      "div",
      "cv-provenance",
      `${described.label} — ${described.detail} · ${rendered.backend.toUpperCase()} · ${rendered.tier} tier`,
    );
    // How the tier was decided, on hover: a measured cost or the fallback.
    provenance.title = rendered.notes.join("\n");
    corner.appendChild(provenance);
  }

  /* ── selection ───────────────────────────────────────────────────────── */

  /**
   * The lamp phase clock. The three decision lamps BREATHE — a sine on this
   * value drives their glow scale and opacity — so passing a running clock
   * here kept them pulsing after the reader asked for motion off. R6 says
   * reduced motion may remove movement but must remove no state: a frozen
   * phase keeps every lamp exactly as LIT or as dark as it was, and only the
   * breathing stops. Zero is the phase at which the breath is at its rest
   * value, so a lamp does not freeze mid-flare either.
   */
  const lampPhase = () => (reduced ? 0 : performance.now() / 1000);

  let busy = false;
  let actionError = null;

  function select(entity) {
    if (!entity) return;
    /* The hover card and the panel say the same things about the same record,
       so leaving the card up behind the panel showed the reader two copies of
       one record and let the card follow the pointer over the panel it had
       just opened. `hovered` is cleared too, or moving the pointer inside the
       entity you just clicked would not bring the card back. */
    card.dataset.open = "false";
    hovered = null;
    panel.open(entity, { project: store.project, busy, error: actionError });
    world.invalidate();
  }

  function showToast(text, ms = 3200) {
    if (!activity.active) return;
    toast.textContent = text;
    toast.dataset.open = "true";
    activity.timeout(() => {
      toast.dataset.open = "false";
    }, ms);
  }

  async function runAction(action, target) {
    if (!activity.active) return;
    const id = target.dispatchId ?? target.id;
    busy = true;
    actionError = null;
    panel.update({ project: store.project, busy, error: null });
    try {
      if (action === "merge") {
        await source.merge(id);
        showToast(`Merging ${target.ticketId ?? id}…`);
      } else if (action === "dismiss") {
        await source.dismiss(id);
        showToast("Dismissed.");
        panel.close();
      } else if (action === "reply") {
        const text = window.prompt(`Reply to ${target.villager?.name ?? id}:`);
        if (text) {
          await source.reply(id, text);
          showToast("Sent. They are back at work.");
          panel.close();
        }
      } else if (action === "ack") {
        const acknowledged = await source.ackMainHealth(id);
        store.applyMainHealthRecord(acknowledged);
        world.applyLamps(store.village, lampPhase());
        renderRail();
        renderCorner();
        showToast("Acknowledged. The bell is quiet — the marked dock parcel and scaffold stay.");
      }
    } catch (error) {
      if (!activity.active) return;
      actionError = error.message ?? String(error);
      showToast(`Refused: ${actionError}`, 5200);
    } finally {
      if (!activity.active) return;
      busy = false;
      panel.update({ project: store.project, busy, error: actionError });
    }
  }

  /* ── the live feed ───────────────────────────────────────────────────── */

  /**
   * R1 + R3. Replace the whole world from freshly-read projections.
   *
   * Used on stream reconnect and whenever the tab comes back to the front.
   * A backgrounded tab has its rAF loop throttled or suspended, so events
   * arrive against a store the renderer has not been keeping up with — and
   * missed events are simply gone. Re-reading is the only honest recovery.
   *
   * Note what this deliberately does NOT do: it does not replay the missed
   * interval as animation. No crossing is replayed for a merge that landed
   * while you were in another tab, and no lamp "arrives" — the village
   * simply IS the current facts when you look at it again. Replaying missed
   * paint as progress is precisely what R1 forbids, and it would also be the
   * one way this world could show you a celebration you never earned.
   */
  let resyncing = false;
  async function resyncFromServer(fresh) {
    if (!activity.active || resyncing) return;
    resyncing = true;
    try {
      const next = fresh ?? (await source.load());
      if (!activity.active) return;
      projectOptions = next.projects ?? projectOptions;
      store.replace(next);
      await world.build(store.village);
      world.applyLamps(store.village, lampPhase());
      renderRail();
      renderCorner();
      if (panel.current) panel.close();
    } catch (error) {
      if (!activity.active) return;
      showToast(`Could not refresh from Atelier: ${error.message}`, 5000);
    } finally {
      resyncing = false;
    }
  }

  async function switchProject(name) {
    if (!activity.active || projectSwitching || name === store.project.name || !source.selectProject) return;
    projectSwitching = true;
    renderRail();
    try {
      const next = await source.selectProject(name);
      if (!activity.active) return;
      projectOptions = next.projects ?? projectOptions;
      store.replace(next);
      await world.build(store.village);
      world.applyLamps(store.village, lampPhase());
      panel.close();
      renderRail();
      renderCorner();
      showToast(`Now viewing ${store.project.name}.`);
    } catch (error) {
      if (!activity.active) return;
      showToast(`Could not switch project: ${error.message}`, 5000);
    } finally {
      if (!activity.active) return;
      projectSwitching = false;
      renderRail();
    }
  }

  /* A tab that was in the background is showing stale facts by definition. */
  function onVisibility() {
    if (document.visibilityState === "visible") resyncFromServer();
  }
  document.addEventListener("visibilitychange", onVisibility);

  unsubscribe = source.subscribe(async (event) => {
    if (!activity.active) return;
    if (event.type === "stream.degraded") return;
    if (event.type === "stream.resync") {
      await resyncFromServer(event.data);
      return;
    }
    const change = store.applyEvent(event);
    if (!change) return;

    if (change.kind === "board") {
      await world.build(store.village);
      renderRail();
      renderCorner();
      world.applyLamps(store.village, lampPhase());
      return;
    }

    if (change.kind === "merged") {
      await world.build(store.village);
      await world.animateTransition(change, { reduced });
      if (!activity.active) return;
      renderRail();
      renderCorner();
      world.applyLamps(store.village, lampPhase());
      showToast("Merged. The parcel crossed the test dock and is awaiting archive.", 4200);
      /* The chime hook: a real DOM event carrying the real dispatch id. */
      root.dispatchEvent(new CustomEvent("village:merged", { bubbles: true, detail: { dispatchId: change.dispatchId } }));
      if (panel.current?.data?.dispatchId === change.dispatchId) panel.close();
      return;
    }

    if (change.kind === "arrived") {
      await world.build(store.village);
      await world.animateTransition(change, { reduced });
      if (!activity.active) return;
      renderRail();
      showToast(`${change.parcel?.villager?.name ?? "An agent"} carried a real dispatch to the workshop.`);
      return;
    }

    if (change.kind === "moved") {
      await world.build(store.village);
      await world.animateTransition(change, { reduced });
      if (!activity.active) return;
      renderRail();
      renderCorner();
      world.applyLamps(store.village, lampPhase());
      return;
    }

    if (change.kind === "activity") {
      await world.build(store.village);
      world.applyLamps(store.village, lampPhase());
    }
    renderRail();
    renderCorner();
  });

  /* ── input ───────────────────────────────────────────────────────────── */

  let pointer = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
  let hovered = null;

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer = {
      x: event.clientX,
      y: event.clientY,
      ndcX: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ndcY: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    };
    world.setParallax(pointer.ndcX, pointer.ndcY);

    const hit = world.pick(pointer.ndcX, pointer.ndcY);
    const key = hit ? `${hit.kind}:${hit.data?.id ?? ""}` : null;
    if (key !== hovered) {
      hovered = key;
      if (hit) {
        card.replaceChildren(buildCard(hit, { project: store.project }));
        card.dataset.open = "true";
        canvas.style.cursor = "pointer";
      } else {
        card.dataset.open = "false";
        canvas.style.cursor = "default";
      }
    }
    if (card.dataset.open === "true") {
      const width = card.offsetWidth || 300;
      const height = card.offsetHeight || 200;
      card.style.left = `${Math.min(pointer.x + 16, window.innerWidth - width - 16)}px`;
      card.style.top = `${Math.min(pointer.y + 16, window.innerHeight - height - 16)}px`;
    }
  }

  function onClick() {
    const hit = world.pick(pointer.ndcX, pointer.ndcY);
    if (hit) select(hit);
  }

  function onKey(event) {
    if (event.key === "Escape") {
      panel.close();
      tour.close();
      card.dataset.open = "false";
    } else if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
      tour.open();
    } else if (event.key.toLowerCase() === "t") {
      world.frameCamera(world.framing === "village" ? "green" : "village");
      renderRail();
    } else if (event.key.toLowerCase() === "m") {
      reduced = !reduced;
      world.setMotion(!reduced);
      showToast(reduced ? "Motion off. Every fact is still on screen." : "Motion on.");
    } else if (event.key.toLowerCase() === "r") {
      root.dataset.rail = root.dataset.rail === "hidden" ? "shown" : "hidden";
      resize();
    }
  }

  /* Scroll to zoom, drag to orbit. The village is an object you are holding,
     so it should turn in your hand. */
  let dragging = null;
  function onWheel(event) {
    event.preventDefault();
    world.zoomBy(event.deltaY);
  }
  function onPointerDown(event) {
    dragging = { x: event.clientX, y: event.clientY, moved: 0 };
    canvas.setPointerCapture?.(event.pointerId);
  }
  function onPointerUp(event) {
    canvas.releasePointerCapture?.(event.pointerId);
    // A drag is not a click: only a near-stationary release selects.
    const wasClick = dragging && dragging.moved < 5;
    dragging = null;
    if (wasClick) onClick();
  }
  function onDrag(event) {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging.moved += Math.abs(dx) + Math.abs(dy);
    dragging.x = event.clientX;
    dragging.y = event.clientY;
    world.orbitBy(dx, dy);
  }

  // Named, so teardown can remove it by reference.
  function onCanvasPointerMove(event) {
    if (dragging) onDrag(event);
    else onPointerMove(event);
  }

  canvas.addEventListener("pointermove", onCanvasPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);

  function resize() {
    const rect = root.getBoundingClientRect();
    /* The rail sits OVER the canvas, so tell the world how much of its own
       frame it cannot use. It shifts the frustum rather than the camera, and
       the village stays composed in the part you can actually see.

       The rail is a right-hand column on a wide viewport and a bottom sheet on
       a narrow one — that is a CSS decision (`@media (max-width: 60rem)`), and
       the old code re-derived it here as `innerWidth < 960`, then reported
       ZERO obscured area for the narrow case. So on a phone the world believed
       it had the whole screen while the rail covered the bottom 52% of it, and
       fitted the village into a frame half of which was behind the sheet.

       Asking the LAYOUT which shape the rail currently has cannot drift from
       the stylesheet the way a copied breakpoint can. */
    const railRect = rail.getBoundingClientRect();
    const hidden = root.dataset.rail === "hidden";
    const isBottomSheet = railRect.width >= rect.width - 1;
    world.resize(Math.max(1, rect.width), Math.max(1, rect.height), {
      obscuredRight: hidden || isBottomSheet ? 0 : railRect.width,
      obscuredBottom: hidden || !isBottomSheet ? 0 : railRect.height,
    });
  }
  observer = new ResizeObserver(resize);
  observer.observe(root);
  resize();

  /* ── the frame loop ──────────────────────────────────────────────────── */

  let last = performance.now();
  let clockTick = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // The clock is re-derived once a minute. It is the only thing allowed to
    // move the world without a gate transition, because it claims nothing.
    clockTick += dt;
    if (clockTick > 30) {
      clockTick = 0;
      store.tickClock(previewNow ?? new Date());
      world.applyClock(store.village.clock);
      world.applyNight(store.village.clock);
      renderCorner();
    }

    world.update(dt, now);
    world.applyLamps(store.village, lampPhase());

    /* Draw-on-demand: with motion off, or a hidden tab, the loop costs nothing.
       A still village is a still frame, not a spinning GPU. */
    if (world.needsRender && document.visibilityState === "visible") world.render();
  }

  activity.startFrame(frame);

  renderRail();
  renderCorner();
  world.playOpening({ reduced });

  if (!localStorage.getItem(SEEN_KEY)) {
    const hint = el("div", "cv-hint");
    hint.appendChild(el("span", null, "New here?"));
    const open = el("button", "cv-btn", "How work moves");
    open.addEventListener("click", () => {
      tour.open();
      localStorage.setItem(SEEN_KEY, "1");
      hint.remove();
    });
    const skip = el("button", "cv-btn cv-btn-ghost", "Dismiss");
    skip.addEventListener("click", () => {
      localStorage.setItem(SEEN_KEY, "1");
      hint.remove();
    });
    hint.append(open, skip);
    root.appendChild(hint);
  }

  /* A console handle, so any hour of the day can be inspected without waiting
     for it. Same contract as the direction-E hero. */
  window.__village = {
    world,
    store,
    source,
    rebuild: async (now) => {
      store.rebuild(now);
      await world.build(store.village);
      renderRail();
      renderCorner();
      return store.village;
    },
    stats: () => world.stats(),
  };

  /* THE CORE'S CONTRACT IS A CLEANUP FUNCTION.
     ui/app.js does `const cleanup = await mount(host)` and later
     `if (typeof cleanup === "function") await cleanup()`. An object with an
     `unmount` method type-checks as "no cleanup", so every switch away from
     the village would have leaked a WebGL context, a requestAnimationFrame
     loop and an SSE subscription — compounding on each switch. `.unmount` is
     kept as a property because the standalone harness calls it by name. */
  return teardown;
}

/* `entryModule.mount ?? entryModule.default` — the named export is what the
   core picks up. The default keeps the object form for direct importers. */
export default { mount };
