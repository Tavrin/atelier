/**
 * RENDERER SELECTION — WebGPU where available, WebGL otherwise.
 *
 * The flagship policy asks for `WebGPURenderer` where available with a WebGL
 * fallback. This build ships WEBGL, and the reason is concrete rather than a
 * preference:
 *
 *   The vendored three.js is r170's CORE build (`three.module.js`). It does
 *   not contain WebGPURenderer — verified: `grep -c WebGPURenderer` returns 0,
 *   and the class list contains WebGLRenderer only. r170's WebGPU path lives
 *   in the separate `three.webgpu.js` bundle (TSL/node materials), which is
 *   not vendored here and cannot be fetched at build time in this
 *   no-network, zero-dependency repo.
 *
 * So the seam is built and the capability is probed, but the WebGPU branch is
 * unreachable until `three.webgpu.js` is vendored beside the core build. When
 * it is, `loadWebGPURenderer` is the ONLY function that needs to change, and
 * the materials this theme uses (MeshStandardMaterial, MeshBasicMaterial,
 * Sprite) are all supported by the node-material bridge.
 *
 * `describe()` reports what actually happened, so the page can never claim a
 * backend it is not running.
 */

import * as THREE from "../vendor/three.module.js";
import { abortError, raceAbort, throwIfAborted } from "../abort.mjs";

const RENDERER_ABORT_MESSAGE = "Cozy Village renderer initialization was aborted";
const rendererStartupSlots = new Map();
const rendererModuleLoadSlots = new Map();

function disposeRenderer(renderer) {
  const failures = [];
  try {
    renderer?.dispose?.();
  } catch (error) {
    failures.push({ step: "renderer.dispose", error });
  }
  try {
    renderer?.forceContextLoss?.();
  } catch (error) {
    failures.push({ step: "renderer.force-context-loss", error });
  }
  return failures;
}

function requireRendererStartup(token) {
  const slot = rendererStartupSlots.get(token);
  if (!slot) throwIfAborted({ aborted: true }, RENDERER_ABORT_MESSAGE);
  throwIfAborted(slot.signal, RENDERER_ABORT_MESSAGE);
  return slot.renderer;
}

/**
 * Run a provider-owned async initializer with a receiver that retains only its
 * generation token. Every `this.*` access re-resolves the renderer through the
 * slot, which teardown deletes synchronously before late initializer work can
 * reach the canvas or GPU state.
 */
function rendererStartupReceiver(token, prototype) {
  const target = Object.create(prototype);
  return new Proxy(target, {
    get(_target, property, receiver) {
      return Reflect.get(requireRendererStartup(token), property, receiver);
    },
    set(_target, property, value) {
      return Reflect.set(requireRendererStartup(token), property, value);
    },
    has(_target, property) {
      return Reflect.has(requireRendererStartup(token), property);
    },
  });
}

async function initializeRenderer(token, signal, prototype) {
  const receiver = rendererStartupReceiver(token, prototype);
  const init = requireRendererStartup(token).init;
  if (typeof init !== "function") return;
  try {
    await raceAbort(Reflect.apply(init, receiver, []), signal, RENDERER_ABORT_MESSAGE);
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  } finally {
    rendererStartupSlots.delete(token);
  }
}

function takeRendererModuleLoad(token) {
  const slot = rendererModuleLoadSlots.get(token);
  if (!slot) return undefined;
  rendererModuleLoadSlots.delete(token);
  slot.signal?.removeEventListener?.("abort", slot.onAbort);
  return slot;
}

function abortRendererModuleLoad(token) {
  const slot = takeRendererModuleLoad(token);
  slot?.reject(abortError(RENDERER_ABORT_MESSAGE));
}

function completeRendererModuleLoad(token, module) {
  const pending = rendererModuleLoadSlots.get(token);
  if (!pending) return;
  if (pending.signal?.aborted) {
    abortRendererModuleLoad(token);
    return;
  }
  takeRendererModuleLoad(token)?.resolve(module.WebGPURenderer ?? null);
}

function failRendererModuleLoad(token) {
  const pending = rendererModuleLoadSlots.get(token);
  if (!pending) return;
  if (pending.signal?.aborted) {
    abortRendererModuleLoad(token);
    return;
  }
  takeRendererModuleLoad(token)?.resolve(null);
}

function startRendererModuleLoad(token) {
  if (!rendererModuleLoadSlots.has(token)) return;
  import("../vendor/three.webgpu.js").then(
    (module) => completeRendererModuleLoad(token, module),
    () => failRendererModuleLoad(token),
  );
}

/** Is a WebGPU adapter reachable at all? Probed once, cheaply, never retried. */
export async function probeWebGPU({ signal } = {}) {
  throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  if (!globalThis.navigator?.gpu) return { available: false, reason: "navigator.gpu absent" };
  try {
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    const adapter = await raceAbort(
      navigator.gpu.requestAdapter(),
      signal,
      RENDERER_ABORT_MESSAGE,
    );
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    if (!adapter) return { available: false, reason: "no GPU adapter" };
    return { available: true, reason: "adapter acquired" };
  } catch (error) {
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    return { available: false, reason: `adapter request failed: ${error.message}` };
  }
}

/**
 * Load a WebGPURenderer if the vendored bundle provides one.
 * Returns null when the class is absent, which is the case for a core build.
 */
function loadWebGPURenderer({ signal } = {}) {
  throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  return new Promise((resolve, reject) => {
    const token = Symbol("cozy-village-renderer-module-load");
    const onAbort = () => abortRendererModuleLoad(token);
    rendererModuleLoadSlots.set(token, { onAbort, reject, resolve, signal });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    queueMicrotask(() => startRendererModuleLoad(token));
  });
}

/**
 * @returns {Promise<{renderer, backend, capabilities, describe}>}
 */
export async function createRenderer({ canvas, preferWebGPU = true, signal, generation } = {}) {
  const notes = [];
  let renderer;
  const cleanupFailures = [];

  try {
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    if (preferWebGPU) {
      throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
      const probe = await probeWebGPU({ signal });
      throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
      notes.push(`WebGPU probe: ${probe.reason}`);
      if (probe.available) {
        throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
        const WebGPURenderer = await loadWebGPURenderer({ signal });
        throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
        if (WebGPURenderer) {
          renderer = new WebGPURenderer({ canvas, antialias: true, alpha: false });
          const startupToken = generation ?? Symbol("cozy-village-renderer-startup");
          rendererStartupSlots.set(startupToken, { renderer, signal });
          const disposeOnAbort = () => {
            const stale = rendererStartupSlots.get(startupToken);
            rendererStartupSlots.delete(startupToken);
            cleanupFailures.push(...disposeRenderer(stale?.renderer));
          };
          signal?.addEventListener?.("abort", disposeOnAbort, { once: true });
          try {
            throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
            await initializeRenderer(startupToken, signal, Object.getPrototypeOf(renderer));
            throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
          } finally {
            rendererStartupSlots.delete(startupToken);
            signal?.removeEventListener?.("abort", disposeOnAbort);
          }
          return finish(renderer, "webgpu", notes, signal);
        }
        notes.push("WebGPURenderer not in the vendored build (core r170) — using WebGL");
      }
    }

    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
    return finish(renderer, "webgl", notes, signal);
  } catch (error) {
    cleanupFailures.push(...disposeRenderer(renderer));
    if (cleanupFailures.length > 0) {
      const failures = [
        { step: "renderer.startup", error },
        ...cleanupFailures,
      ];
      const cleanupError = new AggregateError(
        failures.map((failure) => failure.error),
        "Cozy Village renderer startup cleanup failed",
      );
      cleanupError.name = "CozyVillageRendererCleanupError";
      cleanupError.failures = failures;
      throw cleanupError;
    }
    throw error;
  }
}

function finish(renderer, backend, notes, signal) {
  throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Milk paint is a diffuse, handled surface. ACES would crush the warmth out
  // of the lamplight; the neutral tone mapping keeps the paint where it was
  // mixed, and the exposure does the dusk work instead.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* A conservative quality tier, so the village is playable on integrated
     graphics without asking. Everything expensive keys off this one number. */
  const dpr = globalThis.devicePixelRatio ?? 1;
  const gl = backend === "webgl" ? renderer.getContext?.() : null;
  const renderedBy = gl?.getExtension?.("WEBGL_debug_renderer_info")
    ? gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL)
    : "";
  const named = String(renderedBy || "");

  /**
   * WHAT THE TIER IS ACTUALLY MEASURED FROM.
   *
   * The tier used to be a regex over the GPU's marketing name, which is a
   * guess wearing a fact's clothes. `/intel/` demotes an Arc A770 and a 2013
   * HD 4000 identically; it reads a hardware-accelerated Apple M3 as low
   * because the string contains "Apple M3 ("; and every browser that masks
   * `UNMASKED_RENDERER_WEBGL` for fingerprinting reasons — which is now the
   * default in several — hands back "" and gets the HIGH tier by accident,
   * which is the failure pointing the wrong way.
   *
   * So the tier is measured: `probeCost` renders a small known workload and
   * times it. That is a real signal about the machine in front of the user,
   * on any vendor, under any masking policy. The name survives as the
   * FALLBACK for when no measurement is available, and `describe()` reports
   * which of the two decided, because a tier nobody can account for is the
   * kind of thing that gets debugged by guessing.
   */
  throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  const measured = probeCost(renderer, signal);
  throwIfAborted(signal, RENDERER_ABORT_MESSAGE);
  const byName = /intel|llvmpipe|swiftshader|software|apple m\d? \(/i.test(named);
  const low = measured == null ? byName : measured > SLOW_FRAME_MS;
  const basis = measured == null
    ? `vendor name fallback (${named ? "no timing" : "no timing, GPU name masked"})`
    : `measured ${measured.toFixed(1)}ms for ${PROBE_DRAWS} probe draws`;

  const capabilities = {
    backend,
    tier: low ? "low" : "high",
    shadowMapSize: low ? 1024 : 2048,
    maxPixelRatio: low ? 1.25 : 2,
    ambientDetail: low ? 0.45 : 1,
    renderedBy: named || "unreported",
    tierBasis: basis,
    probeMs: measured,
  };
  renderer.setPixelRatio(Math.min(dpr, capabilities.maxPixelRatio));

  return {
    renderer,
    backend,
    capabilities,
    describe: () => ({
      backend,
      tier: capabilities.tier,
      gpu: capabilities.renderedBy,
      notes: [...notes, `tier ${capabilities.tier} from ${basis} (shadow ${capabilities.shadowMapSize}²)`],
    }),
  };
}

/** Draw calls issued by the probe. Enough to time; too few to be felt. */
const PROBE_DRAWS = 120;
/**
 * The budget the probe workload must beat to earn the high tier.
 *
 * `PROBE_DRAWS` shadow-casting meshes is roughly a third of the village's
 * ~391 draw calls, so a machine taking longer than this over the probe is not
 * going to hold a frame budget with the full town, 2048² shadows and a 2×
 * pixel ratio on top. Deliberately generous: the cost of demoting a capable
 * machine is a slightly softer shadow, and the cost of promoting a weak one
 * is an unusable village.
 */
const SLOW_FRAME_MS = 22;

/**
 * Time a small known workload on the real device.
 *
 * WebGL is asynchronous, so a bare `render()` returns before the GPU has
 * finished and times nothing. `getError()` is a synchronising call — it
 * flushes the pipeline and blocks until the driver answers — so the elapsed
 * span really does contain the work. Returns null when there is nothing
 * trustworthy to report rather than a number that only looks like one.
 */
function probeCost(renderer, signal) {
  throwIfAborted(signal);
  const gl = renderer.getContext?.();
  if (!gl || typeof performance?.now !== "function") return null;
  let geometry;
  let material;
  let target;
  let previous;
  try {
    const scene = new THREE.Scene();
    geometry = new THREE.BoxGeometry(1, 1, 1);
    material = new THREE.MeshStandardMaterial();
    for (let i = 0; i < PROBE_DRAWS; i++) {
      const box = new THREE.Mesh(geometry, material);
      box.position.set((i % 12) - 6, Math.floor(i / 12) - 5, 0);
      scene.add(box);
    }
    scene.add(new THREE.DirectionalLight(0xffffff, 1));
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 18);

    target = new THREE.WebGLRenderTarget(256, 256);
    previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    // A warm-up pass, so shader compilation and buffer upload are not timed
    // as if they were per-frame cost.
    renderer.render(scene, camera);
    gl.getError();

    const start = performance.now();
    renderer.render(scene, camera);
    gl.getError();
    const elapsed = performance.now() - start;

    throwIfAborted(signal);
    return Number.isFinite(elapsed) ? elapsed : null;
  } catch (error) {
    throwIfAborted(signal);
    // A probe is a convenience. It must never be the reason a village fails
    // to open, so any failure simply hands the decision to the name.
    return null;
  } finally {
    if (target && previous !== undefined) {
      try {
        renderer.setRenderTarget(previous);
      } catch {
        // Disposal below is still required if restoring the target fails.
      }
    }
    target?.dispose?.();
    geometry?.dispose?.();
    material?.dispose?.();
  }
}
