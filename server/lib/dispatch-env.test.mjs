// Non-vacuous env-hygiene coverage for the ensureEntryEnv() consumers on
// dispatch.mjs's boot-revived resume paths (atelier-rio, following the
// atelier-fo5 audit: dispatch.test.mjs:1707 asserted ANTHROPIC_API_KEY was
// undefined without ever seeding it - a check that stays green even if
// hygiene were dropped entirely). Every test here seeds real secret-shaped
// vars into the live process.env, restores them in t.after, and asserts the
// spawned child's env actually lacks them.
//
// Kept in its own file (not dispatch.test.mjs) because atelier-tzw is an
// in-flight branch that also edits dispatch.test.mjs.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

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
  _setPushFetch,
  _setRunFile,
  _setSpawner,
  createDispatcher,
} from "./dispatch.mjs";

function project(path, overrides = {}) {
  return {
    name: "fixture",
    path,
    mainBranch: "main",
    tracker: "none",
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
  const root = await mkdtemp(join(tmpdir(), "atelier-dispatch-env-"));
  const primary = join(root, "primary");
  const state = join(root, "state");
  await mkdir(primary);
  const configuredProject = project(primary, projectOverrides);
  const registry = {
    defaults: { concurrentDispatchCap: 3, ...defaults },
    projects: [configuredProject],
  };
  t.after(async () => {
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
    _setPushFetch();
    await rm(root, { recursive: true, force: true });
  });
  return { root, primary, state, project: configuredProject, registry };
}

// Seeds a persisted dispatch record directly (bypassing a live dispatch()
// call) so the dispatcher created against it is a genuine boot-revived
// history entry: entries.get(id).env is undefined until ensureEntryEnv()
// rebuilds it - the exact condition the fo5 audit found untested.
async function seedDispatch(setup, overrides = {}) {
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const record = {
    id: "dispatch-env-boot",
    project: "fixture",
    ticketId: "fixture-1",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: "atelier/fixture-1-dispatch-env-boot",
    worktreePath: join(setup.state, "worktrees", "fixture", "dispatch-env-boot"),
    startedAt: "2026-07-21T08:00:00.000Z",
    endedAt: "2026-07-21T08:01:00.000Z",
    turns: 2,
    costUSD: 0.5,
    exitSummary: "done",
    strandedBrWrites: false,
    verify: { state: "passed", steps: [] },
    merged: null,
    dismissed: null,
    warnings: [],
    ...overrides,
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

function claudeResultChild({ sessionId = "fixture-session", summary = "done" } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(() => {
    child.stdout.write(
      `${JSON.stringify({
        type: "system",
        subtype: "init",
        model: "fixture-model",
        session_id: sessionId,
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        num_turns: 1,
        total_cost_usd: 0.1,
        result: summary,
        is_error: false,
      })}\n`,
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

async function waitForState(dispatcher, id, states) {
  const wanted = new Set(states);
  const existing = dispatcher.get(id);
  if (wanted.has(existing?.state)) return existing;
  return new Promise((resolvePromise) => {
    const remove = dispatcher.onEvent((event) => {
      if (event.dispatchId !== id || event.type !== "status") return;
      const record = dispatcher.get(id);
      if (!wanted.has(record?.state)) return;
      remove();
      resolvePromise(record);
    });
  });
}

async function waitForCondition(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(message);
}

// Seeds three secret-shaped vars plus one ordinary var into the live
// process.env and restores the previous values (present or absent) in
// t.after - the ticket-mandated shape (OPENAI_API_KEY, MY_SERVICE_TOKEN,
// SOME_PASSWORD).
function seedProcessEnvSecrets(t) {
  const keys = ["OPENAI_API_KEY", "MY_SERVICE_TOKEN", "SOME_PASSWORD", "ATELIER_ENV_TEST_ORDINARY"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.OPENAI_API_KEY = "sk-live-openai-secret";
  process.env.MY_SERVICE_TOKEN = "service-secret-value";
  process.env.SOME_PASSWORD = "hunter2";
  process.env.ATELIER_ENV_TEST_ORDINARY = "keep-me";
}

function assertHygienicEnv(env, { primary }) {
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.MY_SERVICE_TOKEN, undefined);
  assert.equal(env.SOME_PASSWORD, undefined);
  assert.equal(env.ATELIER_ENV_TEST_ORDINARY, "keep-me");
  assert.equal(env.ATELIER_PRIMARY_CHECKOUT, primary);
  assert.ok(env.ATELIER_TRACKER_PATH);
}

test("boot-revived reply resume strips secret-shaped process.env vars via ensureEntryEnv", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, { sessionId: "fixture-session", state: "completed" });
  await mkdir(seeded.worktreePath, { recursive: true });
  seedProcessEnvSecrets(t);

  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return claudeResultChild({ summary: "resumed after boot revival" });
  });

  // A dispatcher constructed straight from persisted history, with no prior
  // live dispatch() call in this process, is exactly the "boot-revived"
  // shape: entries.get(id).env starts undefined.
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const resuming = await dispatcher.reply(seeded.id, { text: "continue after restart" });
  assert.equal(resuming.state, "running");
  await waitForState(dispatcher, seeded.id, ["completed"]);

  assert.equal(launches.length, 1);
  assertHygienicEnv(launches[0].options.env, { primary: setup.primary });
});

test("boot-revived plan approve resume strips secret-shaped process.env vars via ensureEntryEnv", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    state: "plan_ready",
    sessionId: "boot-session",
    plan: { state: "ready", text: "1. Inspect.\n2. Implement." },
    verify: null,
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  seedProcessEnvSecrets(t);

  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return claudeResultChild({ summary: "approved plan complete" });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const approving = await dispatcher.plan(seeded.id, { action: "approve" });
  assert.equal(approving.state, "running");
  await waitForState(dispatcher, seeded.id, ["completed"]);

  assert.equal(launches.length, 1);
  assertHygienicEnv(launches[0].options.env, { primary: setup.primary });
});

test("boot-revived plan revise resume strips secret-shaped process.env vars via ensureEntryEnv", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    state: "plan_ready",
    sessionId: "boot-session",
    plan: { state: "ready", text: "1. Inspect.\n2. Implement." },
    verify: null,
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  seedProcessEnvSecrets(t);

  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return claudeResultChild({ summary: "revised plan text" });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const revising = await dispatcher.plan(seeded.id, { action: "revise", text: "add coverage" });
  assert.equal(revising.state, "running");
  await waitForState(dispatcher, seeded.id, ["plan_ready"]);

  assert.equal(launches.length, 1);
  assertHygienicEnv(launches[0].options.env, { primary: setup.primary });
});

test("post-merge verification spawns its verify commands with a hygienic env", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node verify-env"] });
  const seeded = await seedDispatch(setup);
  const commit = "abcdef1234567890abcdef1234567890abcdef12";
  _setRunFile(async (file, args) => {
    assert.equal(file, "git");
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${commit}\n`;
    return "";
  });
  seedProcessEnvSecrets(t);

  const launches = [];
  _setSpawner((file, args, options) => {
    launches.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const merged = await dispatcher.merge(seeded.id);
  assert.equal(merged.merged.commit, commit);
  await waitForCondition(
    () => dispatcher.get(seeded.id).postMerge.state === "passed",
    "post-merge verification did not pass",
  );

  assert.equal(launches.length, 1);
  assert.equal(launches[0].file, "node");
  assertHygienicEnv(launches[0].options.env, { primary: setup.primary });
});
