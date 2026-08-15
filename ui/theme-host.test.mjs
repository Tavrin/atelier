import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  shouldReturnToDashboard,
  teardownTheme,
  trackThemeCanvases,
} from "./theme-host.mjs";

test("Escape returns an active theme to the dashboard and ignores other contexts", () => {
  assert.equal(shouldReturnToDashboard({ key: "Escape" }, true), true);
  assert.equal(shouldReturnToDashboard({ key: "Escape" }, false), false);
  assert.equal(shouldReturnToDashboard({ key: "Enter" }, true), false);
  assert.equal(shouldReturnToDashboard({ key: "Escape", defaultPrevented: true }, true), false);
});

const STATIC_MODULE_EDGES = [
  /(?:^|\n)\s*import\s+(?!\()(?:(?:[^;"']|\n)*?\sfrom\s+)?["']([^"']+)["']/g,
  /(?:^|\n)\s*export\s+(?:\*|\{(?:[^}"']|\n)*\})\s+from\s+["']([^"']+)["']/g,
];
const FORBIDDEN_LITERAL_MODULE =
  /(?:from\s*|import\s*\(\s*)["'][^"']*(?:^|\/)themes\/|three(?:\.module|\.webgpu)?\.js/i;

async function dashboardModuleGraph(entry, load = (url) => readFile(url, "utf8")) {
  const graph = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const url = queue.shift();
    if (graph.has(url.href)) continue;
    const source = await load(url);
    graph.set(url.href, source);
    assert.doesNotMatch(
      source,
      FORBIDDEN_LITERAL_MODULE,
      `dashboard module ${url.pathname} contains a literal theme or three.js load`,
    );
    for (const edge of STATIC_MODULE_EDGES) {
      for (const match of source.matchAll(edge)) {
        const specifier = match[1];
        assert.doesNotMatch(
          specifier,
          /(?:^|\/)themes\/|three(?:\.module|\.webgpu)?\.js/i,
          `dashboard module ${url.pathname} eagerly imports ${specifier}`,
        );
        if (!specifier.startsWith(".")) continue;
        queue.push(new URL(specifier, url));
      }
    }
  }
  return graph;
}

test("the transitive dashboard module graph has no eager theme or three.js edge", async () => {
  const entry = new URL("./app.js", import.meta.url);
  const [graph, index] = await Promise.all([
    dashboardModuleGraph(entry),
    readFile(new URL("./index.html", import.meta.url), "utf8"),
  ]);
  const app = graph.get(entry.href);
  assert.ok(graph.size > 10, "the negative gate crawled the dashboard's static dependency closure");
  assert.doesNotMatch(index, /modulepreload|\/themes\/|three\.module/);
  assert.match(app, /await raceThemeGeneration\(import\(theme\.entryUrl\), token\)/);
  assert.ok(
    app.indexOf("if (!theme)") < app.indexOf("raceThemeGeneration(import(theme.entryUrl), token)"),
    "dashboard selection returns before the only theme import expression",
  );
  assert.ok(
    app.indexOf("trackThemeCanvases(generationRoot)") <
      app.indexOf("raceThemeGeneration(import(theme.entryUrl), token)"),
    "canvas interception begins before the theme entry module is evaluated",
  );

  const fixtureEntry = new URL("file:///dashboard/app.js");
  const fixtureSources = new Map([
    [fixtureEntry.href, 'import "./dependency.mjs";'],
    [new URL("./dependency.mjs", fixtureEntry).href, 'import "/themes/cozy-village/entry.mjs";'],
  ]);
  await assert.rejects(
    dashboardModuleGraph(fixtureEntry, async (url) => fixtureSources.get(url.href)),
    /(?:contains a literal theme or three\.js load|eagerly imports \/themes\/cozy-village\/entry\.mjs)/,
    "an eager theme import in a transitive dashboard dependency fails the crawler",
  );
});

function fixture({
  dispose,
  cleanup,
  confirmContextLoss = true,
  contextLossExtension = true,
  canvasKinds = ["webgl2", "webgl"],
} = {}) {
  const calls = [];
  const canvases = canvasKinds.map((kind) => {
    const listeners = new Map();
    const context = {
      getExtension(name) {
        calls.push(`extension:${kind}:${name}`);
        if (kind !== "webgl" && kind !== "webgl2") return null;
        if (!contextLossExtension) return null;
        return {
          loseContext() {
            calls.push(`release:${kind}`);
            if (confirmContextLoss) {
              listeners.get("webglcontextlost")?.({ type: "webglcontextlost" });
            }
          },
        };
      },
    };
    const canvas = {
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
      getContext(requested) {
        calls.push(`unexpected-context:${kind}:${requested}`);
        throw new Error("teardown must not call canvas.getContext");
      },
      remove() {
        calls.push(`remove:${kind}`);
      },
      emit(type) {
        listeners.get(type)?.({ type });
      },
    };
    canvas.contextRecord = kind === "uninitialized"
      ? undefined
      : { context, kind: kind.startsWith("webgl") ? "webgl" : kind };
    return canvas;
  });
  const root = {
    childCount: 1,
    querySelectorAll(selector) {
      assert.equal(selector, "canvas");
      return canvases;
    },
    replaceChildren() {
      calls.push("clear");
      this.childCount = 0;
    },
  };
  const canvasTracker = trackThemeCanvases(root, {
    MutationObserverImpl: null,
    contextRecordForCanvas: (canvas) => canvas.contextRecord,
  });
  return { calls, canvases, canvasTracker, cleanup, dispose, root };
}

test("theme teardown calls exported dispose and force-releases every tracked WebGL canvas", async () => {
  const subject = fixture({
    cleanup() {
      subject.calls.push("cleanup");
    },
    dispose() {
      subject.calls.push("dispose");
    },
  });

  const result = await teardownTheme(subject);

  assert.equal(result.error, undefined);
  assert.equal(subject.root.childCount, 0);
  assert.deepEqual(subject.calls.filter((call) => call.startsWith("release:")), [
    "release:webgl2",
    "release:webgl",
  ]);
  assert.equal(result.contextLosses.confirmed, 2);
  assert.equal(result.contextLosses.attempted, 2);
  assert.deepEqual(subject.calls.filter((call) => call.startsWith("remove:")), [
    "remove:webgl2",
    "remove:webgl",
  ]);
  assert.ok(subject.calls.indexOf("dispose") < subject.calls.indexOf("clear"));
});

test("theme teardown without dispose still clears the subtree and releases contexts", async () => {
  const subject = fixture();

  const result = await teardownTheme(subject);

  assert.equal(result.error, undefined);
  assert.equal(subject.root.childCount, 0);
  assert.equal(subject.calls.includes("clear"), true);
  assert.equal(
    subject.calls.filter((call) => call.startsWith("release:")).length,
    2,
    "missing dispose is the negative control",
  );
  assert.equal(result.contextLosses.confirmed, 2);
});

test("throwing theme dispose reports failure after completing dashboard fallback teardown", async () => {
  const subject = fixture({
    dispose() {
      throw new Error("renderer exploded");
    },
  });

  const result = await teardownTheme(subject);

  assert.match(result.error?.message ?? "", /renderer exploded/);
  assert.equal(subject.root.childCount, 0);
  assert.equal(subject.calls.at(-1), "clear");
  assert.equal(subject.calls.filter((call) => call.startsWith("release:")).length, 2);
  assert.equal(result.contextLosses.confirmed, 2);
});

test("theme dispose wait is bounded before fallback teardown", async () => {
  const subject = fixture({
    dispose() {
      return new Promise(() => {});
    },
  });

  const result = await teardownTheme({ ...subject, timeoutMs: 5 });

  assert.match(result.error?.message ?? "", /timed out after 5ms/);
  assert.equal(subject.root.childCount, 0);
});

test("missing context-lost confirmation is reported after the canvases are removed", async () => {
  const subject = fixture({ confirmContextLoss: false });

  const result = await teardownTheme({ ...subject, contextLossWaitMs: 1 });

  assert.match(result.error?.message ?? "", /context loss was not confirmed for 2 canvas/);
  assert.equal(result.contextLosses.confirmed, 0);
  assert.equal(result.contextLosses.attempted, 2);
  assert.equal(result.contextLosses.unconfirmedCount, 2);
  assert.equal("canvases" in result.contextLosses, false);
  assert.equal("unconfirmed" in result.contextLosses, false);
  assert.equal(subject.root.childCount, 0);
  assert.equal(subject.calls.filter((call) => call.startsWith("remove:")).length, 2);
});

test("a WebGL context without WEBGL_lose_context remains unconfirmed", async () => {
  const subject = fixture({ contextLossExtension: false });

  const result = await teardownTheme(subject);

  assert.match(result.error?.message ?? "", /context loss was not confirmed for 2 canvas/);
  assert.equal(result.contextLosses.attempted, 2);
  assert.equal(result.contextLosses.confirmed, 0);
  assert.equal(result.contextLosses.unconfirmedCount, 2);
  assert.equal(subject.calls.filter((call) => call.startsWith("release:")).length, 0);
  assert.equal(subject.calls.filter((call) => call.startsWith("remove:")).length, 2);
  assert.equal(subject.root.childCount, 0);
});

test("a restored natural context loss is fresh for teardown and force-release still runs", async () => {
  const subject = fixture({
    canvasKinds: ["webgl"],
    dispose() {
      throw new Error("theme hook failed");
    },
  });
  subject.canvases[0].emit("webglcontextlost");
  subject.canvases[0].emit("webglcontextrestored");

  const result = await teardownTheme(subject);

  assert.match(result.error?.message ?? "", /theme hook failed/);
  assert.deepEqual(subject.calls.filter((call) => call === "release:webgl"), [
    "release:webgl",
  ]);
  assert.equal(result.contextLosses.attempted, 1);
  assert.equal(result.contextLosses.confirmed, 1);
  assert.equal(result.contextLosses.unconfirmedCount, 0);
});

test("theme teardown reports every failed hook as structured failures", async () => {
  const subject = fixture({
    cleanup() {
      throw new Error("cleanup failed");
    },
    dispose() {
      throw new Error("dispose failed");
    },
  });

  const result = await teardownTheme(subject);

  assert.deepEqual(
    result.failures.slice(0, 2).map(({ step, error }) => [step, error.message]),
    [
      ["theme.cleanup", "cleanup failed"],
      ["theme.dispose", "dispose failed"],
    ],
  );
  assert.equal(result.error?.name, "ThemeTeardownError");
});

test("a WebGPU-style canvas is removed without WebGL probing or blocking teardown", async () => {
  const subject = fixture({ canvasKinds: ["webgpu"] });

  const result = await teardownTheme(subject);

  assert.equal(result.error, undefined);
  assert.equal(result.contextLosses.attempted, 0);
  assert.equal(result.contextLosses.confirmed, 0);
  assert.equal(result.contextLosses.releasedWithoutConfirmation, 1);
  assert.deepEqual(subject.calls, ["remove:webgpu", "clear"]);
});

test("an auxiliary 2D canvas does not join WebGL confirmation or block switching", async () => {
  const subject = fixture({ canvasKinds: ["webgl2", "2d", "uninitialized"] });

  const result = await teardownTheme(subject);

  assert.equal(result.error, undefined);
  assert.equal(result.contextLosses.attempted, 1);
  assert.equal(result.contextLosses.confirmed, 1);
  assert.equal(result.contextLosses.releasedWithoutConfirmation, 2);
  assert.equal(subject.calls.some((call) => call.startsWith("unexpected-context:")), false);
  assert.deepEqual(subject.calls.filter((call) => call.startsWith("remove:")), [
    "remove:webgl2",
    "remove:2d",
    "remove:uninitialized",
  ]);
});

test("a WebGL context created at theme module scope is tracked and confirmed lost", async () => {
  const previousCanvas = globalThis.HTMLCanvasElement;
  const calls = [];
  class ModuleScopeCanvas {
    constructor() {
      this.listeners = new Map();
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    }

    getContext(type) {
      calls.push(`context:${type}`);
      return {
        getExtension: (name) => ({
          loseContext: () => {
            calls.push(`lost:${name}`);
            this.listeners.get("webglcontextlost")?.({ type: "webglcontextlost" });
          },
        }),
      };
    }

    remove() {
      calls.push("remove");
    }
  }
  globalThis.HTMLCanvasElement = ModuleScopeCanvas;
  const originalGetContext = ModuleScopeCanvas.prototype.getContext;
  const root = {
    querySelectorAll() {
      return [];
    },
  };

  try {
    const tracker = trackThemeCanvases(root, { MutationObserverImpl: null });
    await import(
      "data:text/javascript," + encodeURIComponent(`
        globalThis.__atelierModuleScopeCanvas = new globalThis.HTMLCanvasElement();
        globalThis.__atelierModuleScopeCanvas.getContext("webgl2");
      `)
    );

    const result = await tracker.release();

    assert.equal(result.attempted, 1);
    assert.equal(result.confirmed, 1);
    assert.equal(result.unconfirmedCount, 0);
    assert.deepEqual(calls, [
      "context:webgl2",
      "lost:WEBGL_lose_context",
      "remove",
    ]);
    assert.equal(ModuleScopeCanvas.prototype.getContext, originalGetContext);
  } finally {
    delete globalThis.__atelierModuleScopeCanvas;
    globalThis.HTMLCanvasElement = previousCanvas;
  }
});
