import assert from "node:assert/strict";
import test from "node:test";

import { loadReadyTicketIds } from "./ready.mjs";

test("successful malformed structured readiness never falls through to text", async () => {
  const calls = [];
  await assert.rejects(
    loadReadyTicketIds(async (_file, args) => {
      calls.push(args);
      return "{not-json";
    }, "/fixture/br", "/fixture/tracker"),
    /Invalid br ready JSON/,
  );
  assert.deepEqual(calls, [["ready", "--json"]]);
});

test("only an unsupported --json option falls back to validated text readiness", async () => {
  const calls = [];
  const ready = await loadReadyTicketIds(async (_file, args) => {
    calls.push(args);
    if (args.includes("--json")) {
      throw new Error("unknown flag: --json");
    }
    return "1. [P0] [task] atelier-ready: valid fallback";
  }, "/fixture/br", "/fixture/tracker");

  assert.deepEqual([...ready], ["atelier-ready"]);
  assert.deepEqual(calls, [["ready", "--json"], ["ready"]]);

  const warnings = [];
  await assert.rejects(
    loadReadyTicketIds(async (_file, args) => {
      if (args.includes("--json")) throw new Error("unknown flag: --json");
      return "malformed text";
    }, "/fixture/br", "/fixture/tracker", {
      warn: (message) => warnings.push(message),
    }),
    /Invalid br ready text: no parseable issue rows/,
  );
  assert.deepEqual(warnings, [
    "Atelier ready queue: skipped unparseable br ready text line 1",
  ]);
});

test("legacy text skips variant rows while retaining the usable projection", async () => {
  const calls = [];
  const warnings = [];
  const ready = await loadReadyTicketIds(async (_file, args) => {
    calls.push(args);
    if (args.includes("--json")) throw new Error("unknown flag: --json");
    return [
      "📋 Ready work (3 issues with no blockers):",
      "1. [P1] [task] atelier-first: parseable",
      "2. future-format atelier-variant without known metadata",
      "3. [P0] [bug] atelier-urgent: parseable",
    ].join("\n");
  }, "/fixture/br", "/fixture/tracker", {
    warn: (message) => warnings.push(message),
  });

  assert.deepEqual([...ready], ["atelier-urgent", "atelier-first"]);
  assert.deepEqual(calls, [["ready", "--json"], ["ready"]]);
  assert.deepEqual(warnings, [
    "Atelier ready queue: skipped unparseable br ready text line 3",
  ]);
});

test("legacy text requires a recognizable empty shape", async () => {
  await assert.rejects(
    loadReadyTicketIds(async (_file, args) => {
      if (args.includes("--json")) throw new Error("unknown flag: --json");
      return "";
    }, "/fixture/br", "/fixture/tracker"),
    /Invalid br ready text: no parseable issue rows/,
  );
});

test("an ordinary nonzero structured readiness failure does not invoke text mode", async () => {
  const calls = [];
  await assert.rejects(
    loadReadyTicketIds(async (_file, args) => {
      calls.push(args);
      throw new Error("tracker lock unavailable");
    }, "/fixture/br", "/fixture/tracker"),
    /tracker lock unavailable/,
  );
  assert.deepEqual(calls, [["ready", "--json"]]);
});
