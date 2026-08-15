import assert from "node:assert/strict";
import test from "node:test";

import { renderProjectMainHealth } from "./main-health.mjs";

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = [...children];
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  async click() {
    await this.listeners.get("click")?.({ preventDefault() {} });
  }
}

function findByClass(node, className) {
  if (String(node.className).split(/\s+/).includes(className)) return node;
  for (const child of node.children || []) {
    const found = findByClass(child, className);
    if (found) return found;
  }
  return undefined;
}

test.before(() => {
  globalThis.document = {
    createElement(tagName) {
      return new FakeNode(tagName);
    },
  };
});

test.after(() => {
  delete globalThis.document;
});

test("acknowledged failure remains muted and visible while a newer verification runs", () => {
  const container = new FakeNode("div");
  const records = [
    {
      id: "older",
      project: "atelier",
      postMerge: {
        state: "failed",
        commit: "aaaaaaaaaaaaaaaa",
        queuedAt: "2026-07-22T10:00:00.000Z",
        acknowledgedAt: "2026-07-22T10:01:00.000Z",
        evidenceTail: "not ok 1 - older failure",
      },
    },
    {
      id: "newer",
      project: "atelier",
      postMerge: {
        state: "running",
        commit: "bbbbbbbbbbbbbbbb",
        queuedAt: "2026-07-22T10:02:00.000Z",
      },
    },
  ];

  renderProjectMainHealth(container, { name: "atelier" }, records);

  assert.equal(container.children.length, 2);
  assert.match(container.children[0].className, /main-health-acknowledged/);
  assert.equal(findByClass(container.children[0], "main-health-evidence").textContent, "not ok 1 - older failure");
  assert.equal(findByClass(container.children[0], "main-health-ack"), undefined);
  assert.match(container.children[1].className, /main-health-running/);
});

test("acknowledge control calls the persisted acknowledgement action", async () => {
  const container = new FakeNode("div");
  const record = {
    id: "failed",
    project: "atelier",
    postMerge: { state: "failed", commit: "cccccccccccccccc" },
  };
  let acknowledged;
  renderProjectMainHealth(container, { name: "atelier" }, [record], {
    acknowledge(candidate) {
      acknowledged = candidate.id;
    },
  });

  const control = findByClass(container, "main-health-ack");
  assert.ok(control);
  await control.click();
  assert.equal(acknowledged, "failed");
  assert.equal(control.disabled, true);
});
