import assert from "node:assert/strict";
import test from "node:test";

import { resolveMode, resolveTimePreview } from "../data/source.mjs";

test("source query resolves fixture mode and stable clock previews", () => {
  const base = new Date(2026, 6, 30, 8, 15, 12);
  assert.equal(resolveMode("?data=fixture"), "fixture");
  assert.equal(resolveTimePreview("?time=noon", base)?.getHours(), 12);
  assert.equal(resolveTimePreview("?time=dusk", base)?.getHours(), 18);
  assert.equal(resolveTimePreview("?time=dusk", base)?.getMinutes(), 30);
  assert.equal(resolveTimePreview("?time=night", base)?.getHours(), 23);
  assert.equal(resolveTimePreview("?time=21:45", base)?.getHours(), 21);
  assert.equal(resolveTimePreview("?time=21:45", base)?.getMinutes(), 45);
  assert.equal(resolveTimePreview("?time=25:99", base), null);
});
