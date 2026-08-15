import assert from "node:assert/strict";
import test from "node:test";

import { boardColumn, makeActivatable } from "./components.mjs";

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      target: this,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...properties,
    };
    let current = this;
    while (current && !event.propagationStopped) {
      event.currentTarget = current;
      for (const listener of current.listeners.get(type) || []) listener(event);
      current = current.parentNode;
    }
    return event;
  }
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

test("board column makes the card body the keyboard-focusable scroll region", () => {
  const rendered = boardColumn("ready", "Ready", 29);

  assert.equal(rendered.column.className, "column");
  assert.equal(rendered.column.dataset.kind, "ready");
  assert.equal(rendered.column.tabIndex, undefined);
  assert.equal(rendered.body.className, "card-list");
  assert.equal(rendered.body.tabIndex, 0);
  assert.equal(rendered.body.getAttribute("role"), "region");
  assert.equal(rendered.body.getAttribute("aria-label"), "Ready tickets");
  assert.equal(rendered.count.textContent, "29");
  assert.deepEqual(rendered.column.children.map((child) => child.className), [
    "column-header",
    "card-list",
  ]);
});

test("activatable cards let wheel input bubble to the column body without cancellation", () => {
  const { body } = boardColumn("ready", "Ready", 1);
  let activations = 0;
  let wheelEvents = 0;
  const card = makeActivatable(new FakeNode("article"), () => {
    activations += 1;
  });
  body.addEventListener("wheel", () => {
    wheelEvents += 1;
  });
  body.append(card);

  const wheel = card.dispatch("wheel", { deltaY: 120 });
  assert.equal(wheelEvents, 1);
  assert.equal(wheel.defaultPrevented, false);
  assert.equal(activations, 0);

  const arrow = card.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(arrow.defaultPrevented, false);
  assert.equal(activations, 0);

  const enter = card.dispatch("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(activations, 1);
});
