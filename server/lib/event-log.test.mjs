import assert from "node:assert/strict";
import * as fs from "node:fs";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEventLog,
  EVENT_LOG_SCHEMA_VERSION,
  fieldDiff,
  matchesLogQuery,
  MAX_LOG_KINDS,
  MAX_LOG_LIMIT,
  normalizeLogQuery,
} from "./event-log.mjs";

async function logRoot(t, slug) {
  const root = await mkdtemp(join(tmpdir(), `atelier-${slug}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("event log writes the spec event shape, one JSONL line per event", async (t) => {
  const root = await logRoot(t, "event-log-shape");
  const log = createEventLog({ stateDir: root });
  const observed = [];
  const stop = log.onEvent((event) => observed.push(event));

  const first = log.append("queue.drain", {
    project: "alpha",
    decision: "skipped",
    reason: "budget",
  });
  const second = log.append("dispatch.hook", { dispatchId: "d-1" }, { source: "dispatch" });
  log._flush();
  stop();
  log.append("queue.drain", { project: "alpha", decision: "picked" });

  assert.deepEqual(observed.map(({ kind }) => kind), ["queue.drain", "dispatch.hook"]);
  assert.equal(first.v, EVENT_LOG_SCHEMA_VERSION);
  assert.equal(first.source, "server");
  assert.equal(second.source, "dispatch", "source is a writer-supplied field, not server-only");
  assert.equal(second.seq, first.seq + 1);
  assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T/);

  const persisted = await readFile(log.path, "utf8");
  assert.equal(persisted.split("\n").filter(Boolean).length, 3);
  const lines = persisted.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(Object.keys(lines[0]).slice(0, 5), ["v", "ts", "seq", "source", "kind"]);
  assert.deepEqual(lines.map(({ seq }) => seq), [1, 2, 3]);
});

test("security-critical append is inline, fsyncs, and retains the non-authorizing token id", async (t) => {
  const root = await logRoot(t, "event-log-durable");
  let descriptorAppends = 0;
  let fsyncs = 0;
  const log = createEventLog({
    stateDir: root,
    fileOps: {
      ...fs,
      appendFileSync(...args) {
        descriptorAppends += 1;
        return fs.appendFileSync(...args);
      },
      fsyncSync(...args) {
        fsyncs += 1;
        return fs.fsyncSync(...args);
      },
    },
  });
  const tokenId = "a".repeat(43);
  const event = log.appendDurable("dispatch.break-glass", {
    dispatchId: "dispatch-1",
    phase: "minted",
    tokenId,
  });

  assert.equal(event.tokenId, tokenId);
  assert.equal(descriptorAppends, 1);
  assert.ok(fsyncs >= 1);
  assert.equal(JSON.parse(await readFile(log.path, "utf8")).tokenId, tokenId);
});

test("event log redacts secret-shaped keys and credential strings at write time", async (t) => {
  const root = await logRoot(t, "event-log-redact");
  const log = createEventLog({ stateDir: root });

  const event = log.append("registry.change", {
    project: "alpha",
    actor: "ui",
    changes: {
      dispatchEnv: { from: null, to: { ANTHROPIC_API_KEY: "sk-live-must-not-leak-abcdefghij" } },
      notes: { from: "old", to: "token: hunter2-hunter2-hunter2" },
    },
    prompt: "here is ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa for you",
  });

  assert.equal(event.changes.dispatchEnv.to.ANTHROPIC_API_KEY, "***");
  assert.equal(event.changes.notes.to, "token: [redacted]");
  assert.equal(event.prompt, "here is [redacted] for you");
  log._flush();
  const persisted = await readFile(log.path, "utf8");
  assert.doesNotMatch(persisted, /must-not-leak/);
  assert.doesNotMatch(persisted, /hunter2/);
  assert.doesNotMatch(persisted, /ghp_a/);
});

test("event log bounds oversized payloads instead of dropping the decision", async (t) => {
  const root = await logRoot(t, "event-log-bounds");
  const log = createEventLog({ stateDir: root });

  const long = log.append("queue.drain", { project: "alpha", detail: "x".repeat(9_000) });
  assert.equal(long.detail.length, 2_000);

  const huge = log.append("queue.drain", {
    project: "alpha",
    dispatchId: "d-1",
    ticketIds: Array.from({ length: 60 }, (_, index) => `ticket-${index}-`.repeat(300)),
  });
  assert.equal(huge.truncated, true, "an oversized event degrades to its identity fields");
  assert.equal(huge.project, "alpha");
  assert.equal(huge.dispatchId, "d-1");

  let touchedPastBound = false;
  const candidates = Array.from({ length: 1_000 }, (_, index) => `candidate-${index}`);
  Object.defineProperty(candidates, 64, {
    get() {
      touchedPastBound = true;
      throw new Error("redaction traversed beyond the stored candidate bound");
    },
  });
  const boundedFirst = log.append("queue.drain", { candidates });
  assert.equal(boundedFirst.candidates.length, 64);
  assert.equal(touchedPastBound, false, "large arrays are bounded before redaction copies them");

  const hostile = {};
  Object.defineProperty(hostile, "detail", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.equal(log.append("queue.drain", hostile), undefined, "hostile payloads still degrade");

  log._flush();
  const lines = (await readFile(log.path, "utf8")).split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(Buffer.byteLength(line) < 33 * 1024);
});

test("event log reserved fields cannot be spoofed by a payload", async (t) => {
  const root = await logRoot(t, "event-log-reserved");
  const log = createEventLog({ stateDir: root });
  const event = log.append("queue.drain", {
    v: 99,
    ts: "1999-01-01T00:00:00.000Z",
    seq: 4_242,
    source: "spoofed",
    kind: "spoofed.kind",
    project: "alpha",
  });
  assert.equal(event.v, EVENT_LOG_SCHEMA_VERSION);
  assert.equal(event.seq, 1);
  assert.equal(event.kind, "queue.drain");
  assert.equal(event.source, "server");
  assert.notEqual(event.ts, "1999-01-01T00:00:00.000Z");
});

test("event log filters by kind list, project, actor, since and a bounded limit", async (t) => {
  const root = await logRoot(t, "event-log-filters");
  const log = createEventLog({ stateDir: root });
  log.append("queue.drain", { project: "alpha", decision: "picked" });
  log.append("queue.park", { project: "alpha", ticketId: "alpha-1", actor: "dispatcher" });
  log.append("queue.settings", { project: "beta", actor: "ui" });
  log.append("dispatch.transition", { project: "alpha", dispatchId: "d-1" });

  assert.deepEqual(log.read({ project: "alpha" }).map(({ kind }) => kind), [
    "queue.drain",
    "queue.park",
    "dispatch.transition",
  ]);
  assert.deepEqual(log.read({ kind: "queue.drain,queue.settings" }).map(({ project }) => project), [
    "alpha",
    "beta",
  ]);
  assert.deepEqual(log.read({ actor: "ui" }).map(({ project }) => project), ["beta"]);
  assert.deepEqual(log.read({ dispatchId: "d-1" }).map(({ kind }) => kind), [
    "dispatch.transition",
  ]);
  assert.deepEqual(log.read({ limit: 2 }).map(({ kind }) => kind), [
    "queue.settings",
    "dispatch.transition",
  ], "limit keeps the NEWEST events, chronologically ordered");
  assert.equal(log.read({ since: new Date(Date.now() + 60_000).toISOString() }).length, 0);
  assert.equal(log.read({ since: "1999-01-01T00:00:00.000Z" }).length, 4);

  assert.throws(() => log.read({ since: "yesterday-ish" }), /ISO-8601/);
  assert.throws(() => log.read({ since: "2026-07-30" }), /ISO-8601/);
  assert.throws(() => log.read({ since: "07/30/2026 12:00" }), /ISO-8601/);
  assert.throws(
    () => log.read({ kind: Array.from({ length: MAX_LOG_KINDS + 1 }, (_, index) => `k${index}`).join(",") }),
    /at most 16/,
  );
  assert.throws(() => log.read({ limit: 0 }), /between 1 and 1000/);
  assert.throws(() => log.read({ limit: MAX_LOG_LIMIT + 1 }), /between 1 and 1000/);
  assert.equal(normalizeLogQuery({}).limit, 200);
  assert.equal(matchesLogQuery({ kind: "a", ts: "2026-01-01T00:00:00.000Z" }, { kind: ["a"] }), true);
});

test("event log scan cap reports truncation without scanning the full retention window", async (t) => {
  const root = await logRoot(t, "event-log-scan-cap");
  const writer = createEventLog({ stateDir: root, maxBytes: 260, rotations: 5 });
  for (let index = 0; index < 12; index += 1) {
    writer.append("service.sample", { index, detail: "x".repeat(80) });
    writer._flush();
  }

  const capped = createEventLog({
    stateDir: root,
    maxBytes: 260,
    rotations: 5,
    maxScanBytes: 220,
  }).readResult({ kind: "does.not.exist", limit: 1_000 });
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.events, []);

  const complete = createEventLog({
    stateDir: root,
    maxBytes: 260,
    rotations: 5,
    maxScanBytes: 1024 * 1024,
  }).readResult({ kind: "does.not.exist", limit: 1_000 });
  assert.equal(complete.truncated, false, "the same sparse filter is complete under the cap");
});

test("event log rotates the active file and keeps reading across rotations", async (t) => {
  const root = await logRoot(t, "event-log-rotate");
  const log = createEventLog({ stateDir: root, maxBytes: 400, rotations: 2 });

  for (let index = 0; index < 12; index += 1) {
    log.append("service.sample", { index, detail: "x".repeat(80) });
    log._flush();
  }

  const files = (await readdir(log.directory)).sort();
  assert.deepEqual(files, ["events.1.jsonl", "events.2.jsonl", "events.jsonl"]);
  const events = log.read({ limit: MAX_LOG_LIMIT });
  assert.deepEqual(
    events.map(({ seq }) => seq),
    [...events.map(({ seq }) => seq)].sort((left, right) => left - right),
    "reads stay chronological across rotated files",
  );
  assert.equal(events.at(-1).index, 11);
  assert.ok(events.length < 12, "retention discards the oldest rotation");
  assert.ok(events.length > 1, "retained rotations are still readable");
});

test("event log recovers its sequence from the newest tail after a restart", async (t) => {
  const root = await logRoot(t, "event-log-seq");
  const first = createEventLog({ stateDir: root });
  first.append("service.start", {});
  first.append("service.stop", {});
  first._flush();

  const restarted = createEventLog({ stateDir: root });
  assert.equal(restarted.append("service.start", {}).seq, 3);
  restarted._flush();

  // Torn tail from an unclean death: the partial line is skipped, and the
  // sequence continues from the last COMPLETE line rather than resetting.
  appendFileSync(restarted.path, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","seq":4,"kin');
  const afterCrash = createEventLog({ stateDir: root });
  assert.equal(afterCrash.append("service.start", {}).seq, 4);
  assert.deepEqual(afterCrash.read({ limit: 10 }).map(({ seq }) => seq), [1, 2, 3, 4]);
});

test("event log rotation is recovered as a sequence floor, not a reset", async (t) => {
  const root = await logRoot(t, "event-log-seq-rotated");
  const log = createEventLog({ stateDir: root, maxBytes: 300, rotations: 2 });
  for (let index = 0; index < 6; index += 1) {
    log.append("service.sample", { detail: "y".repeat(80) });
    log._flush();
  }
  const highest = log.read({ limit: MAX_LOG_LIMIT }).at(-1).seq;

  const restarted = createEventLog({ stateDir: root, maxBytes: 300, rotations: 2 });
  assert.equal(restarted.append("service.start", {}).seq, highest + 1);
});

test("event log defers one filesystem append per batch and shutdown flushes the final batch", async (t) => {
  const root = await logRoot(t, "event-log-batch");
  let writes = 0;
  const log = createEventLog({
    stateDir: root,
    fileOps: {
      ...fs,
      appendFileSync(...args) {
        writes += 1;
        return fs.appendFileSync(...args);
      },
    },
  });

  log.append("service.start", {});
  log.append("queue.drain", { decision: "skipped" });
  log.append("service.stop", {});
  assert.equal(writes, 0, "append does no inline filesystem work");
  log._flush();
  assert.equal(writes, 1, "one flush writes one batch");
  assert.equal(log.read().length, 3);

  log.append("service.start", { second: true });
  log.shutdown();
  assert.equal(writes, 2, "shutdown makes the final accepted event durable");
  assert.equal(log.append("service.stop", {}), undefined, "closed logs accept no later events");
  assert.equal(JSON.parse((await readFile(log.path, "utf8")).trim().split("\n").at(-1)).second, true);
});

test("event log backs off write failures, counts drops, and emits one recovery summary", async (t) => {
  const root = await logRoot(t, "event-log-degraded");
  const warnings = [];
  let clock = Date.parse("2026-07-30T12:00:00.000Z");
  let attempts = 0;
  const log = createEventLog({
    stateDir: root,
    now: () => clock,
    degradedBackoffMs: 1_000,
    logger: { warn: (message) => warnings.push(message) },
    fileOps: {
      ...fs,
      appendFileSync(...args) {
        attempts += 1;
        if (attempts === 1) throw new Error("disk unavailable");
        return fs.appendFileSync(...args);
      },
    },
  });

  assert.ok(log.append("service.start", {}), "enqueue succeeds before the deferred write fails");
  assert.equal(log._flush(), false);
  assert.equal(log.append("queue.drain", {}), undefined);
  assert.equal(log.append("service.stop", {}), undefined);
  assert.equal(attempts, 1, "events inside backoff do not retry the filesystem");
  assert.equal(warnings.length, 1, "one warning per outage, not per event");
  assert.match(warnings[0], /Atelier event log write failed/);

  clock += 1_000;
  assert.ok(log.append("service.start", { recovered: true }));
  assert.equal(log._flush(), true);
  assert.equal(attempts, 2);
  const events = log.read();
  assert.deepEqual(events.map(({ kind }) => kind), ["log.degraded", "service.start"]);
  assert.equal(events[0].dropped, 3, "failed-batch and backoff drops are summarized once");
  assert.equal(events[1].recovered, true);
});

test("event log tolerates a logger that throws and a listener that throws", async (t) => {
  const root = await logRoot(t, "event-log-hostile");
  const log = createEventLog({
    stateDir: root,
    logger: {
      warn() {
        throw new Error("logger exploded");
      },
    },
  });
  log.onEvent(() => {
    throw new Error("listener exploded");
  });
  const seen = [];
  log.onEvent((event) => seen.push(event.kind));

  assert.doesNotThrow(() => log.append("service.start", {}));
  log._flush();
  assert.deepEqual(seen, ["service.start"], "a throwing listener cannot starve the next one");
});

test("event log creates its directory lazily and reads an absent history as empty", async (t) => {
  const root = await logRoot(t, "event-log-lazy");
  const log = createEventLog({ stateDir: join(root, "never-created-yet") });
  assert.deepEqual(log.read({ limit: 5 }), []);
  assert.deepEqual(log.poll(undefined).events, []);
  assert.ok(log.append("service.start", {}));
  log._flush();
  assert.equal(readFileSync(log.path, "utf8").split("\n").filter(Boolean).length, 1);
});

test("follow cursor delivers every appended event exactly once past its limit", async (t) => {
  const root = await logRoot(t, "event-log-follow");
  const log = createEventLog({ stateDir: root });
  for (let index = 0; index < 5; index += 1) log.append("service.sample", { index });

  // The archived atelier-e5x MAJOR: --follow re-read a TRUNCATED window (it
  // re-applied `limit` on every poll), so events that scrolled past the window
  // between polls were silently lost. The backfill is bounded; the follow is not.
  const started = log.tail({ limit: 2 });
  assert.deepEqual(started.events.map(({ index }) => index), [3, 4]);

  for (let index = 5; index < 25; index += 1) log.append("service.sample", { index });
  const first = log.poll(started.cursor, { limit: 2 });
  assert.deepEqual(
    first.events.map(({ index }) => index),
    Array.from({ length: 20 }, (_, offset) => offset + 5),
    "every event appended between polls is delivered, not just the newest limit",
  );

  const idle = log.poll(first.cursor, { limit: 2 });
  assert.deepEqual(idle.events, [], "a poll with nothing new re-reads nothing");
  log.append("service.sample", { index: 25 });
  assert.deepEqual(log.poll(idle.cursor).events.map(({ index }) => index), [25]);
});

test("follow cursor crosses a rotation without losing the rotated tail", async (t) => {
  const root = await logRoot(t, "event-log-follow-rotate");
  // Sized so the run below rotates twice and stays inside retention: nothing
  // written after the cursor is allowed to go missing.
  const log = createEventLog({ stateDir: root, maxBytes: 400, rotations: 5 });
  const started = log.tail({});
  assert.deepEqual(started.events, []);

  const written = [];
  for (let index = 0; index < 12; index += 1) {
    written.push(index);
    log.append("service.sample", { index, detail: "z".repeat(60) });
    log._flush();
  }
  const files = await readdir(log.directory);
  assert.ok(files.includes("events.2.jsonl"), "the fixture must cross more than one rotation");

  const polled = log.poll(started.cursor, {});
  assert.deepEqual(
    polled.events.map(({ index }) => index),
    written,
    "events written to files that have since rotated are still delivered once",
  );
  log.append("service.sample", { index: 12, detail: "z".repeat(60) });
  assert.deepEqual(log.poll(polled.cursor, {}).events.map(({ index }) => index), [12]);
});

test("follow identity distinguishes rotated files whose first writers reused a sequence", async (t) => {
  const root = await logRoot(t, "event-log-follow-duplicate-seq");
  // Both handles start before either writes, so each independently mints seq=1.
  const writerA = createEventLog({ stateDir: root, maxBytes: 220, rotations: 2 });
  const writerB = createEventLog({ stateDir: root, maxBytes: 220, rotations: 2 });
  writerB.append("service.sample", { writer: "B", detail: "b".repeat(80) });
  writerB._flush();
  const started = writerB.tail({});
  assert.equal(started.events[0].seq, 1);

  // A's same-seq but different first line rotates B's file. Seq-only identity
  // aliases the active file and returns nothing; seq+hash finds B in rotation 1
  // and then consumes A from the active file.
  writerA.append("service.sample", { writer: "A", detail: "a".repeat(80) });
  writerA._flush();
  const polled = writerB.poll(started.cursor, {});
  assert.deepEqual(polled.events.map(({ writer }) => writer), ["A"]);
  assert.equal(polled.events.some(({ gap }) => gap === true), false, "continuity was established");
});

test("follow past the retention bound loses only rotated-out history, never duplicates", async (t) => {
  const root = await logRoot(t, "event-log-follow-evicted");
  const log = createEventLog({ stateDir: root, maxBytes: 300, rotations: 2 });
  const started = log.tail({});
  for (let index = 0; index < 20; index += 1) {
    log.append("service.sample", { index, detail: "z".repeat(60) });
    log._flush();
  }

  const polled = log.poll(started.cursor, {});
  assert.deepEqual(polled.events[0], { gap: true }, "retention loss is explicit");
  const delivered = polled.events.slice(1).map(({ index }) => index);
  assert.equal(new Set(delivered).size, delivered.length, "no duplicates");
  assert.deepEqual(delivered, [...delivered].sort((left, right) => left - right));
  assert.equal(delivered.at(-1), 19, "the newest event is always delivered");
  assert.ok(delivered.length < 20, "history evicted by retention is honestly gone");
  log.append("service.sample", { index: 20, detail: "z".repeat(60) });
  assert.deepEqual(
    log.poll(polled.cursor, {}).events.map(({ index }) => index),
    [20],
    "recovery leaves a usable cursor",
  );
});

test("follow cursor tolerates a torn line and an externally truncated file", async (t) => {
  const root = await logRoot(t, "event-log-follow-torn");
  const log = createEventLog({ stateDir: root });
  const started = log.tail({});
  log.append("service.sample", { index: 0 });
  log._flush();
  appendFileSync(log.path, '{"v":1,"ts":"2026-01-01T00:00:00.000Z","seq":99,"kind":"tor');

  const first = log.poll(started.cursor, {});
  assert.deepEqual(first.events.map(({ index }) => index), [0], "a partial line is not consumed");
  appendFileSync(log.path, 'n","index":1}\n');
  assert.deepEqual(
    log.poll(first.cursor, {}).events.map(({ index }) => index),
    [1],
    "the completed line is delivered on the next poll",
  );
});

test("follow honours filters while still consuming every byte", async (t) => {
  const root = await logRoot(t, "event-log-follow-filter");
  const log = createEventLog({ stateDir: root });
  const started = log.tail({ kind: "queue.drain" });
  log.append("queue.drain", { project: "alpha" });
  log.append("dispatch.transition", { project: "alpha" });
  log.append("queue.drain", { project: "beta" });

  const polled = log.poll(started.cursor, { kind: "queue.drain", project: "beta" });
  assert.deepEqual(polled.events.map(({ project }) => project), ["beta"]);
  log.append("queue.drain", { project: "beta" });
  assert.deepEqual(
    log.poll(polled.cursor, { kind: "queue.drain", project: "beta" }).events.length,
    1,
    "the cursor advanced past the filtered-out events instead of re-reading them",
  );
});

test("fieldDiff reports only changed fields, with an optional allowlist", () => {
  assert.deepEqual(
    fieldDiff(
      { notes: "before", budgetUSDPerDay: 2, same: true },
      { notes: "after", budgetUSDPerDay: 2, same: true },
    ),
    { notes: { from: "before", to: "after" } },
  );
  assert.deepEqual(fieldDiff({}, { name: "alpha" }), { name: { from: null, to: "alpha" } });
  assert.deepEqual(
    fieldDiff({ a: 1, b: 1 }, { a: 2, b: 2 }, ["a"]),
    { a: { from: 1, to: 2 } },
  );
  assert.deepEqual(fieldDiff({ list: [1, 2] }, { list: [1, 2] }), {});
});

test("createEventLog requires a state directory", () => {
  assert.throws(() => createEventLog({}), /stateDir is required/);
});
