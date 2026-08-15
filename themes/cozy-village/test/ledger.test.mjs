import assert from "node:assert/strict";
import test from "node:test";

import { buildLedger } from "../ui/chrome.mjs";

class FakeNode {
  constructor(tagName, textContent = "") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.dataset = {};
    this.style = {};
    this.textContent = textContent;
    this.attributes = new Map();
  }

  append(...children) {
    this.children.push(...children);
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function textOf(node) {
  if (typeof node === "string") return node;
  return [node.textContent, ...node.children.map(textOf)].join("");
}

test.before(() => {
  globalThis.document = {
    createElement(tagName) {
      return new FakeNode(tagName);
    },
    createTextNode(value) {
      return new FakeNode("#text", String(value));
    },
  };
});

test.after(() => {
  delete globalThis.document;
});

test("the village ledger reports aggregate projections without inventing absent cost", () => {
  const text = textOf(buildLedger({
    stats: {
      merges: 44,
      ready: 2,
      inFlight: 5,
      retainedFailures: 1,
      awaitingArchive: 1,
      artifacts: 7,
      costPerMergeUSD: null,
    },
  }));
  assert.match(text, /44merges in the archive projection/);
  assert.match(text, /Ready tickets2/);
  assert.match(text, /Parcels in flight5/);
  assert.match(text, /Retained failures1/);
  assert.match(text, /Awaiting archive1/);
  assert.match(text, /R&D artifacts7/);
  assert.match(text, /Cost per mergeunreported/);
  assert.doesNotMatch(text, /undefined|NaN/);
});

test("a reported aggregate cost remains visible", () => {
  const text = textOf(buildLedger({
    stats: {
      merges: 2,
      ready: 0,
      inFlight: 0,
      retainedFailures: 0,
      awaitingArchive: 0,
      artifacts: 0,
      costPerMergeUSD: 12.5,
    },
  }));
  assert.match(text, /12[.,]50/);
  assert.doesNotMatch(text, /undefined|NaN/);
});
