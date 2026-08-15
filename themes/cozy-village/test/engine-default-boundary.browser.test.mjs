/**
 * DEFAULT ENGINE MOUNT BOUNDARY — a direct check on `world/engine.mjs`'s
 * `mountEngine`/`mountThree` contract: `entry.mjs`'s startup try/catch must
 * wrap ONLY the awaited renderer-creation step, exactly as it did before the
 * engine-registry seam existed. `createWorld()` runs synchronously
 * afterward, OUTSIDE that try, so a `createWorld()` throw must NOT be caught
 * by the renderer's catch/teardown boundary — same as base
 * (`git show 64c2bb3:themes/cozy-village/entry.mjs`), where `createWorld()`
 * was a bare statement after the try/catch closed.
 *
 * Real headless Chrome (same swiftshader/WebGL path `teardown.browser.test.mjs`
 * already relies on for the default engine — no WebGPU flags needed here,
 * unlike the Moss smoke). Self-contained rather than sharing a harness with
 * either sibling suite, for the same reason `moss-engine.browser.test.mjs`
 * gives for its own isolation: this exercises a different seam and has no
 * reason to couple to either suite's page fixtures.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";

const REPO_ROOT = new URL("../../../", import.meta.url);

async function availableChromium() {
  for (const candidate of [
    process.env.ATELIER_CHROME_BIN,
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".woff2", "font/woff2"],
]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDevToolsPort(profile, chromeProcess) {
  const portFile = join(profile, "DevToolsActivePort");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (chromeProcess.exitCode !== null) throw new Error(`Chrome exited with ${chromeProcess.exitCode}`);
    try {
      const [port] = (await readFile(portFile, "utf8")).trim().split(/\s+/);
      if (port) return Number(port);
    } catch {
      // Chrome writes the port file once its browser process is ready.
    }
    await wait(25);
  }
  throw new Error("Chrome did not publish its DevTools port");
}

async function pageWebSocket(port) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
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
  throw new Error("Chrome did not expose the page target");
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
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
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

async function stopChrome(chromeProcess) {
  if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) return;
  chromeProcess.kill("SIGKILL");
  await once(chromeProcess, "exit");
}

/* `world/engine.mjs`'s `mountThree` only imports `createWorld` from
   `./world.mjs` — this stub only needs to cover that one export to safely
   stand in for the real module for every request the page makes. */
const CREATE_WORLD_THROW_MARKER = "__h1_probe_create_world_boom__";
function throwingWorldModule() {
  return `export function createWorld() {
    throw new Error(${JSON.stringify(CREATE_WORLD_THROW_MARKER)});
  }`;
}

function probePage() {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Default engine boundary probe</title></head>
      <body>
        <main id="host" style="position:fixed;inset:0;width:640px;height:480px"></main>
        <script type="module">
          window.__probe = { phase: 'loading' };
          try {
            const { mount } = await import('/themes/cozy-village/entry.mjs');
            const host = document.querySelector('#host');
            try {
              await mount(host, { mode: 'fixture', generation: Symbol('h1-probe') });
              window.__probe.phase = 'mounted-unexpectedly';
            } catch (error) {
              window.__probe.phase = 'rejected';
              window.__probe.errorMessage = String(error?.message ?? error);
              /* If createWorld()'s throw were caught by the renderer's
                 catch/teardown boundary, teardown() would have removed the
                 mounted root (canvas included) synchronously before
                 rethrowing — base never reached teardown on this path, so
                 the root must still be attached here. */
              window.__probe.hostChildrenAfterReject = host.childElementCount;
              window.__probe.canvasStillAttached =
                document.querySelectorAll('canvas.cv-canvas').length > 0;
            }
          } catch (error) {
            window.__probe.phase = 'failed';
            window.__probe.error = String(error?.stack ?? error);
          }
        </script>
      </body>
    </html>`;
}

test(
  "H1: the default engine's createWorld() failure is not caught by the renderer's catch/teardown boundary",
  async (t) => {
    const browser = await availableChromium();
    if (!browser) {
      t.skip("Chrome or Chromium is required; set ATELIER_CHROME_BIN to its executable");
      return;
    }

    const profile = await mkdtemp(join(tmpdir(), "atelier-h1-boundary-"));
    const server = createServer(async (request, response) => {
      try {
        const path = new URL(request.url, "http://127.0.0.1").pathname;
        if (path === "/") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(probePage());
          return;
        }
        if (path === "/themes/cozy-village/world/world.mjs") {
          response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
          response.end(throwingWorldModule());
          return;
        }
        const bare = normalize(path).replace(/^[/\\]+/, "");
        if (!bare || bare.startsWith("..")) throw new Error("path escape");
        const file = new URL(bare, REPO_ROOT);
        const body = await readFile(file);
        response.writeHead(200, {
          "content-type": CONTENT_TYPES.get(extname(bare)) ?? "application/octet-stream",
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

    const chrome = spawn(browser, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-dev-shm-usage",
      "--disable-crash-reporter",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=640,480",
      "about:blank",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    t.after(async () => {
      await stopChrome(chrome);
      await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    });

    const port = await readDevToolsPort(profile, chrome);
    const devtools = await connectDevTools(await pageWebSocket(port));
    t.after(() => devtools.close());

    await devtools.call("Runtime.enable");
    await devtools.call("Page.enable");
    /* Same warmup wait `moss-engine.browser.test.mjs` uses: the GPU process
       needs a moment after launch before adapter/context requests resolve
       reliably under headless swiftshader. */
    await wait(1_000);
    await devtools.call("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });

    let phase;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const result = await devtools.call("Runtime.evaluate", {
        expression: "window.__probe?.phase ?? 'loading'",
        returnByValue: true,
      });
      phase = result.result.value;
      if (phase === "rejected" || phase === "mounted-unexpectedly" || phase === "failed") break;
      await wait(50);
    }

    if (phase === "failed") {
      const errorResult = await devtools.call("Runtime.evaluate", {
        expression: "window.__probe.error",
        returnByValue: true,
      });
      assert.fail(`probe page failed unexpectedly: ${errorResult.result.value}`);
    }
    assert.equal(phase, "rejected", "mount() must reject when createWorld() throws");

    const probeResult = await devtools.call("Runtime.evaluate", {
      expression: "JSON.stringify(window.__probe)",
      returnByValue: true,
    });
    const probe = JSON.parse(probeResult.result.value);
    assert.match(probe.errorMessage, new RegExp(CREATE_WORLD_THROW_MARKER));
    assert.equal(
      probe.canvasStillAttached,
      true,
      "a createWorld() throw must NOT be caught by the renderer's catch/teardown boundary — " +
        "base never reached teardown on this path, so the canvas must stay mounted",
    );
    assert.ok(probe.hostChildrenAfterReject > 0);
  },
);
