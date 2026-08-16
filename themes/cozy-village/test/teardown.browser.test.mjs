import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { setPriority, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("../../../", import.meta.url);

async function availableChromium() {
  for (const candidate of [
    process.env.ATELIER_CHROME_BIN,
    process.env.CHROME_BIN,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
    process.platform === "darwin"
      ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      : undefined,
    process.platform === "win32"
      ? join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe")
      : undefined,
    process.platform === "win32"
      ? join(
          process.env["PROGRAMFILES(X86)"] || "",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        )
      : undefined,
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA || "",
          "Microsoft",
          "Edge",
          "Application",
          "msedge.exe",
        )
      : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking for the same browser family used by the other browser gate.
    }
  }
  return undefined;
}

function teardownPage({
  geometryDisposeThrowsOnce = false,
  leakInterval = false,
  unsubscribeThrowsOnce = false,
  worldDisposeThrowsOnce = false,
} = {}) {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village teardown probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeRaf = window.requestAnimationFrame.bind(window);
          const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeClearTimeout = window.clearTimeout.bind(window);
          const nativeSetInterval = window.setInterval.bind(window);
          const nativeClearInterval = window.clearInterval.bind(window);
          const nativeSetDelete = Set.prototype.delete;
          const themeFrames = new Set();
          const themeTimers = new Set();
          let phase = 'mounting';
          let executingThemeWork = false;
          let unmounted = false;
          let frameWorkAfterUnmount = 0;
          let timerWorkAfterUnmount = 0;
          let unsubscribeDeleteCalls = 0;
          let unsubscribeDeleteThrows = 0;

          Set.prototype.delete = function(value) {
            if (phase === 'unmounting' && typeof value === 'function') {
              unsubscribeDeleteCalls += 1;
            }
            if (
              ${unsubscribeThrowsOnce ? "true" : "false"} &&
              phase === 'unmounting' &&
              unsubscribeDeleteThrows === 0 &&
              typeof value === 'function'
            ) {
              unsubscribeDeleteThrows += 1;
              throw new Error('unsubscribe failed once');
            }
            return nativeSetDelete.call(this, value);
          };

          window.requestAnimationFrame = (callback) => {
            const owned = phase === 'mounting' || phase === 'mounted' || executingThemeWork;
            let id;
            id = nativeRaf((now) => {
              themeFrames.delete(id);
              if (owned && unmounted) frameWorkAfterUnmount += 1;
              const previous = executingThemeWork;
              executingThemeWork = owned;
              try { callback(now); } finally { executingThemeWork = previous; }
            });
            if (owned) themeFrames.add(id);
            return id;
          };
          window.cancelAnimationFrame = (id) => {
            themeFrames.delete(id);
            nativeCancelRaf(id);
          };
          window.setTimeout = (callback, delay, ...args) => {
            const owned = phase === 'mounting' || phase === 'mounted' || executingThemeWork;
            let id;
            id = nativeSetTimeout(() => {
              themeTimers.delete(id);
              if (owned && unmounted) timerWorkAfterUnmount += 1;
              const previous = executingThemeWork;
              executingThemeWork = owned;
              try { callback(...args); } finally { executingThemeWork = previous; }
            }, delay);
            if (owned) themeTimers.add(id);
            return id;
          };
          window.clearTimeout = (id) => {
            themeTimers.delete(id);
            nativeClearTimeout(id);
          };
          window.setInterval = (callback, delay, ...args) => {
            const owned = phase === 'mounting' || phase === 'mounted' || executingThemeWork;
            let id;
            id = nativeSetInterval(() => {
              if (owned && unmounted) timerWorkAfterUnmount += 1;
              const previous = executingThemeWork;
              executingThemeWork = owned;
              try { callback(...args); } finally { executingThemeWork = previous; }
            }, delay);
            if (owned) themeTimers.add(id);
            return id;
          };
          window.clearInterval = (id) => {
            themeTimers.delete(id);
            nativeClearInterval(id);
          };

          try {
            let geometryDisposeCalls = 0;
            let geometryDisposeThrows = 0;
            if (${geometryDisposeThrowsOnce ? "true" : "false"}) {
              const THREE = await import('/themes/cozy-village/vendor/three.module.js');
              const nativeGeometryDispose = THREE.BufferGeometry.prototype.dispose;
              THREE.BufferGeometry.prototype.dispose = function() {
                if (phase === 'unmounting') {
                  geometryDisposeCalls += 1;
                  if (geometryDisposeCalls === 5 && geometryDisposeThrows === 0) {
                    geometryDisposeThrows += 1;
                    throw new Error('geometry disposal failed once');
                  }
                }
                return nativeGeometryDispose.call(this);
              };
            }
            const { mount, dispose } = await import('/themes/cozy-village/entry.mjs');
            const generation = Symbol('teardown-probe');
            const cleanup = await mount(host, {
              mode: 'fixture',
              scripted: false,
              generation,
            });
            phase = 'mounted';
            const leakedInterval = ${leakInterval ? "window.setInterval(() => {}, 10)" : "undefined"};
            const canvas = host.querySelector('canvas.cv-canvas');
            if (!canvas) throw new Error('village did not create its renderer canvas');
            let contextLost = 0;
            canvas.addEventListener('webglcontextlost', () => { contextLost += 1; });
            let worldDisposeCalls = 0;
            if (${worldDisposeThrowsOnce ? "true" : "false"}) {
              const world = window.__village.world;
              const nativeWorldDispose = world.dispose.bind(world);
              world.dispose = () => {
                worldDisposeCalls += 1;
                if (worldDisposeCalls === 1) throw new Error('world dispose failed once');
                return nativeWorldDispose();
              };
            }

            unmounted = true;
            phase = 'unmounting';
            let firstCleanupError;
            try {
              await cleanup();
            } catch (error) {
              firstCleanupError = error;
            }
            const releasedAfterThrow = {
              hostChildren: host.childElementCount,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            };
            if (firstCleanupError) {
              dispose(generation);
              dispose(generation);
            }
            phase = 'done';
            await new Promise((resolve) => nativeSetTimeout(resolve, 150));

            const snapshot = {
              contextLost,
              canvasConnected: canvas.isConnected,
              frameWorkAfterUnmount,
              timerWorkAfterUnmount,
              pendingThemeFrames: themeFrames.size,
              pendingThemeTimers: themeTimers.size,
              firstCleanupError: firstCleanupError?.message,
              releasedAfterThrow,
              geometryDisposeCalls,
              geometryDisposeThrows,
              worldDisposeCalls,
              unsubscribeDeleteCalls,
              unsubscribeDeleteThrows,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            };
            if (leakedInterval !== undefined) window.clearInterval(leakedInterval);
            result.textContent = JSON.stringify(snapshot);
          } catch (error) {
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function persistentUnsubscribeHostPage() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village terminal unsubscribe probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeSetDelete = Set.prototype.delete;
          const nativeSetTimeout = window.setTimeout.bind(window);
          let phase = 'mounting';
          let unsubscribeThrows = 0;

          Set.prototype.delete = function(value) {
            if (phase === 'teardown' && typeof value === 'function' && value.name !== 'track') {
              unsubscribeThrows += 1;
              throw new Error('persistent unsubscribe failure');
            }
            return nativeSetDelete.call(this, value);
          };

          try {
            const { teardownTheme, trackThemeCanvases } = await import('/theme-host.mjs');
            const entry = await import('/themes/cozy-village/entry.mjs');
            const generation = Symbol('persistent-unsubscribe');
            let controller = new AbortController();
            let tracker = trackThemeCanvases(host);
            await entry.mount(host, {
              mode: 'fixture',
              scripted: false,
              generation,
              signal: controller.signal,
            });
            let village = window.__village;
            let internalRoot = host.querySelector('.cv-root');
            let canvas = host.querySelector('canvas.cv-canvas');
            const graphReferences = {
              root: new WeakRef(internalRoot),
              canvas: new WeakRef(canvas),
              world: new WeakRef(village.world),
              source: new WeakRef(village.source),
              store: new WeakRef(village.store),
            };

            phase = 'teardown';
            let teardownResult = await teardownTheme({
              root: host,
              dispose: () => entry.dispose(generation),
              canvasTracker: tracker,
            });
            phase = 'done';
            Set.prototype.delete = nativeSetDelete;
            const surfacedFailure = {
              name: teardownResult.error?.name,
              message: teardownResult.error?.message,
              steps: teardownResult.failures.map(({ step }) => step),
            };
            teardownResult = undefined;
            tracker = undefined;
            controller = undefined;
            village = undefined;
            internalRoot = undefined;
            canvas = undefined;
            if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
            for (let pass = 0; pass < 10; pass += 1) {
              window.gc();
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            result.textContent = JSON.stringify({
              unsubscribeThrows,
              surfacedFailure,
              retainedGraph: Object.fromEntries(
                Object.entries(graphReferences).map(([key, reference]) =>
                  [key, reference.deref() !== undefined]),
              ),
              hasDebugWorld: Boolean(window.__village),
              hostChildren: host.childElementCount,
            });
          } catch (error) {
            Set.prototype.delete = nativeSetDelete;
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function abortDuringAdapterPage() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village adapter abort probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeRaf = window.requestAnimationFrame.bind(window);
          const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeClearTimeout = window.clearTimeout.bind(window);
          const nativeSetInterval = window.setInterval.bind(window);
          const nativeClearInterval = window.clearInterval.bind(window);
          const frames = new Set();
          const timers = new Set();
          let workAfterAbort = 0;
          let aborted = false;

          window.requestAnimationFrame = (callback) => {
            let id;
            id = nativeRaf((now) => {
              frames.delete(id);
              if (aborted) workAfterAbort += 1;
              callback(now);
            });
            frames.add(id);
            return id;
          };
          window.cancelAnimationFrame = (id) => {
            frames.delete(id);
            nativeCancelRaf(id);
          };
          window.setTimeout = (callback, delay, ...args) => {
            let id;
            id = nativeSetTimeout(() => {
              timers.delete(id);
              if (aborted) workAfterAbort += 1;
              callback(...args);
            }, delay);
            timers.add(id);
            return id;
          };
          window.clearTimeout = (id) => {
            timers.delete(id);
            nativeClearTimeout(id);
          };
          window.setInterval = (callback, delay, ...args) => {
            let id;
            id = nativeSetInterval(() => {
              if (aborted) workAfterAbort += 1;
              callback(...args);
            }, delay);
            timers.add(id);
            return id;
          };
          window.clearInterval = (id) => {
            timers.delete(id);
            nativeClearInterval(id);
          };

          let adapterRequested = 0;
          let resolveAdapter;
          const adapterPromise = new Promise((resolve) => { resolveAdapter = resolve; });
          Object.defineProperty(navigator, 'gpu', {
            configurable: true,
            value: {
              requestAdapter() {
                adapterRequested += 1;
                return adapterPromise;
              },
            },
          });
          const nativeGetContext = HTMLCanvasElement.prototype.getContext;
          let contextCalls = 0;
          HTMLCanvasElement.prototype.getContext = function(...args) {
            contextCalls += 1;
            return nativeGetContext.apply(this, args);
          };

          async function waitFor(predicate, label) {
            for (let attempt = 0; attempt < 300; attempt += 1) {
              if (predicate()) return;
              await new Promise((resolve) => nativeSetTimeout(resolve, 10));
            }
            throw new Error('Timed out waiting for ' + label);
          }

          try {
            const { mount } = await import('/themes/cozy-village/entry.mjs');
            const controller = new AbortController();
            const mountPromise = mount(host, {
              mode: 'fixture',
              scripted: false,
              signal: controller.signal,
            });
            await waitFor(() => adapterRequested === 1, 'requestAdapter boundary');
            aborted = true;
            controller.abort();
            resolveAdapter({ name: 'late adapter' });
            let mountError;
            try {
              await mountPromise;
            } catch (error) {
              mountError = error;
            }
            await new Promise((resolve) => nativeSetTimeout(resolve, 100));
            result.textContent = JSON.stringify({
              adapterRequested,
              contextCalls,
              mountError: mountError?.name,
              hostChildren: host.childElementCount,
              pendingFrames: frames.size,
              pendingTimers: timers.size,
              workAfterAbort,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            });
          } catch (error) {
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function abortDuringFixturePage() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village fixture abort probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeRaf = window.requestAnimationFrame.bind(window);
          const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeClearTimeout = window.clearTimeout.bind(window);
          const nativeSetInterval = window.setInterval.bind(window);
          const nativeClearInterval = window.clearInterval.bind(window);
          const nativeFetch = window.fetch.bind(window);
          const nativeJsonParse = JSON.parse.bind(JSON);
          const frames = new Set();
          const timers = new Set();
          const controller = new AbortController();
          let aborted = false;
          let workAfterAbort = 0;
          let fixtureRequestsStarted = 0;
          let pendingFixtureRequests = 0;
          let abortedFixtureRequests = 0;
          const fixtureSignals = [];
          let fixtureParseWorkAfterAbort = 0;

          window.requestAnimationFrame = (callback) => {
            let id;
            id = nativeRaf((now) => {
              frames.delete(id);
              if (aborted) workAfterAbort += 1;
              callback(now);
            });
            frames.add(id);
            return id;
          };
          window.cancelAnimationFrame = (id) => {
            frames.delete(id);
            nativeCancelRaf(id);
          };
          window.setTimeout = (callback, delay, ...args) => {
            let id;
            id = nativeSetTimeout(() => {
              timers.delete(id);
              if (aborted) workAfterAbort += 1;
              callback(...args);
            }, delay);
            timers.add(id);
            return id;
          };
          window.clearTimeout = (id) => {
            timers.delete(id);
            nativeClearTimeout(id);
          };
          window.setInterval = (callback, delay, ...args) => {
            let id;
            id = nativeSetInterval(() => {
              if (aborted) workAfterAbort += 1;
              callback(...args);
            }, delay);
            timers.add(id);
            return id;
          };
          window.clearInterval = (id) => {
            timers.delete(id);
            nativeClearInterval(id);
          };
          window.fetch = async (input, init) => {
            const inputUrl = input instanceof Request ? input.url : String(input);
            const fixtureRequest = new URL(inputUrl, location.href).pathname.includes(
              '/themes/cozy-village/data/fixtures/',
            );
            if (!fixtureRequest) return nativeFetch(input, init);
            fixtureRequestsStarted += 1;
            pendingFixtureRequests += 1;
            const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
            if (requestSignal) fixtureSignals.push(requestSignal);
            try {
              return await nativeFetch(input, init);
            } catch (error) {
              if (error?.name === 'AbortError') abortedFixtureRequests += 1;
              throw error;
            } finally {
              pendingFixtureRequests -= 1;
            }
          };
          JSON.parse = (text, reviver) => {
            const fixturePayload = typeof text === 'string' &&
              (text.includes('"records"') || text.includes('"dispatches"'));
            if (aborted && fixturePayload) fixtureParseWorkAfterAbort += 1;
            return nativeJsonParse(text, reviver);
          };

          const nativeGetContext = HTMLCanvasElement.prototype.getContext;
          let contextCalls = 0;
          HTMLCanvasElement.prototype.getContext = function(...args) {
            contextCalls += 1;
            return nativeGetContext.apply(this, args);
          };

          async function waitFor(predicate, label) {
            for (let attempt = 0; attempt < 300; attempt += 1) {
              if (predicate()) return;
              await new Promise((resolve) => nativeSetTimeout(resolve, 10));
            }
            throw new Error('Timed out waiting for ' + label);
          }

          try {
            const { mount } = await import('/themes/cozy-village/entry.mjs');
            const mountPromise = mount(host, {
              mode: 'fixture',
              scripted: false,
              signal: controller.signal,
            });
            await waitFor(
              () => fixtureRequestsStarted === 2 && pendingFixtureRequests === 2,
              'both throttled fixture requests',
            );
            aborted = true;
            controller.abort();
            let mountError;
            try {
              await mountPromise;
            } catch (error) {
              mountError = error;
            }
            await waitFor(() => pendingFixtureRequests === 0, 'fixture fetch rejection');
            await new Promise((resolve) => nativeSetTimeout(resolve, 100));
            result.textContent = JSON.stringify({
              fixtureRequestsStarted,
              pendingFixtureRequests,
              abortedFixtureRequests,
              fixtureSignalsReceived: fixtureSignals.length,
              fixtureSignalsAborted: fixtureSignals.filter((signal) => signal.aborted).length,
              fixtureParseWorkAfterAbort,
              contextCalls,
              mountError: mountError?.name,
              hostChildren: host.childElementCount,
              pendingFrames: frames.size,
              pendingTimers: timers.size,
              workAfterAbort,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            });
          } catch (error) {
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function stalledHostEntryImportPage(index) {
  const marker = '    <script type="module" src="/app.js"></script>';
  assert.match(index, /<script type="module" src="\/app\.js"><\/script>/);
  return index.replace(marker, `    <output id="qa-result" hidden></output>
    <script type="module">
      const result = document.querySelector('#qa-result');
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeFetch = window.fetch.bind(window);
      const nativeCreateElement = document.createElement.bind(document);
      let aborted = false;
      let lateCanvasCreates = 0;
      document.createElement = (tag, ...args) => {
        if (aborted && String(tag).toLowerCase() === 'canvas') lateCanvasCreates += 1;
        return nativeCreateElement(tag, ...args);
      };

      async function waitFor(predicate, label) {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          if (await predicate()) return;
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label);
      }
      const moduleStatus = async () => {
        const response = await nativeFetch('/__atelier-test/module-delay');
        return response.json();
      };

      try {
        await import('/app.js');
        const select = document.querySelector('#world-theme-toggle');
        await waitFor(
          () => select.querySelector('option[value="cozy-village"]') &&
            !document.querySelector('#app').textContent.includes('Opening Atelier'),
          'dashboard bootstrap',
        );
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          async () => document.querySelector('#theme-mount .theme-generation') &&
            (await moduleStatus()).started === 1,
          'stalled host entry import',
        );
        let firstRoot = document.querySelector('#theme-mount .theme-generation');
        const firstRootReference = new WeakRef(firstRoot);
        const switchStartedAt = performance.now();
        aborted = true;
        select.value = 'dashboard';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => document.querySelector('#theme-host').hidden && !firstRoot.isConnected,
          'dashboard fallback',
        );
        const switchElapsedMs = performance.now() - switchStartedAt;
        firstRoot = undefined;
        if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
        for (let pass = 0; pass < 8; pass += 1) {
          window.gc();
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        const retainedBeforeImportSettled = firstRootReference.deref() !== undefined;
        await waitFor(async () => (await moduleStatus()).completed === 1, 'late host import settlement');
        await new Promise((resolve) => nativeSetTimeout(resolve, 150));
        result.textContent = JSON.stringify({
          switchElapsedMs,
          retainedBeforeImportSettled,
          lateCanvasCreates,
          generationRootsAfterLateSettlement:
            document.querySelectorAll('#theme-mount .theme-generation').length,
          selected: select.value,
          themeActive: document.body.classList.contains('theme-active'),
          hasDebugWorld: Boolean(window.__village),
          hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
        });
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    </script>`);
}

function stalledEntryImportPage({ mode }) {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village source import abort probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeFetch = window.fetch.bind(window);
          const nativeGetContext = HTMLCanvasElement.prototype.getContext;
          let aborted = false;
          let lateFetches = 0;
          let lateContextCalls = 0;
          window.fetch = (input, options) => {
            const url = String(input);
            if (aborted && !url.includes('/__atelier-test/')) lateFetches += 1;
            return nativeFetch(input, options);
          };
          HTMLCanvasElement.prototype.getContext = function(...args) {
            if (aborted) lateContextCalls += 1;
            return nativeGetContext.apply(this, args);
          };

          async function waitFor(predicate, label) {
            for (let attempt = 0; attempt < 400; attempt += 1) {
              if (await predicate()) return;
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            throw new Error('Timed out waiting for ' + label);
          }
          const moduleStatus = async () => {
            const response = await nativeFetch('/__atelier-test/module-delay');
            return response.json();
          };

          async function startAndAbortMount() {
            const { mount } = await import('/themes/cozy-village/entry.mjs');
            let controller = new AbortController();
            const generation = Symbol('stalled-entry-import');
            let mountPromise = mount(host, {
              generation,
              mode: ${JSON.stringify(mode)},
              project: 'atelier',
              scripted: false,
              signal: controller.signal,
            });
            await waitFor(
              async () => host.querySelector('.cv-root') && (await moduleStatus()).started === 1,
              'stalled entry import',
            );
            let firstRoot = host.querySelector('.cv-root');
            const firstRootReference = new WeakRef(firstRoot);
            const abortStartedAt = performance.now();
            aborted = true;
            controller.abort();
            let mountErrorName;
            try {
              await mountPromise;
            } catch (error) {
              mountErrorName = error?.name;
            }
            await waitFor(() => host.childElementCount === 0, 'entry abort cleanup');
            const abortElapsedMs = performance.now() - abortStartedAt;
            mountPromise = undefined;
            controller = undefined;
            firstRoot = undefined;
            return { firstRootReference, mountErrorName, abortElapsedMs };
          }

          try {
            const abortedMount = await startAndAbortMount();
            if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
            for (let pass = 0; pass < 8; pass += 1) {
              window.gc();
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            const retainedBeforeImportSettled =
              abortedMount.firstRootReference.deref() !== undefined;
            await waitFor(async () => (await moduleStatus()).completed === 1, 'late entry import settlement');
            await new Promise((resolve) => nativeSetTimeout(resolve, 150));
            for (let pass = 0; pass < 4; pass += 1) {
              window.gc();
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            result.textContent = JSON.stringify({
              mountError: abortedMount.mountErrorName,
              abortElapsedMs: abortedMount.abortElapsedMs,
              retainedBeforeImportSettled,
              retainedAfterImportSettled:
                abortedMount.firstRootReference.deref() !== undefined,
              lateFetches,
              lateContextCalls,
              hostChildrenAfterLateSettlement: host.childElementCount,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            });
          } catch (error) {
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function stalledRendererModuleImportPage() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Village renderer import abort probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0"></main>
        <output id="qa-result"></output>
        <script type="module">
          const result = document.querySelector('#qa-result');
          const host = document.querySelector('#host');
          const nativeSetTimeout = window.setTimeout.bind(window);
          const nativeFetch = window.fetch.bind(window);
          let rendererConstructs = 0;
          let rendererInitCalls = 0;
          let lateRendererTouches = 0;
          globalThis.__cozyVillageRendererConstruct = () => { rendererConstructs += 1; };
          globalThis.__cozyVillageRendererInit = () => { rendererInitCalls += 1; };
          globalThis.__cozyVillageRendererAwait = () => Promise.resolve();
          globalThis.__cozyVillageRendererTouch = () => { lateRendererTouches += 1; };
          Object.defineProperty(navigator, 'gpu', {
            configurable: true,
            value: { requestAdapter: () => Promise.resolve({ name: 'renderer import adapter' }) },
          });

          async function waitFor(predicate, label) {
            for (let attempt = 0; attempt < 400; attempt += 1) {
              if (await predicate()) return;
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            throw new Error('Timed out waiting for ' + label);
          }
          const moduleStatus = async () => {
            const response = await nativeFetch('/__atelier-test/module-delay');
            return response.json();
          };

          async function startAndAbortMount() {
            const { mount } = await import('/themes/cozy-village/entry.mjs');
            let controller = new AbortController();
            let mountPromise = mount(host, {
              generation: Symbol('stalled-renderer-import'),
              mode: 'fixture',
              scripted: false,
              signal: controller.signal,
            });
            await waitFor(
              async () => host.querySelector('.cv-root') && (await moduleStatus()).started === 1,
              'stalled renderer module import',
            );
            let firstRoot = host.querySelector('.cv-root');
            const firstRootReference = new WeakRef(firstRoot);
            const abortStartedAt = performance.now();
            controller.abort();
            let mountErrorName;
            try {
              await mountPromise;
            } catch (error) {
              mountErrorName = error?.name;
            }
            const abortElapsedMs = performance.now() - abortStartedAt;
            mountPromise = undefined;
            controller = undefined;
            firstRoot = undefined;
            return { abortElapsedMs, firstRootReference, mountErrorName };
          }

          try {
            const abortedMount = await startAndAbortMount();
            if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
            for (let pass = 0; pass < 8; pass += 1) {
              window.gc();
              await new Promise((resolve) => nativeSetTimeout(resolve, 25));
            }
            const retainedBeforeImportSettled =
              abortedMount.firstRootReference.deref() !== undefined;
            await waitFor(async () => (await moduleStatus()).completed === 1, 'late renderer import settlement');
            await new Promise((resolve) => nativeSetTimeout(resolve, 150));
            result.textContent = JSON.stringify({
              abortElapsedMs: abortedMount.abortElapsedMs,
              mountError: abortedMount.mountErrorName,
              retainedBeforeImportSettled,
              rendererConstructs,
              rendererInitCalls,
              lateRendererTouches,
              hostChildrenAfterLateSettlement: host.childElementCount,
              hasDebugWorld: Boolean(window.__village),
              hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
            });
          } catch (error) {
            result.textContent = JSON.stringify({ error: error?.stack || String(error) });
          }
        </script>
      </body>
    </html>`;
}

function hungRendererReactivationPage(index, { hangAt }) {
  assert.ok(["adapter", "init"].includes(hangAt));
  const marker = '    <script type="module" src="/app.js"></script>';
  assert.match(index, /<script type="module" src="\/app\.js"><\/script>/);
  return index.replace(marker, `    <output id="qa-result" hidden></output>
    <script type="module">
      const result = document.querySelector('#qa-result');
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeAbort = AbortController.prototype.abort;
      let abortCalls = 0;
      AbortController.prototype.abort = function(...args) {
        abortCalls += 1;
        return nativeAbort.apply(this, args);
      };
      class ProbeEventSource {
        constructor(url) {
          this.url = String(url);
          this.readyState = 1;
          this.listeners = new Map();
        }
        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) || [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = ProbeEventSource;

      let adapterCalls = 0;
      let resolveHungRenderer;
      const hungRenderer = new Promise((resolve) => { resolveHungRenderer = resolve; });
      let rendererInitCalls = 0;
      let lateRendererTouches = 0;
      window.__cozyVillageRendererInit = () => {
        rendererInitCalls += 1;
      };
      window.__cozyVillageRendererAwait = () => hungRenderer;
      window.__cozyVillageRendererTouch = () => { lateRendererTouches += 1; };
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: {
          requestAdapter() {
            adapterCalls += 1;
            if (adapterCalls > 1) return Promise.resolve(null);
            return ${JSON.stringify(hangAt)} === 'adapter'
              ? hungRenderer
              : Promise.resolve({ name: 'first adapter' });
          },
        },
      });

      async function waitFor(predicate, label) {
        for (let attempt = 0; attempt < 320; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label);
      }

      try {
        await import('/app.js');
        const select = document.querySelector('#world-theme-toggle');
        await waitFor(
          () => select.querySelector('option[value="cozy-village"]') &&
            !document.querySelector('#app').textContent.includes('Opening Atelier'),
          'dashboard bootstrap',
        );
        const abortBaseline = abortCalls;
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => adapterCalls === 1 &&
            (${JSON.stringify(hangAt)} === 'adapter' || rendererInitCalls === 1),
          'hung first renderer boundary',
        );
        let firstRoot = document.querySelector('#theme-mount .theme-generation');
        const firstRootReference = new WeakRef(firstRoot);
        const switchStartedAt = performance.now();
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => adapterCalls === 2 && window.__village?.world &&
            document.querySelector('#theme-mount canvas.cv-canvas'),
          'clean second generation',
        );
        const switchElapsedMs = performance.now() - switchStartedAt;
        const secondRoot = document.querySelector('#theme-mount .theme-generation');
        const mountedSnapshot = {
          adapterCalls,
          abortCallsAfterFirstGeneration: abortCalls - abortBaseline,
          firstRootConnected: firstRoot?.isConnected ?? false,
          secondRootConnected: secondRoot?.isConnected ?? false,
          secondCanvasConnected: Boolean(secondRoot?.querySelector('canvas.cv-canvas')?.isConnected),
          selected: select.value,
          themeActive: document.body.classList.contains('theme-active'),
          switchElapsedMs,
        };
        firstRoot = undefined;
        if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
        for (let pass = 0; pass < 6; pass += 1) {
          window.gc();
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        const firstGenerationRetainedAfterTeardown = firstRootReference.deref() !== undefined;
        resolveHungRenderer(${JSON.stringify(hangAt)} === 'adapter' ? { name: 'late adapter' } : undefined);
        await new Promise((resolve) => nativeSetTimeout(resolve, 100));
        const generationRootsAfterLateSettlement =
          document.querySelectorAll('#theme-mount .theme-generation').length;
        document.querySelector('#theme-dashboard-return').click();
        await waitFor(
          () => document.querySelector('#theme-host').hidden && !secondRoot.isConnected,
          'second generation cleanup',
        );
        result.textContent = JSON.stringify({
          ...mountedSnapshot,
          firstGenerationRetainedAfterTeardown,
          generationRootsAfterLateSettlement,
          rendererInitCalls,
          lateRendererTouches,
          dashboardAfterCleanup: select.value === 'dashboard',
          hasDebugWorldAfterCleanup: Boolean(window.__village),
        });
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    </script>`);
}

function dashboardTeardownPage(index, {
  contextLossDelayMs = 75,
  teardownShouldFail = false,
  asyncLeakKinds = [],
} = {}) {
  const marker = '    <script type="module" src="/app.js"></script>';
  assert.match(index, /<script type="module" src="\/app\.js"><\/script>/);
  return index.replace(marker, `    <output id="qa-result" hidden></output>
    <script type="module">
      const result = document.querySelector('#qa-result');
      const nativeRaf = window.requestAnimationFrame.bind(window);
      const nativeCancelRaf = window.cancelAnimationFrame.bind(window);
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeClearTimeout = window.clearTimeout.bind(window);
      const nativeSetInterval = window.setInterval.bind(window);
      const nativeClearInterval = window.clearInterval.bind(window);
      const nativeQueueMicrotask = window.queueMicrotask.bind(window);
      const nativeAddEventListener = EventTarget.prototype.addEventListener;
      const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
      const themeFrames = new Map();
      const themeTimers = new Map();
      const eventSources = [];
      let phase = 'dashboard';
      let currentThemeGeneration = 0;
      let executingThemeGeneration = 0;
      const unmountedGenerations = new Set();
      let frameWorkAfterUnmount = 0;
      let timerWorkAfterUnmount = 0;
      const pendingAsyncOwners = [];
      const trackedCanvases = new WeakSet();
      const trackedContexts = new WeakSet();
      const canvasReferences = [];
      const contextReferences = [];
      const canvasTypes = [];
      const contextTypes = [];
      const canvasIndexes = new WeakMap();

      const currentOwner = () =>
        ((phase === 'mounting' || phase === 'mounted') ? currentThemeGeneration : 0) ||
        executingThemeGeneration || pendingAsyncOwners.at(-1)?.owner || 0;
      const runOwned = (owner, callback, receiver, args) => {
        const previous = executingThemeGeneration;
        executingThemeGeneration = owner;
        let returned;
        try {
          returned = callback.apply(receiver, args);
        } catch (error) {
          if (executingThemeGeneration === owner) executingThemeGeneration = previous;
          throw error;
        }
        if (returned && typeof returned.then === 'function') {
          const pendingOwner = owner ? { owner } : null;
          if (pendingOwner) pendingAsyncOwners.push(pendingOwner);
          if (executingThemeGeneration === owner) executingThemeGeneration = previous;
          return Promise.resolve(returned).finally(() => {
            const index = pendingAsyncOwners.indexOf(pendingOwner);
            if (index >= 0) pendingAsyncOwners.splice(index, 1);
          });
        }
        if (executingThemeGeneration === owner) executingThemeGeneration = previous;
        return returned;
      };
      const listenerWrappers = new WeakMap();
      const captureFor = (options) => typeof options === 'boolean'
        ? options
        : Boolean(options?.capture);
      EventTarget.prototype.addEventListener = function(type, listener, options) {
        const owner = currentOwner();
        if (!owner || !listener) {
          return nativeAddEventListener.call(this, type, listener, options);
        }
        const capture = captureFor(options);
        const records = listenerWrappers.get(listener) || [];
        let record = records.find((candidate) =>
          candidate.target === this && candidate.type === type && candidate.capture === capture);
        if (!record) {
          const wrapped = function(...args) {
            const invoke = typeof listener === 'function'
              ? () => listener.apply(this, args)
              : () => listener.handleEvent?.apply(listener, args);
            return runOwned(owner, invoke, undefined, []);
          };
          record = { target: this, type, capture, wrapped };
          records.push(record);
          listenerWrappers.set(listener, records);
        }
        return nativeAddEventListener.call(this, type, record.wrapped, options);
      };
      EventTarget.prototype.removeEventListener = function(type, listener, options) {
        const capture = captureFor(options);
        const records = listener && listenerWrappers.get(listener);
        const record = records?.find((candidate) =>
          candidate.target === this && candidate.type === type && candidate.capture === capture);
        return nativeRemoveEventListener.call(this, type, record?.wrapped ?? listener, options);
      };
      window.queueMicrotask = (callback) => {
        const owner = currentOwner();
        nativeQueueMicrotask(() => { void runOwned(owner, callback, undefined, []); });
      };

      window.requestAnimationFrame = (callback) => {
        const owner = currentOwner();
        let id;
        id = nativeRaf((now) => {
          themeFrames.delete(id);
          if (owner && unmountedGenerations.has(owner)) frameWorkAfterUnmount += 1;
          void runOwned(owner, callback, undefined, [now]);
        });
        if (owner) themeFrames.set(id, owner);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        themeFrames.delete(id);
        nativeCancelRaf(id);
      };
      window.setTimeout = (callback, delay, ...args) => {
        const owner = currentOwner();
        let id;
        id = nativeSetTimeout(() => {
          themeTimers.delete(id);
          if (owner && unmountedGenerations.has(owner)) timerWorkAfterUnmount += 1;
          void runOwned(owner, callback, undefined, args);
        }, delay);
        if (owner) themeTimers.set(id, owner);
        return id;
      };

      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      let delayedContextCanvas;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        const context = nativeGetContext.call(this, type, ...args);
        if (context && !trackedCanvases.has(this)) {
          trackedCanvases.add(this);
          canvasIndexes.set(this, canvasReferences.length);
          canvasReferences.push(new WeakRef(this));
          canvasTypes.push([]);
        }
        const canvasIndex = canvasIndexes.get(this);
        if (canvasIndex !== undefined && !canvasTypes[canvasIndex].includes(String(type))) {
          canvasTypes[canvasIndex].push(String(type));
        }
        if (context && !trackedContexts.has(context)) {
          trackedContexts.add(context);
          contextReferences.push(new WeakRef(context));
          contextTypes.push(String(type));
        }
        if (!context || delayedContextCanvas || !/^webgl2?$/.test(String(type))) return context;
        delayedContextCanvas = this;
        const nativeGetExtension = context.getExtension.bind(context);
        context.getExtension = (name) => {
          const extension = nativeGetExtension(name);
          if (name !== 'WEBGL_lose_context' || !extension?.loseContext) return extension;
          return new Proxy(extension, {
            get(target, property) {
              if (property === 'loseContext') {
                return () => nativeSetTimeout(() => {
                  target.loseContext();
                  delayedContextCanvas = undefined;
                }, ${contextLossDelayMs});
              }
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        };
        return context;
      };
      window.clearTimeout = (id) => {
        themeTimers.delete(id);
        nativeClearTimeout(id);
      };
      window.setInterval = (callback, delay, ...args) => {
        const owner = currentOwner();
        let id;
        id = nativeSetInterval(() => {
          if (owner && unmountedGenerations.has(owner)) timerWorkAfterUnmount += 1;
          void runOwned(owner, callback, undefined, args);
        }, delay);
        if (owner) themeTimers.set(id, owner);
        return id;
      };
      window.clearInterval = (id) => {
        themeTimers.delete(id);
        nativeClearInterval(id);
      };

      class ProbeEventSource {
        constructor(url) {
          this.url = String(url);
          this.readyState = 1;
          this.closeCalls = 0;
          this.listeners = new Map();
          eventSources.push(this);
        }
        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) || [];
          listeners.push({ listener, owner: currentOwner() });
          this.listeners.set(type, listeners);
        }
        removeEventListener(type, listener) {
          const listeners = (this.listeners.get(type) || []).filter(
            (record) => record.listener !== listener,
          );
          if (listeners.length > 0) this.listeners.set(type, listeners);
          else this.listeners.delete(type);
        }
        emit(type, event) {
          for (const { listener, owner } of this.listeners.get(type) || []) {
            void runOwned(owner, listener, this, [event]);
          }
        }
        close() {
          this.closeCalls += 1;
          this.readyState = 2;
        }
      }
      window.EventSource = ProbeEventSource;

      async function waitFor(predicate, label) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label);
      }

      try {
        await import('/app.js');
        const select = document.querySelector('#world-theme-toggle');
        await waitFor(
          () => select.querySelector('option[value="cozy-village"]') &&
            eventSources.some((source) => new URL(source.url, location.href).pathname === '/api/board/events') &&
            !document.querySelector('#app').textContent.includes('Opening Atelier'),
          'dashboard bootstrap',
        );
        const coreSources = [...eventSources];

        currentThemeGeneration = 1;
        phase = 'mounting';
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => window.__village?.world && document.querySelector('#theme-mount canvas.cv-canvas'),
          'activateWorldTheme mount',
        );
        await Promise.resolve();
        phase = 'mounted';
        let firstCanvas = document.querySelector('#theme-mount canvas.cv-canvas');
        let firstWorld = window.__village.world;
        const firstThemeSources = eventSources.slice(coreSources.length);
        let contextLost = 0;
        firstCanvas.addEventListener('webglcontextlost', () => { contextLost += 1; });

        unmountedGenerations.add(1);
        phase = 'unmounting';
        document.querySelector('#theme-dashboard-return').click();
        currentThemeGeneration = 2;
        phase = 'mounting';
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const expectedTeardownFailure = ${teardownShouldFail ? "true" : "false"};
        const enabledAsyncLeaks = new Set(${JSON.stringify(asyncLeakKinds)});
        const asyncLeakTimers = {};
        let releaseAwaitLeak;
        let awaitLeakTarget;
        let fetchLeakTarget;
        let microtaskLeakTarget;
        let eventSourceLeak;
        let fallbackBeforeContextLoss = false;
        let firstReleasedBeforeSecondMount = false;
        let secondCanvas;
        let secondWorld;
        let secondThemeSources = [];
        let secondGenerationAlive = null;
        let canvasConnectedAfterTeardown;
        let retainedTrackedCanvases;
        let retainedTrackedContexts;

        if (expectedTeardownFailure) {
          await waitFor(
            () => document.querySelector('#theme-host').hidden && select.value === 'dashboard',
            'failed teardown dashboard fallback',
          );
          fallbackBeforeContextLoss = contextLost === 0;
          await waitFor(() => contextLost > 0, 'late first-generation context loss');
        } else {
          await waitFor(
            () => window.__village?.world && window.__village.world !== firstWorld &&
              document.querySelector('#theme-mount canvas.cv-canvas') !== firstCanvas,
            'second activateWorldTheme mount',
          );
          firstReleasedBeforeSecondMount = !firstCanvas.isConnected && contextLost > 0 &&
            firstThemeSources.every((source) => source.readyState === 2);
          phase = 'mounted';
          secondCanvas = document.querySelector('#theme-mount canvas.cv-canvas');
          secondWorld = window.__village.world;
          secondThemeSources = eventSources.slice(
            coreSources.length + firstThemeSources.length,
          );
          await waitFor(
            () => !firstCanvas.isConnected && contextLost > 0 &&
              firstThemeSources.every((source) => source.readyState === 2),
            'slow first-generation teardown',
          );
          secondGenerationAlive = {
            canvasConnected: secondCanvas.isConnected,
            debugWorld: window.__village?.world === secondWorld,
            frames: [...themeFrames.values()].filter((owner) => owner === 2).length,
            streams: secondThemeSources.filter((source) => source.readyState === 1).length,
          };

          if (enabledAsyncLeaks.has('await')) {
            const pending = new Promise((resolve) => { releaseAwaitLeak = resolve; });
            awaitLeakTarget = new EventTarget();
            awaitLeakTarget.addEventListener('leak', async () => {
              await pending;
              asyncLeakTimers.await = window.setInterval(() => {}, 10);
            });
            awaitLeakTarget.dispatchEvent(new Event('leak'));
          }
          if (enabledAsyncLeaks.has('microtask')) {
            microtaskLeakTarget = new EventTarget();
            microtaskLeakTarget.addEventListener('leak', () => {
              queueMicrotask(() => {
                asyncLeakTimers.microtask = window.setInterval(() => {}, 10);
              });
            });
          }
          if (enabledAsyncLeaks.has('fetch')) {
            fetchLeakTarget = new EventTarget();
            fetchLeakTarget.addEventListener('leak', async () => {
              await fetch('/api/async-owner');
              asyncLeakTimers.fetch = window.setInterval(() => {}, 10);
            });
            fetchLeakTarget.dispatchEvent(new Event('leak'));
          }
          if (enabledAsyncLeaks.has('eventsource')) {
            eventSourceLeak = new EventSource('/async-owner-events');
            eventSourceLeak.addEventListener('leak', () => {
              asyncLeakTimers.eventsource = window.setInterval(() => {}, 10);
            });
          }

          unmountedGenerations.add(2);
          phase = 'unmounting';
          document.querySelector('#theme-dashboard-return').click();
          await waitFor(
            () => document.querySelector('#theme-host').hidden && !secondCanvas.isConnected,
            'final leaveActiveTheme dashboard switch',
          );
          canvasConnectedAfterTeardown = secondCanvas.isConnected;
          phase = 'done';
          releaseAwaitLeak?.();
          microtaskLeakTarget?.dispatchEvent(new Event('leak'));
          eventSourceLeak?.emit('leak', { type: 'leak' });
        }
        await new Promise((resolve) => nativeSetTimeout(resolve, enabledAsyncLeaks.size ? 300 : 150));
        if (!expectedTeardownFailure && enabledAsyncLeaks.size === 0) {
          firstCanvas = undefined;
          firstWorld = undefined;
          secondCanvas = undefined;
          secondWorld = undefined;
          delayedContextCanvas = undefined;
          if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
          for (let pass = 0; pass < 8; pass += 1) {
            window.gc();
            await new Promise((resolve) => nativeSetTimeout(resolve, 25));
          }
          retainedTrackedCanvases = canvasReferences.filter((reference) =>
            reference.deref() !== undefined).length;
          retainedTrackedContexts = contextReferences.filter((reference) =>
            reference.deref() !== undefined).length;
        }

        const firstGenerationAlive = {
          frames: [...themeFrames.values()].filter((owner) => owner === 1).length,
          timers: [...themeTimers.values()].filter((owner) => owner === 1).length,
          streams: firstThemeSources.filter((source) => source.readyState !== 2).length,
        };
        const asyncLeakOwners = Object.fromEntries(
          Object.entries(asyncLeakTimers).map(([kind, id]) => [kind, themeTimers.get(id) ?? 0]),
        );
        const snapshot = {
          contextLost,
          canvasConnected: canvasConnectedAfterTeardown ?? firstCanvas?.isConnected,
          trackedCanvasCount: canvasReferences.length,
          trackedContextCount: contextReferences.length,
          retainedTrackedCanvases,
          retainedTrackedContexts,
          retainedCanvasTypes: canvasReferences.flatMap((reference, index) =>
            reference.deref() === undefined ? [] : [canvasTypes[index]]),
          retainedContextTypes: contextReferences.flatMap((reference, index) =>
            reference.deref() === undefined ? [] : [contextTypes[index]]),
          frameWorkAfterUnmount,
          timerWorkAfterUnmount,
          pendingThemeFrames: themeFrames.size,
          pendingThemeTimers: themeTimers.size,
          firstGenerationAlive,
          secondGenerationAlive,
          firstReleasedBeforeSecondMount,
          fallbackBeforeContextLoss,
          asyncLeakOwners,
          hasDebugWorld: Boolean(window.__village),
          hasThemeStylesheet: Boolean(document.querySelector('link[data-cozy-village]')),
          dashboardSelected: select.value === 'dashboard',
          themeActive: document.body.classList.contains('theme-active'),
          themeStreams: [...firstThemeSources, ...secondThemeSources].map((source) => ({
            path: new URL(source.url, location.href).pathname,
            closeCalls: source.closeCalls,
            readyState: source.readyState,
          })),
          themeStreamListenerCounts: [...firstThemeSources, ...secondThemeSources]
            .map((source) => [...source.listeners.values()]
              .reduce((count, listeners) => count + listeners.length, 0)),
          coreBoardReadyState: coreSources.find(
            (source) => new URL(source.url, location.href).pathname === '/api/board/events',
          )?.readyState,
        };
        for (const id of Object.values(asyncLeakTimers)) window.clearInterval(id);
        eventSourceLeak?.close();
        result.textContent = JSON.stringify(snapshot);
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    </script>`);
}

function failedInFlightCleanupPage(index) {
  const marker = '    <script type="module" src="/app.js"></script>';
  assert.match(index, /<script type="module" src="\/app\.js"><\/script>/);
  return index.replace(marker, `    <output id="qa-result" hidden></output>
    <script type="module">
      const result = document.querySelector('#qa-result');
      const nativeSetTimeout = window.setTimeout.bind(window);

      async function waitFor(predicate, label) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label);
      }

      class ProbeEventSource {
        constructor(url) {
          this.url = String(url);
          this.readyState = 1;
          this.listeners = new Map();
          (window.__probeSources ??= []).push(this);
        }
        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) ?? [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = ProbeEventSource;

      try {
        await import('/app.js');
        const select = document.querySelector('#world-theme-toggle');
        await waitFor(
          () => select.querySelector('option[value="cozy-village"]') &&
            !document.querySelector('#app').textContent.includes('Opening Atelier'),
          'dashboard bootstrap',
        );
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => window.__failedTheme?.mountCalls === 1 &&
            window.__failedTheme.source?.readyState === 1 &&
            window.__failedTheme.timer !== undefined,
          'in-flight theme resources',
        );

        document.querySelector('#theme-dashboard-return').click();
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(
          () => document.querySelector('#theme-host').hidden && select.value === 'dashboard',
          'failed cleanup fallback',
        );
        await new Promise((resolve) => nativeSetTimeout(resolve, 150));

        const snapshot = {
          mountCalls: window.__failedTheme.mountCalls,
          disposeCalls: window.__failedTheme.disposeCalls,
          leakedStreamAlive: window.__failedTheme.source.readyState === 1,
          leakedTimerAlive: window.__failedTheme.timer !== undefined,
          dashboardSelected: select.value === 'dashboard',
          themeActive: document.body.classList.contains('theme-active'),
          cleanupToast: document.querySelector('#toast-root')?.textContent ?? '',
        };
        window.__failedTheme.source.close();
        clearInterval(window.__failedTheme.timer);
        window.__failedTheme.timer = undefined;
        result.textContent = JSON.stringify(snapshot);
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    </script>`);
}

function dashboardCanvasGcPage(index) {
  const marker = '    <script type="module" src="/app.js"></script>';
  assert.match(index, /<script type="module" src="\/app\.js"><\/script>/);
  return index.replace(marker, `    <output id="qa-result" hidden></output>
    <script type="module">
      const result = document.querySelector('#qa-result');
      const nativeSetTimeout = window.setTimeout.bind(window);
      const nativeGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type, ...args) {
        if (this.dataset.gcTheme === 'true') return this.__gcContext;
        return nativeGetContext.call(this, type, ...args);
      };

      class ProbeEventSource {
        constructor(url) {
          this.url = String(url);
          this.readyState = 1;
          this.listeners = new Map();
        }
        addEventListener(type, listener) {
          const listeners = this.listeners.get(type) ?? [];
          listeners.push(listener);
          this.listeners.set(type, listeners);
        }
        removeEventListener(type, listener) {
          const listeners = (this.listeners.get(type) ?? []).filter(
            (candidate) => candidate !== listener,
          );
          if (listeners.length > 0) this.listeners.set(type, listeners);
          else this.listeners.delete(type);
        }
        close() {
          this.readyState = 2;
        }
      }
      window.EventSource = ProbeEventSource;

      async function waitFor(predicate, label) {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          if (predicate()) return;
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        throw new Error('Timed out waiting for ' + label);
      }

      async function activateAndRelease() {
        await import('/app.js');
        const select = document.querySelector('#world-theme-toggle');
        await waitFor(
          () => select.querySelector('option[value="cozy-village"]') &&
            !document.querySelector('#app').textContent.includes('Opening Atelier'),
          'dashboard bootstrap',
        );
        select.value = 'cozy-village';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitFor(() => window.__gcThemeTargets, 'synthetic WebGL ownership');
        document.querySelector('#theme-dashboard-return').click();
        await waitFor(
          () => document.querySelector('#theme-host').hidden &&
            select.value === 'dashboard',
          'final dashboard switch',
        );
        return window.__gcThemeTargets;
      }

      try {
        const released = await activateAndRelease();
        if (typeof window.gc !== 'function') throw new Error('explicit GC is unavailable');
        for (let pass = 0; pass < 10; pass += 1) {
          window.gc();
          await new Promise((resolve) => nativeSetTimeout(resolve, 25));
        }
        result.textContent = JSON.stringify({
          contextLost: released.contextLost,
          retainedCanvases: released.canvas.deref() !== undefined ? 1 : 0,
          retainedContexts: released.context.deref() !== undefined ? 1 : 0,
          dashboardSelected:
            document.querySelector('#world-theme-toggle').value === 'dashboard',
        });
      } catch (error) {
        result.textContent = JSON.stringify({ error: error?.stack || String(error) });
      }
    </script>`);
}

const GC_THEME_MODULE = `
  export function mount(root) {
    const canvas = document.createElement('canvas');
    canvas.dataset.gcTheme = 'true';
    const context = {
      getExtension(name) {
        if (name !== 'WEBGL_lose_context') return null;
        return {
          loseContext() {
            canvas.dispatchEvent(new Event('webglcontextlost'));
          },
        };
      },
    };
    const targets = {
      canvas: new WeakRef(canvas),
      context: new WeakRef(context),
      contextLost: 0,
    };
    canvas.addEventListener('webglcontextlost', () => { targets.contextLost += 1; });
    canvas.__gcContext = context;
    root.append(canvas);
    canvas.getContext('webgl2');
    globalThis.__gcThemeTargets = targets;
  }
`;
const FAILED_IN_FLIGHT_THEME_MODULE = `
  const instances = new Map();
  globalThis.__failedTheme = {
    mountCalls: 0,
    disposeCalls: 0,
    source: undefined,
    timer: undefined,
  };
  export async function mount(root, { generation }) {
    globalThis.__failedTheme.mountCalls += 1;
    const source = new EventSource('/api/leaked-theme-events');
    const timer = setInterval(() => {}, 10);
    const instance = { root, source, timer };
    instances.set(generation, instance);
    globalThis.__failedTheme.source = source;
    globalThis.__failedTheme.timer = timer;
    root.append(document.createElement('section'));
    await new Promise(() => {});
  }
  export function dispose(generation) {
    globalThis.__failedTheme.disposeCalls += 1;
    if (!instances.has(generation)) return;
    throw new Error('persistent in-flight dispose failure');
  }
`;

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff2", "font/woff2"],
]);

const PROJECT = Object.freeze({
  name: "atelier",
  path: "/tmp/atelier",
  tracker: "br",
  detectedTracker: "br",
  archetype: "full",
  requireReview: true,
});

function liveApiPayload(path) {
  if (path === "/api/themes") {
    return {
      themes: [{
        id: "cozy-village",
        name: "Cozy Village",
        entryUrl: "/themes/cozy-village/entry.mjs",
      }],
    };
  }
  if (path === "/api/projects") return { projects: [PROJECT], groups: [] };
  if (path === "/api/dispatches") return [];
  if (path === "/api/convoys") return { convoys: [] };
  if (path === "/api/projects/atelier/chronicle") {
    return {
      project: "atelier",
      generatedAt: "2026-07-31T00:00:00.000Z",
      records: [],
      summary: { merges: 0 },
      truncated: false,
    };
  }
  if (path === "/api/projects/atelier/state") {
    return {
      issues: [],
      readyIssues: [],
      tracker: "committed",
      degraded: false,
      generatedAt: "2026-07-31T00:00:00.000Z",
    };
  }
  if (path === "/api/projects/atelier/queue") {
    return { enabled: true, unavailable: false, parkedTickets: [] };
  }
  if (path === "/api/projects/atelier/main-health") {
    return {
      project: "atelier",
      state: "passed",
      checksTotal: 0,
      unresolvedFailures: [],
      running: [],
    };
  }
  if (path === "/api/projects/atelier/artifacts") {
    return {
      project: "atelier",
      generatedAt: "2026-07-31T00:00:00.000Z",
      artifacts: [],
    };
  }
  return undefined;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDevToolsPort(profile, process) {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (process.exitCode !== null) throw new Error(`Chrome exited with ${process.exitCode}`);
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\s+/);
      if (port) return Number(port);
    } catch {
      // Chrome writes the port file after its browser process is ready.
    }
    await wait(25);
  }
  throw new Error("Chrome did not publish its DevTools port");
}

async function pageWebSocket(port) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // The HTTP debugger can lag slightly behind DevToolsActivePort.
    }
    await wait(25);
  }
  throw new Error("Chrome did not expose the teardown page target");
}

async function connectDevTools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function stopChrome(process) {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGKILL");
  await once(process, "exit");
}

async function runBrowserProbe(t, {
  page,
  query,
  apiPayload,
  throttleFixtureRequests = false,
  asyncOwnerResponseDelayMs = 0,
  webGpuRendererModule = false,
  testModules = {},
  delayedModulePath,
  delayedModuleMs = 2_500,
}) {
  const browser = await availableChromium();
  assert.ok(browser, "Chrome or Chromium is required; set ATELIER_CHROME_BIN to its executable");
  const profile = await mkdtemp(join(tmpdir(), "atelier-village-teardown-"));
  const pendingThrottledFixtureRequests = new Set();
  let serverAbortedFixtureRequests = 0;
  let delayedModuleRequests = 0;
  let completedDelayedModuleRequests = 0;
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      if (path === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(page);
        return;
      }
      if (path === "/api/session") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "set-cookie": "atelier_session=browser-fixture; HttpOnly; SameSite=Strict; Path=/",
        });
        response.end('{"csrfToken":"browser-csrf-fixture"}');
        return;
      }
      if (path === "/api/async-owner") {
        if (asyncOwnerResponseDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, asyncOwnerResponseDelayMs));
        }
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end('{"ok":true}');
        return;
      }
      if (path === "/__atelier-test/module-delay") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          started: delayedModuleRequests,
          completed: completedDelayedModuleRequests,
        }));
        return;
      }
      if (delayedModulePath === path) {
        delayedModuleRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, delayedModuleMs));
        completedDelayedModuleRequests += 1;
      }
      if (webGpuRendererModule && path === "/themes/cozy-village/vendor/three.webgpu.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(`
          export class WebGPURenderer {
            constructor({ canvas }) {
              globalThis.__cozyVillageRendererConstruct?.();
              this.canvas = canvas;
              this.shadowMap = {};
            }
            async init() {
              globalThis.__cozyVillageRendererInit();
              await globalThis.__cozyVillageRendererAwait();
              this.canvas.dataset.rendererInitialized = 'true';
              globalThis.__cozyVillageRendererTouch();
            }
            dispose() {}
            forceContextLoss() {}
            setPixelRatio() { globalThis.__cozyVillageRendererTouch(); }
            getContext() { globalThis.__cozyVillageRendererTouch(); return null; }
          }
        `);
        return;
      }
      if (Object.hasOwn(testModules, path)) {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(testModules[path]);
        return;
      }
      const payload = apiPayload?.(path);
      if (payload !== undefined) {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify(payload));
        return;
      }
      const bare = normalize(path).replace(/^[/\\]+/, "");
      const relative = bare.startsWith("themes/") || bare.startsWith("shared/")
        ? bare
        : bare.startsWith("theme-lib/")
          ? `ui/${bare.slice("theme-lib/".length)}`
          : `ui/${bare}`;
      if (!relative || relative.startsWith("..")) throw new Error("path escape");
      const file = new URL(relative, REPO_ROOT);
      if (
        throttleFixtureRequests &&
        relative.startsWith("themes/cozy-village/data/fixtures/")
      ) {
        const record = { response, timer: undefined };
        let settled = false;
        const abort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(record.timer);
          pendingThrottledFixtureRequests.delete(record);
          serverAbortedFixtureRequests += 1;
        };
        response.once("close", abort);
        record.timer = setTimeout(async () => {
          if (settled) return;
          settled = true;
          pendingThrottledFixtureRequests.delete(record);
          try {
            const body = await readFile(file);
            response.writeHead(200, {
              "content-type": CONTENT_TYPES.get(extname(relative)) ?? "application/octet-stream",
            });
            response.end(body);
          } catch {
            response.writeHead(404);
            response.end("not found");
          }
        }, 1_000);
        pendingThrottledFixtureRequests.add(record);
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES.get(extname(relative)) ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end("not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  const address = server.address();
  const stderr = [];
  const chrome = spawn(
    browser,
    [
      "--headless=new",
      "--no-sandbox",
      "--js-flags=--expose-gc",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--enable-unsafe-swiftshader",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      "--use-angle=swiftshader",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      `http://127.0.0.1:${address.port}/${query}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    setPriority(chrome.pid, 15);
  } catch {
    // Priority is a test-isolation hint; unsupported hosts still run the gate.
  }
  chrome.stderr.on("data", (chunk) => {
    if (stderr.join("").length < 16_000) stderr.push(String(chunk));
  });
  t.after(async () => {
    await stopChrome(chrome);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  });

  const port = await readDevToolsPort(profile, chrome);
  const devtools = await connectDevTools(await pageWebSocket(port));
  t.after(() => devtools.close());
  let payload = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const evaluated = await devtools.call("Runtime.evaluate", {
      expression: "document.querySelector('#qa-result')?.textContent || ''",
      returnByValue: true,
    });
    payload = evaluated.result?.value ?? "";
    if (payload) break;
    await wait(50);
  }
  assert.ok(payload, `browser emitted the village teardown result\n${stderr.join("")}`);
  const result = JSON.parse(payload);
  assert.equal(result.error, undefined, result.error);
  if (throttleFixtureRequests) {
    for (let attempt = 0; attempt < 100 && pendingThrottledFixtureRequests.size; attempt += 1) {
      await wait(10);
    }
    result.serverPendingFixtureRequests = pendingThrottledFixtureRequests.size;
    result.serverAbortedFixtureRequests = serverAbortedFixtureRequests;
  }
  if (delayedModulePath) {
    result.serverDelayedModuleRequests = delayedModuleRequests;
    result.serverCompletedDelayedModuleRequests = completedDelayedModuleRequests;
  }
  return result;
}

test("the real village-to-dashboard user path leaves zero work and closes entry streams", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: dashboardTeardownPage(index),
    query: "?data=live&project=atelier&motion=off#/styleguide",
    apiPayload: liveApiPayload,
  });

  assert.equal(result.contextLost, 1, "renderer emitted the real context-lost event");
  assert.equal(result.canvasConnected, false, "renderer canvas was removed");
  assert.equal(result.frameWorkAfterUnmount, 0);
  assert.equal(result.timerWorkAfterUnmount, 0);
  assert.equal(result.pendingThemeFrames, 0);
  assert.equal(result.pendingThemeTimers, 0);
  assert.deepEqual(
    result.firstGenerationAlive,
    { frames: 0, timers: 0, streams: 0 },
    "the slow first teardown fully reclaims only its generation",
  );
  assert.equal(
    result.firstReleasedBeforeSecondMount,
    true,
    "the activation queue releases the old generation before mounting the new one",
  );
  assert.equal(result.secondGenerationAlive.canvasConnected, true);
  assert.equal(result.secondGenerationAlive.debugWorld, true);
  assert.ok(result.secondGenerationAlive.frames > 0, "the second mount keeps its frame loop");
  assert.equal(result.secondGenerationAlive.streams, 2, "the second mount keeps both streams");
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
  assert.equal(result.dashboardSelected, true);
  assert.equal(result.themeActive, false);
  assert.deepEqual(result.themeStreams, [
    { path: "/api/dispatches/events", closeCalls: 1, readyState: 2 },
    { path: "/api/board/events", closeCalls: 1, readyState: 2 },
    { path: "/api/dispatches/events", closeCalls: 1, readyState: 2 },
    { path: "/api/board/events", closeCalls: 1, readyState: 2 },
  ]);
  assert.deepEqual(
    result.themeStreamListenerCounts,
    [0, 0, 0, 0],
    "closed EventSources retain no theme listener closures",
  );
  assert.equal(
    result.coreBoardReadyState,
    1,
    "the theme entry closes its board stream without conflating it with the dashboard owner",
  );
});

test("a successful final switch retains no canvas or context through teardown state", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: dashboardCanvasGcPage(index),
    query: "#/styleguide",
    apiPayload(path) {
      if (path === "/api/themes") {
        return {
          themes: [{
            id: "cozy-village",
            name: "GC probe theme",
            entryUrl: "/__atelier-test/gc-theme.mjs",
          }],
        };
      }
      return liveApiPayload(path);
    },
    testModules: {
      "/__atelier-test/gc-theme.mjs": GC_THEME_MODULE,
    },
  });

  assert.equal(result.contextLost, 1);
  assert.equal(result.retainedCanvases, 0, JSON.stringify(result));
  assert.equal(result.retainedContexts, 0, JSON.stringify(result));
  assert.equal(result.dashboardSelected, true);
});

test("a timed-out teardown falls back before a queued village reactivation and blocks overlap", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: dashboardTeardownPage(index, {
      contextLossDelayMs: 350,
      teardownShouldFail: true,
    }),
    query: "?data=live&project=atelier&motion=off#/styleguide",
    apiPayload: liveApiPayload,
  });

  assert.equal(result.fallbackBeforeContextLoss, true);
  assert.equal(result.secondGenerationAlive, null, "the queued reactivation never mounts");
  assert.equal(result.dashboardSelected, true);
  assert.equal(result.themeActive, false);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
  assert.equal(result.firstGenerationAlive.streams, 0);
  assert.equal(result.themeStreams.length, 2, "no second-generation streams were opened");
});

test("a failed in-flight dispose with live stream and timer blocks queued activation", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: failedInFlightCleanupPage(index),
    query: "#/styleguide",
    apiPayload(path) {
      if (path === "/api/themes") {
        return {
          themes: [{
            id: "cozy-village",
            name: "Failing in-flight theme",
            entryUrl: "/__atelier-test/failing-theme.mjs",
          }],
        };
      }
      return liveApiPayload(path);
    },
    testModules: {
      "/__atelier-test/failing-theme.mjs": FAILED_IN_FLIGHT_THEME_MODULE,
    },
  });

  assert.equal(result.disposeCalls, 1);
  assert.equal(result.leakedStreamAlive, true, "the failure case proves a live leaked stream");
  assert.equal(result.leakedTimerAlive, true, "the failure case proves a live leaked timer");
  assert.equal(result.mountCalls, 1, "the queued selection never overlaps the leaked generation");
  assert.equal(result.dashboardSelected, true);
  assert.equal(result.themeActive, false);
  assert.match(result.cleanupToast, /persistent in-flight dispose failure/);
});

test("a stalled host entry import releases its generation before the module settles", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: stalledHostEntryImportPage(index),
    query: "?data=live&project=atelier&motion=off#/styleguide",
    apiPayload: liveApiPayload,
    delayedModulePath: "/themes/cozy-village/entry.mjs",
  });

  assert.equal(result.serverDelayedModuleRequests, 1);
  assert.equal(result.serverCompletedDelayedModuleRequests, 1);
  assert.ok(result.switchElapsedMs < 1_800, "dashboard fallback does not await the module fetch");
  assert.equal(result.retainedBeforeImportSettled, false);
  assert.equal(result.lateCanvasCreates, 0, "late module settlement never starts mount work");
  assert.equal(result.generationRootsAfterLateSettlement, 0);
  assert.equal(result.selected, "dashboard");
  assert.equal(result.themeActive, false);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

for (const stalledImport of [
  {
    label: "source adapter",
    mode: "fixture",
    path: "/themes/cozy-village/data/fixture.mjs",
  },
  {
    label: "theme library",
    mode: "live",
    path: "/theme-lib/request.mjs",
  },
]) {
  test(`a stalled entry ${stalledImport.label} import releases its mount before settlement`, async (t) => {
    const result = await runBrowserProbe(t, {
      page: stalledEntryImportPage({ mode: stalledImport.mode }),
      query: "?data=" + stalledImport.mode + "&project=atelier&motion=off",
      apiPayload: liveApiPayload,
      delayedModulePath: stalledImport.path,
    });

    assert.equal(result.serverDelayedModuleRequests, 1);
    assert.equal(result.serverCompletedDelayedModuleRequests, 1);
    assert.equal(result.mountError, "AbortError");
    assert.ok(result.abortElapsedMs < 1_800, "entry abort does not await the module fetch");
    assert.equal(result.retainedBeforeImportSettled, false, JSON.stringify(result));
    assert.equal(result.retainedAfterImportSettled, false, JSON.stringify(result));
    assert.equal(result.lateFetches, 0, "late import settlement never begins source loading");
    assert.equal(result.lateContextCalls, 0, "late import settlement never reaches renderer work");
    assert.equal(result.hostChildrenAfterLateSettlement, 0);
    assert.equal(result.hasDebugWorld, false);
    assert.equal(result.hasThemeStylesheet, false);
  });
}

test("a stalled renderer module import releases its mount before settlement", async (t) => {
  const result = await runBrowserProbe(t, {
    page: stalledRendererModuleImportPage(),
    query: "?data=fixture&motion=off",
    delayedModulePath: "/themes/cozy-village/vendor/three.webgpu.js",
    webGpuRendererModule: true,
  });

  assert.equal(result.serverDelayedModuleRequests, 1);
  assert.equal(result.serverCompletedDelayedModuleRequests, 1);
  assert.equal(result.mountError, "AbortError");
  assert.ok(result.abortElapsedMs < 1_800, "renderer abort does not await the module fetch");
  assert.equal(result.retainedBeforeImportSettled, false);
  assert.equal(result.rendererConstructs, 0, "late module settlement never constructs a renderer");
  assert.equal(result.rendererInitCalls, 0);
  assert.equal(result.lateRendererTouches, 0);
  assert.equal(result.hostChildrenAfterLateSettlement, 0);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

for (const hangAt of ["adapter", "init"]) {
  test(`a hung first-generation ${hangAt} releases its graph and does not block a clean second mount`, async (t) => {
    const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
    const result = await runBrowserProbe(t, {
      page: hungRendererReactivationPage(index, { hangAt }),
      query: "?data=live&project=atelier&motion=off#/styleguide",
      apiPayload: liveApiPayload,
      webGpuRendererModule: hangAt === "init",
    });

    assert.equal(result.adapterCalls, 2);
    assert.equal(result.rendererInitCalls, hangAt === "init" ? 1 : 0);
    assert.ok(result.abortCallsAfterFirstGeneration > 0, "superseding aborts generation one");
    assert.equal(result.firstRootConnected, false);
    assert.equal(
      result.firstGenerationRetainedAfterTeardown,
      false,
      `the pending ${hangAt} promise retains no torn-down generation objects`,
    );
    assert.equal(result.lateRendererTouches, 0, "late settlement exits before renderer work");
    assert.equal(result.generationRootsAfterLateSettlement, 1, "late settlement does not reattach");
    assert.equal(result.secondRootConnected, true);
    assert.equal(result.secondCanvasConnected, true);
    assert.equal(result.selected, "cozy-village");
    assert.equal(result.themeActive, true);
    assert.ok(result.switchElapsedMs < 1_800, "abort settles before the teardown timeout");
    assert.equal(result.dashboardAfterCleanup, true);
    assert.equal(result.hasDebugWorldAfterCleanup, false);
  });
}

test("dashboard probe attributes native await, microtask, fetch, and stream continuation leaks", async (t) => {
  const index = await readFile(new URL("ui/index.html", REPO_ROOT), "utf8");
  const result = await runBrowserProbe(t, {
    page: dashboardTeardownPage(index, {
      asyncLeakKinds: ["await", "microtask", "fetch", "eventsource"],
    }),
    query: "?data=live&project=atelier&motion=off#/styleguide",
    apiPayload: liveApiPayload,
    asyncOwnerResponseDelayMs: 200,
  });

  assert.deepEqual(result.asyncLeakOwners, {
    await: 2,
    microtask: 2,
    eventsource: 2,
    fetch: 2,
  });
  assert.ok(result.timerWorkAfterUnmount >= 4);
  assert.ok(result.pendingThemeTimers >= 4);
});

test("supplementary direct fixture mount also leaves zero browser work", async (t) => {
  const result = await runBrowserProbe(t, {
    page: teardownPage(),
    query: "?data=fixture&motion=off",
  });

  assert.equal(result.contextLost, 1, "renderer emitted the real context-lost event");
  assert.equal(result.canvasConnected, false, "renderer canvas was removed");
  assert.equal(result.frameWorkAfterUnmount, 0);
  assert.equal(result.timerWorkAfterUnmount, 0);
  assert.equal(result.pendingThemeFrames, 0);
  assert.equal(result.pendingThemeTimers, 0);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

test("entry teardown terminally releases references after a throwing world dispose", async (t) => {
  const result = await runBrowserProbe(t, {
    page: teardownPage({ worldDisposeThrowsOnce: true }),
    query: "?data=fixture&motion=off",
  });

  assert.match(result.firstCleanupError, /world dispose failed once/);
  assert.deepEqual(result.releasedAfterThrow, {
    hostChildren: 0,
    hasDebugWorld: false,
    hasThemeStylesheet: false,
  });
  assert.equal(result.worldDisposeCalls, 1, "a terminally failed instance is not retained for retry");
  assert.equal(
    result.contextLost,
    0,
    "the injected wrapper fails before world disposal; production host fallback owns context loss",
  );
  assert.equal(result.canvasConnected, false);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

test("world disposal continues after a mid-cleanup geometry failure", async (t) => {
  const result = await runBrowserProbe(t, {
    page: teardownPage({ geometryDisposeThrowsOnce: true }),
    query: "?data=fixture&motion=off",
  });

  assert.match(result.firstCleanupError, /geometry disposal failed once/);
  assert.equal(result.geometryDisposeThrows, 1);
  assert.ok(result.geometryDisposeCalls > 5, "the first terminal pass continues world cleanup");
  assert.equal(result.contextLost, 1);
  assert.equal(result.canvasConnected, false);
  assert.equal(result.pendingThemeFrames, 0);
  assert.equal(result.pendingThemeTimers, 0);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

test("entry teardown terminally releases a throwing unsubscribe", async (t) => {
  const result = await runBrowserProbe(t, {
    page: teardownPage({ unsubscribeThrowsOnce: true }),
    query: "?data=fixture&motion=off",
  });

  assert.match(result.firstCleanupError, /unsubscribe failed once/);
  assert.deepEqual(result.releasedAfterThrow, {
    hostChildren: 0,
    hasDebugWorld: false,
    hasThemeStylesheet: false,
  });
  assert.equal(result.unsubscribeDeleteThrows, 1);
  assert.equal(result.unsubscribeDeleteCalls, 1, "the failed instance is evicted without retry retention");
  assert.equal(result.contextLost, 1, "world cleanup still completes on the first attempt");
  assert.equal(result.pendingThemeTimers, 0);
});

test("persistent unsubscribe failure reaches the host and liveInstances retains no graph", async (t) => {
  const result = await runBrowserProbe(t, {
    page: persistentUnsubscribeHostPage(),
    query: "?data=fixture&motion=off",
  });

  assert.equal(result.unsubscribeThrows, 1);
  assert.equal(result.surfacedFailure.name, "ThemeTeardownError");
  assert.match(result.surfacedFailure.message, /persistent unsubscribe failure/);
  assert.ok(result.surfacedFailure.steps.includes("theme.dispose"));
  assert.deepEqual(result.retainedGraph, {
    root: false,
    canvas: false,
    world: false,
    source: false,
    store: false,
  });
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hostChildren, 0);
});

test("teardown instrumentation catches a deliberately leaked interval", async (t) => {
  const result = await runBrowserProbe(t, {
    page: teardownPage({ leakInterval: true }),
    query: "?data=fixture&motion=off",
  });

  assert.ok(result.timerWorkAfterUnmount > 0, "the leaked interval executes after unmount");
  assert.equal(result.pendingThemeTimers, 1, "the leaked interval remains owned by the theme");
});

test("abort during throttled fixture fetch leaves no pending request or parse work", async (t) => {
  const result = await runBrowserProbe(t, {
    page: abortDuringFixturePage(),
    query: "?data=fixture&motion=off",
    throttleFixtureRequests: true,
  });

  assert.equal(result.fixtureRequestsStarted, 2);
  assert.equal(result.fixtureSignalsReceived, 2, "both fixture fetches receive a lifecycle signal");
  assert.equal(result.fixtureSignalsAborted, 2, "both fixture fetch signals follow mount abort");
  assert.equal(result.abortedFixtureRequests, 2);
  assert.equal(result.pendingFixtureRequests, 0);
  assert.equal(result.serverAbortedFixtureRequests, 2);
  assert.equal(result.serverPendingFixtureRequests, 0);
  assert.equal(result.fixtureParseWorkAfterAbort, 0);
  assert.equal(result.mountError, "AbortError");
  assert.equal(result.contextCalls, 0);
  assert.equal(result.hostChildren, 0);
  assert.equal(result.pendingFrames, 0);
  assert.equal(result.pendingTimers, 0);
  assert.equal(result.workAfterAbort, 0);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});

test("abort during requestAdapter allocates no context and leaves no resources", async (t) => {
  const result = await runBrowserProbe(t, {
    page: abortDuringAdapterPage(),
    query: "?data=fixture&motion=off",
  });

  assert.equal(result.adapterRequested, 1);
  assert.equal(result.mountError, "AbortError");
  assert.equal(result.contextCalls, 0, "no WebGPU or WebGL context is allocated after abort");
  assert.equal(result.hostChildren, 0);
  assert.equal(result.pendingFrames, 0);
  assert.equal(result.pendingTimers, 0);
  assert.equal(result.workAfterAbort, 0);
  assert.equal(result.hasDebugWorld, false);
  assert.equal(result.hasThemeStylesheet, false);
});
