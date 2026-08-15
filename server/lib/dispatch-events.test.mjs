// Dispatcher-side coverage for the structured event log (atelier-e5x): the queue
// drain decision trail, dispatch lifecycle events, the circuit-breaker
// queue.settings event the archived attempt silently skipped, and the property
// every one of those hangs off - logging can never change or fail a dispatch.
//
// Kept in its own file rather than dispatch.test.mjs (14k lines, edited by
// concurrent branches), following dispatch-env.test.mjs's precedent.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createEventLog } from "./event-log.mjs";
import {
  _setBrResolver,
  _setCodexModelFileOps,
  _setCompanionResolver,
  _setGcFileOps,
  _setGitDirFileOps,
  _setPersistenceFileOps,
  _setPersistenceLogger,
  _setPostMergeFileOps,
  _setPostMergeHooks,
  _setProbe,
  _setRunFile,
  _setSpawner,
  createDispatcher,
} from "./dispatch.mjs";

const PROBE_CHANGED_FILE = "src/changed.txt\n";

function project(path, overrides = {}) {
  return {
    name: "fixture",
    path,
    mainBranch: "main",
    tracker: "committed",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: [],
    dispatchProfile: {
      model: "haiku",
      maxTurns: 7,
      allowedTools: ["Read", "Edit"],
      lane: "claude",
    },
    ...overrides,
  };
}

async function fixture(t, projectOverrides = {}, defaults = {}) {
  const root = await mkdtemp(join(tmpdir(), "atelier-dispatch-events-"));
  const primary = join(root, "primary");
  const state = join(root, "state");
  await mkdir(primary);
  const configuredProject = project(primary, projectOverrides);
  const registry = {
    defaults: { concurrentDispatchCap: 3, ...defaults },
    projects: [configuredProject],
  };
  // Every dispatcher a test builds, so teardown can STOP it before removing the
  // state directory. Without this the rm races the dispatcher's own late writes
  // (an automatic review, a queue settlement, an event-log append) and fails
  // ENOTEMPTY intermittently - a fixture race, but one that reads as a product
  // flake in CI.
  const dispatchers = [];
  _setCodexModelFileOps({ readFileSync: () => 'model = "gpt-5.6-fixture"\n' });
  t.after(async () => {
    for (const dispatcher of dispatchers) {
      await dispatcher.shutdown({ graceMs: 0 }).catch(() => {});
    }
    _setBrResolver();
    _setSpawner();
    _setRunFile();
    _setProbe();
    _setCompanionResolver();
    _setCodexModelFileOps();
    _setGcFileOps();
    _setGitDirFileOps();
    _setPersistenceFileOps();
    _setPersistenceLogger();
    _setPostMergeFileOps();
    _setPostMergeHooks();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  await mkdir(state, { recursive: true });
  await writeFile(
    join(state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: true } })}\n`,
  );
  const dispatcherFor = (options = {}) => {
    const dispatcher = createDispatcher({
      registry,
      stateDir: state,
      sweepCodexProcessesAtBoot: false,
      ...options,
    });
    dispatchers.push(dispatcher);
    return dispatcher;
  };
  return {
    root,
    primary,
    state,
    project: configuredProject,
    registry,
    dispatcherFor,
  };
}

function isOutcomeDiffProbe(args) {
  return args[2] === "diff" && args[3] === "--no-ext-diff" && args[4] === "--name-only";
}

function claudeChild({ ok = true, summary = "done" } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(() => {
    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        num_turns: 2,
        total_cost_usd: 0.25,
        result: summary,
        is_error: !ok,
      })}\n`,
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", ok ? 0 : 1, null);
  });
  return child;
}

// br + git stub covering everything a queue drain touches.
function stubQueueCommands({ ready = [], onCall = () => {} } = {}) {
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    onCall(file, args, options);
    if (file === "/fixture/br") {
      if (args[0] === "ready") return JSON.stringify(ready);
      if (["update", "comments", "comment", "sync", "show", "close"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log", "rev-parse", "add", "commit"].includes(args[2])) {
      return "";
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
}

async function waitForCondition(predicate, message) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(message);
}

function kinds(log, kind) {
  return log.read({ kind, limit: 1_000 });
}

test("a queue drain pass records why it skipped and what it picked", async (t) => {
  const setup = await fixture(t, { budgetUSDPerDay: 1, queueFailureLimit: 1 });
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({
    ready: [
      { id: "fixture-parked", priority: 0, created_at: "2026-01-01T00:00:00Z" },
      { id: "fixture-good", priority: 1, created_at: "2026-01-02T00:00:00Z" },
    ],
  });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  // Pass 1: a park generation exists for the top candidate, and the second is
  // pickable - the operator must see WHICH ticket was picked over WHICH parked one.
  const first = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-parked" });
  await waitForCondition(
    () => dispatcher.get(first.id)?.state === "failed" ||
      dispatcher.get(first.id)?.state === "completed",
    "seed dispatch never settled",
  );

  await dispatcher.drainQueuesOnce();
  const picked = kinds(eventLog, "queue.drain").filter(({ decision }) => decision === "picked");
  assert.equal(picked.length, 1, "a drain that dispatches logs exactly one picked decision");
  assert.equal(picked[0].project, "fixture");
  assert.equal(picked[0].ticketId, "fixture-parked");
  assert.deepEqual(picked[0].candidates, ["fixture-parked", "fixture-good"]);
  assert.ok(picked[0].dispatchId, "the picked decision names the dispatch it started");

  // Pass 2: that dispatch is still active - the skip reason must name it.
  await dispatcher.drainQueuesOnce();
  const active = kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "active");
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].activeDispatchIds, [picked[0].dispatchId]);
  assert.equal(active[0].decision, "skipped");
});

test("a budget-blocked drain records spend against cap, and un-blocks visibly", async (t) => {
  const setup = await fixture(t, { budgetUSDPerDay: 0.1 });
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [{ id: "fixture-1", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  // One completed dispatch at 0.25 USD blows a 0.10 USD daily budget.
  const seed = await dispatcher.dispatch({ project: "fixture", prompt: "seed", force: true });
  await waitForCondition(
    () => ["completed", "failed"].includes(dispatcher.get(seed.id)?.state),
    "seed dispatch never settled",
  );

  await dispatcher.drainQueuesOnce();
  const blocked = kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "budget");
  assert.equal(blocked.length, 1, "the budget block is on the record");
  assert.equal(blocked[0].decision, "skipped");
  assert.equal(blocked[0].budgetUSD, 0.1);
  assert.ok(blocked[0].spentUSD >= 0.25, `spend readout was ${blocked[0].spentUSD}`);
  assert.equal(Number.isInteger(blocked[0].passId), true);
  assert.equal(dispatcher.getQueue("fixture").budget.exceeded, true);

  // The headline is still "budget", but a different cap is a different cause
  // and must be emitted. The old identity silently deduped this forensic change.
  setup.project.budgetUSDPerDay = 0.2;
  await dispatcher.drainQueuesOnce();
  const changedCause = kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "budget");
  assert.equal(changedCause.length, 2);
  assert.equal(changedCause[1].budgetUSD, 0.2);

  // A genuinely identical budget block is a repeat, not news: it is counted,
  // and reported on the next decision that differs.
  await dispatcher.drainQueuesOnce();
  await dispatcher.drainQueuesOnce();
  assert.equal(
    kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "budget").length,
    2,
    "consecutive identical skips are deduplicated instead of flooding the log",
  );
  setup.project.budgetUSDPerDay = 1_000;
  await dispatcher.drainQueuesOnce();
  const next = kinds(eventLog, "queue.drain").at(-1);
  assert.equal(next.decision, "picked");
  assert.deepEqual(next.previous, {
    decision: "skipped",
    reason: "budget",
    spentUSD: changedCause[1].spentUSD,
    budgetUSD: 0.2,
    repeats: 3,
    since: next.previous.since,
  });
  assert.match(next.previous.since, /^\d{4}-\d{2}-\d{2}T/);
});

test("a drain over only parked tickets records the park reasons, not a bare no-ready", async (t) => {
  const setup = await fixture(t, { queueFailureLimit: 1 });
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [{ id: "fixture-bad", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  _setSpawner(() => claudeChild({ ok: false }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  await dispatcher.drainQueuesOnce();
  await waitForCondition(
    () => dispatcher.getQueue("fixture").parkedTickets.length === 1,
    "the failing ticket never parked",
  );
  await dispatcher.drainQueuesOnce();

  const park = kinds(eventLog, "queue.park");
  assert.equal(park.length, 1, "parking is logged once per park generation");
  assert.equal(park[0].ticketId, "fixture-bad");
  assert.equal(park[0].actor, "dispatcher");
  assert.equal(park[0].attempts, 1);
  assert.equal(park[0].lastFailureKind, "agent_error");
  assert.match(park[0].parkReason, /agent_error/);

  const parkedSkip = kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "parked");
  assert.equal(parkedSkip.length, 1);
  assert.deepEqual(parkedSkip[0].parkedTicketIds, ["fixture-bad"]);
  assert.deepEqual(parkedSkip[0].candidates, ["fixture-bad"]);
  assert.equal(
    kinds(eventLog, "queue.drain").filter(({ reason }) => reason === "no-ready").length,
    0,
    "a parked backlog must not read as an empty backlog",
  );

  dispatcher.resumeQueueTicket("fixture", "fixture-bad", { actor: "ui" });
  const unpark = kinds(eventLog, "queue.unpark");
  assert.equal(unpark.length, 1);
  assert.equal(unpark[0].ticketId, "fixture-bad");
  assert.equal(unpark[0].actor, "ui");
  assert.equal(unpark[0].attempts, 1);
});

test("an empty ready queue records no-ready with the empty candidate set", async (t) => {
  const setup = await fixture(t);
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [] });
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  await dispatcher.drainQueuesOnce();
  const drain = kinds(eventLog, "queue.drain");
  assert.equal(drain.length, 1);
  assert.equal(drain[0].reason, "no-ready");
  assert.deepEqual(drain[0].candidates, []);
});

test("queue drain passId groups projects per sweep and advances between sweeps", async (t) => {
  const setup = await fixture(t);
  const secondPath = join(setup.root, "second-primary");
  await mkdir(secondPath);
  setup.registry.projects.push(project(secondPath, { name: "second" }));
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: true }, second: { enabled: true } })}\n`,
  );
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [] });
  const dispatcher = setup.dispatcherFor({ eventLog });

  await dispatcher.drainQueuesOnce();
  const firstPass = kinds(eventLog, "queue.drain");
  assert.equal(firstPass.length, 2);
  assert.equal(new Set(firstPass.map(({ passId }) => passId)).size, 1);
  assert.deepEqual(firstPass.map(({ project }) => project), ["fixture", "second"]);

  dispatcher.setTrackerMoving("fixture", true);
  dispatcher.setTrackerMoving("second", true);
  await dispatcher.drainQueuesOnce();
  const secondPass = kinds(eventLog, "queue.drain").filter(
    ({ reason }) => reason === "tracker-moving",
  );
  assert.equal(secondPass.length, 2);
  assert.equal(new Set(secondPass.map(({ passId }) => passId)).size, 1);
  assert.ok(secondPass[0].passId > firstPass[0].passId);
});

test("a disabled queue writes no drain events at all", async (t) => {
  const setup = await fixture(t);
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: false } })}\n`,
  );
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [{ id: "fixture-1", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  for (let pass = 0; pass < 5; pass += 1) await dispatcher.drainQueuesOnce();
  assert.deepEqual(
    eventLog.read({ limit: 100 }),
    [],
    "an off queue must not narrate its own silence every interval",
  );
});

test("the circuit-breaker auto-disable is recorded as a queue.settings change", async (t) => {
  const setup = await fixture(t);
  const eventLog = createEventLog({ stateDir: setup.state });
  // br ready throws: every drain pass fails, tripping the 3-failure breaker.
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "ready") throw new Error("br exploded");
    return "";
  });
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  assert.equal(dispatcher.getQueue("fixture").enabled, true);
  for (let pass = 0; pass < 3; pass += 1) await dispatcher.drainQueuesOnce();
  assert.equal(dispatcher.getQueue("fixture").enabled, false, "the breaker must have tripped");

  // THE ARCHIVED MAJOR. The breaker turns a queue off without going through
  // setQueue, so a log that only taps setQueue records every human toggle and
  // misses the single disable an operator actually has to explain.
  const settings = kinds(eventLog, "queue.settings");
  assert.equal(settings.length, 1, "the auto-disable must be on the record exactly once");
  assert.equal(settings[0].actor, "circuit-breaker");
  assert.equal(settings[0].project, "fixture");
  assert.deepEqual(settings[0].changes, { enabled: { from: true, to: false } });
  assert.equal(settings[0].reason, "consecutive-failures");
  assert.equal(settings[0].consecutiveFailures, 3);
  assert.match(settings[0].lastError, /br exploded/);

  // Further failed passes do not re-disable an already-disabled queue.
  await dispatcher.drainQueuesOnce();
  assert.equal(kinds(eventLog, "queue.settings").length, 1);
});

test("circuit-breaker behaviour is identical with the event log on and off", async (t) => {
  const outcomes = [];
  for (const withLog of [false, true]) {
    const setup = await fixture(t);
    _setBrResolver(() => "/fixture/br");
    _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
    _setRunFile(async (file, args) => {
      if (file === "/fixture/br" && args[0] === "ready") throw new Error("br exploded");
      return "";
    });
    const dispatcher = setup.dispatcherFor(
      withLog ? { eventLog: createEventLog({ stateDir: setup.state }) } : {},
    );
    const trail = [];
    for (let pass = 0; pass < 4; pass += 1) {
      await dispatcher.drainQueuesOnce();
      const queue = dispatcher.getQueue("fixture");
      trail.push({
        enabled: queue.enabled,
        consecutiveFailures: queue.consecutiveFailures,
        lastError: queue.lastError,
      });
    }
    outcomes.push(trail);
  }
  assert.deepEqual(
    outcomes[0],
    outcomes[1],
    "logging the circuit breaker must not change when or how it trips",
  );
  assert.deepEqual(outcomes[0].map(({ enabled }) => enabled), [true, true, false, false]);
});

test("an event log that throws on every append cannot fail a dispatch or a drain", async (t) => {
  const setup = await fixture(t);
  const attempted = [];
  const hostileLog = {
    append(kind) {
      attempted.push(kind);
      throw new Error("event log exploded");
    },
  };
  const warnings = [];
  _setPersistenceLogger({ error: (line) => warnings.push(line), warn: (line) => warnings.push(line) });
  stubQueueCommands({ ready: [{ id: "fixture-1", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({
    eventLog: hostileLog,
  });

  await dispatcher.drainQueuesOnce();
  const record = dispatcher.list().find(({ ticketId }) => ticketId === "fixture-1");
  assert.ok(record, "the drain still dispatched");
  await waitForCondition(
    () => ["completed", "failed"].includes(dispatcher.get(record.id)?.state),
    "the dispatch never reached a terminal state with a hostile event log",
  );
  assert.equal(dispatcher.get(record.id).state, "completed");
  assert.ok(attempted.length > 3, `the tap was exercised (${attempted.length} attempts)`);
  assert.equal(
    warnings.filter((line) => line.includes("event log")).length,
    1,
    "one warning per outage, not one per event",
  );
  await assert.doesNotReject(dispatcher.shutdown({ graceMs: 0 }));
});

test("an observer dispatcher writes no events", async (t) => {
  const setup = await fixture(t);
  const eventLog = createEventLog({ stateDir: setup.state });
  stubQueueCommands({ ready: [{ id: "fixture-1", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  const observer = setup.dispatcherFor({
    eventLog,
    observer: true,
    sweepCodexProcessesAtBoot: false,
  });

  await observer.drainQueuesOnce();
  observer.setQueue("fixture", { enabled: false }, { actor: "test" });
  await observer.shutdown({ graceMs: 0 });
  assert.deepEqual(
    eventLog.read({ limit: 100 }),
    [],
    "an observer observes; it does not narrate",
  );
});

test("dispatch lifecycle transitions are logged with failure kind and outcome", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => claudeChild({ ok: false, summary: "agent failed" }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  const started = await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  await waitForCondition(
    () => dispatcher.get(started.id)?.state === "failed",
    "the dispatch never failed",
  );

  const transitions = kinds(eventLog, "dispatch.transition");
  assert.deepEqual(
    transitions.map(({ from, to }) => `${from}->${to}`),
    ["null->queued", "queued->preparing", "preparing->running", "running->failed"],
    "the trail starts at record creation, not mid-life",
  );
  for (const event of transitions) {
    assert.equal(event.dispatchId, started.id);
    assert.equal(event.project, "fixture");
    assert.equal(event.lane, "claude");
  }
  assert.deepEqual(
    transitions.map(({ failureKind }) => failureKind),
    [null, null, null, "agent_error"],
    "failureKind is set on the failure and only on the failure",
  );
  assert.match(transitions.at(-1).detail, /^agent failed/);
  assert.equal(transitions.at(-1).turns, 2);
  assert.equal(transitions.at(-1).costUSD, 0.25);
});

test("secrets in a dispatch summary never reach the log file", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => claudeChild({
    ok: false,
    summary: "failed using sk-abcdefghijklmnopqrstuvwxyz012345",
  }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  const started = await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  await waitForCondition(
    () => dispatcher.get(started.id)?.state === "failed",
    "the dispatch never failed",
  );
  const failure = kinds(eventLog, "dispatch.transition").at(-1);
  assert.match(failure.detail, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(eventLog.read({ limit: 100 })), /sk-abcdef/);
});

test("budget evaluations are logged at enforcement, not on readouts", async (t) => {
  const setup = await fixture(t, { budgetUSDPerDay: 5, tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });

  for (let readout = 0; readout < 5; readout += 1) dispatcher.getQueue("fixture");
  assert.deepEqual(kinds(eventLog, "budget.evaluation"), [], "readouts are not decisions");

  await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  const evaluations = kinds(eventLog, "budget.evaluation");
  assert.equal(evaluations.length, 1);
  assert.deepEqual(
    {
      metric: evaluations[0].metric,
      budgetUSD: evaluations[0].budgetUSD,
      verdict: evaluations[0].verdict,
    },
    { metric: "cost", budgetUSD: 5, verdict: "allowed" },
  );
});

test("service shutdown is on the record with the dispatches it interrupted", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  const dispatcher = setup.dispatcherFor({
    eventLog,
  });
  await dispatcher.shutdown({ graceMs: 0 });

  const shutdown = kinds(eventLog, "service.shutdown");
  assert.equal(shutdown.length, 1);
  assert.deepEqual(shutdown[0].activeDispatchIds, []);
  assert.equal(shutdown[0].graceMs, 0);
});

test("a failed log write loses that event only, and the file stays readable", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  let failNext = false;
  const flakyLog = {
    append(kind, payload) {
      if (failNext) {
        failNext = false;
        throw new Error("crashed between the transition and the log write");
      }
      return eventLog.append(kind, payload);
    },
  };
  _setPersistenceLogger({ error: () => {}, warn: () => {} });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({
    eventLog: flakyLog,
  });

  const started = await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  failNext = true;
  await waitForCondition(
    () => ["completed", "failed"].includes(dispatcher.get(started.id)?.state),
    "the dispatch never settled",
  );
  const transitions = kinds(eventLog, "dispatch.transition");
  assert.ok(transitions.length >= 2, "earlier events survived the failed write");
  assert.deepEqual(
    transitions.map(({ seq }) => seq),
    [...transitions.map(({ seq }) => seq)].sort((left, right) => left - right),
    "the file is still ordered and parseable after a lost event",
  );
  assert.equal(dispatcher.get(started.id).state, "completed");
});

test("a log that throws for ONE kind still records the others and settles the dispatch", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  _setPersistenceLogger({ error: () => {}, warn: () => {} });
  // Not the same as the all-appends-throw case above: this proves the tap is
  // per-event, so one poisoned kind cannot take the trail down with it. (The
  // guard also wraps payload CONSTRUCTION in transition()/logDrainDecision,
  // which no external injection can trigger - plain record fields only - so it
  // stays defence in depth rather than something a test can reach.)
  const partiallyHostileLog = {
    append(kind, payload) {
      if (kind === "dispatch.transition") throw new Error("transition logging exploded");
      return eventLog.append(kind, payload);
    },
  };
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => claudeChild({ ok: true }));
  const dispatcher = setup.dispatcherFor({ eventLog: partiallyHostileLog });

  const started = await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  await waitForCondition(
    () => ["completed", "failed"].includes(dispatcher.get(started.id)?.state),
    "the dispatch never settled",
  );
  assert.equal(dispatcher.get(started.id).state, "completed");
  assert.deepEqual(kinds(eventLog, "dispatch.transition"), []);
  await dispatcher.shutdown({ graceMs: 0 });
  assert.equal(kinds(eventLog, "service.shutdown").length, 1, "other kinds keep recording");
});

test("a human queue toggle is recorded with its actor, an unchanged toggle is not", async (t) => {
  const setup = await fixture(t);
  const eventLog = createEventLog({ stateDir: setup.state });
  // setQueue(enabled) refuses without a real br executable, so point the
  // resolver at a file that exists.
  _setBrResolver(() => process.execPath);
  const dispatcher = setup.dispatcherFor({ eventLog });

  dispatcher.setQueue("fixture", { enabled: false }, { actor: "ui" });
  dispatcher.setQueue("fixture", { enabled: false }, { actor: "ui" });
  dispatcher.setQueue("fixture", { enabled: true }, { actor: "mcp" });

  assert.deepEqual(
    kinds(eventLog, "queue.settings").map(({ actor, changes }) => ({ actor, changes })),
    [
      { actor: "ui", changes: { enabled: { from: true, to: false } } },
      { actor: "mcp", changes: { enabled: { from: false, to: true } } },
    ],
    "only real changes are events; re-asserting the current value is not news",
  );
});

test("dismissal is recorded with the state and failure kind it dismissed", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  // A persisted terminal record with no worktree: dismissal then removes the
  // RECORD, which is the path this event hangs off.
  await mkdir(join(setup.state, "dispatches"), { recursive: true });
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "dispatch-dismissable",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "failed",
      branch: null,
      worktreePath: null,
      startedAt: "2026-07-30T00:00:00.000Z",
      endedAt: "2026-07-30T00:01:00.000Z",
      turns: 3,
      costUSD: 0.25,
      exitSummary: "agent failed",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async () => "");
  const dispatcher = setup.dispatcherFor({ eventLog });

  await dispatcher.dismiss("dispatch-dismissable");

  const dismissed = kinds(eventLog, "dispatch.dismiss");
  assert.equal(dismissed.length, 1);
  assert.equal(dismissed[0].dispatchId, "dispatch-dismissable");
  assert.equal(dismissed[0].state, "failed");
  assert.equal(dismissed[0].failureKind, "agent_error");
  assert.equal(dismissed[0].merged, false);
});

test("a linked review verdict is recorded against the reviewed dispatch", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const eventLog = createEventLog({ stateDir: setup.state });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") return "abc1234\n";
    // The review gate refuses an empty target diff, so the committed-diff read
    // (main...head, distinct from the outcome probe above) must return content.
    if (file === "git" && args[2] === "diff" && String(args[4] ?? "").includes("...")) {
      return "diff --git a/src/changed.txt b/src/changed.txt\n+work\n";
    }
    return "";
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return claudeChild({
      ok: true,
      summary: launches === 1
        ? "did the work"
        : "VERDICT: FAIL\nSUMMARY: the fix papers over the root cause",
    });
  });
  const dispatcher = setup.dispatcherFor({ eventLog });

  const worked = await dispatcher.dispatch({ project: "fixture", prompt: "do a thing" });
  await waitForCondition(
    () => dispatcher.get(worked.id)?.state === "completed",
    "the reviewed dispatch never completed",
  );
  const review = await dispatcher.review(worked.id);
  await waitForCondition(
    () => dispatcher.get(worked.id)?.review?.verdict === "fail",
    "the review verdict never settled",
  );

  const logged = kinds(eventLog, "dispatch.review");
  assert.equal(logged.length, 1);
  assert.equal(logged[0].dispatchId, worked.id, "the event hangs off the REVIEWED dispatch");
  assert.equal(logged[0].reviewDispatchId, review.id);
  assert.equal(logged[0].verdict, "fail");
  assert.match(logged[0].summary, /papers over the root cause/);
});

test("the queue readout agrees with the drain decision it exists to explain", async (t) => {
  const setup = await fixture(t, {
    unpricedDispatchCapPerDay: 1,
    dispatchProfile: { lane: "codex", maxTurns: 7 },
  });
  const eventLog = createEventLog({ stateDir: setup.state });
  // One unpriced codex REVIEW dispatch today. The budget check excludes review
  // cost; the unpriced cap does not - so a readout that excluded reviews would
  // report "0 of 1, fine" while the drain refuses with "1 of 1".
  await mkdir(join(setup.state, "dispatches"), { recursive: true });
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify({
      id: "codex-review",
      project: "fixture",
      ticketId: null,
      reviewOf: "codex-target",
      model: "gpt-5.6-fixture",
      effort: null,
      lane: "codex",
      state: "completed",
      branch: null,
      worktreePath: null,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      turns: 1,
      costUSD: 0,
      exitSummary: "reviewed",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  stubQueueCommands({ ready: [{ id: "fixture-1", priority: 0, created_at: "2026-01-01T00:00:00Z" }] });
  const dispatcher = setup.dispatcherFor({ eventLog });

  await dispatcher.drainQueuesOnce();
  const skip = kinds(eventLog, "queue.drain").at(-1);
  assert.equal(skip.reason, "unpriced-cap");
  const queue = dispatcher.getQueue("fixture");
  assert.deepEqual(queue.unpricedDispatches, {
    dispatchesToday: 1,
    dispatchCap: 1,
    exceeded: true,
  });
  assert.equal(queue.lastError, "daily unpriced dispatch cap reached (1 of 1)");
  assert.equal(skip.dispatchesToday, queue.unpricedDispatches.dispatchesToday);
});
