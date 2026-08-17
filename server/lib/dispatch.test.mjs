import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { LONG_GIT_TIMEOUT_MS } from "./exec.mjs";
import { createEventLog } from "./event-log.mjs";
import { acquireInstanceLock } from "./instance-lock.mjs";
import { stateDir } from "./paths.mjs";
import { normalizeProject } from "./registry.mjs";
import { chronicleFor, gatesFor } from "./world-contract.mjs";
import {
  _claimsMainMerged,
  _claimsTestsPassed,
  _classifiedReviewFindings,
  _normalizedFindingIdentity,
  _parseReadyTicketIds,
  _parsedReviewResult,
  _reviewMaxFixRounds,
  _reviewMergeAssessment,
  _reviewParkingDecision,
  _setBrResolver,
  _setPushFetch,
  _setCodexPollIntervalMs,
  _setCodexProcessOps,
  _setCompanionResolver,
  _setCodexModelFileOps,
  _setGcFileOps,
  _setGitDirFileOps,
  _setFencedProcessSignal,
  _setPersistenceFileOps,
  _setPersistenceLogger,
  _setProcessProbe,
  _setPostMergeFileOps,
  _setPostMergeHooks,
  _setProbe,
  _setResultFinalizer,
  _setRunFile as setRunFile,
  _setSpawner,
  _resolveDispatchLane,
  createDispatcher,
  invalidateResult,
} from "./dispatch.mjs";

const FORCE_AUDIT = Object.freeze({
  forcedBy: "fixture-architect",
  reason: "Fixture explicitly exercises the audited override path.",
  dispositionRef: "fixture-disposition-ref",
});
const seededSyntheticBranches = new Set();

// Most dispatch fixtures use a synthetic branch rather than a real repository.
// Once merge became bound to the finalized result, that fake branch must resolve
// to the same default SHA the seeded result names unless a test supplies a more
// specific answer (stale-head, concurrency, and real-git tests all do).
function _setRunFile(nextRunner) {
  if (!nextRunner) {
    setRunFile();
    return;
  }
  setRunFile(async (file, args, options) => {
    const output = await nextRunner(file, args, options);
    if (
      file === "git" &&
      args[2] === "rev-parse" &&
      args[3] === "--verify" &&
      typeof output === "string" &&
      !output.trim() &&
      seededSyntheticBranches.has(String(args[4] || ""))
    ) {
      return "validated-head\n";
    }
    return output;
  });
}

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
  const root = await mkdtemp(join(tmpdir(), "atelier-dispatch-"));
  const primary = join(root, "primary");
  const state = join(root, "state");
  await mkdir(primary);
  const configuredProject = project(primary, projectOverrides);
  const registry = {
    defaults: { concurrentDispatchCap: 3, ...defaults },
    projects: [configuredProject],
  };
  _setCodexModelFileOps({ readFileSync: () => 'model = "gpt-5.6-fixture"\n' });
  _setResultFinalizer(async ({ baseCommit }) => ({
    resultCommit: FIXTURE_BASE_COMMIT,
    resultTree: FIXTURE_RESULT_TREE,
    baseCommit: /^[0-9a-f]{7,64}$/i.test(String(baseCommit ?? ""))
      ? baseCommit
      : FIXTURE_BASE_COMMIT,
    manifest: [],
    workspaceClean: true,
    commitCreated: false,
  }));
  t.after(async () => {
    _setBrResolver();
    _setSpawner();
    _setRunFile();
    _setResultFinalizer();
    _setProbe();
    _setCompanionResolver();
    _setCodexPollIntervalMs();
    _setCodexProcessOps();
    _setCodexModelFileOps();
    _setGcFileOps();
    _setGitDirFileOps();
    _setPersistenceFileOps();
    _setPersistenceLogger();
    _setPostMergeFileOps();
    _setPostMergeHooks();
    _setProcessProbe();
    _setFencedProcessSignal();
    await rm(root, { recursive: true, force: true });
  });
  return { root, primary, state, project: configuredProject, registry };
}

function claudeResultChild({
  onLaunch = () => {},
  sessionId = "fixture-session",
  turns = 2,
  costUSD = 0.5,
  summary = "done",
} = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(async () => {
    await onLaunch();
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
        num_turns: turns,
        total_cost_usd: costUSD,
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

function successfulChild(onLaunch = () => {}) {
  return claudeResultChild({ onLaunch });
}

function failedChild({ turns } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(() => {
    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        result: "agent failed",
        is_error: true,
        ...(turns === undefined ? {} : { num_turns: turns }),
      })}\n`,
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 1, null);
  });
  return child;
}

function secretOutputChild(secretText) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(() => {
    child.stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: `assistant ${secretText}` },
            { type: "tool_use", name: "Read", input: { note: secretText, apiKey: "field-secret" } },
          ],
        },
      })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", content: `tool ${secretText}` }] },
      })}\n`,
    );
    child.stdout.write(`raw ${secretText}\n`);
    child.stdout.write(
      `${JSON.stringify({
        type: "result",
        result: `summary ${secretText}`,
        is_error: false,
      })}\n`,
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function heldChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.complete = (summary = "done") => {
    child.stdout.write(
      `${JSON.stringify({ type: "result", result: summary, is_error: false })}\n`,
    );
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  };
  return child;
}

function codexLaunchChild(jobId = "codex-job", onLaunch = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(async () => {
    await onLaunch();
    child.stdout.write(`${JSON.stringify({ jobId })}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

function verifyChild({ stdout = [], stderr = [], code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  setImmediate(() => {
    for (const line of stdout) child.stdout.write(`${line}\n`);
    for (const line of stderr) child.stderr.write(`${line}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, null);
  });
  return child;
}

function processStartIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  const startTime = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  return `linux-proc-start:${bootId}:${startTime}`;
}

function probeFixtureProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return {
      exists: true,
      zombie: fields[0] === "Z",
      identity: `linux-proc-start:${bootId}:${fields[19]}`,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, zombie: false, identity: undefined };
    throw error;
  }
}

// A real, currently-alive process to stand in for an orphaned worker -
// process.kill(pid, 0)-style liveness checks and /proc identity fencing need
// an actual OS process, not a mock.
function spawnAliveProcess(t, { trapSigterm = false } = {}) {
  const script = trapSigterm
    ? "process.on('SIGTERM',()=>console.log('SIGTERM'));console.log('ready');setInterval(()=>{},1000)"
    : "console.log('ready');setInterval(()=>{},1000)";
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: process.platform === "win32",
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const exitPromise = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
      await exitPromise.catch(() => {});
    }
  });
  return {
    child,
    exitPromise,
    ready: once(child.stdout, "data"),
    output: () => output,
  };
}

// Waiting on a real process exit must never be able to hang the suite: if the
// reap under test regresses, the exit simply never comes.
function withDeadline(promise, message, timeoutMs = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolvePromise, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
  } catch {
    return undefined;
  }
}

// A REAL zombie: `sh` forks a child that exits immediately, then execs `sleep`
// in its own place, so the (still-living) parent never waits and the child sits
// in the process table as state Z. A zombie's /proc/<pid>/stat stays fully
// readable - start-time identity included - which is exactly why "the identity
// still matches" is not evidence of life (atelier-tzw round 3, I6).
async function spawnZombieProcess(t) {
  const parent = spawn("sh", ["-c", "true & printf '%s\\n' \"$!\"; exec sleep 30"], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  const exitPromise = once(parent, "exit");
  t.after(async () => {
    if (parent.exitCode === null && parent.signalCode === null) {
      process.kill(-parent.pid, "SIGKILL");
      await exitPromise.catch(() => {});
    }
  });
  let output = "";
  parent.stdout.setEncoding("utf8");
  parent.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await once(parent.stdout, "data");
  const pid = Number(output.trim());
  await waitForConditionOverTime(
    () => procState(pid) === "Z",
    `pid ${pid} never became a zombie`,
  );
  return { parent, pid, exitPromise };
}

// atelier-8r6: finish() asks git whether the dispatch produced anything before it
// verifies, and an empty answer is a real outcome (completed_empty). A stub that
// returns "" for every git call is therefore claiming "this run changed nothing",
// so fixtures whose subject is a NORMAL completion must say the opposite out
// loud. Only the exact probe shape is intercepted; every other git call falls
// through to the stub it wraps.
const PROBE_CHANGED_FILE = "src/changed.txt\n";
const FIXTURE_BASE_COMMIT = "1111111111111111111111111111111111111111";
const FIXTURE_RESULT_TREE = "2222222222222222222222222222222222222222";

function isOutcomeDiffProbe(args) {
  return args[2] === "diff" && args[3] === "--no-ext-diff" && args[4] === "--name-only";
}

function withDispatchChanges(
  runner,
  changed = PROBE_CHANGED_FILE,
  { verificationStatus = () => "" } = {},
) {
  return async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return changed;
    if (file === "git" && args[2] === "status" && args.includes("--ignored=matching")) {
      return verificationStatus();
    }
    if (file === "git" && args[2] === "diff" && args[3] === "--name-only") return "";
    if (file === "git" && args[2] === "rev-parse" && args[3] === "--verify") {
      return `${args[4].endsWith("^{tree}") ? FIXTURE_RESULT_TREE : FIXTURE_BASE_COMMIT}\n`;
    }
    return runner(file, args, options);
  };
}

function stubPreparation({
  dirtyCount = 0,
  strandedStatus = "",
  onCommand = () => {},
  verificationTree = () => FIXTURE_RESULT_TREE,
  verificationStatus = () => "",
} = {}) {
  _setProbe(async () => ({ git: { dirtyCount, branch: "main" } }));
  _setRunFile(withDispatchChanges(async (file, args, options = {}) => {
    onCommand(file, args, options);
    if (["update", "ready", "sync"].includes(args[0])) return ""; // br tracker calls
    assert.equal(file, "git");
    if (args[2] === "status") return strandedStatus;
    if (args[2] === "log") return "";
    if (args[2] === "rev-parse") {
      return `${args[3] === "HEAD^{tree}" ? verificationTree() : FIXTURE_BASE_COMMIT}\n`;
    }
    if (args[2] === "rev-list") return "0\n";
    if (args[2] === "worktree" && args[3] === "remove") {
      await rm(args[4], { recursive: true, force: true });
      return "";
    }
    if (args[2] === "worktree" && args[4] === "--detach") {
      await mkdir(args[5], { recursive: true });
      return "";
    }
    assert.deepEqual(args.slice(0, 5), ["-C", args[1], "worktree", "add", "-b"]);
    const primary = args[1];
    const worktreePath = args[6];
    await mkdir(worktreePath, { recursive: true });
    const primaryIssues = join(primary, ".beads", "issues.jsonl");
    if (existsSync(primaryIssues)) {
      await mkdir(join(worktreePath, ".beads"), { recursive: true });
      await copyFile(primaryIssues, join(worktreePath, ".beads", "issues.jsonl"));
    }
    return "";
  }, PROBE_CHANGED_FILE, { verificationStatus }));
}

function stubTrackedPreparation(setup, calls) {
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(withDispatchChanges(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    return "";
  }));
}

function stubConvoyRuntime(
  setup,
  issues,
  calls = [],
  { changed = PROBE_CHANGED_FILE, readyIssues = issues } = {},
) {
  mkdirSync(join(setup.primary, ".beads"), { recursive: true });
  writeFileSync(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(withDispatchChanges(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") return `${JSON.stringify(readyIssues)}\n`;
      if (args[0] === "show") {
        return `${JSON.stringify(issues.find((issue) => issue.id === args[1]))}\n`;
      }
      if (args[0] === "update") {
        appendFileSync(join(options.cwd, ".beads", "issues.jsonl"), "\n");
        return "";
      }
      throw new Error(`unexpected br command: ${args.join(" ")}`);
    }
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "-b") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    if (args[2] === "rev-parse") return "9999999999999999999999999999999999999999\n";
    return "";
  }, changed));
  return calls;
}

function stubBakeoffRuntime(
  setup,
  { claudeFails = false, codexStatus = "completed" } = {},
) {
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setSpawner((file) => {
    if (file === "claude") return claudeFails ? failedChild() : successfulChild();
    if (file === "node") return codexLaunchChild();
    throw new Error(`unexpected spawn: ${file}`);
  });
  _setRunFile(withDispatchChanges(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") return "";
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: codexStatus, summary: `codex ${codexStatus}` });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: `codex ${codexStatus}` } });
    }
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "-b") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    if (["status", "log"].includes(args[2])) return "";
    return "";
  }));
  return calls;
}

async function waitForState(dispatcher, id, states) {
  const wanted = new Set(states);
  const existing = dispatcher.get(id);
  if (wanted.has(existing?.state)) return existing;
  return new Promise((resolvePromise, rejectPromise) => {
    const remove = dispatcher.onEvent((event) => {
      if (event.dispatchId !== id || event.type !== "status") return;
      const record = dispatcher.get(id);
      // Fail loudly instead of hanging when a fixture lands on an unfinished
      // outcome it did not ask for (atelier-8r6): it almost always means the stub
      // runner answered the change probe with "" and so declared that the
      // dispatch produced nothing. `withDispatchChanges` is the fix.
      if (
        ["completed_empty", "needs_input"].includes(record?.state) &&
        !wanted.has(record.state)
      ) {
        remove();
        rejectPromise(new Error(
          `dispatch ${id} reached ${record.state} while waiting for ${[...wanted].join("|")} - does the fixture claim the run produced changes?`,
        ));
        return;
      }
      if (!wanted.has(record?.state)) return;
      remove();
      resolvePromise(record);
    });
  });
}

async function waitForConvoy(dispatcher, id, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const convoy = dispatcher.listConvoys().find((candidate) => candidate.id === id);
    if (convoy && predicate(convoy)) return convoy;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`convoy ${id} did not reach the expected condition`);
}

// exposedRecord() - NOT publicRecord() - is what omits the restart-reattach/
// orphan-reap plumbing (codexJobId/codexWorkspace/codexWorkerPid/
// codexWorkerPidIdentity, childPid/childPidIdentity - atelier-tzw review finding
// 7f). publicRecord() keeps full fidelity precisely because persist() writes
// it; every externally served record goes through exposedRecord() on top of it.
// Tests that need to see those persisted-only fields read index.jsonl directly.
function rawRecord(setup, id) {
  const raw = readFileSync(join(setup.state, "dispatches", "index.jsonl"), "utf8");
  let latest;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    if (parsed.id === id) latest = parsed;
  }
  if (!latest) throw new Error(`no persisted record found for ${id}`);
  return latest;
}

// Lets every already-queued microtask/setImmediate chain drain, for the negative
// assertions ("boot did NOT settle this again") that no positive condition can
// prove by waiting.
async function settleAsyncWork(turns = 50) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

async function waitForCondition(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(message);
}

// setImmediate-polling (waitForCondition above) burns through 100 attempts
// in under a millisecond of real time - useless for anything waiting on an
// actual setTimeout-based grace period (e.g. orphan-reap's terminatePostMergeChild
// boundary). This polls on the wall clock instead.
async function waitForConditionOverTime(predicate, message, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

async function seedDispatch(setup, overrides = {}) {
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const boundCommit = overrides.branchHead ?? overrides.result?.commit ?? "validated-head";
  const resultVersion = overrides.result?.version ?? 1;
  const record = {
    id: "dispatch-merge",
    project: "fixture",
    ticketId: "fixture-1",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: "atelier/fixture-1-dispatch-merge",
    worktreePath: join(setup.state, "worktrees", "fixture", "dispatch-merge"),
    startedAt: "2026-07-21T08:00:00.000Z",
    endedAt: "2026-07-21T08:01:00.000Z",
    turns: 2,
    costUSD: 0.5,
    exitSummary: "done",
    strandedBrWrites: false,
    verify: { state: "passed", steps: [] },
    branchHead: boundCommit,
    result: {
      commit: boundCommit,
      tree: FIXTURE_RESULT_TREE,
      base: FIXTURE_BASE_COMMIT,
      manifest: [],
      version: resultVersion,
    },
    attestation: { resultCommit: boundCommit, resultVersion },
    merged: null,
    dismissed: null,
    warnings: [],
    ...overrides,
  };
  seededSyntheticBranches.add(record.branch);
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

async function stubHarvestScenario(
  setup,
  { primaryIssues, worktreeIssues, brHandler, staged = false },
) {
  const trackerPath = setup.project.trackerPath ?? setup.primary;
  await mkdir(join(trackerPath, ".beads"), { recursive: true });
  await writeFile(join(trackerPath, ".beads", "issues.jsonl"), primaryIssues);
  const calls = [];
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    if (file === "/fixture/br") return brHandler(args, options);
    assert.equal(file, "git");
    if (args[2] === "worktree") {
      await mkdir(join(args[6], ".beads"), { recursive: true });
      await copyFile(
        join(trackerPath, ".beads", "issues.jsonl"),
        join(args[6], ".beads", "issues.jsonl"),
      );
      return "";
    }
    if (args[2] === "status") return " M .beads/issues.jsonl\n";
    if (args[2] === "log") return "";
    if (args[2] === "rev-parse") return `${trackerPath}\n`;
    if (args[2] === "add" || args[2] === "commit") return "";
    if (args[2] === "diff" && staged) throw new Error("staged changes");
    if (args[2] === "diff") return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner((_command, _args, options) =>
    successfulChild(async () => {
      await writeFile(join(options.cwd, ".beads", "issues.jsonl"), worktreeIssues);
    }),
  );
  return calls;
}

async function enablePersistedQueue(setup) {
  await mkdir(setup.state, { recursive: true });
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: true } })}\n`,
  );
}

function localStartedAt(daysAgo) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString();
}

function localDay(daysAgo) {
  const date = new Date(localStartedAt(daysAgo));
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

test("dispatcher rejects a foreign live writer before state creation while observer remains lock-free", async (t) => {
  const setup = await fixture(t);
  await mkdir(setup.state, { recursive: true });
  const owner = spawn(
    process.execPath,
    ["-e", 'console.log("ready");setInterval(() => {}, 1000)'],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(async () => {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill("SIGKILL");
      await once(owner, "exit").catch(() => {});
    }
  });
  await once(owner.stdout, "data");
  const lockPath = join(setup.state, "atelier.lock");
  await writeFile(lockPath, `${owner.pid}\n`);

  assert.throws(
    () => createDispatcher({ registry: setup.registry, stateDir: setup.state }),
    (error) => error.code === "EATELIERLOCKED" && error.message.includes(`PID ${owner.pid}`),
  );
  assert.equal(existsSync(join(setup.state, "dispatches")), false);

  const observer = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  assert.equal(await readFile(lockPath, "utf8"), `${owner.pid}\n`);
  await observer.shutdown({ graceMs: 0 });
  assert.equal(await readFile(lockPath, "utf8"), `${owner.pid}\n`);
});

test("observer construction against empty state creates nothing", async (t) => {
  const setup = await fixture(t);
  await mkdir(setup.state);
  const before = await readdir(setup.state);

  const observer = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  await observer.shutdown({ graceMs: 0 });

  assert.deepEqual(await readdir(setup.state), before);
});

test("observer skips a large unterminated index tail without repair or compaction", async (t) => {
  const setup = await fixture(t);
  const dispatchDir = join(setup.state, "dispatches");
  const indexPath = join(dispatchDir, "index.jsonl");
  await mkdir(dispatchDir, { recursive: true });
  const record = JSON.stringify({
    id: "observer-seed",
    project: "fixture",
    state: "failed",
    ticketId: null,
  });
  const contents = `${Array.from({ length: 1_001 }, () => record).join("\n")}\n{"id":`;
  await writeFile(indexPath, contents);
  const before = await stat(indexPath);
  const warnings = [];
  _setPersistenceLogger({ error: (message) => warnings.push(message) });

  const observer = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  await observer.shutdown({ graceMs: 0 });

  const after = await stat(indexPath);
  assert.equal(await readFile(indexPath, "utf8"), contents);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.ok(warnings.some((message) => /skipped 1 malformed index line/.test(message)));
});

test("dispatcher construction failure releases a lock it acquired", async (t) => {
  const setup = await fixture(t);
  await mkdir(setup.state);
  await writeFile(join(setup.state, "dispatches"), "not a directory\n");

  assert.throws(
    () => createDispatcher({ registry: setup.registry, stateDir: setup.state }),
    (error) => error.code === "EEXIST",
  );
  assert.equal(existsSync(join(setup.state, "atelier.lock")), false);

  const lock = acquireInstanceLock(setup.state);
  lock.release();
  assert.equal(existsSync(join(setup.state, "atelier.lock")), false);
});

test("dispatch runs queued -> preparing -> running -> completed with prompt posture", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    warn: "never publish",
    verifyMode: "container-primary",
    verifyCommands: ["node --test"],
  });
  await mkdir(join(setup.primary, ".beads"));
  await writeFile(join(setup.primary, ".beads", "issues.jsonl"), "");
  const commandOptions = [];
  stubPreparation({
    dirtyCount: 2,
    onCommand(file, args, options) {
      if (file === "git" && args[2] === "worktree" && args[3] === "add") {
        commandOptions.push(options);
      }
    },
  });
  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return successfulChild();
  });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-pass";
  t.after(() => {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-1",
    model: "opus[1m]",
    effort: "xhigh",
  });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(commandOptions[0].timeout, LONG_GIT_TIMEOUT_MS);

  assert.equal(record.turns, 2);
  assert.equal(record.costUSD, 0.5);
  assert.equal(record.sessionId, "fixture-session");
  assert.equal(record.exitSummary, "done");
  assert.equal(record.model, "opus[1m]");
  assert.equal(record.effort, "xhigh");
  assert.match(record.branch, /^atelier\/fixture-1-/);
  assert.ok(record.warnings.includes("primary has 2 uncommitted changes invisible to this dispatch"));
  assert.equal(launches[0].command, "claude");
  const modelFlag = launches[0].args.indexOf("--model");
  assert.equal(launches[0].args[modelFlag + 1], "opus[1m]");
  const effortFlag = launches[0].args.indexOf("--effort");
  assert.equal(launches[0].args[effortFlag + 1], "xhigh");
  const prompt = launches[0].args[1];
  assert.match(prompt, /TRACKER RULE/);
  assert.match(prompt, /FORBIDDEN: never publish/);
  assert.match(prompt, /advisory only for your worktree changes/);
  assert.doesNotMatch(prompt, /Prior attempts/);
  assert.equal(launches[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launches[0].options.env.ATELIER_PRIMARY_CHECKOUT, setup.primary);
  assert.deepEqual(
    dispatcher.getEvents(id).filter((event) => event.type === "status").map((event) => event.state),
    ["queued", "preparing", "running", "running", "completed"],
  );
});

test("ticket redispatch brief includes bounded, redacted prior-attempt provenance", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const longSummary = `discard-this-prefix ${"x".repeat(700)} sk-abcdefghijklmnopqrstu tail-token`;
  const failed = await seedDispatch(setup, {
    id: "prior-failed",
    ticketId: "fixture-history",
    lane: "claude",
    model: "sonnet",
    state: "failed",
    failureKind: "turn_cap",
    branch: "atelier/fixture-history-prior-failed",
    exitSummary: longSummary,
    startedAt: "2026-07-21T08:00:00.000Z",
  });
  const completed = {
    ...failed,
    id: "prior-completed",
    lane: "codex",
    model: "gpt-5.6-fixture",
    state: "completed",
    failureKind: null,
    branch: "atelier/fixture-history-prior-completed",
    exitSummary: "implementation ready",
    startedAt: "2026-07-21T09:00:00.000Z",
  };
  const branchless = {
    ...failed,
    id: "prior-stopped",
    state: "stopped",
    failureKind: null,
    branch: null,
    exitSummary: "stopped for a clean retry",
    startedAt: "2026-07-21T10:00:00.000Z",
  };
  const unrelated = {
    ...failed,
    id: "unrelated-attempt",
    ticketId: "fixture-other",
    branch: "atelier/fixture-other-unrelated",
  };
  appendFileSync(
    join(setup.state, "dispatches", "index.jsonl"),
    `${[completed, branchless, unrelated].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );

  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const gitLogRefs = [];
  const atelierLogCalls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") return "";
    assert.equal(file, "git");
    if (args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "log") {
      if (!args.includes("--grep=[atelier-committed]")) return "";
      const ref = args.at(-2);
      gitLogRefs.push(ref);
      atelierLogCalls.push(args);
      if (ref === failed.branch) {
        return "abcdef1234567890abcdef1234567890abcdef12\0wip [atelier-salvage]\n";
      }
      if (ref === completed.branch) {
        return "1234567890abcdef1234567890abcdef12345678\0work [atelier-committed]\n";
      }
      return "";
    }
    if (args[2] === "status") return "";
    return "";
  });
  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return successfulChild();
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-history",
  });
  await waitForState(dispatcher, id, ["completed"]);

  const prompt = launches[0].args[1];
  assert.match(prompt, /Prior attempts/);
  assert.match(prompt, /Inspect surviving branches before starting/);
  assert.match(prompt, /build on committed prior work when sound instead of recreating it/);
  assert.match(prompt, /dispatch prior-failed/);
  assert.match(prompt, /lane\/model: claude \/ sonnet/);
  assert.match(prompt, /terminal state\/failureKind: failed \/ turn_cap/);
  assert.match(prompt, /branch: atelier\/fixture-history-prior-failed/);
  assert.match(prompt, /salvage\/Atelier commit: abcdef123456 \[atelier-salvage\]/);
  assert.match(prompt, /dispatch prior-completed/);
  assert.match(prompt, /terminal state\/failureKind: completed \/ none/);
  assert.match(prompt, /salvage\/Atelier commit: 1234567890ab \[atelier-committed\]/);
  assert.match(prompt, /dispatch prior-stopped/);
  assert.match(prompt, /terminal state\/failureKind: stopped \/ unknown/);
  assert.match(prompt, /branch: \(none recorded\)/);
  assert.match(prompt, /exitSummary tail: ….*\[redacted\] tail-token/);
  assert.doesNotMatch(prompt, /discard-this-prefix/);
  assert.doesNotMatch(prompt, /sk-abcdefghijklmnopqrstu/);
  assert.doesNotMatch(prompt, /unrelated-attempt/);
  assert.deepEqual(gitLogRefs, [failed.branch, completed.branch]);
  assert.deepEqual(
    atelierLogCalls.map((args) => args.find((argument) => argument.startsWith("--since="))),
    ["--since=2026-07-21T08:00:00.000Z", "--since=2026-07-21T09:00:00.000Z"],
  );
});

test("plan-first runs read-only, supports revision, then approves with full tools", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  stubPreparation();
  const firstPlan = `1. Inspect the feature.\n2. Implement it.\n${"detail ".repeat(400)}`;
  const revisedPlan = "1. Inspect the feature.\n2. Add rollback coverage.\n3. Implement it.";
  const launches = [];
  let claudeRuns = 0;
  let verifyRuns = 0;
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    if (command === "claude") {
      const summaries = [firstPlan, revisedPlan, "implementation complete"];
      const child = claudeResultChild({ summary: summaries[claudeRuns] });
      claudeRuns += 1;
      return child;
    }
    verifyRuns += 1;
    return verifyChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const { id } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "Build the requested feature",
    planFirst: true,
  });
  const ready = await waitForState(dispatcher, id, ["plan_ready"]);
  assert.equal(ready.plan.state, "ready");
  assert.equal(ready.plan.text, firstPlan);
  assert.equal(ready.plan.text.length > 2_000, true);
  assert.equal(ready.verify, null);
  assert.equal(verifyRuns, 0);
  assert.match(
    launches[0].args[1],
    /^Produce a concrete implementation plan for the task below\. Do NOT modify any files\. End with the full plan as your final message\.\nTASK:\nBuild the requested feature/,
  );
  assert.match(launches[0].args[1], /VERIFY \(worktree\):\nnode --test$/);
  assert.equal(
    launches[0].args[launches[0].args.indexOf("--allowedTools") + 1],
    "Read,Grep,Glob",
  );

  const revising = await dispatcher.plan(id, { action: "revise", text: "Add rollback coverage" });
  assert.equal(revising.state, "running");
  const revised = await waitForState(dispatcher, id, ["plan_ready"]);
  assert.deepEqual(revised.plan, { state: "ready", text: revisedPlan });
  assert.equal(verifyRuns, 0);
  assert.deepEqual(launches[1].args.slice(0, 4), [
    "-p",
    "--resume",
    "fixture-session",
    "Revise the plan per this feedback, again WITHOUT modifying files:\nAdd rollback coverage",
  ]);
  assert.equal(
    launches[1].args[launches[1].args.indexOf("--allowedTools") + 1],
    "Read,Grep,Glob",
  );

  const approving = await dispatcher.plan(id, { action: "approve" });
  assert.equal(approving.state, "running");
  const completed = await waitForState(dispatcher, id, ["completed"]);
  assert.deepEqual(completed.plan, { state: "approved", text: revisedPlan });
  assert.equal(completed.verify.state, "passed");
  assert.equal(verifyRuns, 1);
  assert.deepEqual(launches[2].args.slice(0, 4), [
    "-p",
    "--resume",
    "fixture-session",
    `Execute the approved plan exactly:\n${revisedPlan}`,
  ]);
  assert.equal(
    launches[2].args[launches[2].args.indexOf("--allowedTools") + 1],
    "Read,Edit",
  );
  assert.deepEqual(
    dispatcher.getEvents(id).filter((event) => event.type === "plan").map((event) => event.text),
    [firstPlan, revisedPlan],
  );
  await assert.rejects(
    dispatcher.plan(id, { action: "approve" }),
    (error) => error.status === 409 && /while dispatch is completed/.test(error.message),
  );
});

test("boot preserves plan_ready and it does not hold the concurrent cap", async (t) => {
  const setup = await fixture(t, {}, { concurrentDispatchCap: 1 });
  const seeded = await seedDispatch(setup, {
    id: "planned-on-boot",
    ticketId: null,
    state: "plan_ready",
    endedAt: null,
    sessionId: "boot-session",
    plan: { state: "ready", text: "Boot-preserved plan" },
    verify: null,
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  stubPreparation();
  const summaries = ["other work complete", "approved work complete"];
  let launches = 0;
  _setSpawner((command) => {
    assert.equal(command, "claude");
    const child = claudeResultChild({ summary: summaries[launches] });
    launches += 1;
    return child;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.get(seeded.id).state, "plan_ready");
  const other = await dispatcher.dispatch({ project: "fixture", prompt: "cap-exempt work" });
  await waitForState(dispatcher, other.id, ["completed"]);
  await dispatcher.plan(seeded.id, { action: "approve" });
  const completed = await waitForState(dispatcher, seeded.id, ["completed"]);
  assert.equal(completed.plan.state, "approved");
  assert.equal(completed.exitSummary, "approved work complete");
});

test("plan-first rejects non-Claude lanes before preparation", async (t) => {
  const setup = await fixture(t);
  let commands = 0;
  _setRunFile(async () => {
    commands += 1;
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({
      project: "fixture",
      prompt: "plan elsewhere",
      lane: "codex",
      planFirst: true,
    }),
    (error) => error.status === 409 && /resumable Claude lane/.test(error.message),
  );
  assert.equal(commands, 0);
});

test("dispatch lane resolution follows the complete source-aware precedence chain", () => {
  const cases = [
    {
      name: "explicit lane beats every configured value",
      opts: { lane: "codex" },
      ownProfile: { lane: "claude" },
      defaultAgent: "claude",
      defaults: { dispatchProfile: { lane: "claude" } },
      expected: "codex",
    },
    {
      name: "project-owned profile lane beats defaultAgent",
      opts: {},
      ownProfile: { lane: "codex" },
      defaultAgent: "claude",
      defaults: { dispatchProfile: { lane: "claude" } },
      expected: "codex",
    },
    {
      name: "defaultAgent beats the defaults lane",
      opts: {},
      ownProfile: undefined,
      defaultAgent: "codex",
      defaults: { dispatchProfile: { lane: "claude" } },
      expected: "codex",
    },
    {
      name: "defaults lane applies when the project has no lane setting",
      opts: {},
      ownProfile: undefined,
      defaultAgent: undefined,
      defaults: { dispatchProfile: { lane: "codex" } },
      expected: "codex",
    },
    {
      name: "claude is the final fallback",
      opts: {},
      ownProfile: undefined,
      defaultAgent: undefined,
      defaults: {},
      expected: "claude",
    },
  ];

  for (const { name, opts, ownProfile, defaultAgent, defaults, expected } of cases) {
    const rawProject = {
      ...(ownProfile === undefined ? {} : { dispatchProfile: ownProfile }),
      ...(defaultAgent === undefined ? {} : { defaultAgent }),
    };
    const project = normalizeProject(rawProject, defaults);
    assert.equal(_resolveDispatchLane(opts, project, defaults), expected, name);
  }
});

test("reply resumes the captured Claude session, accumulates usage, and re-runs verification", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  stubPreparation();
  const launches = [];
  let claudeRuns = 0;
  let verifyRuns = 0;
  let dispatcher;
  let dispatchId;
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    if (command === "claude") {
      claudeRuns += 1;
      if (claudeRuns === 2) {
        assert.equal(dispatcher.getEvents(dispatchId).at(-1).type, "reply");
        return claudeResultChild({ turns: 3, costUSD: 1.25, summary: "resumed work done" });
      }
      return successfulChild();
    }
    verifyRuns += 1;
    return verifyChild();
  });
  dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  ({ id: dispatchId } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "initial work",
    effort: "high",
  }));
  const first = await waitForState(dispatcher, dispatchId, ["completed"]);
  assert.equal(first.sessionId, "fixture-session");
  assert.equal(verifyRuns, 1);
  assert.equal(first.result.version, 1);

  const replyText = "Continue with token=supersecretvalue";
  const resumed = await dispatcher.reply(dispatchId, { text: replyText });
  assert.equal(resumed.state, "running");
  assert.equal(resumed.result.version, 2);
  assert.equal(resumed.result.invalidationReason, "dispatch resumed for new work");
  assert.deepEqual(resumed.verify, {
    state: "invalidated",
    detail: "dispatch resumed for new work",
    steps: [],
  });
  const completed = await waitForState(dispatcher, dispatchId, ["completed"]);

  assert.equal(completed.turns, 5);
  assert.equal(completed.costUSD, 1.75);
  assert.equal(completed.exitSummary, "resumed work done");
  assert.equal(completed.verify.state, "passed");
  assert.equal(completed.result.version, 2);
  assert.equal(completed.result.invalidationReason, undefined);
  assert.equal(verifyRuns, 2);
  const claudeLaunches = launches.filter(({ command }) => command === "claude");
  assert.deepEqual(claudeLaunches[1].args, [
    "-p",
    "--resume",
    "fixture-session",
    replyText,
    "--model",
    "haiku",
    "--max-turns",
    "7",
    "--allowedTools",
    "Read,Edit",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--effort",
    "high",
  ]);
  assert.equal(claudeLaunches[1].options.cwd, first.worktreePath);
  assert.deepEqual(claudeLaunches[1].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.notStrictEqual(claudeLaunches[1].options.env, claudeLaunches[0].options.env);

  const events = dispatcher.getEvents(dispatchId);
  const reply = events.find((event) => event.type === "reply");
  assert.equal(reply.text, "Continue with token=[redacted]");
  const replyIndex = events.findIndex((event) => event.type === "reply");
  assert.equal(events[replyIndex + 1].type, "status");
  assert.equal(events[replyIndex + 1].state, "running");
  const persisted = (await readFile(join(setup.state, "dispatches", "index.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .at(-1);
  assert.equal(persisted.sessionId, "fixture-session");
});

test("running reply writes the accepted Claude JSONL shape to piped stdin", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  let input = "";
  let launch;
  child.stdin.on("data", (chunk) => {
    input += chunk.toString("utf8");
  });
  _setSpawner((command, args, options) => {
    launch = { command, args, options };
    return child;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "held work" });
  await waitForState(dispatcher, id, ["running"]);
  assert.equal(launch.command, "claude");
  assert.deepEqual(launch.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(
    launch.args.slice(launch.args.indexOf("--input-format"), launch.args.indexOf("--input-format") + 2),
    ["--input-format", "stream-json"],
  );

  const record = await dispatcher.reply(id, { text: "steer now" });
  assert.equal(record.state, "running");
  assert.deepEqual(input.trim().split("\n").map(JSON.parse), [
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "held work" }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "steer now" }],
      },
    },
  ]);
  assert.equal(dispatcher.getEvents(id).at(-1).type, "reply");
  child.stdin.end();
  await assert.rejects(
    dispatcher.reply(id, { text: "too late" }),
    (error) => error.status === 409 && error.message === "agent no longer accepting input",
  );
  child.complete();
  const completed = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(completed.state, "completed");
  assert.equal(child.stdin.writableEnded, true);
});

test("reply rejects a completed Claude run without a session", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "no session" });
  await waitForState(dispatcher, id, ["running"]);
  child.complete();
  await waitForState(dispatcher, id, ["completed"]);
  await assert.rejects(
    dispatcher.reply(id, { text: "try again" }),
    (error) => error.status === 409 && /no sessionId/.test(error.message),
  );
});

test("emit-time redaction masks every credential class in live and persisted output", async (t) => {
  const setup = await fixture(t);
  const credentials = [
    "sk-ABCDEFGHIJKLMNOP",
    "ghp_abcdefghijklmnopqrst",
    "github_pat_abcdefghijklmnopqrst_uv",
    "AKIAABCDEFGHIJKL",
    "xoxb-abcdefghij",
    `eyJ${"A".repeat(20)}.${"B".repeat(10)}.${"C".repeat(10)}`,
    "token=supersecretvalue",
    "Bearer abcdefghijklmnop",
  ];
  const secretText = credentials.join(" ");
  stubPreparation();
  _setSpawner(() => secretOutputChild(secretText));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const liveEvents = [];
  const removeListener = dispatcher.onEvent((event) => liveEvents.push(event));
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "redact output" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  removeListener();

  const liveText = JSON.stringify(liveEvents);
  const persistedEvents = await readFile(
    join(setup.state, "dispatches", `${id}.jsonl`),
    "utf8",
  );
  const persistedIndex = await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  );
  for (const credential of credentials) {
    assert.doesNotMatch(liveText, new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(
      persistedEvents,
      new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.doesNotMatch(
      persistedIndex,
      new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
  assert.match(liveText, /\[redacted\]/);
  assert.match(persistedEvents, /\[redacted\]/);
  assert.match(record.exitSummary, /\[redacted\]/);
  assert.doesNotMatch(record.exitSummary, /supersecretvalue/);
});

test("persistence write failures warn, keep transitions live, and resync on recovery", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  let writesFail = true;
  _setPersistenceFileOps({
    appendFileSync(...args) {
      if (writesFail) {
        throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
      }
      appendFileSync(...args);
    },
  });
  const logLines = [];
  _setPersistenceLogger({
    error(line) {
      logLines.push(line);
    },
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const liveEvents = [];
  const removeListener = dispatcher.onEvent((event) => liveEvents.push(event));
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "survive persistence" });
  const running = await waitForState(dispatcher, id, ["running"]);
  assert.equal(running.state, "running");
  assert.equal(existsSync(join(setup.state, "dispatches", "index.jsonl")), false);
  assert.equal(existsSync(join(setup.state, "dispatches", `${id}.jsonl`)), false);

  writesFail = false;
  child.complete();
  const completed = await waitForState(dispatcher, id, ["completed"]);
  removeListener();

  const persistenceWarnings = completed.warnings.filter((warning) =>
    warning.startsWith("PERSISTENCE DEGRADED:"),
  );
  assert.equal(persistenceWarnings.length, 1);
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], new RegExp(`dispatch ${id} \\(record\\): fixture disk full`));
  assert.equal(liveEvents[0].type, "status");
  assert.equal(liveEvents[0].state, "queued");
  assert.equal(liveEvents[0].seq, 1);

  const persistedRecords = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(persistedRecords[0].state, "running");
  assert.ok(persistedRecords[0].warnings.includes(persistenceWarnings[0]));
  assert.equal(persistedRecords.at(-1).state, "completed");

  const persistedEvents = (await readFile(
    join(setup.state, "dispatches", `${id}.jsonl`),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(persistedEvents[0].seq > 1);
  assert.equal(persistedEvents.at(-1).state, "completed");
});

test("terminal event-only persistence failure preserves its warning in record, live SSE, and replay", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  let failedTerminalEvent = false;
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      const event = path.endsWith("index.jsonl") ? null : JSON.parse(contents.trim());
      if (
        !failedTerminalEvent &&
        event?.type === "status" &&
        event.state === "completed"
      ) {
        failedTerminalEvent = true;
        throw Object.assign(new Error("fixture event EIO"), { code: "EIO" });
      }
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const liveEvents = [];
  const removeListener = dispatcher.onEvent((event) => liveEvents.push(event));
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "terminal event" });
  await waitForState(dispatcher, id, ["running"]);
  child.complete();
  const completed = await waitForState(dispatcher, id, ["completed"]);
  removeListener();

  assert.equal(failedTerminalEvent, true);
  assert.equal(logLines.length, 1);
  const warning = completed.warnings.find((item) => item.startsWith("PERSISTENCE DEGRADED:"));
  assert.ok(warning);
  const liveCompleted = liveEvents.find(
    (event) => event.type === "status" && event.state === "completed",
  );
  assert.equal(liveCompleted.warning, warning);

  const persistedRecords = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(persistedRecords.at(-1).warnings.includes(warning));
  const replayedCompleted = dispatcher.getEvents(id).find(
    (event) => event.type === "status" && event.state === "completed",
  );
  assert.equal(replayedCompleted.warning, warning);
});

test("partial record append is separated and malformed JSONL is skipped on recovery", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  _setSpawner(() => successfulChild());
  let wrotePartialRecord = false;
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      if (!wrotePartialRecord && path.endsWith("index.jsonl")) {
        wrotePartialRecord = true;
        appendFileSync(path, contents.slice(0, 12), encoding);
        throw Object.assign(new Error("fixture partial write"), { code: "ENOSPC" });
      }
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });
  _setPersistenceLogger({ error() {} });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "partial append" });
  await waitForState(dispatcher, id, ["completed"]);

  const lines = (await readFile(join(setup.state, "dispatches", "index.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean);
  assert.throws(() => JSON.parse(lines[0]), SyntaxError);
  const validRecords = lines.slice(1).map(JSON.parse);
  assert.equal(validRecords.at(-1).state, "completed");
  assert.ok(validRecords.at(-1).warnings.some((warning) =>
    warning.startsWith("PERSISTENCE DEGRADED:"),
  ));

  const reloaded = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(reloaded.get(id).state, "completed");
});

test("a second dispatch repairs a malformed shared index tail left by another entry", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const firstChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? firstChild : successfulChild();
  });
  let firstId;
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      if (!path.endsWith("index.jsonl")) {
        appendFileSync(path, contents, encoding);
        return;
      }
      const record = JSON.parse(contents.trim());
      if (!firstId) {
        firstId = record.id;
        appendFileSync(path, contents.slice(0, 12), encoding);
        throw Object.assign(new Error("fixture entry A partial write"), { code: "ENOSPC" });
      }
      if (record.id === firstId) {
        throw Object.assign(new Error("fixture entry A still blocked"), { code: "ENOSPC" });
      }
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });
  _setPersistenceLogger({ error() {} });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const first = await dispatcher.dispatch({ project: "fixture", prompt: "entry A" });
  await waitForState(dispatcher, first.id, ["running"]);
  const second = await dispatcher.dispatch({ project: "fixture", prompt: "entry B" });
  const completedSecond = await waitForState(dispatcher, second.id, ["completed"]);

  assert.equal(first.id, firstId);
  assert.ok(completedSecond.warnings.some((warning) =>
    warning.startsWith("PERSISTENCE DEGRADED:"),
  ));
  const lines = (await readFile(join(setup.state, "dispatches", "index.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean);
  assert.throws(() => JSON.parse(lines[0]), SyntaxError);
  const validRecords = lines.slice(1).map(JSON.parse);
  assert.equal(validRecords.at(-1).id, second.id);
  assert.equal(validRecords.at(-1).state, "completed");

  _setPersistenceFileOps();
  firstChild.complete();
  await waitForState(dispatcher, first.id, ["completed"]);
});

test("dispatcher boot skips and repairs a malformed index tail before the next append", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, { id: "clean-before-malformed-tail" });
  const indexPath = join(setup.state, "dispatches", "index.jsonl");
  appendFileSync(indexPath, '{"id":"broken-tail"', "utf8");
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });
  stubPreparation();
  _setSpawner(() => successfulChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(dispatcher.get(seeded.id).state, "completed");
  assert.ok(logLines.some((line) => line.includes("malformed final line")));
  const next = await dispatcher.dispatch({ project: "fixture", prompt: "after restart repair" });
  await waitForState(dispatcher, next.id, ["completed"]);

  const lines = (await readFile(indexPath, "utf8")).split("\n").filter(Boolean);
  const validRecords = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  assert.equal(validRecords.find((record) => record.id === seeded.id).state, "completed");
  assert.equal(validRecords.filter((record) => record.id === next.id).at(-1).state, "completed");
});

test("periodic drain retries a terminal record snapshot that stayed unpersisted", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  let failTerminalRecord = true;
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      if (path.endsWith("index.jsonl")) {
        const record = JSON.parse(contents.trim());
        if (failTerminalRecord && record.state === "completed") {
          throw Object.assign(new Error("fixture terminal record ESTALE"), { code: "ESTALE" });
        }
      }
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });
  _setPersistenceLogger({ error() {} });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "pending terminal" });
  await waitForState(dispatcher, id, ["running"]);
  child.complete();
  const completed = await waitForState(dispatcher, id, ["completed"]);

  assert.ok(completed.warnings.some((warning) => warning.startsWith("PERSISTENCE DEGRADED:")));
  let persistedRecords = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.notEqual(persistedRecords.at(-1).state, "completed");

  failTerminalRecord = false;
  await dispatcher.drainQueuesOnce();
  persistedRecords = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  ))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(persistedRecords.at(-1).state, "completed");
  const reloaded = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(reloaded.get(id).state, "completed");
});

test("non-filesystem programming errors inside transitions still propagate", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "programming error" });
  await waitForState(dispatcher, id, ["running"]);

  _setPersistenceFileOps({
    appendFileSync() {
      throw new TypeError("fixture programming defect");
    },
    writeFileSync,
  });
  await assert.rejects(
    dispatcher.stop(id),
    (error) => error instanceof TypeError && error.message === "fixture programming defect",
  );
  assert.equal(dispatcher.get(id).state, "stopping");
  assert.equal(
    dispatcher.get(id).warnings.some((warning) => warning.startsWith("PERSISTENCE DEGRADED:")),
    false,
  );

  _setPersistenceFileOps();
  child.complete();
  await waitForState(dispatcher, id, ["stopped"]);
});

test("worktree verification runs sequential argv steps and records a passed verdict", async (t) => {
  const setup = await fixture(t, {
    verifyCommands: ["node --test one", "printf verified"],
  });
  stubPreparation();
  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    if (command === "claude") return successfulChild();
    return verifyChild({ stdout: [`${command} output`], stderr: ["detail"] });
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "verify work" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.verify.state, "passed");
  assert.deepEqual(
    record.verify.steps.map(({ command, exitCode }) => ({ command, exitCode })),
    [
      { command: "node --test one", exitCode: 0 },
      { command: "printf verified", exitCode: 0 },
    ],
  );
  assert.match(record.verify.steps[0].tail, /node output\ndetail/);
  assert.deepEqual(
    launches.slice(1).map(({ command, args, options }) => ({
      command,
      args,
      detached: options.cwd.includes(`${join("verify-worktrees", "fixture")}`),
      anthropicKey: options.env.ANTHROPIC_API_KEY,
    })),
    [
      { command: "node", args: ["--test", "one"], detached: true, anthropicKey: undefined },
      { command: "printf", args: ["verified"], detached: true, anthropicKey: undefined },
    ],
  );
  const events = dispatcher.getEvents(id);
  assert.deepEqual(
    events.filter((event) => event.type === "status").map((event) => event.state),
    ["queued", "preparing", "running", "running", "verifying", "completed"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "verify").map(({ step, phase, exitCode }) => ({
      step,
      phase,
      ...(phase === "end" ? { exitCode } : {}),
    })),
    [
      { step: 0, phase: "start" },
      { step: 0, phase: "end", exitCode: 0 },
      { step: 1, phase: "start" },
      { step: 1, phase: "end", exitCode: 0 },
    ],
  );
  assert.ok(events.some((event) => event.type === "verify-output" && event.line === "detail"));
});

test("worktree verification records the exact tested HEAD and current main drift", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      await rm(args[4], { recursive: true, force: true });
      return "";
    }
    if (args[2] === "status" || args[2] === "log") return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") {
      return `${FIXTURE_RESULT_TREE}\n`;
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return "1111111111111111111111111111111111111111\n";
    }
    if (args[2] === "rev-parse" && args[3] === "main") {
      return "2222222222222222222222222222222222222222\n";
    }
    if (args[2] === "rev-list") return "3\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner((command) => command === "claude" ? successfulChild() : verifyChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "stamp verification base" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.verify.state, "passed");
  assert.equal(record.verify.mainBranch, "main");
  assert.equal(record.verify.testedTree, "1111111111111111111111111111111111111111");
  assert.equal(record.verify.mainTip, "2222222222222222222222222222222222222222");
  assert.equal(record.verify.commitsBehind, 3);
  assert.match(record.verify.contextAt, /^2026-/);
});

test("clean detached verification persists an immutable attestation and removes its worktree", async (t) => {
  const commands = ["node --test one", "printf verified"];
  const setup = await fixture(t, { verifyCommands: commands });
  const gitCalls = [];
  stubPreparation({ onCommand: (_file, args) => gitCalls.push([...args]) });
  const verifyCwds = [];
  _setSpawner((command, _args, options) => {
    if (command === "claude") return successfulChild();
    verifyCwds.push(options.cwd);
    return verifyChild();
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "attest clean bytes" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const added = gitCalls.find((args) => args[2] === "worktree" && args[4] === "--detach");
  const removed = gitCalls.find((args) => args[2] === "worktree" && args[3] === "remove");

  assert.equal(record.verify.state, "passed");
  assert.ok(added, "verification never created a detached worktree");
  assert.equal(added[5].includes(`${join("verify-worktrees", "fixture")}`), true);
  assert.deepEqual(verifyCwds, [added[5], added[5]]);
  assert.equal(removed?.[4], added[5], "passing verification left its worktree registered");
  assert.equal(existsSync(added[5]), false, "passing verification left its worktree directory");
  assert.deepEqual(record.attestation, {
    resultCommit: FIXTURE_BASE_COMMIT,
    resultTree: FIXTURE_RESULT_TREE,
    resultVersion: 1,
    suite: "project-verify",
    commandsDigest: createHash("sha256").update(JSON.stringify(commands)).digest("hex"),
    pre: { head: FIXTURE_BASE_COMMIT, tree: FIXTURE_RESULT_TREE, statusClean: true },
    post: { head: FIXTURE_BASE_COMMIT, tree: FIXTURE_RESULT_TREE, statusClean: true },
    attestedAt: record.attestation.attestedAt,
    attempt: 1,
  });
  assert.match(record.attestation.attestedAt, /^2026-/);
  assert.deepEqual(rawRecord(setup, id).attestation, record.attestation);
});

test("a zero-exit verifier that mutates the detached tree fails and cannot attest", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node mutate"] });
  const gitCalls = [];
  let verifierRan = false;
  const mutatedTree = "3333333333333333333333333333333333333333";
  stubPreparation({
    onCommand: (_file, args) => gitCalls.push([...args]),
    verificationTree: () => verifierRan ? mutatedTree : FIXTURE_RESULT_TREE,
  });
  _setSpawner((command) => {
    if (command === "claude") return successfulChild();
    verifierRan = true;
    return verifyChild({ code: 0 });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "detect mutation" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const added = gitCalls.find((args) => args[2] === "worktree" && args[4] === "--detach");
  const removed = gitCalls.find((args) => args[2] === "worktree" && args[3] === "remove");

  assert.equal(record.verify.steps[0].exitCode, 0);
  assert.notEqual(record.verify.state, "passed");
  assert.match(record.verify.detail, /^EATELIER_VERIFICATION_MUTATED_WORKTREE: /);
  assert.match(record.verify.detail, new RegExp(`${FIXTURE_RESULT_TREE}.*${mutatedTree}`));
  assert.equal(record.attestation, null);
  assert.equal(removed?.[4], added?.[5], "failed verification left its worktree registered");
  assert.equal(existsSync(added[5]), false, "failed verification left its worktree directory");
});

test("verification mutation details redact credential-shaped porcelain paths", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node mutate"] });
  const credential = "sk-ABCDEFGHIJKLMNOP";
  let verifierRan = false;
  stubPreparation({
    verificationStatus: () => verifierRan ? `?? ${credential}.txt\0` : "",
  });
  _setSpawner((command) => {
    if (command === "claude") return successfulChild();
    verifierRan = true;
    return verifyChild();
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "redact mutation path" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const persisted = await readFile(join(setup.state, "dispatches", "index.jsonl"), "utf8");

  assert.match(record.verify.detail, /^EATELIER_VERIFICATION_MUTATED_WORKTREE: /);
  assert.match(record.verify.detail, /\[redacted\]/);
  assert.doesNotMatch(record.verify.detail, new RegExp(credential));
  assert.doesNotMatch(persisted, new RegExp(credential));
});

test("a failed post-command snapshot is classified as verifier mutation", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node mutate-linkage"] });
  let verifierRan = false;
  stubPreparation({
    verificationTree() {
      if (verifierRan) throw new Error("checkout .git linkage is unreadable");
      return FIXTURE_RESULT_TREE;
    },
  });
  _setSpawner((command) => {
    if (command === "claude") return successfulChild();
    verifierRan = true;
    return verifyChild();
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "break post probe" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.verify.steps[0].exitCode, 0);
  assert.match(record.verify.detail, /^EATELIER_VERIFICATION_MUTATED_WORKTREE: /);
  assert.match(record.verify.detail, /post-command checkout probe failed/);
  assert.equal(record.attestation, null);
});

test("verification removes a checkout left behind by a timed-out worktree add", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node never"] });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let verificationWorktree;
  const calls = [];
  _setRunFile(withDispatchChanges(async (file, args) => {
    calls.push({ file, args });
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "-b") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      verificationWorktree = args[5];
      await mkdir(verificationWorktree, { recursive: true });
      const error = new Error("git worktree add timed out");
      error.code = "ETIMEDOUT";
      throw error;
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      await rm(args[4], { recursive: true, force: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-list") return "0\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  }));
  _setSpawner(() => successfulChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "time out checkout add" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.match(record.verify.detail, /^verification checkout failed: git worktree add timed out/);
  assert.ok(calls.some(({ args }) =>
    args[2] === "worktree" && args[3] === "remove" && args[4] === verificationWorktree));
  assert.equal(existsSync(verificationWorktree), false);
});

test("verification reports only the checkout failure when worktree add never registered a path", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node never"] });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let verificationWorktree;
  const calls = [];
  _setRunFile(withDispatchChanges(async (file, args) => {
    calls.push({ file, args });
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "-b") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      verificationWorktree = args[5];
      throw new Error("git worktree add rejected before registration");
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      throw new Error("unknown worktree path");
    }
    if (["status", "log"].includes(args[2])) return "";
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-list") return "0\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  }));
  _setSpawner(() => successfulChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "reject checkout add" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.match(
    record.verify.detail,
    /^verification checkout failed: git worktree add rejected before registration$/,
  );
  assert.equal(existsSync(verificationWorktree), false);
  assert.equal(record.verify.worktreePath, undefined);
  assert.equal(
    record.warnings.some((warning) => warning.startsWith("verification worktree cleanup failed:")),
    false,
  );
  assert.equal(
    calls.some(({ args }) =>
      args[2] === "worktree" && args[3] === "remove" && args[4] === verificationWorktree),
    false,
  );
});

test("result invalidation clears an existing attestation", () => {
  const entry = {
    record: {
      result: { commit: FIXTURE_BASE_COMMIT, tree: FIXTURE_RESULT_TREE, version: 4 },
      attestation: { resultCommit: FIXTURE_BASE_COMMIT, resultVersion: 4 },
    },
  };

  invalidateResult(entry, "new work arrived");

  assert.equal(Object.hasOwn(entry.record, "attestation"), false);
  assert.equal(entry.record.result.version, 5);
  assert.deepEqual(entry.record.verify, {
    state: "invalidated",
    detail: "new work arrived",
    steps: [],
  });
});

test("an attested finalized result keeps the stale-head verification code", async (t) => {
  const setup = await fixture(t);
  const movedHead = "3333333333333333333333333333333333333333";
  const record = await seedDispatch(setup, {
    result: { commit: FIXTURE_BASE_COMMIT, tree: FIXTURE_RESULT_TREE, version: 2 },
    attestation: { resultCommit: FIXTURE_BASE_COMMIT, resultVersion: 2 },
  });
  await mkdir(record.worktreePath, { recursive: true });
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "git" && args[2] === "rev-parse" && args[3] === "--verify") {
      return `${movedHead}\n`;
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge(record.id),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /^EATELIER_VERIFICATION_HEAD_MISMATCH: /);
      return true;
    },
  );
  assert.equal(
    calls.some(({ args }) => ["merge", "update-ref"].includes(args[2])),
    false,
    "stale-attestation refusal still moved main",
  );
});

test("strict merge binding refuses a missing result, divergent result, and missing attestation", async (t) => {
  const scenarios = [
    {
      label: "attested but missing result",
      overrides: {
        result: null,
        attestation: { resultCommit: "validated-head", resultVersion: 1 },
      },
      branchHead: "validated-head",
    },
    {
      label: "divergent result",
      overrides: {
        result: { commit: "other-head", manifest: [], version: 1 },
        attestation: { resultCommit: "validated-head", resultVersion: 1 },
      },
      branchHead: "validated-head",
    },
    {
      label: "missing attestation",
      overrides: { attestation: null },
      branchHead: "validated-head",
    },
  ];

  for (const scenario of scenarios) {
    const setup = await fixture(t);
    const seeded = await seedDispatch(setup, scenario.overrides);
    const calls = [];
    _setRunFile(async (file, args) => {
      calls.push({ file, args });
      if (args[2] === "rev-parse" && args[3] === "--verify") {
        return `${scenario.branchHead}\n`;
      }
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    await assert.rejects(dispatcher.merge(seeded.id), (error) => {
      assert.equal(error.status, 409, scenario.label);
      assert.match(error.message, /^EATELIER_RESULT_VERIFICATION_MISMATCH: /, scenario.label);
      return true;
    });
    assert.equal(
      calls.some(({ args }) => ["fetch", "merge", "branch"].includes(args[2])),
      false,
      `${scenario.label} moved main`,
    );
  }
});

test("attestation mismatch keeps its verification-head code after result binding passes", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    branchHead: "current-head",
    result: {
      commit: "current-head",
      tree: FIXTURE_RESULT_TREE,
      base: FIXTURE_BASE_COMMIT,
      manifest: [],
      version: 2,
    },
    attestation: { resultCommit: "prior-head", resultVersion: 2 },
  });
  _setRunFile(async (_file, args) =>
    args[2] === "rev-parse" && args[3] === "--verify" ? "current-head\n" : "");
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 &&
      /^EATELIER_VERIFICATION_HEAD_MISMATCH: attested commit/.test(error.message),
  );
});

test("the reviewed-head gate retains its own refusal message", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const seeded = await seedDispatch(setup, {
    branchHead: "current-head",
    result: {
      commit: "current-head",
      tree: FIXTURE_RESULT_TREE,
      base: FIXTURE_BASE_COMMIT,
      manifest: [],
      version: 2,
    },
    attestation: { resultCommit: "current-head", resultVersion: 2 },
    review: {
      verdict: "pass",
      reviewedHead: "prior-head",
      findings: [],
      findingCount: 0,
    },
  });
  _setRunFile(async (_file, args) =>
    args[2] === "rev-parse" && args[3] === "--verify" ? "current-head\n" : "");
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 &&
      error.message === "review gate failed: eligible review does not match the current branch HEAD",
  );
});

test("a legacy record without a finalized result verifies in place without attesting", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const record = await seedRerunnable(setup);
  const calls = stubVerificationRuntime();
  let verifyCwd;
  _setSpawner((_file, _args, options) => {
    verifyCwd = options.cwd;
    return verifyChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.rerunVerification(record.id);
  const completed = await waitForState(dispatcher, record.id, ["completed"]);

  assert.equal(completed.verify.state, "passed");
  assert.equal(completed.attestation, null);
  assert.equal(verifyCwd, record.worktreePath);
  assert.equal(calls.some(({ args }) => args[2] === "worktree"), false);
});

test("a legacy result with a commit but no tree verifies in place without attesting", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const record = await seedRerunnable(setup, {
    result: { commit: FIXTURE_BASE_COMMIT, version: 1 },
  });
  const calls = stubVerificationRuntime();
  let verifyCwd;
  _setSpawner((_file, _args, options) => {
    verifyCwd = options.cwd;
    return verifyChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.rerunVerification(record.id);
  const completed = await waitForState(dispatcher, record.id, ["completed"]);

  assert.equal(completed.verify.state, "passed");
  assert.equal(completed.attestation, null);
  assert.equal(verifyCwd, record.worktreePath);
  assert.equal(calls.some(({ args }) => args[2] === "worktree"), false);
});

test("verification output is redacted in events and recorded step tails", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node verify"] });
  const credential = "sk-ABCDEFGHIJKLMNOP";
  stubPreparation();
  _setSpawner((command) =>
    command === "claude"
      ? successfulChild()
      : verifyChild({ stdout: [`credential ${credential}`] }),
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "verify redaction" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const events = dispatcher.getEvents(id);
  const persisted = await readFile(join(setup.state, "dispatches", `${id}.jsonl`), "utf8");

  const output = events.find((event) => event.type === "verify-output");
  assert.equal(output.line, "credential [redacted]");
  assert.match(record.verify.steps[0].tail, /credential \[redacted\]/);
  assert.doesNotMatch(record.verify.steps[0].tail, new RegExp(credential));
  assert.doesNotMatch(persisted, new RegExp(credential));
});

test("verification records the first and last 1000 output characters", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node long-output"] });
  stubPreparation();
  const first = "A".repeat(1_500);
  const last = "Z".repeat(1_500);
  _setSpawner((command) =>
    command === "claude" ? successfulChild() : verifyChild({ stdout: [first, last] }));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "long verify" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const output = record.verify.steps[0].tail;

  assert.ok(output.startsWith("A".repeat(1_000)));
  assert.match(output, /\.\.\.\[verify output truncated\]\.\.\./);
  assert.ok(output.endsWith(`${"Z".repeat(999)}\n`));
});

test("verification preserves every mid-output TAP failure and bounded YAML diagnostics", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  stubPreparation();
  const failingSubtest = "not ok 27 - atelier-4f4 mid-output dispatch failure";
  const secondFailingSubtest = "not ok 28 - atelier-4f4 second dispatch failure";
  _setSpawner((command) => command === "claude"
    ? successfulChild()
    : verifyChild({
      code: 1,
      stdout: [
        "A".repeat(1_300),
        failingSubtest,
        "  ---",
        "  error: 'dispatch failure detail'",
        "  code: 'ERR_TEST_FAILURE'",
        `  stack: ${"X".repeat(1_000)}`,
        "  ...",
        secondFailingSubtest,
        "  ---",
        "  error: 'second failure detail'",
        "  ...",
        "Z".repeat(1_300),
      ],
    }));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "failing verify" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  const persisted = await readFile(join(setup.state, "dispatches", `${id}.jsonl`), "utf8");

  assert.equal(record.verify.state, "failed");
  assert.match(record.verify.steps[0].tail, new RegExp(failingSubtest));
  assert.match(record.verify.steps[0].tail, new RegExp(secondFailingSubtest));
  assert.match(record.verify.steps[0].tail, /dispatch failure detail/);
  assert.match(record.verify.steps[0].tail, /ERR_TEST_FAILURE/);
  assert.match(record.verify.steps[0].tail, /failure diagnostics truncated/);
  assert.match(record.verify.steps[0].tail, /second failure detail/);
  assert.match(record.verify.steps[0].tail, /A{100}/);
  assert.match(record.verify.steps[0].tail, /Z{100}/);
  assert.match(persisted, new RegExp(failingSubtest));
  assert.match(persisted, new RegExp(secondFailingSubtest));
});

test("dispatchEnv merges project over defaults, stays hygienic, and reaches verification", async (t) => {
  const setup = await fixture(
    t,
    {
      verifyCommands: ["node verify-env"],
      dispatchEnv: {
        SHARED: "project",
        PROJECT_ONLY: "configured",
        ANTHROPIC_API_KEY: "must-still-be-removed",
      },
    },
    {
      dispatchProfile: {
        dispatchEnv: { SHARED: "default", DEFAULT_ONLY: "inherited" },
      },
    },
  );
  stubPreparation();
  const launches = [];
  _setSpawner((command, args, options) => {
    launches.push({ command, args, options });
    return command === "claude" ? successfulChild() : verifyChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "verify env" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.verify.state, "passed");
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.options.env.SHARED, "project");
    assert.equal(launch.options.env.DEFAULT_ONLY, "inherited");
    assert.equal(launch.options.env.PROJECT_ONLY, "configured");
    assert.equal(launch.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(launch.options.env.ATELIER_PRIMARY_CHECKOUT, setup.primary);
  }
  assert.notEqual(launches[0].options.env, launches[1].options.env);
});

test("project defaultAgent beats the defaults lane and Codex tolerates a read-only git dir", async (t) => {
  const setup = await fixture(t, {}, { dispatchProfile: { lane: "claude" } });
  setup.project.defaultAgent = "codex";
  delete setup.project.dispatchProfile.lane;
  setup.project = normalizeProject(setup.project, setup.registry.defaults);
  setup.registry.projects[0] = setup.project;
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({
    writeFileSync() {
      throw new Error("read-only git dir");
    },
    unlinkSync() {},
  });
  let launched = false;
  _setSpawner(() => {
    launched = true;
    return codexLaunchChild();
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") return ".atelier-git\n";
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "done" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "done" } });
    }
    if (file === "git" && args[2] === "status") return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "codex read-only git",
  });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(record.lane, "codex");
  assert.equal(record.model, "gpt-5.6-fixture");
  assert.equal(launched, true);
  assert.ok(
    record.warnings.includes(
      "Atelier cannot write the worktree gitdir - automatic Codex commit may fail",
    ),
  );
  while (dispatcher.get(id).state !== "completed") {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  await assert.rejects(
    dispatcher.reply(id, { text: "continue" }),
    (error) => error.status === 409 && /no sessionId/.test(error.message),
  );
});

test("completed Codex reply resumes its captured companion thread with user text", async (t) => {
  const setup = await fixture(t);
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const launches = [];
  const deliveredPrompts = [];
  const companionCommands = [];
  _setSpawner((command, args, options) => {
    const promptArgument = args.at(-1);
    assert.match(
      promptArgument,
      /^Before doing anything else, read and follow the complete task prompt in this UTF-8 file:\n.+$/,
    );
    deliveredPrompts.push(readFileSync(promptArgument.split("\n").at(-1), "utf8"));
    launches.push({ command, args, options });
    return codexLaunchChild(`codex-job-${launches.length}`);
  });
  _setRunFile(async (file, args, options) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") return ".atelier-git\n";
    if (file === "git" && args[2] === "status") return "";
    if (file === "node" && args[1] === "status") {
      companionCommands.push({ args, options });
      return JSON.stringify({
        job: {
          status: "completed",
          summary: args[2] === "codex-job-1" ? "initial done" : "resumed done",
          threadId: "codex-thread-123",
        },
      });
    }
    if (file === "node" && args[1] === "result") {
      companionCommands.push({ args, options });
      return JSON.stringify({
        job: {
          summary: args[2] === "codex-job-1" ? "initial done" : "resumed done",
          threadId: "codex-thread-123",
        },
      });
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcherBeforeRestart = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
  });
  const { id } = await dispatcherBeforeRestart.dispatch({
    project: "fixture",
    prompt: "initial Codex work",
    lane: "codex",
  });
  await waitForCondition(
    () => dispatcherBeforeRestart.get(id).state === "completed",
    "initial Codex dispatch did not complete",
  );
  const initial = dispatcherBeforeRestart.get(id);
  assert.equal(initial.sessionId, "codex-thread-123");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const replyText = "continue the Codex work";
  const resuming = await dispatcher.reply(id, { text: replyText });
  assert.equal(resuming.state, "resuming");
  await waitForCondition(
    () => dispatcher.get(id).state === "completed",
    "resumed Codex dispatch did not complete",
  );
  const completed = dispatcher.get(id);

  assert.equal(completed.sessionId, "codex-thread-123");
  assert.equal(completed.exitSummary, "resumed done");
  assert.deepEqual(launches.map(({ command, args }) => [command, ...args.slice(0, -1)]), [
    [
      "node",
      "/fixture/codex-companion.mjs",
      "task",
      "--write",
      "--background",
      "--json",
    ],
    [
      "node",
      "/fixture/codex-companion.mjs",
      "task",
      "--write",
      "--resume",
      "--background",
      "--json",
    ],
  ]);
  assert.deepEqual(deliveredPrompts, ["initial Codex work", replyText]);
  assert.ok(launches.every(({ args }) => Buffer.byteLength(args.at(-1)) < 1_024));
  assert.equal(launches[1].options.cwd, initial.worktreePath);
  assert.equal(
    launches[1].options.env.ATELIER_PRIMARY_CHECKOUT,
    launches[0].options.env.ATELIER_PRIMARY_CHECKOUT,
  );
  assert.equal(launches[1].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(
    launches[0].options.env.CLAUDE_PLUGIN_DATA,
    join(stateDir(), "codex-companion"),
  );
  assert.equal(
    launches[1].options.env.CLAUDE_PLUGIN_DATA,
    join(stateDir(), "codex-companion"),
  );
  assert.equal(companionCommands.length, 4);
  assert.ok(companionCommands.every(
    ({ options }) =>
      options.env.CLAUDE_PLUGIN_DATA === join(stateDir(), "codex-companion"),
  ));
  assert.equal(launches[1].options.stdio, undefined);
  const events = dispatcher.getEvents(id);
  const replyIndex = events.findIndex((event) => event.type === "reply");
  assert.equal(events[replyIndex + 1].type, "status");
  assert.equal(events[replyIndex + 1].state, "running");
});

test("Codex review delivers an oversized brief through a file without oversized argv", async (t) => {
  const setup = await fixture(t);
  const receiptPath = join(setup.root, "codex-prompt-receipt.json");
  const companionPath = join(setup.root, "codex-companion-fixture.mjs");
  setup.project.dispatchEnv = { MY_APP_RECEIPT_PATH: receiptPath };
  await writeFile(
    companionPath,
    `import { readFileSync, writeFileSync } from "node:fs";
const instruction = process.argv.at(-1);
const promptPath = instruction.split("\\n").at(-1);
const prompt = readFileSync(promptPath, "utf8");
writeFileSync(process.env.MY_APP_RECEIPT_PATH, JSON.stringify({ instruction, prompt, promptPath }));
process.stdout.write(JSON.stringify({ jobId: "oversized-review-job" }) + "\\n");
`,
  );

  const reviewedHead = "a".repeat(40);
  const oversizedDiff =
    `diff --git a/server.mjs b/server.mjs\n--- a/server.mjs\n+++ b/server.mjs\n` +
    `+${"x".repeat(220 * 1024)}\n+END_OF_OVERSIZED_DIFF`;
  const reviewSummary =
    "Review complete.\nVERDICT: PASS\n[NIT] server.mjs:1 - Oversized brief received.";
  const seeded = await seedDispatch(setup, {
    lane: "codex",
    model: "gpt-5.6-fixture",
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({
      id: seeded.ticketId,
      description: "Audit the complete synthetic diff without truncation.",
      acceptance_criteria: "The final diff sentinel must reach the reviewer.",
    })}\n`,
  );

  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => companionPath);
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        job: { status: "completed", summary: reviewSummary },
      });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({
        job: { status: "completed" },
        storedJob: { result: { rawOutput: reviewSummary } },
      });
    }
    assert.equal(file, "git");
    if (args[2] === "diff" && args[4] === `main...${reviewedHead}`) {
      return oversizedDiff;
    }
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return args[1] === seeded.worktreePath ? `${reviewedHead}\n` : `${"b".repeat(40)}\n`;
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const review = await dispatcher.review(seeded.id);
  const completed = await waitForState(
    dispatcher,
    review.id,
    ["completed", "failed", "prepare_failed"],
  );
  assert.equal(completed.state, "completed", completed.exitSummary);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));

  assert.equal(completed.reviewOf, seeded.id);
  assert.equal(dispatcher.get(seeded.id).review.verdict, "pass");
  assert.ok(Buffer.byteLength(receipt.prompt) > 200 * 1024);
  assert.match(receipt.prompt, /Audit the complete synthetic diff without truncation\./);
  assert.ok(receipt.prompt.includes(oversizedDiff));
  assert.match(receipt.prompt, /END_OF_OVERSIZED_DIFF$/);
  assert.ok(Buffer.byteLength(receipt.instruction) < 1_024);
  assert.equal(dirname(receipt.promptPath), join(setup.state, "dispatches"));
  if (process.platform !== "win32") {
    assert.equal((await stat(receipt.promptPath)).mode & 0o777, 0o600);
  }
});

test("failed Codex jobs surface companion errorMessage and stderr", async (t) => {
  const setup = await fixture(t);
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setSpawner(() => {
    const child = codexLaunchChild("codex-failed");
    child.stderr.write("companion launch diagnostic\n");
    return child;
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") return ".atelier-git\n";
    if (file === "git" && args[2] === "status") return "";
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        job: {
          status: "failed",
          summary: "resume request",
          errorMessage: "No previous Codex task thread was found for this repository.",
        },
      });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({
        job: { status: "failed", summary: "resume request" },
        storedJob: {
          errorMessage: "No previous Codex task thread was found for this repository.",
        },
      });
    }
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "resume Codex work",
    lane: "codex",
  });
  await waitForCondition(
    () => dispatcher.get(id).state === "failed",
    "failed Codex dispatch did not settle",
  );
  const failed = dispatcher.get(id);

  assert.match(
    failed.exitSummary,
    /No previous Codex task thread was found for this repository\./,
  );
  assert.match(failed.exitSummary, /companion launch diagnostic/);
  assert.doesNotMatch(failed.exitSummary, /^exit code 1$/);
});

test("codex lane stays warning-free when its resolved git dir is writable", async (t) => {
  const setup = await fixture(
    t,
    {
      dispatchEnv: {
        CODEX_ENV: "project",
        ANTHROPIC_API_KEY: "must-still-be-removed",
      },
    },
    { dispatchProfile: { dispatchEnv: { DEFAULT_ENV: "inherited" } } },
  );
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  const calls = [];
  let launch;
  let gitDir;
  _setSpawner((command, args, options) => {
    launch = { command, args, options };
    return codexLaunchChild();
  });
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, options });
    if (file === "git" && args[2] === "worktree") {
      const worktreePath = args[6];
      gitDir = join(worktreePath, ".atelier-git");
      await mkdir(gitDir, { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") return ".atelier-git\n";
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "done" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "done" } });
    }
    if (file === "git" && args[2] === "status") return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "codex writable git",
    lane: "codex",
  });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(
    record.warnings.includes(
      "Atelier cannot write the worktree gitdir - automatic Codex commit may fail",
    ),
    false,
  );
  assert.deepEqual(await readdir(gitDir), []);
  assert.ok(
    calls.some(
      ({ file, args }) =>
        file === "git" &&
        args.join("\0") === ["-C", record.worktreePath, "rev-parse", "--git-dir"].join("\0"),
    ),
  );
  assert.equal(launch.command, "node");
  assert.equal(launch.options.env.DEFAULT_ENV, "inherited");
  assert.equal(launch.options.env.CODEX_ENV, undefined);
  assert.equal(launch.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launch.options.env.ATELIER_PRIMARY_CHECKOUT, setup.primary);
  assert.equal(launch.options.stdio, undefined);
});

test("Atelier commits completed Codex changes before worktree verification", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  _setResultFinalizer();
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const order = [];
  const gitCalls = [];
  let finalizerStatusCalls = 0;
  _setSpawner((file, args) => {
    if (file === "node" && args[0] === "/fixture/codex-companion.mjs") {
      order.push("agent");
      return codexLaunchChild();
    }
    order.push("verify");
    return verifyChild();
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "implemented safely" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "implemented safely" } });
    }
    assert.equal(file, "git");
    gitCalls.push(args);
    if (args[2] === "worktree" && args[3] === "remove") return "";
    if (args[2] === "worktree" && args[3] === "add") {
      const target = args[4] === "--detach" ? args[5] : args[6];
      await mkdir(target, { recursive: true });
      if (args[4] === "--detach") return "";
      const gitDir = join(setup.primary, ".git", "worktrees", "fixture-finalizer");
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(target, ".git"), `gitdir: ${gitDir}\n`);
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-common-dir") {
      return `${join(setup.primary, ".git")}\n`;
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") return `${FIXTURE_RESULT_TREE}\n`;
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      return `${args[4].endsWith("^{tree}") ? FIXTURE_RESULT_TREE : FIXTURE_BASE_COMMIT}\n`;
    }
    if (args[2] === "status" && args.includes("--ignored=matching")) {
      finalizerStatusCalls += 1;
      return finalizerStatusCalls === 1
        ? " M server/lib/dispatch.mjs\n?? new-file.mjs\n"
        : "";
    }
    if (args[2] === "status") return "";
    if (args[2] === "diff" && args[3] === "--name-only") return "";
    if (args[2] === "add") {
      order.push("add");
      return "";
    }
    if (args[2] === "commit") {
      order.push("commit");
      return "";
    }
    if (args[2] === "rev-list") return "0\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-42",
    lane: "codex",
  });
  await waitForCondition(
    () => dispatcher.get(id).state === "completed",
    "Codex dispatch did not complete after Atelier committed and verified its work",
  );
  const record = dispatcher.get(id);

  assert.equal(record.verify.state, "passed");
  assert.deepEqual(record.result, {
    commit: FIXTURE_BASE_COMMIT,
    tree: FIXTURE_RESULT_TREE,
    base: FIXTURE_BASE_COMMIT,
    manifest: [],
    workspaceClean: true,
    selfCommitted: false,
    commitCreated: true,
    finalizedAt: record.result.finalizedAt,
    version: 1,
  });
  assert.deepEqual(order, ["agent", "add", "commit", "verify"]);
  assert.deepEqual(gitCalls.find((args) => args[2] === "status"), [
    "-C",
    record.worktreePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
    "-z",
    "--",
    ".",
    ":(exclude).beads",
  ]);
  assert.deepEqual(gitCalls.find((args) => args[2] === "add"), [
    "-C",
    record.worktreePath,
    "add",
    "--all",
    "--",
    ".",
    ":(exclude).beads",
  ]);
  assert.deepEqual(gitCalls.find((args) => args[2] === "commit"), [
    "-C",
    record.worktreePath,
    "commit",
    "-m",
    "chore(dispatch): finalize result [atelier-finalized]",
    "--",
    ".",
    ":(exclude).beads",
  ]);
});

test("a failed Atelier-owned commit fails the dispatch before verification", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  _setResultFinalizer();
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  let verifyRuns = 0;
  _setSpawner((file, args) => {
    if (file === "node" && args[0] === "/fixture/codex-companion.mjs") {
      return codexLaunchChild();
    }
    verifyRuns += 1;
    return verifyChild();
  });
  let finalizerStatusCalls = 0;
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "done" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "done" } });
    }
    assert.equal(file, "git");
    if (args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      const gitDir = join(setup.primary, ".git", "worktrees", "fixture-finalizer");
      await mkdir(gitDir, { recursive: true });
      await writeFile(join(args[6], ".git"), `gitdir: ${gitDir}\n`);
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-common-dir") {
      return `${join(setup.primary, ".git")}\n`;
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "status" && args.includes("--ignored=matching")) {
      finalizerStatusCalls += 1;
      return " M changed.mjs\n";
    }
    if (args[2] === "status") return "";
    if (args[2] === "add") return "";
    if (args[2] === "commit") throw new Error("identity unavailable");
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-43",
    lane: "codex",
  });
  const record = await waitForState(dispatcher, id, ["failed"]);

  assert.equal(record.verify, null);
  assert.equal(verifyRuns, 0);
  assert.equal(
    record.exitSummary,
    "Atelier could not finalize completed Codex result [ERESULT_GIT]: Result finalization git command failed: git " +
      `-C ${record.worktreePath} commit -m chore(dispatch): finalize result [atelier-finalized] -- . :(exclude).beads: identity unavailable`,
  );
});

test("shutdown during deferred result finalization cannot resurrect a failed dispatch", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  stubPreparation();
  _setSpawner(() => successfulChild());
  let announceStarted;
  let releaseFinalizer;
  const started = new Promise((resolvePromise) => {
    announceStarted = resolvePromise;
  });
  const gate = new Promise((resolvePromise) => {
    releaseFinalizer = resolvePromise;
  });
  _setResultFinalizer(async ({ baseCommit, expectedCommonDir }) => {
    assert.equal(expectedCommonDir, join(setup.primary, ".git"));
    announceStarted();
    await gate;
    return {
      resultCommit: FIXTURE_BASE_COMMIT,
      resultTree: FIXTURE_RESULT_TREE,
      baseCommit,
      manifest: [],
      workspaceClean: true,
      commitCreated: false,
    };
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const events = [];
  const removeListener = dispatcher.onEvent((event) => events.push(event));
  t.after(removeListener);
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "finish slowly" });
  await started;

  await dispatcher.shutdown({ graceMs: 0 });
  assert.equal(dispatcher.get(id).state, "failed");
  releaseFinalizer();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const record = dispatcher.get(id);
  assert.equal(record.state, "failed");
  assert.equal(record.result, null);
  assert.equal(record.verify, null);
  assert.deepEqual(
    events
      .filter((event) => event.dispatchId === id && event.type === "status")
      .map((event) => event.state)
      .filter((state) => ["verifying", "completed"].includes(state)),
    [],
  );
});

test("worktree verification stops after a failed step but leaves dispatch completed", async (t) => {
  const setup = await fixture(t, {
    verifyCommands: ["node first", "node fail", "node never"],
  });
  stubPreparation();
  const verifyLaunches = [];
  _setSpawner((command, args) => {
    if (command === "claude") return successfulChild();
    verifyLaunches.push([command, ...args]);
    return verifyChild({ code: args[0] === "fail" ? 2 : 0, stderr: ["verification failed"] });
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "verify failure" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.state, "completed");
  assert.equal(record.verify.state, "failed");
  assert.deepEqual(verifyLaunches, [["node", "first"], ["node", "fail"]]);
  assert.deepEqual(record.verify.steps.map((step) => step.exitCode), [0, 2]);
});

test("successful dispatch records skipped verification when no commands apply", async (t) => {
  const setup = await fixture(t, { verifyCommands: [] });
  stubPreparation();
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "nothing to verify" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.deepEqual(record.verify, { state: "skipped", steps: [] });
  assert.equal(dispatcher.getEvents(id).some((event) => event.state === "verifying"), false);
});

test("stop during verification transitions to stopped", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  stubPreparation();
  const verify = heldChild();
  _setSpawner((command) => (command === "claude" ? successfulChild() : verify));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "stop verify" });
  await waitForState(dispatcher, id, ["verifying"]);

  const record = await dispatcher.stop(id);
  assert.equal(record.state, "stopped");
  assert.equal(record.verify.state, "failed");
  verify.complete();
});

test("merge fast-forwards the captured validated SHA with the exact argv cleanup sequence", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    if (args[2] === "fetch") {
      assert.deepEqual(rawRecord(setup, seeded.id).mergeIntent, {
        resultCommit: "validated-head",
        branchHead: "validated-head",
        mainBranch: "main",
        mainTipBefore: "abcdef1234567890",
        startedAt: rawRecord(setup, seeded.id).mergeIntent.startedAt,
      });
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const record = await dispatcher.merge(seeded.id);

  assert.deepEqual(calls, [
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    [
      "git",
      [
        "-C",
        setup.primary,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "main",
        "validated-head",
        "--",
        ".beads",
      ],
    ],
    ["git", ["-C", setup.primary, "fetch", ".", "validated-head:main"]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    ["git", ["-C", setup.primary, "worktree", "remove", seeded.worktreePath, "--force"]],
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "branch", "-D", seeded.branch]],
  ]);
  assert.equal(record.merged.commit, "abcdef1234567890");
  assert.equal(record.merged.strategy, "ff");
  assert.equal(record.merged.resultCommit, "validated-head");
  assert.equal(record.merged.resultVersion, 1);
  assert.equal(record.merged.mainTipBefore, "abcdef1234567890");
  assert.match(record.merged.mergedAt, /^2026-/);
  assert.equal(rawRecord(setup, seeded.id).mergeIntent, null);
  assert.ok(
    dispatcher.getEvents(seeded.id).some((event) => event.detail === "merged abcdef1"),
  );
});

test("branch cleanup preserves a dispatch branch that advanced after merge", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  let branchReads = 0;
  const calls = [];
  _setRunFile(async (_file, args) => {
    calls.push(args);
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      branchReads += 1;
      return branchReads === 1 ? "validated-head\n" : "advanced-branch-head\n";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-main\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge(seeded.id);

  assert.equal(calls.some((args) => args[2] === "branch" && args[3] === "-D"), false);
  assert.ok(merged.warnings.includes(
    `branch cleanup skipped: ${seeded.branch} advanced from merged validated-head to advanced-branch-head`,
  ));
});

test("merge discards divergent dispatch .beads and preserves the committed main tracker tree", async (t) => {
  const setup = await fixture(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: setup.primary, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Atelier Test"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.email", "atelier@example.test"], { cwd: setup.primary });
  await mkdir(join(setup.primary, ".beads"));
  const mainTracker = '{"id":"fixture-1","status":"in_progress"}\n';
  await writeFile(join(setup.primary, ".beads", "issues.jsonl"), mainTracker);
  execFileSync("git", ["add", ".beads/issues.jsonl"], { cwd: setup.primary });
  execFileSync("git", ["commit", "-m", "tracker: current main state"], {
    cwd: setup.primary,
    stdio: "ignore",
  });

  const seeded = await seedDispatch(setup);
  await mkdir(dirname(seeded.worktreePath), { recursive: true });
  execFileSync(
    "git",
    ["worktree", "add", "-b", seeded.branch, seeded.worktreePath, "main"],
    { cwd: setup.primary, stdio: "ignore" },
  );
  await writeFile(
    join(seeded.worktreePath, ".beads", "issues.jsonl"),
    '{"id":"fixture-1","status":"open"}\n',
  );
  await writeFile(join(seeded.worktreePath, "feature.txt"), "dispatch work\n");
  execFileSync("git", ["add", ".beads/issues.jsonl", "feature.txt"], {
    cwd: seeded.worktreePath,
  });
  execFileSync("git", ["commit", "-m", "dispatch work with stale tracker"], {
    cwd: seeded.worktreePath,
    stdio: "ignore",
  });
  const exactResult = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: seeded.worktreePath,
    encoding: "utf8",
  }).trim();
  const trackerBlob = execFileSync("git", ["rev-parse", `${exactResult}:.beads/issues.jsonl`], {
    cwd: seeded.worktreePath,
    encoding: "utf8",
  }).trim();
  const featureBlob = execFileSync("git", ["rev-parse", `${exactResult}:feature.txt`], {
    cwd: seeded.worktreePath,
    encoding: "utf8",
  }).trim();
  seeded.branchHead = exactResult;
  seeded.result = {
    ...seeded.result,
    commit: exactResult,
    manifest: [
      { path: ".beads/issues.jsonl", blobHash: trackerBlob, tracker: true },
      { path: "feature.txt", blobHash: featureBlob },
    ],
  };
  seeded.attestation = { resultCommit: exactResult, resultVersion: seeded.result.version };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(seeded)}\n`,
  );

  const loggedWarnings = [];
  _setPersistenceLogger({
    error() {},
    warn(message) {
      loggedWarnings.push(message);
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const record = await dispatcher.merge(seeded.id);

  const warning =
    "divergent tracker bytes were discarded from the dispatch branch; main .beads state was preserved";
  const committedTracker = execFileSync(
    "git",
    ["show", `${record.merged.commit}:.beads/issues.jsonl`],
    { cwd: setup.primary, encoding: "utf8" },
  );
  assert.equal(committedTracker, mainTracker);
  const checkoutTracker = await readFile(join(setup.primary, ".beads", "issues.jsonl"), "utf8");
  assert.equal(checkoutTracker, mainTracker, "primary checkout .beads must stay untouched");
  assert.equal(await readFile(join(setup.primary, "feature.txt"), "utf8"), "dispatch work\n");
  assert.ok(record.warnings.includes(warning));
  assert.deepEqual(loggedWarnings, [`Atelier merge ${seeded.id}: ${warning}`]);
  assert.equal(record.merged.strategy, "primary-merge");
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "main"], {
    cwd: setup.primary,
    encoding: "utf8",
  }).trim().split(/\s+/);
  assert.equal(parents.length, 3, "tracker divergence forces a protected merge commit");
});

test("merge returns before post-merge verification and persists a loud failure event", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test", "node never"] });
  setup.registry.defaults.notifyUrl = "https://ntfy.example/main-health";
  const seeded = await seedDispatch(setup);
  const commit = "abcdef1234567890abcdef1234567890abcdef12";
  const gitCalls = [];
  _setRunFile(async (file, args, options = {}) => {
    assert.equal(file, "git");
    gitCalls.push({ args, timeout: options.timeout });
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${commit}\n`;
    return "";
  });
  let completeVerify;
  let markVerifyStarted;
  const failingSubtest = "not ok 41 - atelier-4f4 mid-output post-merge failure";
  const verifyStarted = new Promise((resolvePromise) => {
    markVerifyStarted = resolvePromise;
  });
  const launches = [];
  _setSpawner((file, args, options) => {
    launches.push({ file, args, cwd: options.cwd });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    completeVerify = () => {
      child.stdout.write(`${"A".repeat(1_300)}\n`);
      child.stdout.write(`${failingSubtest}\n`);
      child.stdout.write("  ---\n");
      child.stdout.write("  error: 'post-merge failure detail'\n");
      child.stdout.write("  code: 'ERR_TEST_FAILURE'\n");
      child.stdout.write("  ...\n");
      child.stdout.write(`${"Z".repeat(1_300)}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 2, null);
    };
    markVerifyStarted();
    return child;
  });
  const pushes = [];
  _setPushFetch(async (url, options) => {
    pushes.push({ url, title: options.headers.Title, body: options.body });
    return { ok: true };
  });
  t.after(() => _setPushFetch());
  const errors = [];
  _setPersistenceLogger({ error: (message) => errors.push(message), warn() {} });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge(seeded.id);
  assert.equal(merged.merged.commit, commit);
  assert.equal(merged.postMerge.state, "queued");
  await verifyStarted;
  assert.equal(dispatcher.get(seeded.id).postMerge.state, "running");
  completeVerify();
  await waitForCondition(
    () => dispatcher.get(seeded.id).postMerge.state === "failed",
    "post-merge verification did not record its failure",
  );

  const record = dispatcher.get(seeded.id);
  assert.equal(record.postMerge.commit, commit);
  assert.equal(record.postMerge.testedTree, commit);
  assert.equal(record.postMerge.steps.length, 1);
  assert.equal(record.postMerge.steps[0].exitCode, 2);
  assert.match(record.postMerge.steps[0].tail, new RegExp(failingSubtest));
  assert.match(record.postMerge.steps[0].tail, /post-merge failure detail/);
  assert.match(record.postMerge.evidenceTail, new RegExp(failingSubtest));
  assert.match(record.postMerge.evidenceTail, /post-merge failure detail/);
  assert.ok(record.postMerge.evidenceTail.length <= 800);
  const persisted = await readFile(
    join(setup.state, "dispatches", `${seeded.id}.jsonl`),
    "utf8",
  );
  assert.match(persisted, new RegExp(failingSubtest));
  assert.equal(launches.length, 1, "post-merge verification stops after the failing command");
  assert.equal(launches[0].file, "node");
  assert.deepEqual(launches[0].args, ["--test"]);
  assert.match(launches[0].cwd, /post-merge-worktrees/);
  assert.ok(
    gitCalls.some(({ args, timeout }) =>
      args[2] === "worktree" &&
      args[3] === "add" &&
      args[4] === "--detach" &&
      args[6] === commit &&
      timeout === LONG_GIT_TIMEOUT_MS),
  );
  const failure = dispatcher.getEvents(seeded.id).find(
    (event) => event.type === "post-merge" && event.phase === "end" && event.state === "failed",
  );
  assert.equal(failure.commit, commit);
  assert.match(failure.output, new RegExp(failingSubtest));
  assert.match(failure.output, /post-merge failure detail/);
  assert.match(errors[0], /MAIN IS RED/);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, "https://ntfy.example/main-health");
  assert.equal(pushes[0].title, "Atelier: fixture MAIN IS RED");
  assert.match(pushes[0].body, new RegExp(failingSubtest));
  assert.match(pushes[0].body, /post-merge failure detail/);
});

test("post-merge evidence preserves every long TAP failure identity beyond its context budget", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const seeded = await seedDispatch(setup);
  const commit = "fedcba9876543210fedcba9876543210fedcba98";
  const failureLines = Array.from({ length: 4 }, (_, index) =>
    `not ok ${index + 1} - ${"X".repeat(500)} distinguishing-subtest-${index + 1}`);
  const verifyOutput = ["A".repeat(1_300)];
  for (const [index, failureLine] of failureLines.entries()) {
    verifyOutput.push(
      failureLine,
      "  ---",
      `  error: 'saturated failure detail ${index + 1}'`,
      "  ...",
    );
  }
  verifyOutput.push("Z".repeat(1_300));
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && ["main", "HEAD"].includes(args[3])) return `${commit}\n`;
    return "";
  });
  _setSpawner(() => verifyChild({ stdout: verifyOutput, code: 1 }));
  _setPersistenceLogger({ error() {}, warn() {} });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.merge(seeded.id);
  await waitForCondition(
    () => dispatcher.get(seeded.id).postMerge.state === "failed",
    "saturated post-merge verification did not fail",
  );

  const record = dispatcher.get(seeded.id);
  const failureEvent = dispatcher.getEvents(seeded.id).find(
    (event) => event.type === "post-merge" && event.phase === "end" && event.state === "failed",
  );
  const persisted = await readFile(
    join(setup.state, "dispatches", `${seeded.id}.jsonl`),
    "utf8",
  );
  assert.ok(
    record.postMerge.evidenceTail.length > 800,
    "required failure identities must not be forced back under the context budget",
  );
  for (const [index, failureLine] of failureLines.entries()) {
    assert.ok(record.postMerge.steps[0].tail.includes(failureLine));
    assert.ok(record.postMerge.evidenceTail.includes(failureLine));
    assert.ok(record.postMerge.evidenceTail.includes(`saturated failure detail ${index + 1}`));
    assert.ok(failureEvent.output.includes(failureLine));
    assert.ok(persisted.includes(failureLine));
  }
});

test("dispatcher shutdown terminates a running post-merge verifier within its grace budget", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const seeded = await seedDispatch(setup);
  const commit = "9999999999999999999999999999999999999999";
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${commit}\n`;
    return "";
  });
  let verifier;
  let verifierExit;
  let verifierReady;
  _setSpawner((_file, _args, options) => {
    verifier = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      {
        ...options,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: process.platform === "win32",
      },
    );
    verifierExit = once(verifier, "exit");
    verifierReady = new Promise((resolvePromise) => {
      verifier.stdout.once("data", resolvePromise);
    });
    return verifier;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.merge(seeded.id);
  await waitForCondition(() => Boolean(verifierReady), "post-merge verifier did not launch");
  await verifierReady;
  // The shutdown below is what normally ends this verifier, so an assertion that
  // fails BEFORE it never gets there and the fixture keeps `node --test` alive
  // forever - a red test that reads as a hung suite.
  t.after(async () => {
    if (verifier.exitCode === null && verifier.signalCode === null) {
      if (process.platform === "win32") verifier.kill("SIGKILL");
      else process.kill(-verifier.pid, "SIGKILL");
      await verifierExit.catch(() => {});
    }
  });
  if (process.platform === "linux") {
    // The fence is PERSISTED plumbing (atelier-kaz folded the post-merge pair into
    // FENCING_FIELDS), so it is read off the index, never off the served record -
    // exposedRecord strips it, which the assertion below pins.
    assert.match(
      rawRecord(setup, seeded.id).postMerge.pidIdentity,
      /^linux-proc-start:[0-9a-f-]+:\d+$/,
    );
    assert.equal(rawRecord(setup, seeded.id).postMerge.pid, verifier.pid);
  }
  const exposed = dispatcher.get(seeded.id);
  assert.equal("pid" in exposed.postMerge, false, "the served record leaked the verifier pid");
  assert.equal(
    "pidIdentity" in exposed.postMerge,
    false,
    "the served record leaked the verifier identity",
  );
  const startedAt = Date.now();
  await dispatcher.shutdown({ graceMs: 150 });
  const elapsedMs = Date.now() - startedAt;
  await verifierExit;

  assert.ok(elapsedMs < 400, `shutdown exceeded its grace budget: ${elapsedMs}ms`);
  assert.notEqual(verifier.exitCode === null && verifier.signalCode === null, true);
  assert.equal(dispatcher.get(seeded.id).postMerge.state, "failed");
  assert.match(
    dispatcher.get(seeded.id).postMerge.steps[0].tail,
    /server shutdown interrupted verification/,
  );
});

test("boot recovery terminates a persisted post-merge verifier before failing health closed", async (t) => {
  if (process.platform !== "linux") {
    t.skip("persisted verifier identity uses Linux /proc start time");
    return;
  }
  const setup = await fixture(t);
  const commit = "8888888888888888888888888888888888888888";
  const verifier = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    },
  );
  const verifierExit = once(verifier, "exit");
  t.after(async () => {
    if (verifier.exitCode === null && verifier.signalCode === null) {
      if (process.platform === "win32") verifier.kill("SIGKILL");
      else process.kill(-verifier.pid, "SIGKILL");
      await verifierExit.catch(() => {});
    }
  });
  await once(verifier.stdout, "data");
  const seeded = await seedDispatch(setup, {
    postMerge: {
      state: "running",
      commit,
      mergeCommit: commit,
      pid: verifier.pid,
      pidIdentity: processStartIdentity(verifier.pid),
      steps: [],
      startedAt: "2026-07-22T12:00:00.000Z",
    },
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await dispatcher.shutdown({ graceMs: 150 });
  await verifierExit;

  const recovered = dispatcher.get(seeded.id);
  assert.equal(recovered.postMerge.state, "failed");
  assert.match(recovered.postMerge.error, /server restart interrupted post-merge verification/);
  // Death was CONFIRMED by the post-kill re-probe (atelier-kaz), which is the only
  // thing that may clear the pair - so assert on the persisted record, where the
  // fence actually lives, not on the served copy that strips it either way.
  await waitForConditionOverTime(
    () => rawRecord(setup, seeded.id).postMerge.pid === undefined,
    "the post-merge fence was not cleared after death was confirmed",
  );
  assert.equal(rawRecord(setup, seeded.id).postMerge.pidIdentity, undefined);
  assert.equal(rawRecord(setup, seeded.id).orphanUnresolved, false);
});

test("boot recovery never signals a reused PID with a non-matching verifier identity", async (t) => {
  const setup = await fixture(t);
  const commit = "7777777777777777777777777777777777777777";
  const unrelated = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>console.log('SIGTERM'));console.log('ready');setInterval(()=>{},1000)"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    },
  );
  const unrelatedExit = once(unrelated, "exit");
  let output = "";
  unrelated.stdout.setEncoding("utf8");
  unrelated.stdout.on("data", (chunk) => {
    output += chunk;
  });
  t.after(async () => {
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      if (process.platform === "win32") unrelated.kill("SIGKILL");
      else process.kill(-unrelated.pid, "SIGKILL");
      await unrelatedExit.catch(() => {});
    }
  });
  await once(unrelated.stdout, "data");
  const seeded = await seedDispatch(setup, {
    postMerge: {
      state: "running",
      commit,
      mergeCommit: commit,
      pid: unrelated.pid,
      pidIdentity: "linux-proc-start:00000000-0000-0000-0000-000000000000:1",
      steps: [],
      startedAt: "2026-07-22T12:00:00.000Z",
    },
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 75,
  });
  await dispatcher.shutdown({ graceMs: 75 });

  assert.equal(unrelated.exitCode, null);
  assert.equal(unrelated.signalCode, null);
  assert.doesNotMatch(output, /SIGTERM/);
  assert.equal(dispatcher.get(seeded.id).postMerge.state, "failed");
});

test("exposed records derive gates once while persistence stays projection-free", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    outcome: { kind: "completed", changes: "changed" },
    review: { verdict: "pass" },
    merged: {
      commit: "1111111111111111111111111111111111111111",
      mergedAt: "2026-07-30T08:00:00.000Z",
      strategy: "primary-merge",
    },
    postMerge: null,
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const exposed = dispatcher.get(seeded.id);

  assert.deepEqual(exposed.gates, [
    { gate: "changes", state: "passed" },
    { gate: "verify", state: "passed" },
    { gate: "review", state: "passed" },
    { gate: "merge", state: "passed" },
    { gate: "main", state: "not-run" },
  ]);
  assert.deepEqual(
    dispatcher.list().find((record) => record.id === seeded.id)?.gates,
    exposed.gates,
    "list and get must share the one exposed-record projection",
  );
  assert.equal(
    Object.hasOwn(rawRecord(setup, seeded.id), "gates"),
    false,
    "derived gates must not become stale persisted state",
  );
});

test("main health reports not-run, not passed, when a project has zero post-merge checks", async (t) => {
  const setup = await fixture(t);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.deepEqual(dispatcher.getMainHealth("fixture"), {
    project: "fixture",
    state: "not-run",
    checksTotal: 0,
    unresolvedFailures: [],
    running: [],
  });
});

test("post-merge verification is FIFO and keeps an older failure visible while a newer run is in flight", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const first = await seedDispatch(setup, {
    id: "merge-one",
    branch: "atelier/one",
    worktreePath: join(setup.state, "worktrees", "fixture", "merge-one"),
  });
  const second = {
    ...first,
    id: "merge-two",
    branch: "atelier/two",
    worktreePath: join(setup.state, "worktrees", "fixture", "merge-two"),
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  );
  const commits = [
    "1111111111111111111111111111111111111111",
    "2222222222222222222222222222222222222222",
  ];
  let mainResolution = 0;
  const worktreeCommits = new Map();
  const removed = [];
  _setRunFile(async (file, args) => {
    assert.equal(file, "git");
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") {
      return `${commits[Math.floor(mainResolution++ / 2)]}\n`;
    }
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      worktreeCommits.set(args[5], args[6]);
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return `${worktreeCommits.get(args[1])}\n`;
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      if (args[4].includes("post-merge-worktrees")) removed.push(args[4]);
      return "";
    }
    return "";
  });
  const completions = [];
  _setSpawner(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    completions.push((exitCode) => {
      if (exitCode !== 0) child.stderr.write("older failure sk-ABCDEFGHIJKLMNOP\n");
      child.stdout.end();
      child.stderr.end();
      child.emit("close", exitCode, null);
    });
    return child;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.merge(first.id);
  await waitForCondition(() => completions.length === 1, "first verification did not start");
  await dispatcher.merge(second.id);
  assert.equal(dispatcher.get(second.id).postMerge.state, "queued");
  assert.equal(completions.length, 1, "second verification must remain queued");

  completions[0](2);
  await waitForCondition(() => completions.length === 2, "second verification did not start");
  const inFlightHealth = dispatcher.getMainHealth("fixture");
  assert.deepEqual(inFlightHealth.unresolvedFailures.map((record) => record.id), [first.id]);
  assert.deepEqual(inFlightHealth.running.map((record) => record.id), [second.id]);
  assert.match(inFlightHealth.unresolvedFailures[0].postMerge.evidenceTail, /\[redacted\]/i);

  completions[1](0);
  await waitForCondition(
    () => dispatcher.get(second.id).postMerge.state === "passed",
    "second verification did not pass",
  );
  await waitForCondition(() => removed.length === 2, "verification worktrees were not cleaned");
  assert.equal(dispatcher.getMainHealth("fixture").unresolvedFailures.length, 0);
  assert.equal(dispatcher.get(first.id).postMerge.resolvedBy, commits[1]);
  assert.deepEqual(new Set(removed).size, 2, "failure and success paths each clean their worktree");
});

test("pre-setup post-merge crash is terminally caught without an unhandled rejection", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const seeded = await seedDispatch(setup);
  const commit = "3333333333333333333333333333333333333333";
  let worktreeAdds = 0;
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "worktree" && args[3] === "add") worktreeAdds += 1;
    return "";
  });
  _setPostMergeFileOps({
    mkdirSync() {
      throw new Error("injected pre-setup mkdir crash");
    },
  });
  let unhandled;
  const captureUnhandled = (error) => {
    unhandled = error;
  };
  process.on("unhandledRejection", captureUnhandled);
  t.after(() => process.off("unhandledRejection", captureUnhandled));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge(seeded.id);
  assert.equal(merged.postMerge.state, "queued");
  await waitForCondition(
    () => dispatcher.get(seeded.id).postMerge.state === "failed",
    "terminal catch did not record the injected crash",
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(unhandled, undefined);
  assert.equal(worktreeAdds, 0);
  assert.match(dispatcher.get(seeded.id).postMerge.evidenceTail, /injected pre-setup mkdir crash/);
});

test("post-merge crash after worktree creation still cleans the detached worktree", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const seeded = await seedDispatch(setup);
  const commit = "4444444444444444444444444444444444444444";
  let addedPath;
  let removedPath;
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      addedPath = args[5];
      return "";
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      removedPath = args[4];
      return "";
    }
    return "";
  });
  _setPostMergeHooks({
    afterWorktreeAdded() {
      throw new Error("injected after-add crash");
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.merge(seeded.id);
  await waitForCondition(
    () => dispatcher.get(seeded.id).postMerge.state === "failed",
    "after-add crash did not settle",
  );
  assert.ok(addedPath);
  assert.equal(removedPath, addedPath);
  assert.equal(dispatcher.get(seeded.id).postMerge.worktreePath, undefined);
});

test("post-merge acknowledgement persists across dispatcher restart", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    postMerge: {
      state: "failed",
      commit: "5555555555555555555555555555555555555555",
      evidenceTail: "failure evidence",
      endedAt: "2026-07-22T10:00:00.000Z",
      steps: [],
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const acknowledged = dispatcher.acknowledgePostMergeFailure(seeded.id);
  assert.match(acknowledged.postMerge.acknowledgedAt, /^2026-/);

  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(
    restarted.get(seeded.id).postMerge.acknowledgedAt,
    acknowledged.postMerge.acknowledgedAt,
  );
  assert.deepEqual(restarted.getMainHealth("fixture").unresolvedFailures.map(({ id }) => id), [seeded.id]);
});

test("close-on-merge closes an open ticket and pathspec-commits its tracker write", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    autoCloseOnMerge: true,
    autoCommitTracker: true,
  });
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: seeded.ticketId, status: "open" }])}\n`;
    }
    if (file === "git" && args[2] === "diff") throw new Error("staged changes");
    if (file === "git" && args[2] === "rev-parse" && args[3] === "main") {
      return "abcdef1234567890\n";
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const record = await dispatcher.merge(seeded.id);

  assert.equal(record.mergedClose.ticketId, seeded.ticketId);
  assert.match(record.mergedClose.closedAt, /^2026-/);
  assert.ok(
    calls.some(
      (call) =>
        call.file === "/fixture/br" &&
        call.args.join("\0") ===
          ["close", seeded.ticketId, "-r", "merged abcdef1"].join("\0") &&
        call.cwd === setup.primary,
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.file === "git" &&
        call.args.join("\0") ===
          ["-C", setup.primary, "add", "--", ".beads"].join("\0"),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.file === "git" &&
        call.args.join("\0") ===
          [
            "-C",
            setup.primary,
            "commit",
            "-m",
            `chore(tracker): close ${seeded.ticketId} [atelier]`,
            "--",
            ".beads",
          ].join("\0"),
    ),
  );
  assert.equal(calls.flatMap((call) => call.args).includes("-A"), false);
});

test("close-on-merge tolerates an already-closed ticket", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const seeded = await seedDispatch(setup);
  const closedAt = "2026-07-21T08:02:00.000Z";
  const brCalls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      brCalls.push(args);
      return `${JSON.stringify([{ id: seeded.ticketId, status: "closed", closed_at: closedAt }])}\n`;
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const record = await dispatcher.merge(seeded.id);

  assert.deepEqual(record.mergedClose, { ticketId: seeded.ticketId, closedAt });
  assert.deepEqual(brCalls, [["show", seeded.ticketId, "--json"]]);
});

test("close-on-merge leaves a ticket open while it solely carries redirected review work", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const [carrier] = await seedDispatches(setup, [
    {
      id: "dispatch-carrier",
      ticketId: "fixture-carrier",
      branch: "atelier/fixture-carrier-dispatch-carrier",
      branchHead: "carrier-head",
    },
    {
      id: "dispatch-source",
      ticketId: "fixture-source",
      branch: "atelier/fixture-source-dispatch-source",
      review: {
        rounds: [{
          round: 1,
          verdict: "fail",
          findings: [{
            ref: "round-1:finding-1",
            severity: "major",
            file: "server/lib/dispatch.mjs",
            line: 1,
            summary: "The carrier ticket owns this redirected work.",
          }],
        }],
      },
      reviewDispositions: [{
        ref: "disposition-1",
        findingRef: "round-1:finding-1",
        disposition: "redirected",
        redirectTicket: "fixture-carrier",
        note: "Move the work to its existing carrier ticket.",
        actor: "fixture-architect",
        at: "2026-07-31T00:00:00.000Z",
      }],
    },
  ]);
  let trackerCalls = 0;
  _setRunFile(async (file, args) => {
    if (file !== "git") trackerCalls += 1;
    if (args[2] === "rev-parse" && args[3] === "--verify") return "carrier-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge(carrier.id);

  assert.equal(merged.merged.commit, "merged-head");
  assert.equal(merged.mergedClose, null);
  assert.equal(trackerCalls, 0, "auto-close must not mutate the sole carrier ticket");
  assert.ok(merged.warnings.includes(
    "merge ticket auto-close skipped: fixture-carrier is the sole carrier of 1 redirected review finding",
  ));
  const persisted = rawRecord(setup, carrier.id);
  assert.equal(persisted.mergeFollowUpDebt.ticketCloseSettledAt, null);
  assert.match(
    persisted.mergeFollowUpDebt.ticketCloseLastError,
    /sole carrier of 1 redirected review finding/,
    "an intentionally open carrier remains honest retryable closure debt",
  );
});

test("redirect carriers are project-scoped when ticket ids collide", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const otherPrimary = join(setup.root, "other-primary");
  await mkdir(otherPrimary);
  setup.registry.projects.push(project(otherPrimary, {
    name: "other",
    tracker: "committed",
    autoCloseOnMerge: true,
  }));
  const sharedTicket = "shared-carrier";
  const [fixtureCarrier, otherCarrier, source] = await seedDispatches(setup, [
    {
      id: "dispatch-fixture-carrier",
      project: "fixture",
      ticketId: sharedTicket,
      branch: "atelier/fixture-shared-carrier",
      branchHead: "carrier-head",
    },
    {
      id: "dispatch-other-carrier",
      project: "other",
      ticketId: sharedTicket,
      branch: "atelier/other-shared-carrier",
      branchHead: "carrier-head",
    },
    {
      id: "dispatch-fixture-source",
      project: "fixture",
      ticketId: "fixture-source",
      branch: "atelier/fixture-source",
      review: {
        rounds: [{
          round: 1,
          verdict: "fail",
          findings: [{
            ref: "round-1:finding-1",
            severity: "major",
            file: "server/lib/dispatch.mjs",
            line: 1,
            summary: "Only the fixture project's carrier owns this work.",
          }],
        }],
      },
    },
  ]);
  for (const [path, issues] of [
    [setup.primary, [{ id: sharedTicket, status: "open" }, { id: source.ticketId, status: "open" }]],
    [otherPrimary, [{ id: sharedTicket, status: "open" }]],
  ]) {
    await mkdir(join(path, ".beads"), { recursive: true });
    await writeFile(
      join(path, ".beads", "issues.jsonl"),
      `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
    );
  }
  _setBrResolver(() => "/fixture/br");
  const brCalls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (file === "/fixture/br") {
      brCalls.push({ args, cwd: options.cwd });
      if (args[0] === "show") {
        return `${JSON.stringify([{ id: args[1], status: "open" }])}\n`;
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "carrier-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const redirected = await dispatcher.reviewDisposition(source.id, {
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: sharedTicket,
    note: "Move the work to the fixture project's existing carrier.",
    actor: "fixture-architect",
  });
  assert.deepEqual(
    {
      redirectProject: redirected.reviewDispositions.at(-1).redirectProject,
      redirectTicket: redirected.reviewDispositions.at(-1).redirectTicket,
    },
    { redirectProject: "fixture", redirectTicket: sharedTicket },
  );
  assert.equal(
    rawRecord(setup, source.id).reviewDispositions.at(-1).redirectProject,
    "fixture",
  );

  const unrelated = await dispatcher.merge(otherCarrier.id);
  assert.equal(unrelated.mergedClose.ticketId, sharedTicket);
  assert.ok(brCalls.some(({ args, cwd }) =>
    args[0] === "close" && args[1] === sharedTicket && cwd === otherPrimary));

  const actualCarrier = await dispatcher.merge(fixtureCarrier.id);
  assert.equal(actualCarrier.mergedClose, null);
  assert.ok(actualCarrier.warnings.includes(
    `merge ticket auto-close skipped: ${sharedTicket} is the sole carrier of 1 redirected review finding`,
  ));
  assert.equal(
    brCalls.some(({ cwd }) => cwd === setup.primary),
    false,
    "the actual carrier remains open while the same-id ticket in the unrelated project closes",
  );
});

test("a later lineage acceptance releases redirect-carrier closure debt", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const sharedFinding = {
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 1,
    summary: "The carrier ticket owns this redirected work.",
  };
  const [carrier, source] = await seedDispatches(setup, [
    {
      id: "dispatch-carrier-superseded",
      ticketId: "fixture-carrier-superseded",
      branch: "atelier/fixture-carrier-superseded",
      branchHead: "carrier-head",
    },
    {
      id: "dispatch-source-superseded",
      ticketId: "fixture-source-superseded",
      branch: "atelier/fixture-source-superseded",
      review: {
        rounds: [{
          round: 1,
          verdict: "fail",
          findings: [{ ...sharedFinding, ref: "round-1:finding-1", novelty: "new" }],
        }, {
          round: 2,
          verdict: "fail",
          findings: [{
            ...sharedFinding,
            ref: "round-2:finding-1",
            novelty: "redirect-disputed",
            dispositionRef: "disposition-redirect",
          }],
        }],
      },
      reviewDispositions: [{
        ref: "disposition-redirect",
        findingRef: "round-1:finding-1",
        disposition: "redirected",
        redirectTicket: "fixture-carrier-superseded",
        note: "Move the work to its carrier ticket.",
        actor: "fixture-architect",
        at: "2026-07-31T00:00:00.000Z",
      }],
    },
  ]);
  const brCalls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      brCalls.push(args);
      if (args[0] === "show") {
        return `${JSON.stringify([{ id: carrier.ticketId, status: "open" }])}\n`;
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "carrier-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const initiallyMerged = await dispatcher.merge(carrier.id);
  assert.equal(initiallyMerged.mergedClose, null);
  assert.equal(
    rawRecord(setup, carrier.id).mergeFollowUpDebt.ticketCloseSettledAt,
    null,
  );
  assert.equal(brCalls.length, 0, "the active redirect must keep its carrier open");

  await dispatcher.reviewDisposition(source.id, {
    findingRef: "round-2:finding-1",
    disposition: "accepted",
    note: "The disputed finding is back in the source dispatch scope.",
    actor: "fixture-architect",
  });
  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => Boolean(restarted.get(carrier.id)?.mergedClose),
    "superseded redirect did not release carrier ticket closure",
  );

  const closed = restarted.get(carrier.id);
  const persistedClosed = rawRecord(setup, carrier.id);
  assert.equal(closed.mergedClose.ticketId, carrier.ticketId);
  assert.ok(persistedClosed.mergeFollowUpDebt.ticketCloseSettledAt);
  assert.equal(persistedClosed.mergeFollowUpDebt.ticketCloseLastError, null);
  assert.equal(
    closed.warnings.some((warning) => warning.includes("sole carrier")),
    false,
    "successful retry removes the obsolete carrier warning",
  );
  assert.ok(brCalls.some((args) => args[0] === "close" && args[1] === carrier.ticketId));
});

test("close-on-merge makes no tracker call when a dispatch has no ticket", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const seeded = await seedDispatch(setup, { ticketId: null });
  let brCalls = 0;
  _setRunFile(async (file, args) => {
    if (file !== "git") brCalls += 1;
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const record = await dispatcher.merge(seeded.id);

  assert.equal(record.mergedClose, null);
  assert.equal(brCalls, 0);
});

test("merge falls back to a clean checked-out primary branch", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  const mergeTimeouts = [];
  _setRunFile(async (file, args, options = {}) => {
    calls.push([file, args]);
    if (args[2] === "merge" && args[3] === "--no-ff") mergeTimeouts.push(options.timeout);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args.join("\0") === ["-C", setup.primary, "rev-parse", "--abbrev-ref", "HEAD"].join("\0")) {
      return "main\n";
    }
    if (args[2] === "status") return "";
    if (args[2] === "write-tree") return "candidate-tree\n";
    if (args[2] === "commit-tree") return "merge-commit\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "1234567890abcdef\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const record = await dispatcher.merge(seeded.id);

  assert.deepEqual(calls, [
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    [
      "git",
      [
        "-C",
        setup.primary,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "main",
        "validated-head",
        "--",
        ".beads",
      ],
    ],
    ["git", ["-C", setup.primary, "fetch", ".", "validated-head:main"]],
    ["git", ["-C", setup.primary, "rev-parse", "--abbrev-ref", "HEAD"]],
    ["git", ["-C", setup.primary, "status", "--porcelain"]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    [
      "git",
      [
        "-C",
        setup.primary,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "1234567890abcdef",
        "validated-head",
        "--",
        ".beads",
      ],
    ],
    [
      "git",
      [
        "-C",
        setup.primary,
        "merge",
        "--no-ff",
        "--no-commit",
        "validated-head",
      ],
    ],
    [
      "git",
      [
        "-C",
        setup.primary,
        "restore",
        "--source",
        "1234567890abcdef",
        "--staged",
        "--worktree",
        "--",
        ".beads",
      ],
    ],
    ["git", ["-C", setup.primary, "write-tree"]],
    [
      "git",
      [
        "-C",
        setup.primary,
        "commit-tree",
        "candidate-tree",
        "-p",
        "1234567890abcdef",
        "-p",
        "validated-head",
        "-m",
        `merge: atelier dispatch ${seeded.id} (${seeded.ticketId})`,
      ],
    ],
    [
      "git",
      ["-C", setup.primary, "update-ref", "refs/heads/main", "merge-commit", "1234567890abcdef"],
    ],
    ["git", ["-C", setup.primary, "reset", "--hard", "merge-commit"]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    ["git", ["-C", setup.primary, "worktree", "remove", seeded.worktreePath, "--force"]],
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "branch", "-D", seeded.branch]],
  ]);
  assert.equal(record.merged.strategy, "primary-merge");
  assert.deepEqual(mergeTimeouts, [LONG_GIT_TIMEOUT_MS]);
});

test("merge rejects a dirty checked-out primary branch", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "main\n";
    if (args[2] === "status") return " M README.md\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) =>
      error.status === 409 &&
      error.message === "primary has uncommitted changes on main; commit or stash before merging",
  );
  assert.deepEqual(calls.slice(-2), [
    ["git", ["-C", setup.primary, "rev-parse", "--abbrev-ref", "HEAD"]],
    ["git", ["-C", setup.primary, "status", "--porcelain"]],
  ]);
});

test("merge falls back to a detached worktree when primary is not on main", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "feature\n";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "feedface12345678\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "feedface12345678\n";
    if (args[2] === "write-tree") return "candidate-tree\n";
    if (args[2] === "commit-tree") return "detached-merge-commit\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const record = await dispatcher.merge(seeded.id);
  const mergeWorktree = calls.find(([, args]) => args[2] === "worktree" && args[3] === "add")[1][5];

  assert.ok(mergeWorktree.startsWith(join(setup.state, "merge-worktrees")));
  assert.deepEqual(calls, [
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    [
      "git",
      [
        "-C",
        setup.primary,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "main",
        "validated-head",
        "--",
        ".beads",
      ],
    ],
    ["git", ["-C", setup.primary, "fetch", ".", "validated-head:main"]],
    ["git", ["-C", setup.primary, "rev-parse", "--abbrev-ref", "HEAD"]],
    ["git", ["-C", setup.primary, "worktree", "add", "--detach", mergeWorktree, "main"]],
    ["git", ["-C", mergeWorktree, "rev-parse", "HEAD"]],
    [
      "git",
      [
        "-C",
        mergeWorktree,
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        "feedface12345678",
        "validated-head",
        "--",
        ".beads",
      ],
    ],
    [
      "git",
      [
        "-C",
        mergeWorktree,
        "merge",
        "--no-ff",
        "--no-commit",
        "validated-head",
      ],
    ],
    [
      "git",
      [
        "-C",
        mergeWorktree,
        "restore",
        "--source",
        "feedface12345678",
        "--staged",
        "--worktree",
        "--",
        ".beads",
      ],
    ],
    ["git", ["-C", mergeWorktree, "write-tree"]],
    [
      "git",
      [
        "-C",
        mergeWorktree,
        "commit-tree",
        "candidate-tree",
        "-p",
        "feedface12345678",
        "-p",
        "validated-head",
        "-m",
        `merge: atelier dispatch ${seeded.id} (${seeded.ticketId})`,
      ],
    ],
    [
      "git",
      [
        "-C",
        setup.primary,
        "update-ref",
        "refs/heads/main",
        "detached-merge-commit",
        "feedface12345678",
      ],
    ],
    ["git", ["-C", setup.primary, "worktree", "remove", mergeWorktree, "--force"]],
    ["git", ["-C", setup.primary, "rev-parse", "main"]],
    ["git", ["-C", setup.primary, "worktree", "remove", seeded.worktreePath, "--force"]],
    ["git", ["-C", setup.primary, "rev-parse", "--verify", seeded.branch]],
    ["git", ["-C", setup.primary, "branch", "-D", seeded.branch]],
  ]);
  assert.equal(record.merged.strategy, "detached-worktree");
});

test("detached merge compare-and-swap refuses a concurrent main advance", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  let mainReads = 0;
  _setRunFile(async (_file, args) => {
    calls.push(args);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "feature\n";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "main-before\n";
    if (args[2] === "rev-parse" && args[3] === "main") {
      mainReads += 1;
      return mainReads === 1 ? "main-before\n" : "concurrent-main\n";
    }
    if (args[2] === "write-tree") return "candidate-tree\n";
    if (args[2] === "commit-tree") return "candidate-merge\n";
    if (args[2] === "update-ref") throw new Error("cannot lock ref: is at concurrent-main");
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(dispatcher.merge(seeded.id), (error) => {
    assert.equal(error.status, 409);
    assert.equal(
      error.message,
      "concurrent main advance: expected main at main-before, found concurrent-main; main was not moved",
    );
    return true;
  });
  assert.deepEqual(
    calls.find((args) => args[2] === "update-ref"),
    ["-C", setup.primary, "update-ref", "refs/heads/main", "candidate-merge", "main-before"],
  );
  assert.equal(rawRecord(setup, seeded.id).mergeIntent, null);
  assert.equal(dispatcher.get(seeded.id).merged, null);
});

test("primary merge conflict returns 409 after aborting", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "main\n";
    if (args[2] === "status") return "";
    if (args[2] === "merge" && args[3] === "--no-ff") {
      throw new Error("CONFLICT in README.md");
    }
    if (args[2] === "diff" && args.includes("--diff-filter=U")) return "README.md\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(dispatcher.merge(seeded.id), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /merge conflict: CONFLICT in README\.md/);
    return true;
  });
  assert.ok(
    calls.some(([, args]) =>
      args.join("\0") === ["-C", setup.primary, "merge", "--abort"].join("\0")),
  );
  assert.equal(dispatcher.get(seeded.id).merged, null);
});

test("detached merge conflict returns 409 after aborting and removing its worktree", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "feature\n";
    if (args[2] === "merge" && args[3] === "--no-ff") {
      throw new Error("CONFLICT in README.md");
    }
    if (args[2] === "diff" && args.includes("--diff-filter=U")) return "README.md\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(dispatcher.merge(seeded.id), (error) => {
    assert.equal(error.status, 409);
    assert.match(error.message, /merge conflict: CONFLICT in README\.md/);
    return true;
  });
  const mergeWorktree = calls.find(([, args]) => args[2] === "worktree" && args[3] === "add")[1][5];
  assert.ok(
    calls.some(([, args]) =>
      args.join("\0") === ["-C", mergeWorktree, "merge", "--abort"].join("\0")),
  );
  assert.ok(
    calls.some(([, args]) =>
      args.join("\0") ===
      ["-C", setup.primary, "worktree", "remove", mergeWorktree, "--force"].join("\0")),
  );
  assert.equal(dispatcher.get(seeded.id).merged, null);
});

test("merge gates verification, duplicate merge, and stranded writes unless forced", async (t) => {
  const setup = await fixture(t);
  await seedDispatch(setup, { verify: { state: "failed", steps: [] } });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await assert.rejects(dispatcher.merge("dispatch-merge"), /verify gate failed/);

  const strandedSetup = await fixture(t);
  await seedDispatch(strandedSetup, { strandedBrWrites: true });
  const strandedDispatcher = createDispatcher({
    registry: strandedSetup.registry,
    stateDir: strandedSetup.state,
  });
  await assert.rejects(strandedDispatcher.merge("dispatch-merge"), /stranded br writes gate/);

  const mergedSetup = await fixture(t);
  await seedDispatch(mergedSetup, {
    merged: { commit: "already", mergedAt: "2026-07-21T08:02:00.000Z", strategy: "ff" },
  });
  const mergedDispatcher = createDispatcher({
    registry: mergedSetup.registry,
    stateDir: mergedSetup.state,
  });
  let duplicateGitCalls = 0;
  _setRunFile(async () => {
    duplicateGitCalls += 1;
    return "";
  });
  const duplicate = await mergedDispatcher.merge("dispatch-merge");
  assert.equal(duplicate.merged.commit, "already");
  assert.equal(duplicateGitCalls, 0, "an idempotent duplicate must not execute a second git merge");

  const forcedSetup = await fixture(t);
  await seedDispatch(forcedSetup, {
    verify: { state: "skipped", steps: [] },
    strandedBrWrites: true,
    result: null,
    attestation: null,
  });
  _setRunFile(async (_file, args) =>
    args[2] === "rev-parse" && args[3] === "main" ? "fedcba9876543210\n" : "",
  );
  const eventLog = createEventLog({ stateDir: forcedSetup.state });
  const forcedDispatcher = createDispatcher({
    registry: forcedSetup.registry,
    stateDir: forcedSetup.state,
    eventLog,
  });
  assert.deepEqual(eventLog.read({ kind: "dispatch.merge" }), [], "a gate alone emits no merge");
  await assert.rejects(
    forcedDispatcher.merge("dispatch-merge", { force: true }),
    /forcedBy must be a non-empty string/,
  );
  const forced = await forcedDispatcher.merge("dispatch-merge", {
    force: true,
    actor: "theme:forest-town",
    ...FORCE_AUDIT,
  });
  assert.equal(forced.merged.commit, "fedcba9876543210");
  assert.deepEqual(
    {
      forcedBy: forced.merged.forcedBy,
      reason: forced.merged.reason,
      dispositionRef: forced.merged.dispositionRef,
    },
    FORCE_AUDIT,
  );
  assert.deepEqual(
    forced.gates.find((gate) => gate.gate === "merge"),
    { gate: "merge", state: "passed", ...FORCE_AUDIT },
  );
  const mergeEvents = eventLog.read({ kind: "dispatch.merge" });
  assert.equal(mergeEvents.length, 1);
  assert.equal(mergeEvents[0].dispatchId, "dispatch-merge");
  assert.equal(mergeEvents[0].commit, "fedcba9876543210");
  assert.equal(mergeEvents[0].forced, true);
  assert.equal(
    mergeEvents[0].actor,
    "theme:forest-town",
    "the theme actor survives the merge route-to-event plumbing",
  );
  assert.equal(mergeEvents[0].forcedBy, FORCE_AUDIT.forcedBy);
  assert.equal(mergeEvents[0].reason, FORCE_AUDIT.reason);
  assert.equal(mergeEvents[0].dispositionRef, FORCE_AUDIT.dispositionRef);
});

test("a pending durable merge intent retries reconciliation inline and blocks if still unresolved", async (t) => {
  const setup = await fixture(t);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await seedDispatch(setup, {
    mergeIntent: {
      resultCommit: "validated-head",
      branchHead: "validated-head",
      mainBranch: "main",
      mainTipBefore: "main-before",
      startedAt: "2026-08-17T08:00:00.000Z",
    },
  });
  let commands = 0;
  _setRunFile(async () => {
    commands += 1;
    throw new Error("transient git outage");
  });
  await assert.rejects(
    dispatcher.merge("dispatch-merge"),
    (error) => error.status === 409 && /merge intent is pending recovery/.test(error.message),
  );
  assert.equal(commands, 1);
  assert.equal(dispatcher.get("dispatch-merge").mergeRecoveryPending, true);
});

test("an idempotent duplicate drains durable ticket-close debt without touching git", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const owedAt = "2026-08-17T08:00:00.000Z";
  await seedDispatch(setup, {
    merged: {
      commit: "already-merged",
      mergedAt: owedAt,
      strategy: "ff",
      resultCommit: "validated-head",
      resultVersion: 1,
      mainTipBefore: "main-before",
    },
    mergeFollowUpDebt: {
      ticketCloseOwedAt: owedAt,
      ticketCloseSettledAt: null,
      ticketCloseAttempts: 0,
      ticketCloseLastAttemptAt: null,
      ticketCloseLastError: null,
    },
  });
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: "fixture-1", status: "open" }])}\n`;
    }
    if (file === "/fixture/br" && args[0] === "close") return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const duplicate = await dispatcher.merge("dispatch-merge");

  assert.equal(duplicate.merged.commit, "already-merged");
  assert.deepEqual(calls.map(({ file, args }) => [file, args[0]]), [
    ["/fixture/br", "show"],
    ["/fixture/br", "close"],
  ]);
  assert.ok(rawRecord(setup, "dispatch-merge").mergeFollowUpDebt.ticketCloseSettledAt);
});

test("manifest deletion checks refuse a resurrected file or directory before fast-forward", async (t) => {
  const scenarios = [
    {
      path: "deleted.txt",
      manifest: { path: "deleted.txt", deleted: true },
      tree: "100644 blob resurrected\tdeleted.txt\0",
    },
    {
      path: "deleted-dir",
      manifest: { path: "deleted-dir", deleted: true },
      tree: "040000 tree resurrected-tree\tdeleted-dir\0",
    },
  ];
  for (const scenario of scenarios) {
    const setup = await fixture(t);
    const seeded = await seedDispatch(setup, {
      result: {
        commit: "validated-head",
        tree: FIXTURE_RESULT_TREE,
        base: FIXTURE_BASE_COMMIT,
        manifest: [scenario.manifest],
        version: 1,
      },
    });
    const calls = [];
    _setRunFile(async (file, args) => {
      calls.push({ file, args });
      if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
      if (args[2] === "rev-parse" && args[3] === "main") return "main-before\n";
      if (args.includes("ls-tree")) return scenario.tree;
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    await assert.rejects(dispatcher.merge(seeded.id), (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /^EATELIER_RESULT_VERIFICATION_MISMATCH: /);
      assert.match(error.message, new RegExp(scenario.path));
      return true;
    });
    assert.equal(calls.some(({ args }) => args[2] === "fetch"), false);
    assert.equal(rawRecord(setup, seeded.id).mergeIntent, null);
  }
});

test("merge-commit strategy validates the staged merged tree before committing", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    result: {
      commit: "validated-head",
      tree: FIXTURE_RESULT_TREE,
      base: FIXTURE_BASE_COMMIT,
      manifest: [{ path: "feature.txt", blobHash: "expected-blob" }],
      version: 1,
    },
  });
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "main-head\n";
    if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "main\n";
    if (args[2] === "status") return "";
    if (args[2] === "fetch") throw new Error("non-fast-forward");
    if (args[2] === "write-tree") return "candidate-tree\n";
    if (args.includes("ls-tree")) return "100644 blob expected-blob\tfeature.txt\0";
    if (args[2] === "commit-tree") return "merge-commit\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge(seeded.id);
  const operations = calls.map(({ args }) => args.includes("ls-tree") ? "ls-tree" : args[2]);
  const writeTree = operations.indexOf("write-tree");
  const mergedTreeRead = operations.lastIndexOf("ls-tree");

  assert.equal(merged.merged.strategy, "primary-merge");
  assert.ok(writeTree < mergedTreeRead);
  assert.ok(mergedTreeRead < operations.indexOf("commit-tree"));
  const commitTreeCall = calls.find(({ args }) => args[2] === "commit-tree");
  assert.equal(commitTreeCall.args[3], "candidate-tree");
});

test("merge-commit validation binds result mode and object id before commit-tree", async (t) => {
  const scenarios = [{
    label: "same bytes with executable bit flipped",
    candidate: "100755 blob expected-blob\tfeature.txt\0",
    result: "100644 blob expected-blob\tfeature.txt\0",
  }, {
    label: "divergent blob",
    candidate: "100644 blob divergent-blob\tfeature.txt\0",
    result: "100644 blob expected-blob\tfeature.txt\0",
  }];
  for (const scenario of scenarios) {
    const setup = await fixture(t);
    const seeded = await seedDispatch(setup, {
      result: {
        commit: "validated-head",
        tree: FIXTURE_RESULT_TREE,
        base: FIXTURE_BASE_COMMIT,
        manifest: [{ path: "feature.txt", blobHash: "expected-blob" }],
        version: 1,
      },
    });
    const calls = [];
    _setRunFile(async (_file, args) => {
      calls.push(args);
      if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
      if (args[2] === "rev-parse" && args[3] === "main") return "main-head\n";
      if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "main\n";
      if (args[2] === "status") return "";
      if (args[2] === "fetch") throw new Error("non-fast-forward");
      if (args[2] === "write-tree") return "candidate-tree\n";
      if (args.includes("ls-tree")) return args.includes("candidate-tree")
        ? scenario.candidate
        : scenario.result;
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    await assert.rejects(dispatcher.merge(seeded.id), (error) => {
      assert.equal(error.status, 409, scenario.label);
      assert.match(error.message, /^EATELIER_RESULT_VERIFICATION_MISMATCH: /);
      assert.match(error.message, /feature\.txt/);
      return true;
    });
    assert.equal(calls.some((args) => args[2] === "commit-tree"), false, scenario.label);
  }
});

test("both fast-forward and merge-commit strategies fail closed on a missing manifest", async (t) => {
  for (const trackerDiverged of [false, true]) {
    const setup = await fixture(t);
    const seeded = await seedDispatch(setup, {
      result: {
        commit: "validated-head",
        tree: FIXTURE_RESULT_TREE,
        base: FIXTURE_BASE_COMMIT,
        version: 1,
      },
    });
    const calls = [];
    _setRunFile(async (_file, args) => {
      calls.push(args);
      if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
      if (args[2] === "rev-parse" && args[3] === "main") return "main-head\n";
      if (args[2] === "rev-parse" && args[3] === "--abbrev-ref") return "main\n";
      if (args[2] === "status") return "";
      if (args[2] === "diff-tree") return trackerDiverged ? ".beads/issues.jsonl\n" : "";
      if (args[2] === "write-tree") return "candidate-tree\n";
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    await assert.rejects(dispatcher.merge(seeded.id), (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.message,
        "EATELIER_RESULT_VERIFICATION_MISMATCH: result manifest: missing or malformed",
      );
      return true;
    });
    assert.equal(calls.some((args) => ["fetch", "commit-tree"].includes(args[2])), false);
  }
});

test("boot reconciles landed and unlanded merge intents before follow-up debt drains", async (t) => {
  const landedSetup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const intent = {
    resultCommit: "result-head",
    branchHead: "result-head",
    mainBranch: "main",
    mainTipBefore: "main-before",
    startedAt: "2026-08-17T08:00:00.000Z",
  };
  await seedDispatch(landedSetup, {
    branchHead: "result-head",
    mergeIntent: intent,
  });
  _setBrResolver(() => "/fixture/br");
  let closeCalls = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: "fixture-1", status: "open" }])}\n`;
    }
    if (file === "/fixture/br" && args[0] === "close") {
      closeCalls += 1;
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "current-main\n";
    if (args[2] === "merge-base") return "result-head\n";
    if (args[2] === "rev-list") return "landed-merge\nlater-main\n";
    return "";
  });
  const recoveryEventLog = createEventLog({ stateDir: landedSetup.state });
  const landed = createDispatcher({
    registry: landedSetup.registry,
    stateDir: landedSetup.state,
    eventLog: recoveryEventLog,
  });
  await waitForCondition(
    () => Boolean(landed.get("dispatch-merge")?.merged),
    "boot did not synthesize the landed merge intent",
  );
  await waitForCondition(
    () => Boolean(rawRecord(landedSetup, "dispatch-merge").mergeFollowUpDebt?.ticketCloseSettledAt),
    "boot did not drain synthesized ticket-close debt",
  );

  const recovered = landed.get("dispatch-merge");
  const recoveredRaw = rawRecord(landedSetup, "dispatch-merge");
  assert.equal(recovered.merged.commit, "landed-merge");
  assert.equal(recovered.merged.resultCommit, "result-head");
  assert.equal(recovered.merged.mainTipBefore, "main-before");
  assert.equal(recoveredRaw.mergeIntent, null);
  assert.ok(recoveredRaw.mergeFollowUpDebt.ticketCloseOwedAt);
  assert.ok(recoveredRaw.mergeFollowUpDebt.ticketCloseSettledAt);
  assert.equal(closeCalls, 1);
  assert.ok(
    landed.getEvents("dispatch-merge").some((event) =>
      event.type === "status" && event.recovered === true && event.detail === "merged landed-"),
  );
  const recoveredMergeEvents = recoveryEventLog.read({ kind: "dispatch.merge" });
  assert.equal(recoveredMergeEvents.length, 1);
  assert.equal(recoveredMergeEvents[0].commit, "landed-merge");
  assert.equal(recoveredMergeEvents[0].recovered, true);

  const unlandedSetup = await fixture(t);
  await seedDispatch(unlandedSetup, { mergeIntent: intent });
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return "main-before\n";
    if (args[2] === "merge-base") return "some-other-base\n";
    return "";
  });
  const unlanded = createDispatcher({
    registry: unlandedSetup.registry,
    stateDir: unlandedSetup.state,
  });
  await waitForCondition(
    () => rawRecord(unlandedSetup, "dispatch-merge").mergeIntent === null,
    "boot did not clear an unlanded merge intent",
  );

  assert.equal(unlanded.get("dispatch-merge").merged, null);
  assert.equal(rawRecord(unlandedSetup, "dispatch-merge").mergeIntent, null);
});

test("unlanded intent recovery aborts an interrupted primary merge before clearing intent", async (t) => {
  const setup = await fixture(t);
  const intent = {
    resultCommit: "result-head",
    branchHead: "result-head",
    mainBranch: "main",
    mainTipBefore: "main-before",
    startedAt: "2026-08-17T08:00:00.000Z",
  };
  await seedDispatch(setup, { branchHead: "result-head", mergeIntent: intent });
  const calls = [];
  _setRunFile(async (_file, args) => {
    calls.push(args);
    if (args[2] === "rev-parse" && args[3] === "main") return "main-before\n";
    if (args[2] === "merge-base") return "some-other-base\n";
    if (args[2] === "rev-parse" && args[3] === "-q") return "result-head\n";
    if (args[2] === "merge" && args[3] === "--abort") return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await waitForCondition(
    () => rawRecord(setup, "dispatch-merge").mergeIntent === null,
    "unlanded recovery did not clear its intent",
  );
  const mergeStateProbe = calls.findIndex((args) => args[2] === "rev-parse" && args[3] === "-q");
  const mergeAbort = calls.findIndex((args) => args[2] === "merge" && args[3] === "--abort");
  assert.ok(mergeStateProbe !== -1 && mergeStateProbe < mergeAbort);
  assert.equal(dispatcher.get("dispatch-merge").mergeRecoveryPending, false);
});

test("landing discovery failure leaves merge recovery pending with a public warning", async (t) => {
  const setup = await fixture(t);
  const intent = {
    resultCommit: "result-head",
    branchHead: "result-head",
    mainBranch: "main",
    mainTipBefore: "main-before",
    startedAt: "2026-08-17T08:00:00.000Z",
  };
  await seedDispatch(setup, { branchHead: "result-head", mergeIntent: intent });
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return "later-main\n";
    if (args[2] === "merge-base") return "result-head\n";
    if (args[2] === "rev-list") throw new Error("transient rev-list failure");
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await waitForCondition(
    () => dispatcher.get("dispatch-merge").warnings.some((warning) =>
      warning.includes("could not identify the landing commit")),
    "landing-discovery warning was not surfaced",
  );
  const recovered = dispatcher.get("dispatch-merge");
  assert.equal(recovered.merged, null);
  assert.equal(recovered.mergeRecoveryPending, true);
  assert.deepEqual(rawRecord(setup, "dispatch-merge").mergeIntent, intent);
});

test("a merge request retries a boot-time transient recovery failure without restart", async (t) => {
  const setup = await fixture(t);
  const intent = {
    resultCommit: "result-head",
    branchHead: "result-head",
    mainBranch: "main",
    mainTipBefore: "main-before",
    startedAt: "2026-08-17T08:00:00.000Z",
  };
  await seedDispatch(setup, { branchHead: "result-head", mergeIntent: intent });
  let mainReads = 0;
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") {
      mainReads += 1;
      if (mainReads === 1) throw new Error("boot git unavailable");
      return "result-head\n";
    }
    if (args[2] === "merge-base") return "result-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(() => mainReads === 1, "boot reconciliation did not attempt git");

  const merged = await dispatcher.merge("dispatch-merge");

  assert.equal(merged.merged.commit, "result-head");
  assert.equal(merged.mergeRecoveryPending, false);
  assert.equal(mainReads, 2);
});

test("boot debt draining and a duplicate merge race to one ticket-close attempt", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCloseOnMerge: true });
  const owedAt = "2026-08-17T08:00:00.000Z";
  await seedDispatch(setup, {
    merged: {
      commit: "already-merged",
      mergedAt: owedAt,
      strategy: "ff",
      resultCommit: "validated-head",
      resultVersion: 1,
      mainTipBefore: "main-before",
    },
    mergeFollowUpDebt: {
      ticketCloseOwedAt: owedAt,
      ticketCloseSettledAt: null,
      ticketCloseAttempts: 0,
      ticketCloseLastAttemptAt: null,
      ticketCloseLastError: null,
    },
  });
  _setBrResolver(() => "/fixture/br");
  let closeCalls = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: "fixture-1", status: "open" }])}\n`;
    }
    if (file === "/fixture/br" && args[0] === "close") {
      closeCalls += 1;
      return "";
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const duplicate = await dispatcher.merge("dispatch-merge");
  await settleAsyncWork();

  assert.equal(duplicate.merged.commit, "already-merged");
  assert.equal(closeCalls, 1);
  assert.equal(rawRecord(setup, "dispatch-merge").mergeFollowUpDebt.ticketCloseAttempts, 1);
});

test("a no-op duplicate merge does not append another persisted record", async (t) => {
  const setup = await fixture(t);
  await seedDispatch(setup, {
    merged: { commit: "already", mergedAt: "2026-08-17T08:00:00.000Z", strategy: "ff" },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();
  const indexPath = join(setup.state, "dispatches", "index.jsonl");
  const before = readFileSync(indexPath, "utf8");

  const duplicate = await dispatcher.merge("dispatch-merge");

  assert.equal(duplicate.merged.commit, "already");
  assert.equal(readFileSync(indexPath, "utf8"), before);
});

test("strict unforced merge accepts refuted, redirected, and waived MAJOR dispositions", async (t) => {
  for (const disposition of ["refuted", "redirected", "waived"]) {
    await t.test(disposition, async (t) => {
      const setup = await fixture(t, { requireReview: true, reviewPolicy: "strict" });
      await seedDispatch(setup, {
        branchHead: "reviewed-head",
        review: {
          rounds: [{
            round: 1,
            dispatchId: "review-adjudicated",
            reviewedHead: "reviewed-head",
            verdict: "fail",
            findingCount: 1,
            findings: [{
              ref: "round-1:finding-1",
              severity: "major",
              file: "docs/THEMES.md",
              line: 1,
              summary: "The wording is disputed.",
              novelty: "new",
            }],
          }],
        },
        reviewDispositions: [{
          ref: "disposition-1",
          findingRef: "round-1:finding-1",
          disposition,
          ...(disposition === "redirected" ? { redirectTicket: "atelier-follow-up" } : {}),
          note: `${disposition} by the fixture architect with explicit evidence.`,
          actor: "fixture-architect",
          at: "2026-07-31T00:00:00.000Z",
        }],
      });
      _setRunFile(async (_file, args) => {
        if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
        if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
        return "";
      });
      const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

      const before = dispatcher.get("dispatch-merge");
      assert.equal(
        before.gates.find((gate) => gate.gate === "review").state,
        "passed-with-dispositions",
      );
      const merged = await dispatcher.merge("dispatch-merge");
      assert.equal(merged.merged.commit, "merged-head");
      assert.equal(Object.hasOwn(merged.merged, "forcedBy"), false);
    });
  }
});

test("tiered MINOR/NIT review creates one durable linked follow-up ticket per finding", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  const findings = [
    {
      ref: "round-1:finding-1",
      severity: "minor",
      file: "ui/app.js",
      line: 17,
      summary: "Clarify the policy label.",
      novelty: "new",
    },
    {
      ref: "round-1:finding-2",
      severity: "nit",
      file: "docs/REGISTRY.md",
      line: 81,
      summary: "Tighten the example wording.",
      novelty: "new",
    },
  ];
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-minor-only",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: 2,
        findings,
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const legacySourceComments = [{
    text: "Legacy source comment\nMarker: atelier-review-advisory:dispatch-merge:review-minor-only:round-1:finding-1",
  }];
  const issues = [{ id: "fixture-1", status: "in_progress", comments: legacySourceComments }];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  const trackerCalls = [];
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      trackerCalls.push(args);
      if (args[0] === "create") {
        const id = `fixture-review-${issues.length}`;
        issues.push({
          id,
          title: args[1],
          description: args[args.indexOf("--description") + 1],
          status: "open",
          comments: [],
        });
        await writeIssues();
        return `${id}\n`;
      }
      if (args[0] === "comments" && args[1] === "add") {
        issues.find((issue) => issue.id === args[2]).comments.push({ text: args[3] });
        await writeIssues();
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge("dispatch-merge");
  assert.equal(merged.merged.commit, "merged-head");
  const creates = trackerCalls.filter((args) => args[0] === "create");
  const comments = trackerCalls.filter((args) => args[0] === "comments" && args[1] === "add");
  assert.equal(creates.length, 2);
  assert.equal(comments.length, 2);
  assert.deepEqual(comments.map((args) => args[2]), ["fixture-review-1", "fixture-review-2"]);
  assert.match(comments[0][3], /Review dispatch: review-minor-only/);
  assert.match(comments[0][3], /\[MINOR\] ui\/app\.js:17 - Clarify the policy label\./);
  assert.match(comments[1][3], /\[NIT\] docs\/REGISTRY\.md:81 - Tighten the example wording\./);
  assert.deepEqual(
    issues[0].comments,
    [{
      text: "Legacy source comment\nMarker: atelier-review-advisory:dispatch-merge:review-minor-only:round-1:finding-1",
    }],
    "follow-up work must not be buried on or rediscovered from the source ticket",
  );
  assert.ok(issues.slice(1).every((issue) => issue.description.includes("Source ticket: fixture-1")));
  assert.equal(
    merged.review.current.advisoryFollowUps.every((followUp) => Boolean(followUp.filedAt)),
    true,
  );

  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await restarted.ready;
  assert.equal(
    trackerCalls.filter((args) => args[0] === "comments" && args[1] === "add").length,
    2,
    "restart recovery does not duplicate completed follow-ups",
  );
  assert.equal(
    trackerCalls.filter((args) => args[0] === "create").length,
    2,
    "restart recovery does not duplicate completed follow-up tickets",
  );
});

test("advisory recovery keeps finding-1 distinct from finding-10", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  const findings = Array.from({ length: 10 }, (_, index) => ({
    ref: `round-1:finding-${index + 1}`,
    severity: "minor",
    file: `file-${index + 1}.mjs`,
    line: index + 1,
    summary: `Keep finding ${index + 1} distinct.`,
    novelty: "new",
  }));
  const legacyFindingOneMarker =
    "atelier-review-advisory:dispatch-merge:review-marker-collision:round-1:finding-1";
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-marker-collision",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: findings.length,
        findings,
        advisoryFollowUps: [{
          findingRef: "round-1:finding-1",
          reviewDispatchId: "review-marker-collision",
          marker: legacyFindingOneMarker,
          title: "Review MINOR: Keep finding 1 distinct.",
          description: `Legacy pending follow-up.\nMarker: ${legacyFindingOneMarker}`,
          comment: `Legacy pending link.\nMarker: ${legacyFindingOneMarker}`,
          ticketId: null,
          filedAt: null,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        }],
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const issues = [
    { id: "fixture-1", status: "in_progress", comments: [] },
    {
      id: "fixture-existing-10",
      status: "open",
      description: [
        "Recovered review advisory.",
        "Marker: atelier-review-advisory:dispatch-merge:review-marker-collision:round-1:finding-10:",
      ].join("\n"),
      comments: [],
    },
  ];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  const trackerCalls = [];
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      trackerCalls.push(args);
      if (args[0] === "create") {
        const id = `fixture-created-${issues.length}`;
        issues.push({
          id,
          title: args[1],
          description: args[args.indexOf("--description") + 1],
          status: "open",
          comments: [],
        });
        await writeIssues();
        return `${id}\n`;
      }
      if (args[0] === "comments" && args[1] === "add") {
        issues.find((issue) => issue.id === args[2]).comments.push({ text: args[3] });
        await writeIssues();
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge("dispatch-merge");
  const followUps = new Map(
    merged.review.current.advisoryFollowUps.map((followUp) => [followUp.findingRef, followUp]),
  );
  assert.equal(followUps.get("round-1:finding-10").ticketId, "fixture-existing-10");
  assert.notEqual(followUps.get("round-1:finding-1").ticketId, "fixture-existing-10");
  assert.equal(followUps.get("round-1:finding-1").marker, legacyFindingOneMarker);
  assert.match(followUps.get("round-1:finding-10").marker, /finding-10:$/);
  assert.equal(new Set([...followUps.values()].map(({ ticketId }) => ticketId)).size, 10);
  assert.equal(trackerCalls.filter((args) => args[0] === "create").length, 9);
});

test("tiered review files one lossless ticket per finding beyond the structured cap", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  const findingLines = Array.from({ length: 12 }, (_, index) =>
    index === 0
      ? "[MINOR] file-1.mjs:1 - Validate `reviewPolicy`."
      : `[MINOR] file-${index + 1}.mjs:${index + 1} - exact finding text ${index + 1}`);
  const parsed = _parsedReviewResult({
    state: "completed",
    exitSummary: ["VERDICT: FAIL", ...findingLines].join("\n"),
  });
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-twelve-minors",
        reviewedHead: "reviewed-head",
        ...parsed,
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const issues = [{ id: "fixture-1", status: "in_progress", comments: [] }];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  const trackerCalls = [];
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      trackerCalls.push(args);
      if (args[0] === "create") {
        const id = `fixture-review-${issues.length}`;
        issues.push({
          id,
          title: args[1],
          description: args[args.indexOf("--description") + 1],
          status: "open",
          comments: [],
        });
        await writeIssues();
        return `${id}\n`;
      }
      if (args[0] === "comments" && args[1] === "add") {
        issues.find((issue) => issue.id === args[2]).comments.push({ text: args[3] });
        await writeIssues();
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge("dispatch-merge");
  const creates = trackerCalls.filter((args) => args[0] === "create");
  assert.equal(creates.length, 12, "all twelve findings must receive their own ticket");
  assert.equal(merged.review.current.advisoryFollowUps.length, 12);
  assert.ok(merged.review.current.advisoryFollowUps.every((followUp) => followUp.filedAt));
  const followUpIssues = issues.slice(1);
  assert.equal(followUpIssues.filter((issue) => issue.description.includes("Finding: ")).length, 12);
  assert.equal(parsed.findings[0].summary, "Validate reviewPolicy.");
  assert.ok(followUpIssues[0].description.includes("Validate reviewPolicy."));
  assert.equal(followUpIssues[0].description.includes("`reviewPolicy`"), false);
  const persistedFindingLines = findingLines.map((line) => line.replaceAll("`", ""));
  for (const findingText of persistedFindingLines) {
    assert.ok(
      followUpIssues.some((issue) => issue.description.includes(findingText)),
      `tracker lost finding text: ${findingText}`,
    );
  }
});

test("an oversized advisory finding uses a bounded argv and files its complete text", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  const hugeClaim = `${"abcdefghij".repeat(30_000)}TAIL-SENTINEL`;
  const overflowText = `[MINOR] \`overflow.mjs:99\` - ${hugeClaim}`;
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: { rounds: [{
      round: 1,
      dispatchId: "review-oversized-advisory",
      reviewedHead: "reviewed-head",
      verdict: "fail",
      findingCount: 10,
      findings: Array.from({ length: 10 }, (_, index) => ({
        ...scenarioFinding(index, "minor", "visible-advisory"),
        ref: `round-1:finding-${index + 1}`,
        novelty: "new",
      })),
      findingsTruncated: true,
      findingOverflowCount: 1,
      findingOverflowSeverity: "minor",
      findingOverflowSeverityCounts: { blocker: 0, major: 0, minor: 1, nit: 0 },
      findingOverflowSeverities: ["minor"],
      findingOverflowText: overflowText,
    }] },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const issues = [{ id: "fixture-1", status: "in_progress", comments: [] }];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  const trackerCalls = [];
  let fileBackedCommentPath;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") {
      trackerCalls.push(args);
      if (args[0] === "create") {
        const id = `fixture-review-${issues.length}`;
        issues.push({
          id,
          title: args[1],
          description: args[args.indexOf("--description") + 1],
          status: "open",
          comments: [],
        });
        await writeIssues();
        return `${id}\n`;
      }
      if (args[0] === "comments" && args[1] === "add") {
        const fileIndex = args.indexOf("--file");
        const text = fileIndex === -1
          ? args[3]
          : readFileSync((fileBackedCommentPath = args[fileIndex + 1]), "utf8");
        issues.find((issue) => issue.id === args[2]).comments.push({ text });
        await writeIssues();
      }
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merged = await dispatcher.merge("dispatch-merge");
  const completeComment = issues.slice(1)
    .flatMap((issue) => issue.comments.map((comment) => comment.text))
    .find((comment) => comment.includes("TAIL-SENTINEL"));
  assert.ok(completeComment?.includes(overflowText), "the file-backed comment lost finding bytes");
  assert.ok(fileBackedCommentPath, "the oversized comment did not use br --file");
  assert.equal(existsSync(fileBackedCommentPath), false, "the transient tracker input was retained");
  assert.ok(
    trackerCalls.flat().every((arg) => Buffer.byteLength(String(arg), "utf8") <= 16_000),
    "an advisory tracker call retained an unbounded argv entry",
  );
  assert.ok(
    issues.slice(1).every((issue) => Buffer.byteLength(issue.description, "utf8") <= 16_000),
  );
  assert.equal(merged.review.current.advisoryFollowUps.length, 11);
  assert.ok(merged.review.current.advisoryFollowUps.every((followUp) => followUp.filedAt));
});

test("tiered advisory debt is durable at merge, visible to doctor, and retries in-process", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-transient-advisory",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "minor",
          file: "docs/REGISTRY.md",
          line: 93,
          summary: "Clarify the tiered follow-up obligation.",
          novelty: "new",
        }],
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const issues = [{ id: "fixture-1", status: "in_progress", comments: [] }];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  let createAttempts = 0;
  let commentAttempts = 0;
  let markFirstAttempt;
  const firstAttempt = new Promise((resolvePromise) => {
    markFirstAttempt = resolvePromise;
  });
  let releaseFirstAttempt;
  const firstAttemptBarrier = new Promise((resolvePromise) => {
    releaseFirstAttempt = resolvePromise;
  });
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "create") {
      createAttempts += 1;
      const id = "fixture-review-debt";
      issues.push({
        id,
        title: args[1],
        description: args[args.indexOf("--description") + 1],
        status: "open",
        comments: [],
      });
      await writeIssues();
      return `${id}\n`;
    }
    if (file === "/fixture/br" && args[0] === "comments" && args[1] === "add") {
      commentAttempts += 1;
      if (commentAttempts === 1) {
        markFirstAttempt();
        await firstAttemptBarrier;
        throw new Error("tracker transient failure one");
      }
      if (commentAttempts === 2) throw new Error("tracker transient failure two");
      issues.find((issue) => issue.id === args[2]).comments.push({ text: args[3] });
      await writeIssues();
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merging = dispatcher.merge("dispatch-merge");
  await firstAttempt;
  const persistedWhileOwed = rawRecord(setup, "dispatch-merge");
  assert.equal(persistedWhileOwed.merged.commit, "merged-head");
  assert.equal(persistedWhileOwed.review.current.advisoryFollowUps.length, 1);
  assert.equal(persistedWhileOwed.review.current.advisoryFollowUps[0].filedAt, null);
  assert.equal(
    persistedWhileOwed.review.current.advisoryFollowUps[0].ticketId,
    "fixture-review-debt",
    "the created ticket id must persist before its linking comment is retried",
  );

  const doctorWhileOwed = await dispatcher.gc({ dryRun: true, olderThanDays: 7 });
  assert.deepEqual(
    doctorWhileOwed.advisoryDebts.map((debt) => ({
      dispatchId: debt.dispatchId,
      findingRef: debt.findingRef,
      attempts: debt.attempts,
    })),
    [{
      dispatchId: "dispatch-merge",
      findingRef: "round-1:finding-1",
      attempts: 1,
    }],
  );

  releaseFirstAttempt();
  const merged = await merging;
  assert.equal(createAttempts, 1, "comment retries must not duplicate the follow-up ticket");
  assert.equal(commentAttempts, 3, "the filing did not retry twice in the merge process");
  assert.equal(issues[0].comments.length, 0);
  assert.equal(issues[1].comments.length, 1);
  assert.equal(merged.review.current.advisoryFollowUps[0].attempts, 3);
  assert.ok(merged.review.current.advisoryFollowUps[0].filedAt);
  assert.equal(merged.review.current.advisoryFollowUps[0].lastError, null);

  const doctorAfterDrain = await dispatcher.gc({ dryRun: true, olderThanDays: 7 });
  assert.deepEqual(doctorAfterDrain.advisoryDebts, []);
});

test("advisory retry includes tracker auto-commit and succeeds in-process", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    autoCommitTracker: true,
    requireReview: true,
    reviewPolicy: "tiered",
  });
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-auto-commit-debt",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "minor",
          file: "docs/REGISTRY.md",
          line: 94,
          summary: "Keep the advisory visible until its tracker commit is durable.",
          novelty: "new",
        }],
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  const issuePath = join(setup.primary, ".beads", "issues.jsonl");
  const issues = [{ id: "fixture-1", status: "in_progress", comments: [] }];
  const writeIssues = () => writeFile(
    issuePath,
    `${issues.map((issue) => JSON.stringify(issue)).join("\n")}\n`,
  );
  await writeIssues();
  _setBrResolver(() => "/fixture/br");
  let createCalls = 0;
  let commentCalls = 0;
  let trackerCommitCalls = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "create") {
      createCalls += 1;
      issues.push({
        id: "fixture-review-auto-commit",
        title: args[1],
        description: args[args.indexOf("--description") + 1],
        status: "open",
        comments: [],
      });
      await writeIssues();
      return "fixture-review-auto-commit\n";
    }
    if (file === "/fixture/br" && args[0] === "comments" && args[1] === "add") {
      commentCalls += 1;
      issues.find((issue) => issue.id === args[2]).comments.push({ text: args[3] });
      await writeIssues();
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    if (args[2] === "rev-parse" && args[3] === "--show-toplevel") return `${setup.primary}\n`;
    if (args[2] === "diff" && args[3] === "--cached") {
      throw new Error("staged tracker changes");
    }
    if (args[2] === "commit" && args.at(-1) === ".beads") {
      trackerCommitCalls += 1;
      if (trackerCommitCalls === 1) throw new Error("simulated crash before tracker commit");
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const merged = await dispatcher.merge("dispatch-merge");
  assert.ok(merged.review.current.advisoryFollowUps[0].filedAt);
  assert.equal(merged.review.current.advisoryFollowUps[0].lastError, null);
  assert.equal(merged.review.current.advisoryFollowUps[0].attempts, 2);
  assert.equal((await dispatcher.gc({ dryRun: true })).advisoryDebts.length, 0);
  assert.equal(createCalls, 1, "commit retry must rediscover the existing follow-up ticket");
  assert.equal(commentCalls, 1, "commit retry must not duplicate the existing link comment");
  assert.equal(trackerCommitCalls, 2, "tracker auto-commit must retry before merge returns");
});

test("merge and advisory debt survive a crash at branch cleanup and recover at boot", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    reviewPolicy: "tiered",
  });
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-crash-cut",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "minor",
          file: "docs/REGISTRY.md",
          line: 95,
          summary: "The merge must journal this advisory before cleanup.",
          novelty: "new",
        }],
      }],
    },
  });
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br") throw new Error("tracker offline across crash cut");
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    if (args[2] === "branch" && args[3] === "-D") {
      throw new Error("injected branch cleanup crash");
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge("dispatch-merge"),
    /injected branch cleanup crash/,
  );
  const persisted = rawRecord(setup, "dispatch-merge");
  assert.equal(persisted.merged.commit, "merged-head");
  assert.equal(persisted.review.current.advisoryFollowUps.length, 1);
  assert.equal(persisted.review.current.advisoryFollowUps[0].filedAt, null);

  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await restarted.ready;
  const recovered = restarted.get("dispatch-merge");
  assert.equal(recovered.merged.commit, "merged-head");
  assert.equal(recovered.review.current.advisoryFollowUps.length, 1);
  assert.equal(recovered.review.current.advisoryFollowUps[0].filedAt, null);
  assert.deepEqual(
    (await restarted.gc({ dryRun: true })).advisoryDebts.map((debt) => debt.findingRef),
    ["round-1:finding-1"],
  );
});

test("merge follow-up debt survives a branch-cleanup crash and boot drains verification and closure", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    autoCloseOnMerge: true,
    verifyCommands: ["node --test"],
  });
  await seedDispatch(setup, { branchHead: "branch-head" });
  _setBrResolver(() => "/fixture/br");
  _setSpawner(() => verifyChild({ stdout: ["post-merge verification passed"] }));
  let ticketStatus = "open";
  let ticketCloseCalls = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: "fixture-1", status: ticketStatus }])}\n`;
    }
    if (file === "/fixture/br" && args[0] === "close") {
      ticketCloseCalls += 1;
      ticketStatus = "closed";
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return "branch-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "merged-head\n";
    if (args[2] === "branch" && args[3] === "-D") {
      throw new Error("injected branch cleanup crash");
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge("dispatch-merge"),
    /injected branch cleanup crash/,
  );
  const persisted = rawRecord(setup, "dispatch-merge");
  assert.equal(persisted.merged.commit, "merged-head");
  assert.equal(persisted.postMerge, null);
  assert.ok(persisted.mergeFollowUpDebt.postMergeOwedAt);
  assert.ok(persisted.mergeFollowUpDebt.ticketCloseOwedAt);
  assert.equal(persisted.mergeFollowUpDebt.ticketCloseSettledAt, null);
  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await restarted.ready;
  await waitForCondition(
    () => restarted.get("dispatch-merge").postMerge?.state === "passed",
    "boot recovery did not drain post-merge verification debt",
  );
  const recovered = restarted.get("dispatch-merge");
  assert.equal(recovered.merged.commit, "merged-head");
  assert.equal(recovered.postMerge.state, "passed");
  assert.equal(ticketCloseCalls, 1);
  const recoveredRaw = rawRecord(setup, "dispatch-merge");
  assert.ok(recovered.mergedClose);
  assert.equal(recovered.mergedClose.ticketId, "fixture-1");
  assert.ok(recoveredRaw.mergeFollowUpDebt.postMergeStartedAt);
  assert.ok(recoveredRaw.mergeFollowUpDebt.ticketCloseSettledAt);
  assert.equal(recoveredRaw.mergeFollowUpDebt.ticketCloseAttempts, 1);
  assert.equal(recoveredRaw.mergeFollowUpDebt.ticketCloseLastError, null);
});

test("concurrent merges for one project execute sequentially", async (t) => {
  const setup = await fixture(t);
  const firstHead = "1111111111111111111111111111111111111111";
  const secondHead = "2222222222222222222222222222222222222222";
  const first = await seedDispatch(setup, { branchHead: firstHead });
  const second = {
    ...first,
    id: "dispatch-merge-second",
    branch: "atelier/fixture-2-dispatch-merge-second",
    worktreePath: join(setup.state, "worktrees", "fixture", "dispatch-merge-second"),
    branchHead: secondHead,
    result: { ...first.result, commit: secondHead },
    attestation: { resultCommit: secondHead, resultVersion: first.result.version },
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  );
  const order = [];
  let activeMerges = 0;
  let maximumActiveMerges = 0;
  let releaseFirst;
  const firstGate = new Promise((resolvePromise) => {
    releaseFirst = resolvePromise;
  });
  let markFirstStarted;
  const firstStarted = new Promise((resolvePromise) => {
    markFirstStarted = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      return `${args[4] === first.branch ? firstHead : secondHead}\n`;
    }
    if (args[2] === "fetch") {
      const head = args[4].split(":")[0];
      activeMerges += 1;
      maximumActiveMerges = Math.max(maximumActiveMerges, activeMerges);
      order.push(`start:${head}`);
      if (head === firstHead) {
        markFirstStarted();
        await firstGate;
      }
      order.push(`end:${head}`);
      activeMerges -= 1;
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const firstMerge = dispatcher.merge(first.id);
  await firstStarted;
  const secondMerge = dispatcher.merge(second.id);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.deepEqual(order, [`start:${firstHead}`]);
  releaseFirst();
  await Promise.all([firstMerge, secondMerge]);

  assert.equal(maximumActiveMerges, 1);
  assert.deepEqual(order, [
    `start:${firstHead}`,
    `end:${firstHead}`,
    `start:${secondHead}`,
    `end:${secondHead}`,
  ]);
});

test("merge lifecycle reservation rejects a disposition change after eligibility assessment", async (t) => {
  const setup = await fixture(t, { requireReview: true, reviewPolicy: "strict" });
  await seedDispatch(setup, {
    branchHead: "reviewed-head",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-reserved-merge",
        reviewedHead: "reviewed-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "major",
          file: "server/lib/dispatch.mjs",
          line: 1,
          summary: "The waiver makes the initial merge assessment eligible.",
          novelty: "new",
        }],
      }],
    },
    reviewDispositions: [{
      ref: "disposition-1",
      findingRef: "round-1:finding-1",
      disposition: "waived",
      note: "Explicit waiver for the initial eligibility assessment.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  });
  let markMergeStarted;
  const mergeStarted = new Promise((resolvePromise) => {
    markMergeStarted = resolvePromise;
  });
  let releaseMerge;
  const mergeBarrier = new Promise((resolvePromise) => {
    releaseMerge = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "fetch") {
      markMergeStarted();
      await mergeBarrier;
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const merging = dispatcher.merge("dispatch-merge");
  await mergeStarted;
  await assert.rejects(
    dispatcher.reviewDisposition("dispatch-merge", {
      findingRef: "round-1:finding-1",
      disposition: "accepted",
      note: "This would supersede the waiver and reopen the MAJOR finding.",
      actor: "fixture-architect",
    }),
    (error) => error.status === 409 && /dispatch is being merged/.test(error.message),
  );
  releaseMerge();

  const merged = await merging;
  assert.equal(merged.merged.commit, "merged-head");
  assert.deepEqual(
    merged.reviewDispositions.map(({ ref, disposition }) => ({ ref, disposition })),
    [{ ref: "disposition-1", disposition: "waived" }],
    "the rejected concurrent ruling must not invalidate the assessment that merged",
  );
});

test("concurrent merge and reply reserve exactly one lifecycle winner", async (t) => {
  const mergeSetup = await fixture(t);
  const mergeTarget = await seedDispatch(mergeSetup, {
    sessionId: "merge-race-session",
    branchHead: "merge-race-head",
  });
  await mkdir(mergeTarget.worktreePath, { recursive: true });
  const mergeCalls = [];
  let resumeLaunches = 0;
  _setSpawner(() => {
    resumeLaunches += 1;
    return heldChild();
  });
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    mergeCalls.push(args);
    if (args[2] === "rev-parse" && args[3] === "--verify") return "merge-race-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-race-head\n";
    return "";
  });
  const mergeDispatcher = createDispatcher({
    registry: mergeSetup.registry,
    stateDir: mergeSetup.state,
  });

  const mergePromise = mergeDispatcher.merge(mergeTarget.id);
  await assert.rejects(
    mergeDispatcher.reply(mergeTarget.id, { text: "Resume while merge is reserved." }),
    (error) => error.status === 409 && error.message === "dispatch is being merged",
  );
  const merged = await mergePromise;

  assert.equal(resumeLaunches, 0);
  assert.equal(merged.state, "completed");
  assert.equal(merged.merged.commit, "merged-race-head");
  assert.ok(mergeCalls.some((args) => args[2] === "worktree" && args[3] === "remove"));
  assert.ok(mergeCalls.some((args) => args[2] === "branch" && args[3] === "-D"));

  const replySetup = await fixture(t);
  const replyTarget = await seedDispatch(replySetup, { sessionId: "reply-race-session" });
  await mkdir(replyTarget.worktreePath, { recursive: true });
  const replyCalls = [];
  const replyChild = heldChild();
  _setSpawner(() => replyChild);
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    replyCalls.push(args);
    return "";
  });
  const replyDispatcher = createDispatcher({
    registry: replySetup.registry,
    stateDir: replySetup.state,
  });

  const replyPromise = replyDispatcher.reply(replyTarget.id, {
    text: "Win the lifecycle reservation with a fix round.",
  });
  await assert.rejects(
    replyDispatcher.merge(replyTarget.id),
    (error) => error.status === 409 && error.message === "dispatch is resuming",
  );
  const resumed = await replyPromise;

  assert.equal(resumed.state, "running");
  assert.equal(resumed.merged, null);
  assert.equal(
    replyCalls.some((args) => args[2] === "worktree" && args[3] === "remove"),
    false,
  );
  assert.equal(replyCalls.some((args) => args[2] === "branch" && args[3] === "-D"), false);
  assert.equal(replyDispatcher.get(replyTarget.id).state, "running");
  assert.equal(replyDispatcher.get(replyTarget.id).merged, null);

  replyChild.complete("fix round completed");
  const completed = await waitForState(replyDispatcher, replyTarget.id, ["completed"]);
  assert.equal(completed.merged, null);
});

test("concurrent stop and reply preserve queued stop intent with one lifecycle owner", async (t) => {
  const replySetup = await fixture(t);
  const replyTarget = await seedDispatch(replySetup, { sessionId: "stop-reply-session" });
  await mkdir(replyTarget.worktreePath, { recursive: true });
  const resumedChild = heldChild();
  let resumeLaunches = 0;
  _setSpawner(() => {
    resumeLaunches += 1;
    return resumedChild;
  });
  _setRunFile(async () => "");
  const replyDispatcher = createDispatcher({
    registry: replySetup.registry,
    stateDir: replySetup.state,
  });

  const replyPromise = replyDispatcher.reply(replyTarget.id, {
    text: "Start the fix round before the queued stop.",
  });
  // stop() must queue behind reply()'s lifecycle reservation (reserveStopLifecycle
  // waits out an in-progress "reply" operation) rather than race it - it is
  // called before reply() has resolved, while the resume is still in
  // flight (orphan-reap check, then spawn), and asserted below to still
  // only touch the record AFTER the resume reached "running".
  const stopPromise = replyDispatcher.stop(replyTarget.id);

  const resumed = await replyPromise;
  assert.equal(resumed.state, "running");
  const stopping = await stopPromise;
  assert.equal(resumeLaunches, 1);
  assert.equal(stopping.state, "stopping");
  assert.equal(replyDispatcher.get(replyTarget.id).state, "stopping");

  resumedChild.complete("resume stopped by user");
  const stoppedAfterReply = await waitForState(replyDispatcher, replyTarget.id, ["stopped"]);
  assert.equal(stoppedAfterReply.merged, null);
  assert.equal(stoppedAfterReply.dismissed, null);

  const stopSetup = await fixture(t);
  stubPreparation();
  const runningChild = heldChild();
  _setSpawner(() => runningChild);
  const stopDispatcher = createDispatcher({
    registry: stopSetup.registry,
    stateDir: stopSetup.state,
  });
  const running = await stopDispatcher.dispatch({
    project: "fixture",
    prompt: "Let stop own the lifecycle reservation.",
  });
  await waitForState(stopDispatcher, running.id, ["running"]);

  const winningStop = stopDispatcher.stop(running.id);
  await assert.rejects(
    stopDispatcher.reply(running.id, { text: "This reply must lose cleanly." }),
    (error) => error.status === 409 && error.message === "dispatch is being stopped",
  );
  assert.equal((await winningStop).state, "stopping");
  runningChild.complete("stopped before another reply");
  const stoppedFirst = await waitForState(stopDispatcher, running.id, ["stopped"]);
  assert.equal(stoppedFirst.merged, null);
  assert.equal(stoppedFirst.dismissed, null);
});

test("concurrent merge and dismiss reserve exactly one lifecycle winner", async (t) => {
  const mergeSetup = await fixture(t);
  const mergeTarget = await seedDispatch(mergeSetup, { branchHead: "merge-dismiss-head" });
  await mkdir(mergeTarget.worktreePath, { recursive: true });
  const mergeCalls = [];
  let markMergeStarted;
  const mergeStarted = new Promise((resolvePromise) => {
    markMergeStarted = resolvePromise;
  });
  let releaseMerge;
  const mergeGate = new Promise((resolvePromise) => {
    releaseMerge = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    mergeCalls.push(args);
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      markMergeStarted();
      await mergeGate;
      return "merge-dismiss-head\n";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-dismiss-head\n";
    return "";
  });
  const mergeDispatcher = createDispatcher({
    registry: mergeSetup.registry,
    stateDir: mergeSetup.state,
  });

  const mergePromise = mergeDispatcher.merge(mergeTarget.id);
  await mergeStarted;
  await assert.rejects(
    mergeDispatcher.dismiss(mergeTarget.id),
    (error) => error.status === 409 && error.message === "dispatch is being merged",
  );
  releaseMerge();
  const merged = await mergePromise;

  assert.equal(merged.merged.commit, "merged-dismiss-head");
  assert.equal(merged.dismissed, null);
  assert.equal(
    mergeCalls.filter((args) => args[2] === "worktree" && args[3] === "remove").length,
    1,
  );
  assert.equal(
    mergeCalls.filter((args) => args[2] === "branch" && args[3] === "-D").length,
    1,
  );

  const dismissSetup = await fixture(t);
  const dismissTarget = await seedDispatch(dismissSetup);
  await mkdir(dismissTarget.worktreePath, { recursive: true });
  const dismissCalls = [];
  let markDismissStarted;
  const dismissStarted = new Promise((resolvePromise) => {
    markDismissStarted = resolvePromise;
  });
  let releaseDismiss;
  const dismissGate = new Promise((resolvePromise) => {
    releaseDismiss = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    dismissCalls.push(args);
    if (args[2] === "worktree" && args[3] === "remove") {
      markDismissStarted();
      await dismissGate;
    }
    return "";
  });
  const dismissDispatcher = createDispatcher({
    registry: dismissSetup.registry,
    stateDir: dismissSetup.state,
  });

  const dismissPromise = dismissDispatcher.dismiss(dismissTarget.id);
  await dismissStarted;
  await assert.rejects(
    dismissDispatcher.merge(dismissTarget.id),
    (error) => error.status === 409 && error.message === "dispatch is being dismissed",
  );
  releaseDismiss();
  const dismissed = await dismissPromise;

  assert.ok(dismissed.dismissed);
  assert.equal(dismissed.merged, null);
  assert.equal(
    dismissCalls.filter((args) => args[2] === "worktree" && args[3] === "remove").length,
    1,
  );
  assert.equal(
    dismissCalls.filter((args) => args[2] === "branch" && args[3] === "-D").length,
    1,
  );
});

test("dismiss cleans terminal artifacts, releases the claim, and is idempotent", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const seeded = await seedDispatch(setup);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    calls.push([file, args, options.cwd]);
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const dismissed = await dispatcher.dismiss(seeded.id);
  assert.match(dismissed.dismissed.at, /^2026-/);
  assert.deepEqual(calls, [
    [
      "git",
      ["-C", setup.primary, "worktree", "remove", seeded.worktreePath, "--force"],
      undefined,
    ],
    ["git", ["-C", setup.primary, "branch", "-D", seeded.branch], undefined],
    [
      "/fixture/br",
      ["update", seeded.ticketId, "--status", "open"],
      setup.primary,
    ],
  ]);
  assert.ok(
    dispatcher.getEvents(seeded.id).some(
      (event) => event.type === "status" && event.detail === "dismissed",
    ),
  );
  assert.deepEqual(await dispatcher.dismiss(seeded.id), dismissed);
  assert.equal(calls.length, 3);
});

test("dismiss rejects active work and marks merged history without git cleanup", async (t) => {
  const activeSetup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const activeDispatcher = createDispatcher({
    registry: activeSetup.registry,
    stateDir: activeSetup.state,
  });
  const active = await activeDispatcher.dispatch({ project: "fixture", prompt: "still active" });
  await waitForState(activeDispatcher, active.id, ["running"]);
  await assert.rejects(
    activeDispatcher.dismiss(active.id),
    (error) => error.status === 409 && /only terminal/.test(error.message),
  );
  child.complete();
  await waitForState(activeDispatcher, active.id, ["completed"]);

  const mergedSetup = await fixture(t);
  const seeded = await seedDispatch(mergedSetup, {
    merged: { commit: "abcdef", mergedAt: "2026-07-21T08:02:00.000Z", strategy: "ff" },
  });
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    return "";
  });
  const mergedDispatcher = createDispatcher({
    registry: mergedSetup.registry,
    stateDir: mergedSetup.state,
  });
  const dismissed = await mergedDispatcher.dismiss(seeded.id);
  assert.ok(dismissed.dismissed);
  assert.deepEqual(calls, []);
});

test("stop during preparing attempts best-effort artifact cleanup", async (t) => {
  const setup = await fixture(t);
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let finishWorktreeAdd;
  const addPending = new Promise((resolvePromise) => {
    finishWorktreeAdd = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "worktree" && args[3] === "add") return addPending;
    if (args[2] === "worktree" && args[3] === "remove") throw new Error("device busy");
    if (args[2] === "branch" && args[3] === "-D") throw new Error("branch locked");
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "stop preparing" });
  while (!dispatcher.get(id)?.worktreePath) await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const stopped = await dispatcher.stop(id);
  assert.equal(stopped.state, "stopped");
  assert.ok(stopped.warnings.includes("worktree cleanup failed: device busy"));
  assert.ok(stopped.warnings.includes("branch cleanup failed: branch locked"));
  finishWorktreeAdd("");
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(dispatcher.get(id).state, "stopped");
});

test("gc selects only old terminal non-merged non-dismissed records", async (t) => {
  const setup = await fixture(t);
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const base = {
    project: "fixture",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: null,
    worktreePath: null,
    startedAt: "2026-07-01T00:00:00.000Z",
    endedAt: "2026-07-01T01:00:00.000Z",
    turns: 0,
    costUSD: 0,
    exitSummary: "done",
    strandedBrWrites: false,
    verify: { state: "passed", steps: [] },
    merged: null,
    dismissed: null,
    warnings: [],
  };
  const records = [
    { ...base, id: "old" },
    { ...base, id: "recent", endedAt: "2026-07-20T01:00:00.000Z" },
    {
      ...base,
      id: "merged",
      merged: { commit: "abc", mergedAt: "2026-07-02T00:00:00.000Z", strategy: "ff" },
    },
    { ...base, id: "dismissed", dismissed: { at: "2026-07-02T00:00:00.000Z" } },
  ];
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  _setRunFile(async (_file, args) => (args[2] === "worktree" && args[3] === "list" ? "" : ""));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.gc({
    olderThanDays: 7,
    dryRun: true,
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.deepEqual(result.dismissed, ["old"]);
  assert.deepEqual(result.orphans, []);
  assert.deepEqual(result.errors, []);
});

test("gc sweeps registered and stale orphan worktrees through stubbed fs and git layers", async (t) => {
  const setup = await fixture(t);
  const known = join(setup.state, "worktrees", "fixture", "known");
  const registered = join(setup.state, "worktrees", "fixture", "registered-orphan");
  const stale = join(setup.state, "worktrees", "fixture", "stale-orphan");
  const stalePostMerge = join(
    setup.state,
    "post-merge-worktrees",
    "fixture",
    "stale-post-merge",
  );
  const staleVerify = join(
    setup.state,
    "verify-worktrees",
    "fixture",
    "crash-orphaned-verify",
  );
  await seedDispatch(setup, { worktreePath: known, dismissed: { at: "2026-07-02T00:00:00.000Z" } });
  const removedDirectories = [];
  const dirent = (name) => ({ name, isDirectory: () => true });
  _setGcFileOps({
    readdirSync(path) {
      if (path === join(setup.state, "worktrees")) return [dirent("fixture")];
      if (path === join(setup.state, "worktrees", "fixture")) {
        return [dirent("known"), dirent("registered-orphan"), dirent("stale-orphan")];
      }
      if (path === join(setup.state, "post-merge-worktrees")) return [dirent("fixture")];
      if (path === join(setup.state, "post-merge-worktrees", "fixture")) {
        return [dirent("stale-post-merge")];
      }
      if (path === join(setup.state, "verify-worktrees")) return [dirent("fixture")];
      if (path === join(setup.state, "verify-worktrees", "fixture")) {
        return [dirent("crash-orphaned-verify")];
      }
      if (path === join(setup.state, "merge-worktrees")) return [];
      throw new Error(`unexpected readdir: ${path}`);
    },
    rmSync(path, options) {
      removedDirectories.push([path, options]);
    },
  });
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push([file, args]);
    if (args[2] === "worktree" && args[3] === "list") {
      return `worktree ${setup.primary}\n\nworktree ${registered}\n`;
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.gc({
    olderThanDays: 7,
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.deepEqual(result.orphans, [registered, stale, staleVerify, stalePostMerge]);
  assert.deepEqual(result.errors, []);
  assert.ok(
    calls.some(([, args]) =>
      args.join("\0") ===
      ["-C", setup.primary, "worktree", "remove", registered, "--force"].join("\0")),
  );
  assert.ok(
    calls.some(([, args]) =>
      args.join("\0") === ["-C", setup.primary, "worktree", "prune"].join("\0")),
  );
  assert.deepEqual(removedDirectories, [
    [stale, { recursive: true, force: true }],
    [staleVerify, { recursive: true, force: true }],
    [stalePostMerge, { recursive: true, force: true }],
  ]);
});

for (const readyMetadata of [
  {
    name: "a string-form closed external prerequisite",
    dependency: "external-closed",
    externalIssue: { id: "external-closed", status: "closed", dependencies: [] },
  },
  {
    name: "stale-open external dependency metadata",
    dependency: { depends_on_id: "external-closed", status: "open" },
    externalIssue: { id: "external-closed", status: "closed", dependencies: [] },
  },
]) {
  test(`convoy trusts br ready over ${readyMetadata.name}`, async (t) => {
    const setup = await fixture(t, { tracker: "committed" });
    const first = {
      id: "fixture-1",
      status: "open",
      dependencies: [readyMetadata.dependency],
    };
    const second = { id: "fixture-2", status: "open", dependencies: [] };
    const issues = [first, second, readyMetadata.externalIssue];
    stubConvoyRuntime(setup, issues, [], { readyIssues: [first, second] });
    _setSpawner(() => successfulChild());
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    const convoy = await dispatcher.createConvoy("fixture", {
      ticketIds: [first.id, second.id],
    });
    const completed = await waitForState(
      dispatcher,
      convoy.currentDispatchId,
      ["completed", "failed", "prepare_failed"],
    );

    assert.equal(completed.state, "completed", completed.exitSummary);
    assert.equal(completed.ticketId, first.id);
  });
}

test("convoy accepts a not-ready dependent on an earlier convoy member", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-prerequisite", status: "open", dependencies: [] },
    {
      id: "fixture-dependent",
      status: "open",
      dependencies: [{ depends_on_id: "fixture-prerequisite", status: "open" }],
    },
  ];
  stubConvoyRuntime(setup, issues, [], { readyIssues: [issues[0]] });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const convoy = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-prerequisite", "fixture-dependent"],
  });

  assert.deepEqual(convoy.ticketIds, ["fixture-prerequisite", "fixture-dependent"]);
  const first = await waitForState(dispatcher, convoy.currentDispatchId, ["completed"]);
  assert.equal(first.ticketId, "fixture-prerequisite");
  await dispatcher.merge(first.id, { force: true, ...FORCE_AUDIT });
  const advanced = await waitForConvoy(
    dispatcher,
    convoy.id,
    (candidate) => candidate.cursor === 1 && Boolean(candidate.currentDispatchId),
  );
  const second = await waitForState(dispatcher, advanced.currentDispatchId, ["completed"]);
  assert.equal(
    second.ticketId,
    "fixture-dependent",
    "an earlier merged convoy dependency is the one readiness exception",
  );
});

test("convoy rejects a dependent ordered before its prerequisite", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-0", status: "open", dependencies: [] },
    {
      id: "fixture-1",
      status: "open",
      dependencies: [{ depends_on_id: "fixture-2", status: "open" }],
    },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  const calls = stubConvoyRuntime(setup, issues, [], {
    readyIssues: [issues[0]],
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.createConvoy("fixture", {
      ticketIds: ["fixture-0", "fixture-1", "fixture-2"],
    }),
    (error) =>
      error.status === 409 &&
      /fixture-1 depends on later convoy member fixture-2/.test(error.message),
  );
  assert.equal(dispatcher.list().length, 0);
  assert.equal(calls.some((call) => call.args[0] === "update"), false);
});

test("convoy rejects a Atelier-parked later member even when br ready returns it", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  const parkedAttempt = {
    attempts: 2,
    lastFailureAt: "2026-07-30T08:01:00.000Z",
    lastFailureKind: "agent_error",
    lastDispatchId: "dispatch-parked",
    parked: true,
    parkedAt: "2026-07-30T08:01:00.000Z",
    parkReason: "agent_error after 2 failed attempts",
  };
  await mkdir(setup.state, { recursive: true });
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: false,
        ticketAttempts: { "fixture-2": parkedAttempt },
      },
    })}\n`,
  );
  const calls = stubConvoyRuntime(setup, issues);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.createConvoy("fixture", { ticketIds: ["fixture-1", "fixture-2"] }),
    (error) => error.status === 409 && /fixture-2 is parked/.test(error.message),
  );
  assert.equal(dispatcher.list().length, 0);
  assert.equal(calls.some((call) => call.args[0] === "update"), false);
});

for (const invalidMember of [
  {
    name: "claimed",
    issue: { id: "fixture-2", status: "open", assignee: "other-agent", dependencies: [] },
    message: /fixture-2 is claimed/,
  },
  {
    name: "closed",
    issue: { id: "fixture-2", status: "closed", dependencies: [] },
    message: /fixture-2 is closed/,
  },
]) {
  test(`convoy rejects a ${invalidMember.name} later member`, async (t) => {
    const setup = await fixture(t, { tracker: "committed" });
    const issues = [
      { id: "fixture-1", status: "open", dependencies: [] },
      invalidMember.issue,
    ];
    const calls = stubConvoyRuntime(setup, issues, [], { readyIssues: [issues[0]] });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    await assert.rejects(
      dispatcher.createConvoy("fixture", { ticketIds: ["fixture-1", "fixture-2"] }),
      (error) => error.status === 409 && invalidMember.message.test(error.message),
    );
    assert.equal(dispatcher.list().length, 0);
    assert.equal(calls.some((call) => call.args[0] === "update"), false);
  });
}

test("convoy persists members and advances only after merge", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  stubConvoyRuntime(setup, issues);
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  assert.equal(created.state, "running");
  assert.equal(created.cursor, 0);
  const first = await waitForState(dispatcher, created.currentDispatchId, ["completed"]);
  assert.equal(first.batchId, created.id);
  assert.equal(first.batchKind, "convoy");
  assert.equal(first.batchSeq, 1);
  assert.equal(dispatcher.list().some((record) => record.ticketId === "fixture-2"), false);

  await dispatcher.merge(first.id, { force: true, ...FORCE_AUDIT });
  const advanced = await waitForConvoy(
    dispatcher,
    created.id,
    (convoy) => convoy.cursor === 1 && Boolean(convoy.currentDispatchId),
  );
  const second = await waitForState(dispatcher, advanced.currentDispatchId, ["completed"]);
  assert.equal(second.ticketId, "fixture-2");
  assert.equal(second.batchSeq, 2);
  assert.deepEqual(
    JSON.parse(await readFile(join(setup.state, "convoys.json"), "utf8"))[0].ticketIds,
    ["fixture-1", "fixture-2"],
  );
});

test("convoy advancement refuses a later member parked while awaiting merge", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  stubConvoyRuntime(setup, issues);
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  const first = await waitForState(dispatcher, created.currentDispatchId, ["completed"]);

  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: false,
        ticketAttempts: {
          "fixture-2": {
            attempts: 2,
            lastFailureAt: "2026-07-31T08:01:00.000Z",
            lastFailureKind: "agent_error",
            lastDispatchId: "dispatch-parked",
            parked: true,
            parkedAt: "2026-07-31T08:01:00.000Z",
            parkReason: "agent_error after 2 failed attempts",
          },
        },
      },
    })}\n`,
  );

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await successor.merge(first.id, { force: true, ...FORCE_AUDIT });
  const paused = await waitForConvoy(
    successor,
    created.id,
    (convoy) => convoy.cursor === 1 && convoy.state === "paused",
  );

  assert.equal(paused.currentDispatchId, null);
  assert.match(paused.reason, /could not dispatch fixture-2: Ticket fixture-2 is parked/);
  assert.equal(
    successor.list().some((record) => record.ticketId === "fixture-2"),
    false,
  );
});

test("convoy advancement pauses when member two becomes deferred while member one runs", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  const readyIssues = [...issues];
  const calls = stubConvoyRuntime(setup, issues, [], { readyIssues });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  const first = await waitForState(dispatcher, created.currentDispatchId, ["completed"]);

  issues[1].defer_until = "2099-01-01T00:00:00.000Z";
  readyIssues.splice(0, readyIssues.length, issues[0]);
  await dispatcher.merge(first.id, { force: true, ...FORCE_AUDIT });
  const paused = await waitForConvoy(
    dispatcher,
    created.id,
    (convoy) => convoy.cursor === 1 && convoy.state === "paused",
  );

  assert.equal(paused.currentDispatchId, null);
  assert.match(
    paused.reason,
    /could not dispatch fixture-2: Ticket fixture-2 is not ready/,
  );
  assert.equal(
    dispatcher.list().some((record) => record.ticketId === "fixture-2"),
    false,
  );
  assert.ok(
    calls.filter((call) => call.file === "/fixture/br" && call.args[0] === "ready").length >= 3,
    "creation, member one, and member two each consult current tracker readiness",
  );
});

test("convoy rejects a not-ready external dependency despite stale closed metadata", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    {
      id: "fixture-2",
      status: "open",
      dependencies: [
        { depends_on_id: "fixture-1", status: "open" },
        { depends_on_id: "external-prerequisite", status: "closed" },
      ],
    },
  ];
  const readyIssues = [issues[0]];
  stubConvoyRuntime(setup, issues, [], { readyIssues });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.createConvoy("fixture", {
      ticketIds: ["fixture-1", "fixture-2"],
    }),
    (error) =>
      error.status === 409 &&
      /fixture-2 has unsatisfied dependency external-prerequisite/.test(error.message),
  );

  assert.deepEqual(dispatcher.list(), []);
});

test("convoy pauses on member failure and resume re-dispatches the cursor", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  stubConvoyRuntime(setup, issues);
  let run = 0;
  _setSpawner(() => {
    run += 1;
    return run === 1 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  const paused = await waitForConvoy(
    dispatcher,
    created.id,
    (convoy) => convoy.state === "paused",
  );
  assert.match(paused.reason, /dispatch .* failed/);
  const failedId = paused.currentDispatchId;

  const resumed = await dispatcher.resumeConvoy(created.id);
  assert.equal(resumed.state, "running");
  assert.notEqual(resumed.currentDispatchId, failedId);
  const completed = await waitForState(dispatcher, resumed.currentDispatchId, ["completed"]);
  assert.equal(completed.ticketId, "fixture-1");
  assert.equal(completed.batchSeq, 1);
});

test("a convoy member that lands needs_input pauses the batch for a human answer", async (t) => {
  // needs_input is a convoy failure state: only a merge advances the cursor, and a
  // dispatch waiting on an answer has produced nothing to merge. Marching on to
  // the next ticket would bury the question.
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  // The member produces nothing: an empty change probe, and a closing question.
  stubConvoyRuntime(setup, issues, [], { changed: "" });
  _setSpawner(() => claudeResultChild({ summary: "Should member one use the shared helper?" }));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  const paused = await waitForConvoy(
    dispatcher,
    created.id,
    (convoy) => convoy.state === "paused",
  );

  assert.match(paused.reason, /dispatch .* needs_input/);
  const member = dispatcher.get(paused.currentDispatchId);
  assert.equal(member.state, "needs_input");
  assert.equal(member.ticketId, "fixture-1");
  assert.equal(member.outcome.question, "Should member one use the shared helper?");
  // The cursor did not advance: no dispatch exists for the second ticket.
  assert.deepEqual(
    dispatcher.list().filter((record) => record.ticketId === "fixture-2"),
    [],
  );
});

test("convoy pause persistence failure keeps the failed transition and surfaces warnings", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  stubConvoyRuntime(setup, issues);
  _setSpawner(() => failedChild());
  let failedPauseWrite = false;
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, encoding) {
      if (
        !failedPauseWrite &&
        path.endsWith("convoys.json") &&
        contents.includes('"state": "paused"')
      ) {
        failedPauseWrite = true;
        throw Object.assign(new Error("fixture convoy ENOSPC"), { code: "ENOSPC" });
      }
      writeFileSync(path, contents, encoding);
    },
  });
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const created = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  const paused = await waitForConvoy(
    dispatcher,
    created.id,
    (convoy) => convoy.state === "paused",
  );
  const failed = await waitForState(dispatcher, paused.currentDispatchId, ["failed"]);

  assert.equal(failedPauseWrite, true);
  assert.equal(paused.state, "paused");
  assert.ok(paused.warnings.some((warning) => warning.startsWith("PERSISTENCE DEGRADED:")));
  assert.ok(failed.warnings.some((warning) => warning.startsWith("PERSISTENCE DEGRADED:")));
  assert.equal(logLines.length, 1);
  assert.match(logLines[0], /persistence write failed for convoys \(convoy\)/);
});

test("convoy boot re-derives a merged cursor and dispatches the next member", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  const batchId = "convoy-boot";
  await seedDispatch(setup, {
    id: "merged-member",
    ticketId: "fixture-1",
    batchId,
    batchKind: "convoy",
    batchSeq: 1,
    merged: { commit: "abc", mergedAt: "2026-07-21T08:02:00.000Z", strategy: "ff" },
  });
  await writeFile(
    join(setup.state, "convoys.json"),
    `${JSON.stringify([{
      id: batchId,
      project: "fixture",
      ticketIds: ["fixture-1", "fixture-2"],
      cursor: 0,
      state: "running",
      currentDispatchId: "merged-member",
      reason: null,
      createdAt: "2026-07-21T08:00:00.000Z",
      updatedAt: "2026-07-21T08:02:00.000Z",
    }])}\n`,
  );
  stubConvoyRuntime(setup, issues);
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const recovered = await waitForConvoy(
    dispatcher,
    batchId,
    (convoy) => convoy.cursor === 1 && Boolean(convoy.currentDispatchId),
  );
  const next = await waitForState(dispatcher, recovered.currentDispatchId, ["completed"]);
  assert.equal(next.ticketId, "fixture-2");
  assert.equal(next.batchSeq, 2);
});

test("convoy waits at the global cap and retries on the next boot-style drain", async (t) => {
  const setup = await fixture(t, { tracker: "committed" }, { concurrentDispatchCap: 1 });
  const issues = [
    { id: "fixture-1", status: "open", dependencies: [] },
    { id: "fixture-2", status: "open", dependencies: [] },
  ];
  stubConvoyRuntime(setup, issues);
  const held = heldChild();
  let run = 0;
  _setSpawner(() => {
    run += 1;
    return run === 1 ? held : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const active = await dispatcher.dispatch({ project: "fixture", prompt: "occupy the cap" });
  await waitForState(dispatcher, active.id, ["running"]);

  const convoy = await dispatcher.createConvoy("fixture", {
    ticketIds: ["fixture-1", "fixture-2"],
  });
  assert.equal(convoy.currentDispatchId, null);
  assert.match(convoy.reason, /waiting for dispatch capacity/);
  assert.equal(dispatcher.list().length, 1);

  held.complete();
  await waitForState(dispatcher, active.id, ["completed"]);
  await dispatcher.drainConvoysOnce();
  const retried = dispatcher.listConvoys().find((candidate) => candidate.id === convoy.id);
  assert.ok(retried.currentDispatchId);
  assert.equal(dispatcher.get(retried.currentDispatchId).batchKind, "convoy");
  await waitForState(dispatcher, retried.currentDispatchId, ["completed"]);
});

test("bake-off creates two sibling records with one claim and bypasses only its own dup guard", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const calls = stubBakeoffRuntime(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "prompt only", lanes: ["claude", "codex"] }),
    (error) => error.status === 400 && /ticketId is required/.test(error.message),
  );
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", ticketId: "fixture-1", lanes: ["claude", "claude"] }),
    (error) => error.status === 400 && /must be distinct/.test(error.message),
  );

  const result = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-1",
    lanes: ["claude", "codex"],
  });
  assert.equal(result.ids.length, 2);
  const records = await Promise.all(
    result.ids.map((id) => waitForState(dispatcher, id, ["completed"])),
  );
  assert.deepEqual(records.map((record) => record.lane), ["claude", "codex"]);
  assert.deepEqual(records.map((record) => record.model), ["haiku", "gpt-5.6-fixture"]);
  assert.deepEqual(records.map((record) => record.batchId), [result.batchId, result.batchId]);
  assert.deepEqual(records.map((record) => record.batchKind), ["bakeoff", "bakeoff"]);
  assert.deepEqual(records.map((record) => record.batchSeq), [1, 2]);
  assert.equal(new Set(records.map((record) => record.worktreePath)).size, 2);
  assert.equal(
    calls.filter(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("--claim"),
    ).length,
    1,
  );
  assert.equal(
    calls.some(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("open"),
    ),
    false,
  );
  setup.registry.defaults.concurrentDispatchCap = 1;
  await assert.rejects(
    dispatcher.dispatch({
      project: "fixture",
      ticketId: "fixture-3",
      lanes: ["claude", "codex"],
    }),
    (error) => error.status === 409 && /Concurrent dispatch cap exceeded \(1\)/.test(error.message),
  );
  assert.equal(
    calls.filter(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("--claim"),
    ).length,
    1,
  );
});

test("bake-off releases its shared claim only after the last viable sibling fails", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const calls = stubBakeoffRuntime(setup, { claudeFails: true, codexStatus: "failed" });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-2",
    lanes: ["claude", "codex"],
  });
  await Promise.all(result.ids.map((id) => waitForState(dispatcher, id, ["failed"])));
  await waitForCondition(
    () => calls.some(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("open"),
    ),
    "shared bake-off claim was not released",
  );
  assert.equal(
    calls.filter(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("open"),
    ).length,
    1,
  );
});

test("bake-off permits one merge, excludes its sibling, and keeps the shared claim", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const first = await seedDispatch(setup, {
    id: "bakeoff-first",
    batchId: "bakeoff-fixture",
    batchKind: "bakeoff",
    batchSeq: 1,
  });
  const second = {
    ...first,
    id: "bakeoff-second",
    lane: "codex",
    batchSeq: 2,
    branch: "atelier/fixture-1-bakeoff-second",
    worktreePath: join(setup.state, "worktrees", "fixture", "bakeoff-second"),
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
  );
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") return "";
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.merge(first.id, { force: true, ...FORCE_AUDIT });
  await assert.rejects(
    dispatcher.merge(second.id, { force: true, ...FORCE_AUDIT }),
    (error) =>
      error.status === 409 &&
      error.message === `sibling ${first.id} already merged - dismiss this attempt`,
  );
  await dispatcher.dismiss(second.id);
  assert.equal(
    calls.some(
      ({ file, args }) =>
        file === "/fixture/br" && args[0] === "update" && args.includes("open"),
    ),
    false,
  );
});

test("spentTodayUSD sums only records started inside the current local day", async (t) => {
  const setup = await fixture(t);
  const today = await seedDispatch(setup, {
    id: "today",
    startedAt: localStartedAt(0),
    costUSD: 1.25,
  });
  const yesterday = {
    ...today,
    id: "yesterday",
    startedAt: localStartedAt(1),
    costUSD: 50,
  };
  const tomorrow = {
    ...today,
    id: "tomorrow",
    startedAt: localStartedAt(-1),
    costUSD: 75,
  };
  const invalid = { ...today, id: "invalid", startedAt: "not-a-date", costUSD: 100 };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${[today, yesterday, tomorrow, invalid].map(JSON.stringify).join("\n")}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.spentTodayUSD(setup.project), 1.25);
  assert.equal(dispatcher.spentTodayUSD("fixture"), 1.25);
});

test("unpricedDispatchesToday counts only today's non-reporting lanes", async (t) => {
  const setup = await fixture(t);
  const codex = await seedDispatch(setup, {
    id: "codex-today",
    lane: "codex",
    startedAt: localStartedAt(0),
    costUSD: 0,
  });
  const records = [
    codex,
    { ...codex, id: "claude-today", lane: "claude", costUSD: 1.25 },
    { ...codex, id: "codex-yesterday", startedAt: localStartedAt(1) },
    { ...codex, id: "codex-review", reviewOf: "target-dispatch" },
    { ...codex, id: "removed-adapter", lane: "removed-adapter" },
    { ...codex, id: "invalid-date", startedAt: "not-a-date" },
  ];
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.unpricedDispatchesToday("fixture"), 3);
  assert.equal(dispatcher.unpricedDispatchesToday(setup.project, { excludeReviews: true }), 2);
});

test("unpriced dispatch cap blocks only non-reporting lanes and force overrides it", async (t) => {
  const setup = await fixture(t, { unpricedDispatchCapPerDay: 1 });
  await seedDispatch(setup, {
    id: "codex-existing",
    lane: "codex",
    startedAt: localStartedAt(0),
    costUSD: 0,
  });
  stubBakeoffRuntime(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "blocked Codex", lane: "codex" }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.dispatchCountExceeded, true);
      assert.equal(error.dispatchesToday, 1);
      assert.equal(error.dispatchCap, 1);
      assert.equal(error.message, "daily unpriced dispatch cap reached (1 of 1)");
      return true;
    },
  );

  const priced = await dispatcher.dispatch({
    project: "fixture",
    prompt: "Claude remains cost-gated",
    lane: "claude",
  });
  await waitForState(dispatcher, priced.id, ["completed"]);

  const forced = await dispatcher.dispatch({
    project: "fixture",
    prompt: "explicit Codex override",
    lane: "codex",
    force: true,
  });
  await waitForState(dispatcher, forced.id, ["completed"]);
  assert.equal(dispatcher.unpricedDispatchesToday("fixture"), 2);
});

test("unpriced dispatch reservations close concurrent admission races", async (t) => {
  const setup = await fixture(t, { unpricedDispatchCapPerDay: 1 });
  stubBakeoffRuntime(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const first = dispatcher.dispatch({ project: "fixture", prompt: "first", lane: "codex" });
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "racing second", lane: "codex" }),
    (error) => error.status === 409 && error.dispatchCountExceeded === true,
  );
  const created = await first;
  await waitForState(dispatcher, created.id, ["completed"]);
  assert.equal(dispatcher.unpricedDispatchesToday("fixture"), 1);
});

test("mixed bake-off consumes its unpriced lane and honors force", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    unpricedDispatchCapPerDay: 1,
  });
  await seedDispatch(setup, {
    id: "codex-existing",
    ticketId: "fixture-existing",
    lane: "codex",
    startedAt: localStartedAt(0),
    costUSD: 0,
  });
  const calls = stubBakeoffRuntime(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({
      project: "fixture",
      ticketId: "fixture-bakeoff",
      lanes: ["claude", "codex"],
    }),
    (error) => error.status === 409 && error.dispatchCountExceeded === true,
  );
  assert.equal(
    calls.filter(({ file, args }) => file === "/fixture/br" && args[0] === "update").length,
    0,
  );

  const forced = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-bakeoff",
    lanes: ["claude", "codex"],
    force: true,
  });
  await Promise.all(forced.ids.map((id) => waitForState(dispatcher, id, ["completed"])));
  assert.equal(dispatcher.unpricedDispatchesToday("fixture"), 2);
});

test("manual dispatch returns budget metadata and force overrides the daily ceiling", async (t) => {
  const setup = await fixture(t, { budgetUSDPerDay: 1 });
  await seedDispatch(setup, { startedAt: localStartedAt(0), costUSD: 1.5 });
  stubPreparation();
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "blocked by budget" }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.budgetExceeded, true);
      assert.equal(error.spentUSD, 1.5);
      assert.equal(error.budgetUSD, 1);
      assert.equal(error.message, "daily budget reached ($1.50 of $1.00)");
      return true;
    },
  );
  const forced = await dispatcher.dispatch({
    project: "fixture",
    prompt: "override budget",
    force: true,
  });
  await waitForState(dispatcher, forced.id, ["completed"]);
});

test("reply resume and plan approval require force after the daily budget is reached", async (t) => {
  const replySetup = await fixture(t, { budgetUSDPerDay: 1 });
  const replyRecord = await seedDispatch(replySetup, {
    id: "budget-reply",
    startedAt: localStartedAt(0),
    costUSD: 1.5,
    sessionId: "budget-session",
  });
  await mkdir(replyRecord.worktreePath, { recursive: true });
  stubPreparation();
  _setSpawner(() => successfulChild());
  const replyDispatcher = createDispatcher({
    registry: replySetup.registry,
    stateDir: replySetup.state,
  });
  await assert.rejects(
    replyDispatcher.reply(replyRecord.id, { text: "continue" }),
    (error) => error.status === 409 && error.budgetExceeded === true,
  );
  await replyDispatcher.reply(replyRecord.id, { text: "continue", force: true });
  await waitForState(replyDispatcher, replyRecord.id, ["completed"]);

  const planSetup = await fixture(t, { budgetUSDPerDay: 1 });
  const planRecord = await seedDispatch(planSetup, {
    id: "budget-plan",
    state: "plan_ready",
    startedAt: localStartedAt(0),
    endedAt: null,
    costUSD: 1.5,
    sessionId: "plan-session",
    plan: { state: "ready", text: "Implement the approved change." },
  });
  await mkdir(planRecord.worktreePath, { recursive: true });
  stubPreparation();
  _setSpawner(() => successfulChild());
  const planDispatcher = createDispatcher({
    registry: planSetup.registry,
    stateDir: planSetup.state,
  });
  await assert.rejects(
    planDispatcher.plan(planRecord.id, { action: "approve" }),
    (error) => error.status === 409 && error.budgetExceeded === true,
  );
  await planDispatcher.plan(planRecord.id, { action: "approve", force: true });
  await waitForState(planDispatcher, planRecord.id, ["completed"]);
});

test("ready parser sorts by priority, then creation time, then id", () => {
  assert.deepEqual(
    [..._parseReadyTicketIds(JSON.stringify([
      { id: "fixture-p2-old", priority: 2, created_at: "2026-01-01T00:00:00Z" },
      { id: "fixture-01-new-p0", priority: 0, created_at: "2026-01-03T00:00:00Z" },
      { id: "fixture-99-old-p0", priority: 0, created_at: "2026-01-02T00:00:00Z" },
    ]))],
    ["fixture-99-old-p0", "fixture-01-new-p0", "fixture-p2-old"],
  );
});

test("ready parser coerces string priorities and warns while sorting degraded metadata last", (t) => {
  const warnings = [];
  _setPersistenceLogger({ warn: (line) => warnings.push(line) });
  t.after(() => _setPersistenceLogger());
  assert.deepEqual(
    [..._parseReadyTicketIds(JSON.stringify([
      { id: "fixture-missing", created_at: "2025-02-01T00:00:00Z" },
      { id: "fixture-prefixed", priority: "P1", created_at: "2026-01-02T00:00:00Z" },
      { id: "fixture-invalid", priority: "P9", created_at: "2025-01-01T00:00:00Z" },
      { id: "fixture-numeric", priority: "1", created_at: "2026-01-01T00:00:00Z" },
    ]))],
    ["fixture-numeric", "fixture-prefixed", "fixture-invalid", "fixture-missing"],
  );
  assert.deepEqual(warnings, [
    "Atelier ready queue: fixture-missing has missing or invalid priority metadata; treating it as lowest priority",
    "Atelier ready queue: fixture-invalid has missing or invalid priority metadata; treating it as lowest priority",
  ]);
});

test("ready parser uses id deterministically when creation timestamps are missing", () => {
  assert.deepEqual(
    [..._parseReadyTicketIds(JSON.stringify([
      { id: "fixture-99", priority: 0 },
      { id: "fixture-42", priority: 0 },
    ]))],
    ["fixture-42", "fixture-99"],
  );
});

test("ready parser extracts ids and priorities from real br ready text output", (t) => {
  const warnings = [];
  _setPersistenceLogger({ warn: (line) => warnings.push(line) });
  t.after(() => _setPersistenceLogger());
  const output = [
    "📋 Ready work (3 issues with no blockers):",
    "",
    "1. [● P2] [task] atelier-xyz: title",
    "2. [● P0] [bug] atelier-zulu: urgent fix",
    "3. [● P0] [task] atelier-alpha: equally urgent work",
  ].join("\n");
  assert.deepEqual(
    [..._parseReadyTicketIds(output)],
    ["atelier-alpha", "atelier-zulu", "atelier-xyz"],
  );
  assert.deepEqual(warnings, []);
});

test("ready text parser accepts legitimate empty output without warnings", (t) => {
  const warnings = [];
  _setPersistenceLogger({ warn: (line) => warnings.push(line) });
  t.after(() => _setPersistenceLogger());
  const outputs = [
    "✨ No ready issues — all remaining work is blocked, deferred, or in progress",
    "✨ All work complete — no issues to work on",
    "📋 Ready work (0 issues with no blockers):\n",
  ];
  for (const output of outputs) {
    assert.deepEqual([..._parseReadyTicketIds(output)], []);
  }
  assert.deepEqual(warnings, []);
});

test("ready text parser warns and skips malformed rows without dropping valid rows", (t) => {
  const warnings = [];
  _setPersistenceLogger({ warn: (line) => warnings.push(line) });
  t.after(() => _setPersistenceLogger());
  const output = [
    "📋 Ready work (3 issues with no blockers):",
    "1. [P1] [task] atelier-valid: valid priority-token variant",
    "2. [● P0] [bug] atelier-missing-colon malformed row",
    "3. [task] atelier-missing-priority: malformed row",
  ].join("\n");
  assert.deepEqual([..._parseReadyTicketIds(output)], ["atelier-valid"]);
  assert.deepEqual(warnings, [
    "Atelier ready queue: skipped unparseable br ready text line 3",
    "Atelier ready queue: skipped unparseable br ready text line 4",
  ]);
});

test("legacy ready variants keep parseable work without tripping the queue breaker", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const warnings = [];
  _setPersistenceLogger({ warn: (line) => warnings.push(line) });
  t.after(() => _setPersistenceLogger());
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready" && args.includes("--json")) {
      throw new Error("unknown flag: --json");
    }
    if (file === "/fixture/br" && args[0] === "ready") {
      return [
        "📋 Ready work (2 issues with no blockers):",
        "1. [P0] [task] fixture-legacy: parseable",
        "2. future-format fixture-variant without known metadata",
      ].join("\n");
    }
    if (file === "/fixture/br" && args[0] === "update") return "";
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const queued = dispatcher.list().find((record) => record.ticketId === "fixture-legacy");
  assert.ok(queued);
  await waitForState(dispatcher, queued.id, ["completed"]);
  assert.deepEqual(
    calls.filter(({ file }) => file === "/fixture/br").slice(0, 3).map(({ args }) => args),
    [
      ["ready", "--json"],
      ["ready"],
      ["update", "fixture-legacy", "--claim", "--actor", "atelier"],
    ],
  );
  assert.equal(dispatcher.getQueue("fixture").consecutiveFailures, 0);
  assert.equal(dispatcher.getQueue("fixture").lastError, null);
  assert.deepEqual(warnings, [
    "Atelier ready queue: skipped unparseable br ready text line 3",
  ]);
});

test("ready queue claims the oldest highest-priority ticket before dispatching", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") {
      return JSON.stringify([
        { id: "fixture-p2-old", priority: 2, created_at: "2026-01-01T00:00:00Z" },
        { id: "fixture-11-new-p0", priority: 0, created_at: "2026-01-03T00:00:00Z" },
        { id: "fixture-99-old-p0", priority: 0, created_at: "2026-01-02T00:00:00Z" },
      ]);
    }
    if (file === "/fixture/br" && args[0] === "update") return "";
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const queued = dispatcher.list().find((record) => record.ticketId === "fixture-99-old-p0");
  assert.ok(queued);
  await waitForState(dispatcher, queued.id, ["completed"]);
  assert.deepEqual(
    calls.slice(0, 2),
    [
      { file: "/fixture/br", args: ["ready", "--json"], cwd: setup.primary },
      {
        file: "/fixture/br",
        args: ["update", "fixture-99-old-p0", "--claim", "--actor", "atelier"],
        cwd: setup.primary,
      },
    ],
  );
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
  });
});

test("ready queue parks repeated runtime failures across restart and resumes explicitly", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([
          { id: "fixture-bad", priority: 0, created_at: "2026-01-01T00:00:00Z" },
          { id: "fixture-good", priority: 1, created_at: "2026-01-02T00:00:00Z" },
        ]);
      }
      if (["update", "comments"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches <= 2 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const first = dispatcher.list().find((record) => record.ticketId === "fixture-bad");
  await waitForCondition(
    () => dispatcher.get(first.id)?.state === "failed",
    "first queue dispatch did not fail",
  );
  await waitForCondition(
    () => calls.filter(({ args }) => args[0] === "update" && args[2] === "--status").length === 1,
    "first failed queue dispatch did not release its claim",
  );

  await dispatcher.drainQueuesOnce();
  const second = dispatcher.list().find(
    (record) => record.ticketId === "fixture-bad" && record.id !== first.id,
  );
  await waitForCondition(
    () => dispatcher.get(second.id)?.state === "failed",
    "second queue dispatch did not fail",
  );
  await waitForCondition(
    () => dispatcher.getQueue("fixture").parkedTickets.length === 1,
    "repeated failure did not park the ticket",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "comments" && args[1] === "add"),
    "parking did not add a tracker comment",
  );

  const parked = dispatcher.getQueue("fixture").parkedTickets[0];
  assert.equal(parked.ticketId, "fixture-bad");
  assert.equal(parked.attempts, 2);
  assert.equal(parked.lastFailureKind, "agent_error");
  assert.match(parked.parkReason, /agent_error after 2 failed attempts/);
  assert.equal(
    calls.filter(({ args }) => args[0] === "comments" && args[1] === "add").length,
    1,
  );
  assert.equal(
    calls.find(({ args }) => args[0] === "comments" && args[1] === "add").cwd,
    setup.primary,
  );
  const durableOutcome = dispatcher.get(second.id).queueOutcome;
  assert.equal(dispatcher.get(first.id).queueOutcome.sequence, 1);
  assert.equal(durableOutcome.status, "failure");
  assert.equal(durableOutcome.sequence, 2);
  assert.equal(durableOutcome.attempt.outcomeSequence, 2);
  assert.equal(durableOutcome.attempt.parked, true);
  const parkedState = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(parkedState.fixture.ticketAttempts["fixture-bad"].attempts, 2);
  assert.equal(parkedState.fixture.ticketAttempts["fixture-bad"].parked, true);
  await waitForCondition(
    () => calls.filter(({ args }) => args[0] === "update" && args[2] === "--status").length === 2,
    "second failed queue dispatch did not release its claim",
  );

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await successor.drainQueuesOnce();
  const next = successor.list().find((record) => record.ticketId === "fixture-good");
  assert.ok(next, "a successor process must skip the persisted parked ticket");
  await waitForCondition(
    () => successor.get(next.id)?.state === "completed",
    "next eligible ticket did not complete after restart",
  );
  assert.equal(
    successor.list().filter((record) => record.ticketId === "fixture-bad").length,
    2,
  );

  const resumed = successor.resumeQueueTicket("fixture", "fixture-bad");
  assert.deepEqual(resumed.parkedTickets, []);
  const resumedSuccessor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(resumedSuccessor.getQueue("fixture").parkedTickets, []);
  await resumedSuccessor.drainQueuesOnce();
  const priorBadIds = new Set([first.id, second.id]);
  const retried = resumedSuccessor.list().find(
    (record) => record.ticketId === "fixture-bad" && !priorBadIds.has(record.id),
  );
  assert.ok(retried, "an explicitly resumed ticket must become eligible after restart");
  await waitForCondition(
    () => resumedSuccessor.get(retried.id)?.state === "completed",
    "resumed ticket did not complete",
  );

  const saved = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(saved.fixture.ticketAttempts, undefined);
  assert.ok(saved.fixture.ticketResumes["fixture-bad"]);
});

test("ready queue applies a lowered failure limit before dispatch and comments once", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 2,
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-lowered", priority: 0 }]);
      }
      if (["update", "comments"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const failed = dispatcher.list().find((record) => record.ticketId === "fixture-lowered");
  await waitForCondition(
    () => dispatcher.get(failed.id)?.state === "failed",
    "initial queue dispatch did not fail",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "update" && args[2] === "--status"),
    "initial failed queue dispatch did not release its claim",
  );
  const beforeLowering = JSON.parse(
    await readFile(join(setup.state, "queue.json"), "utf8"),
  );
  assert.equal(beforeLowering.fixture.ticketAttempts["fixture-lowered"].attempts, 1);
  assert.equal(beforeLowering.fixture.ticketAttempts["fixture-lowered"].parked, false);

  // Project settings replace the live registry entry, so model the same runtime update.
  setup.registry.projects.splice(0, 1, {
    ...setup.registry.projects[0],
    queueFailureLimit: 1,
  });
  await dispatcher.drainQueuesOnce();

  assert.equal(launches, 1, "the newly reached limit must prevent another dispatch");
  assert.equal(
    dispatcher.list().filter((record) => record.ticketId === "fixture-lowered").length,
    1,
  );
  assert.equal(
    calls.filter(({ args }) => args[0] === "comments" && args[1] === "add").length,
    1,
  );
  const parked = dispatcher.getQueue("fixture").parkedTickets[0];
  assert.equal(parked.ticketId, "fixture-lowered");
  assert.equal(parked.attempts, 1);
  assert.equal(parked.parked, true);
  const afterLowering = JSON.parse(
    await readFile(join(setup.state, "queue.json"), "utf8"),
  );
  assert.equal(afterLowering.fixture.ticketAttempts["fixture-lowered"].parked, true);
  assert.equal(dispatcher.get(failed.id).queueOutcome.attempt.parked, true);

  await dispatcher.drainQueuesOnce();
  assert.equal(launches, 1);
  assert.equal(
    calls.filter(({ args }) => args[0] === "comments" && args[1] === "add").length,
    1,
    "repeated drains must not duplicate the parking comment",
  );
});

test("ready queue resume rolls back when queue persistence fails", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  const parkedAttempt = {
    attempts: 1,
    lastFailureAt: "2026-07-22T08:00:00.000Z",
    lastFailureKind: "agent_error",
    lastDispatchId: "dispatch-parked",
    parked: true,
    parkedAt: "2026-07-22T08:00:00.000Z",
    parkReason: "agent_error after 1 failed attempts",
    parkCommentPending: false,
  };
  await mkdir(setup.state, { recursive: true });
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: true,
        ticketAttempts: { "fixture-parked": parkedAttempt },
      },
    })}\n`,
  );
  _setPersistenceLogger({ error() {} });
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, encoding) {
      if (path.endsWith("queue.json")) {
        throw Object.assign(new Error("fixture queue EIO"), { code: "EIO" });
      }
      writeFileSync(path, contents, encoding);
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.throws(
    () => dispatcher.resumeQueueTicket("fixture", "fixture-parked"),
    (error) => {
      assert.equal(error.status, 503);
      assert.match(error.message, /Could not persist queue resume/);
      assert.match(error.message, /ticket remains parked/);
      return true;
    },
  );
  assert.equal(dispatcher.getQueue("fixture").parkedTickets[0].ticketId, "fixture-parked");
  const unchanged = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.deepEqual(unchanged.fixture.ticketAttempts["fixture-parked"], parkedAttempt);
  assert.equal(unchanged.fixture.ticketResumes, undefined);

  _setPersistenceFileOps();
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(successor.getQueue("fixture").parkedTickets[0].ticketId, "fixture-parked");
});

test("ready queue retries a pending park comment after failure without redispatching", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let commentAttempts = 0;
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-comment", priority: 0 }]);
      }
      if (args[0] === "comments") {
        commentAttempts += 1;
        if (commentAttempts === 1) {
          throw new Error("fixture comment unavailable");
        }
        return "";
      }
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const failed = dispatcher.list().find((record) => record.ticketId === "fixture-comment");
  await waitForCondition(
    () => commentAttempts === 1,
    "initial parking did not attempt its tracker comment",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "update" && args[2] === "--status"),
    "failed queue dispatch did not release its claim",
  );
  const pending = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(pending.fixture.ticketAttempts["fixture-comment"].parked, true);
  assert.equal(pending.fixture.ticketAttempts["fixture-comment"].parkCommentPending, true);
  assert.equal(dispatcher.get(failed.id).queueOutcome.attempt.parkCommentPending, true);

  await dispatcher.drainQueuesOnce();
  assert.equal(launches, 1, "a pending park comment must be repaired before dispatch selection");
  assert.equal(commentAttempts, 2);
  const completed = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(completed.fixture.ticketAttempts["fixture-comment"].parkCommentPending, false);
  assert.equal(dispatcher.get(failed.id).queueOutcome.attempt.parkCommentPending, false);

  await dispatcher.drainQueuesOnce();
  assert.equal(launches, 1);
  assert.equal(commentAttempts, 2, "a completed park comment must not be duplicated");
});

test("ready queue comment completion cannot re-park a concurrently resumed ticket", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let markCommentStarted;
  let releaseComment;
  const commentStarted = new Promise((resolvePromise) => {
    markCommentStarted = resolvePromise;
  });
  const commentRelease = new Promise((resolvePromise) => {
    releaseComment = resolvePromise;
  });
  let commentsRecorded = 0;
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-race", priority: 0 }]);
      }
      if (args[0] === "comments") {
        markCommentStarted();
        await commentRelease;
        commentsRecorded += 1;
        return "";
      }
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return failedChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  await commentStarted;
  assert.equal(dispatcher.getQueue("fixture").parkedTickets[0].ticketId, "fixture-race");

  const resumed = dispatcher.resumeQueueTicket("fixture", "fixture-race");
  assert.deepEqual(resumed.parkedTickets, []);
  releaseComment();
  await waitForCondition(
    () => commentsRecorded === 1,
    "in-flight parking comment did not complete",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "update" && args[2] === "--status"),
    "failed queue dispatch did not release its claim",
  );

  assert.equal(launches, 1);
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);
  const saved = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(saved.fixture.ticketAttempts, undefined);
  assert.ok(saved.fixture.ticketResumes["fixture-race"]);
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(successor.getQueue("fixture").parkedTickets, []);
});

test("ready queue classifies max-turn agent failures as turn_cap", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 2,
    dispatchProfile: {
      model: "haiku",
      maxTurns: 2,
      allowedTools: ["Read", "Edit"],
      lane: "claude",
    },
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-turn-cap", priority: 0 }]);
      }
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner(() => failedChild({ turns: 2 }));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const failed = dispatcher.list().find((record) => record.ticketId === "fixture-turn-cap");
  await waitForCondition(
    () => dispatcher.get(failed.id)?.queueOutcome,
    "turn-cap failure did not settle its queue outcome",
  );
  const record = dispatcher.get(failed.id);
  assert.equal(record.state, "failed");
  assert.equal(record.turns, 2);
  assert.equal(record.maxTurns, 2);
  assert.equal(record.queueOutcome.attempt.lastFailureKind, "turn_cap");
  assert.equal(dispatcher.getQueue("fixture").parkedTickets.length, 0);
});

test("manual runtime failures never increment queue attempts or park ready work", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-manual", priority: 0 }]);
      }
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const manual = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-manual",
  });
  await waitForCondition(
    () => dispatcher.get(manual.id)?.state === "failed",
    "manual dispatch did not fail",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "update" && args[2] === "--status"),
    "manual failure did not release its claim",
  );

  assert.equal(dispatcher.get(manual.id).queueLaunched, false);
  assert.equal(dispatcher.get(manual.id).queueOutcome, undefined);
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);
  const afterManualFailure = JSON.parse(
    await readFile(join(setup.state, "queue.json"), "utf8"),
  );
  assert.equal(afterManualFailure.fixture.ticketAttempts, undefined);

  await dispatcher.drainQueuesOnce();
  const queueRetry = dispatcher.list().find(
    (record) => record.ticketId === "fixture-manual" && record.id !== manual.id,
  );
  assert.ok(queueRetry, "the manually failed ticket must remain queue-eligible");
  await waitForCondition(
    () => dispatcher.get(queueRetry.id)?.state === "completed",
    "queue retry of the manually failed ticket did not complete",
  );
});

test("success append failure cannot replay an older queue failure after restart", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  const endedAt = "2026-07-22T09:00:00.000Z";
  const baseRecord = {
    project: "fixture",
    ticketId: "fixture-recovered-success",
    model: "haiku",
    effort: null,
    maxTurns: 7,
    lane: "claude",
    queueLaunched: true,
    branch: null,
    branchHead: null,
    worktreePath: null,
    startedAt: "2026-07-22T08:59:00.000Z",
    endedAt,
    turns: 1,
    costUSD: 0,
    sessionId: null,
    prompt: "fixture",
    exitSummary: "fixture",
    strandedBrWrites: false,
    verify: { state: "passed", steps: [] },
    postMerge: null,
    review: null,
    reviewOf: null,
    reviewedHead: null,
    readOnly: false,
    merged: null,
    dismissed: null,
    mergedClose: null,
    harvest: null,
    warnings: [],
  };
  const failedAttempt = {
    attempts: 1,
    lastFailureAt: endedAt,
    lastFailureKind: "agent_error",
    lastDispatchId: "dispatch-z-failure",
    parked: true,
    parkedAt: endedAt,
    parkReason: "agent_error after 1 failed attempts",
    parkCommentPending: false,
  };
  const failedRecord = {
    ...baseRecord,
    id: "dispatch-z-failure",
    state: "failed",
    queueOutcome: {
      status: "failure",
      endedAt,
      dispatchId: "dispatch-z-failure",
      attempt: failedAttempt,
    },
  };
  const successfulRecord = {
    ...baseRecord,
    id: "dispatch-a-success",
    state: "completed",
    exitSummary: "completed",
  };
  await mkdir(join(setup.state, "dispatches"), { recursive: true });
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(failedRecord)}\n${JSON.stringify(successfulRecord)}\n`,
  );
  // This is the old torn state: attempt clearing reached queue.json, while the
  // later success outcome append did not reach the dispatch index.
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: false } })}\n`,
  );
  let failSuccessAppend = true;
  _setPersistenceLogger({ error() {} });
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      if (
        failSuccessAppend &&
        path.endsWith("index.jsonl") &&
        contents.includes('"status":"success"')
      ) {
        throw Object.assign(new Error("fixture success append EIO"), { code: "EIO" });
      }
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);
  const afterRecovery = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(afterRecovery.fixture.ticketAttempts, undefined);
  const beforeRetry = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(beforeRetry.at(-1).id, "dispatch-a-success");
  assert.equal(beforeRetry.at(-1).queueOutcome, undefined);

  failSuccessAppend = false;
  await dispatcher.drainQueuesOnce();
  const afterRetry = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(afterRetry.at(-1).id, "dispatch-a-success");
  assert.equal(afterRetry.at(-1).queueOutcome.status, "success");
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(successor.getQueue("fixture").parkedTickets, []);
});

test("dismissing an older queue failure after success cannot resurrect it on restart", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  const failedAt = "2026-07-22T10:00:00.000Z";
  const succeededAt = "2026-07-22T10:05:00.000Z";
  const failedAttempt = {
    attempts: 1,
    lastFailureAt: failedAt,
    lastFailureKind: "agent_error",
    lastDispatchId: "dispatch-old-failure",
    outcomeSequence: 1,
    parked: true,
    parkedAt: failedAt,
    parkReason: "agent_error after 1 failed attempts",
    parkCommentPending: false,
  };
  const baseRecord = {
    project: "fixture",
    ticketId: "fixture-outcome-order",
    model: "haiku",
    effort: null,
    maxTurns: 7,
    lane: "claude",
    queueLaunched: true,
    branch: null,
    branchHead: null,
    worktreePath: null,
    turns: 1,
    costUSD: 0,
    sessionId: null,
    prompt: "fixture",
    strandedBrWrites: false,
    verify: null,
    postMerge: null,
    review: null,
    reviewOf: null,
    reviewedHead: null,
    readOnly: false,
    merged: null,
    dismissed: null,
    mergedClose: null,
    harvest: null,
    warnings: [],
  };
  const failedRecord = {
    ...baseRecord,
    id: "dispatch-old-failure",
    state: "failed",
    startedAt: "2026-07-22T09:59:00.000Z",
    endedAt: failedAt,
    exitSummary: "failed",
    queueOutcome: {
      status: "failure",
      endedAt: failedAt,
      dispatchId: "dispatch-old-failure",
      sequence: 1,
      attempt: failedAttempt,
    },
  };
  const successfulRecord = {
    ...baseRecord,
    id: "dispatch-new-success",
    state: "completed",
    startedAt: "2026-07-22T10:04:00.000Z",
    endedAt: succeededAt,
    exitSummary: "completed",
    queueOutcome: {
      status: "success",
      endedAt: succeededAt,
      dispatchId: "dispatch-new-success",
      sequence: 2,
    },
  };
  await mkdir(join(setup.state, "dispatches"), { recursive: true });
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    [failedRecord, successfulRecord]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: false,
        ticketAttempts: { "fixture-outcome-order": failedAttempt },
      },
    })}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(dispatcher.get("dispatch-new-success").queueOutcome.sequence, 2);
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);
  const dismissed = await dispatcher.dismiss("dispatch-old-failure");
  assert.match(dismissed.dismissed.at, /^2026-/);
  assert.equal(dismissed.queueOutcome.sequence, 1);
  const reconciled = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(reconciled.fixture.ticketAttempts, undefined);
  const appended = (await readFile(
    join(setup.state, "dispatches", "index.jsonl"),
    "utf8",
  )).trim().split("\n").map(JSON.parse);
  assert.equal(appended.at(-1).id, "dispatch-old-failure");
  assert.equal(appended.at(-1).queueOutcome.sequence, 1);

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(successor.getQueue("fixture").parkedTickets, []);
});

test("queue outcome reconciliation never decreases attempts from a stale snapshot", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 3,
  });
  const snapshotAttempt = {
    attempts: 3,
    lastFailureAt: "2026-07-22T11:00:00.000Z",
    lastFailureKind: "agent_error",
    lastDispatchId: "dispatch-snapshot-failure",
    outcomeSequence: 3,
    parked: true,
    parkedAt: "2026-07-22T11:00:00.000Z",
    parkReason: "agent_error after 3 failed attempts",
    parkCommentPending: false,
  };
  const replayedAttempt = {
    attempts: 2,
    lastFailureAt: "2026-07-22T11:05:00.000Z",
    lastFailureKind: "verify_failed",
    lastDispatchId: "dispatch-newer-replay",
    outcomeSequence: 4,
    parked: false,
    parkedAt: null,
    parkReason: null,
    parkCommentPending: false,
  };
  const record = {
    id: "dispatch-newer-replay",
    project: "fixture",
    ticketId: "fixture-monotonic-attempts",
    model: "haiku",
    effort: null,
    maxTurns: 7,
    lane: "claude",
    state: "failed",
    queueLaunched: true,
    queueOutcome: {
      status: "failure",
      endedAt: replayedAttempt.lastFailureAt,
      dispatchId: "dispatch-newer-replay",
      sequence: 4,
      attempt: replayedAttempt,
    },
    branch: null,
    branchHead: null,
    worktreePath: null,
    startedAt: "2026-07-22T11:04:00.000Z",
    endedAt: replayedAttempt.lastFailureAt,
    turns: 1,
    costUSD: 0,
    sessionId: null,
    prompt: "fixture",
    exitSummary: "failed",
    strandedBrWrites: false,
    verify: { state: "failed", steps: [] },
    postMerge: null,
    review: null,
    reviewOf: null,
    reviewedHead: null,
    readOnly: false,
    merged: null,
    dismissed: null,
    mergedClose: null,
    harvest: null,
    warnings: [],
  };
  await mkdir(join(setup.state, "dispatches"), { recursive: true });
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(record)}\n`,
  );
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: false,
        ticketAttempts: { "fixture-monotonic-attempts": snapshotAttempt },
      },
    })}\n`,
  );

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const parked = dispatcher.getQueue("fixture").parkedTickets[0];
  assert.equal(parked.ticketId, "fixture-monotonic-attempts");
  assert.equal(parked.attempts, 3);
  assert.equal(parked.outcomeSequence, 4);
  assert.equal(parked.lastDispatchId, "dispatch-snapshot-failure");
  const reconciled = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(reconciled.fixture.ticketAttempts["fixture-monotonic-attempts"].attempts, 3);

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(successor.getQueue("fixture").parkedTickets[0].attempts, 3);
});

test("boot reconciles a parked outcome while queue writes remain unavailable", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    queueFailureLimit: 1,
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([
          { id: "fixture-bad", priority: 0 },
          { id: "fixture-good", priority: 1 },
        ]);
      }
      if (["update", "comments"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let failQueueWrite = true;
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, encoding) {
      if (failQueueWrite && path.endsWith("queue.json")) {
        throw Object.assign(new Error("fixture queue EIO"), { code: "EIO" });
      }
      writeFileSync(path, contents, encoding);
    },
  });
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? failedChild() : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  await waitForCondition(
    () => dispatcher.getQueue("fixture").parkedTickets.length === 1,
    "failed queue dispatch did not park in memory",
  );
  await waitForCondition(
    () => calls.some(({ args }) => args[0] === "update" && args[2] === "--status"),
    "failed queue dispatch did not release its claim",
  );
  assert.match(dispatcher.getQueue("fixture").lastError, /PERSISTENCE DEGRADED/);
  assert.deepEqual(JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8")), {
    fixture: { enabled: true },
  });

  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(successor.getQueue("fixture").parkedTickets[0].ticketId, "fixture-bad");
  assert.match(successor.getQueue("fixture").lastError, /PERSISTENCE DEGRADED/);

  failQueueWrite = false;
  await successor.drainQueuesOnce();
  const next = successor.list().find((record) => record.ticketId === "fixture-good");
  assert.ok(next, "the recovered successor must skip the parked ticket");
  await waitForCondition(
    () => successor.get(next.id)?.state === "completed",
    "next eligible ticket did not complete after persistence recovery",
  );
  assert.equal(
    successor.list().filter((record) => record.ticketId === "fixture-bad").length,
    1,
    "the stale queue snapshot must not make the failed ticket eligible after restart",
  );
  const saved = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(saved.fixture.ticketAttempts["fixture-bad"].parked, true);
  assert.doesNotMatch(successor.getQueue("fixture").lastError || "", /PERSISTENCE DEGRADED/);
});

test("ready queue skips a project that already has an active dispatch", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let brCalls = 0;
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      brCalls += 1;
      return "1. [● P0] [task] fixture-42: should stay ready\n";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setBrResolver(() => "/fixture/br");
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const active = await dispatcher.dispatch({ project: "fixture", prompt: "active work" });
  await waitForState(dispatcher, active.id, ["running"]);

  await dispatcher.drainQueuesOnce();
  assert.equal(brCalls, 0);
  child.complete();
  await waitForState(dispatcher, active.id, ["completed"]);
});

test("ready queue ignores an active review on the same project and at the cap", async (t) => {
  const setup = await fixture(
    t,
    { tracker: "committed" },
    { concurrentDispatchCap: 1 },
  );
  await enablePersistedQueue(setup);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Preserve the queue contract.",
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      if (args[0] === "ready") return JSON.stringify([{ id: "fixture-42" }]);
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "diff") {
      return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+queue-safe change";
    }
    if (file === "git" && args[2] === "rev-parse" && args[3] === "HEAD") {
      return "reviewed-head\n";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "remove") return "";
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const reviewChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? reviewChild : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["running"]);
  await dispatcher.drainQueuesOnce();

  const queued = dispatcher.list().find((record) => record.ticketId === "fixture-42");
  assert.ok(queued, "the active review must not occupy the ready queue's project or cap slot");
  await waitForState(dispatcher, queued.id, ["completed"]);
  assert.equal(dispatcher.get(review.id).state, "running");
  assert.equal(launches, 2);

  reviewChild.complete();
  await waitForState(dispatcher, review.id, ["completed"]);
});

test("ready queue reports a daily budget skip without counting a breaker failure", async (t) => {
  const setup = await fixture(t, { tracker: "committed", budgetUSDPerDay: 1 });
  await enablePersistedQueue(setup);
  await seedDispatch(setup, { startedAt: localStartedAt(0), costUSD: 1.25 });
  _setBrResolver(() => "/fixture/br");
  let commands = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "ready") {
      commands += 1;
      return "[]";
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: "daily budget reached ($1.25 of $1.00)",
    failureLimit: 2,
    parkedTickets: [],
    // atelier-e5x: the queue payload carries the spend readout whenever a cap is
    // configured, so a budget block is visible before it becomes a lastError.
    budget: { spentUSD: 1.25, budgetUSD: 1, exceeded: true },
  });
  assert.equal(commands, 0);

  setup.project.budgetUSDPerDay = 2;
  await dispatcher.drainQueuesOnce();
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
    budget: { spentUSD: 1.25, budgetUSD: 2, exceeded: false },
  });
  assert.equal(commands, 1);
});

test("ready queue reports an unpriced dispatch cap without counting a breaker failure", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    unpricedDispatchCapPerDay: 2,
    dispatchProfile: { lane: "codex", maxTurns: 7 },
  });
  await enablePersistedQueue(setup);
  const ordinary = await seedDispatch(setup, {
    id: "codex-existing",
    lane: "codex",
    startedAt: localStartedAt(0),
    costUSD: 0,
  });
  const review = {
    ...ordinary,
    id: "codex-review",
    ticketId: null,
    reviewOf: ordinary.id,
    reviewedHead: "reviewed-head",
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(ordinary)}\n${JSON.stringify(review)}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  let commands = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "ready") {
      commands += 1;
      return "[]";
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: "daily unpriced dispatch cap reached (2 of 2)",
    failureLimit: 2,
    parkedTickets: [],
    // atelier-e5x: same readout for the unpriced-dispatch cap, computed exactly as
    // the drain computes it - reviews COUNT here (unlike the budget), which is
    // why the readout agrees with the lastError above instead of contradicting it.
    unpricedDispatches: { dispatchesToday: 2, dispatchCap: 2, exceeded: true },
  });
  assert.equal(commands, 0);

  setup.project.unpricedDispatchCapPerDay = 3;
  await dispatcher.drainQueuesOnce();
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
    unpricedDispatches: { dispatchesToday: 2, dispatchCap: 3, exceeded: false },
  });
  assert.equal(commands, 1);
});

test("ready queue treats an unpriced slot consumed during br ready as benign contention", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    unpricedDispatchCapPerDay: 1,
    dispatchProfile: { lane: "codex", maxTurns: 7 },
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  let claims = 0;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "ready") {
      await seedDispatch(setup, {
        id: "codex-race-winner",
        ticketId: "fixture-other",
        lane: "codex",
        startedAt: localStartedAt(0),
        costUSD: 0,
      });
      return JSON.stringify([{ id: "fixture-ready" }]);
    }
    if (file === "/fixture/br" && args[0] === "update") claims += 1;
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();

  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: "daily unpriced dispatch cap reached (1 of 1)",
    failureLimit: 2,
    parkedTickets: [],
    unpricedDispatches: { dispatchesToday: 1, dispatchCap: 1, exceeded: true },
  });
  assert.equal(claims, 0);
  assert.equal(
    dispatcher.list().some((record) => record.ticketId === "fixture-ready"),
    false,
  );
});

test("ready queue budget ignores review costs while rollups keep them visible", async (t) => {
  const setup = await fixture(t, { tracker: "committed", budgetUSDPerDay: 1 });
  await enablePersistedQueue(setup);
  const ordinary = await seedDispatch(setup, {
    id: "budget-ordinary",
    startedAt: localStartedAt(0),
    costUSD: 0.9,
  });
  const review = {
    ...ordinary,
    id: "budget-review",
    ticketId: null,
    startedAt: localStartedAt(0),
    costUSD: 0.2,
    reviewOf: ordinary.id,
    reviewedHead: "budget-reviewed-head",
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(ordinary)}\n${JSON.stringify(review)}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      if (args[0] === "ready") return JSON.stringify([{ id: "fixture-budget-ready" }]);
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.spentTodayUSD("fixture"), 1.1);
  assert.equal(dispatcher.rollup().totals.costUSD, 1.1);
  assert.equal(
    dispatcher.rollup().projects.find((candidate) => candidate.project === "fixture").costUSD,
    1.1,
  );
  await dispatcher.drainQueuesOnce();
  const queued = dispatcher.list().find((record) => record.ticketId === "fixture-budget-ready");
  assert.ok(queued, "review cost must not close the ready-queue budget gate");
  await waitForState(dispatcher, queued.id, ["completed"]);
  assert.equal(dispatcher.getQueue("fixture").lastError, null);
});

test("dispatcher exposes the project whose ready queue is actively draining", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  let releaseReady;
  let readyStarted;
  const started = new Promise((resolvePromise) => {
    readyStarted = resolvePromise;
  });
  const heldReady = new Promise((resolvePromise) => {
    releaseReady = resolvePromise;
  });
  _setRunFile(async (file, args) => {
    assert.equal(file, "/fixture/br");
    assert.deepEqual(args, ["ready", "--json"]);
    readyStarted();
    await heldReady;
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const draining = dispatcher.drainQueuesOnce();
  await started;
  assert.equal(dispatcher.isQueueDrainRunning("fixture"), true);
  assert.equal(dispatcher.isQueueDrainRunning("other"), false);
  releaseReady();
  await draining;
  assert.equal(dispatcher.isQueueDrainRunning("fixture"), false);
});

test("dispatcher blocks new dispatch and queue work while a tracker move is in progress", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  let commands = 0;
  _setRunFile(async () => {
    commands += 1;
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  dispatcher.setTrackerMoving("fixture", true);

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "wait for move" }),
    (error) => error.status === 409 && /tracker is moving/.test(error.message),
  );
  await dispatcher.drainQueuesOnce();
  assert.equal(commands, 0);
  dispatcher.setTrackerMoving("fixture", false);
});

test("ready queue circuit breaker disables after three failures and re-enable resets", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  const fakeBr = join(setup.root, "br");
  await writeFile(fakeBr, "");
  _setBrResolver(() => fakeBr);
  _setRunFile(async () => {
    throw new Error("tracker unavailable");
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  await dispatcher.drainQueuesOnce();
  await dispatcher.drainQueuesOnce();
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: false,
    consecutiveFailures: 3,
    lastError: "tracker unavailable",
    failureLimit: 2,
    parkedTickets: [],
  });
  assert.deepEqual(JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8")), {
    fixture: { enabled: false },
  });

  assert.deepEqual(dispatcher.setQueue("fixture", { enabled: true }), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
  });
});

test("setQueue keeps its memory mutation and surfaces a guarded persistence failure", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const fakeBr = join(setup.root, "br");
  await writeFile(fakeBr, "");
  _setBrResolver(() => fakeBr);
  let failQueueWrite = true;
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, encoding) {
      if (failQueueWrite && path.endsWith("queue.json")) {
        throw Object.assign(new Error("fixture queue ESTALE"), { code: "ESTALE" });
      }
      writeFileSync(path, contents, encoding);
    },
  });
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const degraded = dispatcher.setQueue("fixture", { enabled: true });
  assert.equal(degraded.enabled, true);
  assert.equal(degraded.consecutiveFailures, 0);
  assert.match(degraded.lastError, /^PERSISTENCE DEGRADED:/);
  assert.equal(existsSync(join(setup.state, "queue.json")), false);
  assert.equal(logLines.length, 1);

  failQueueWrite = false;
  assert.deepEqual(dispatcher.setQueue("fixture", { enabled: false }), {
    enabled: false,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
  });
  assert.deepEqual(JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8")), {
    fixture: { enabled: false },
  });
});

test("timer-style queue drain persistence failure resolves and keeps the breaker warning", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  const fakeBr = join(setup.root, "br");
  await writeFile(fakeBr, "");
  _setBrResolver(() => fakeBr);
  _setRunFile(async () => {
    throw new Error("tracker unavailable");
  });
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, encoding) {
      if (path.endsWith("queue.json")) {
        throw Object.assign(new Error("fixture queue EIO"), { code: "EIO" });
      }
      writeFileSync(path, contents, encoding);
    },
  });
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  for (let expected = 1; expected <= 3; expected += 1) {
    // Match the server timer's fire-and-forget call. Any rejection is reported
    // by node:test as an unhandled rejection.
    void dispatcher.drainQueuesOnce();
    await waitForCondition(
      () => dispatcher.getQueue("fixture").consecutiveFailures === expected,
      `queue did not record timer failure ${expected}`,
    );
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  const queue = dispatcher.getQueue("fixture");
  assert.equal(queue.enabled, false);
  assert.equal(queue.consecutiveFailures, 3);
  assert.match(queue.lastError, /^tracker unavailable; PERSISTENCE DEGRADED:/);
  assert.equal(logLines.length, 1);
});

test("tracker-less project queue is unavailable and rejects enabling", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.deepEqual(dispatcher.getQueue("fixture"), { enabled: false, unavailable: true });
  await assert.rejects(
    async () => dispatcher.setQueue("fixture", { enabled: true }),
    (error) => error.status === 409 && /no tracker/.test(error.message),
  );
});

test("tracker-only projects reject dispatch, verification, merge, and queue with 409", async (t) => {
  const setup = await fixture(t, {
    archetype: "tracker-only",
    tracker: "personal",
    mainBranch: null,
  });
  const seeded = await seedDispatch(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "work", verify: true }),
    (error) => error.status === 409 && /tracker-only project/.test(error.message),
  );
  assert.throws(
    () => dispatcher.getQueue("fixture"),
    (error) => error.status === 409 && /tracker-only project/.test(error.message),
  );
  assert.throws(
    () => dispatcher.setQueue("fixture", { enabled: false }),
    (error) => error.status === 409 && /tracker-only project/.test(error.message),
  );
  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 && /tracker-only project/.test(error.message),
  );
});

test("dispatcher compacts an oversized index to the latest record per id on boot", async (t) => {
  const setup = await fixture(t);
  const dispatchDir = join(setup.state, "dispatches");
  const indexPath = join(dispatchDir, "index.jsonl");
  await mkdir(dispatchDir, { recursive: true });
  const lines = Array.from({ length: 1_001 }, (_, index) => JSON.stringify({
    id: `dispatch-${index % 3}`,
    project: "fixture",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: null,
    worktreePath: null,
    startedAt: new Date(index * 1_000).toISOString(),
    endedAt: new Date(index * 1_000 + 1).toISOString(),
    turns: index,
    costUSD: 0,
    exitSummary: "done",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  }));
  await writeFile(indexPath, `${lines.join("\n")}\n`);

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const compacted = (await readFile(indexPath, "utf8")).trim().split("\n").map(JSON.parse);

  assert.equal(compacted.length, 3);
  assert.deepEqual(compacted.map((record) => record.turns), [998, 999, 1_000]);
  assert.equal(dispatcher.list().length, 3);
});

test("dispatcher boots with intact records when oversized-index compaction hits ENOSPC", async (t) => {
  const setup = await fixture(t);
  const dispatchDir = join(setup.state, "dispatches");
  const indexPath = join(dispatchDir, "index.jsonl");
  await mkdir(dispatchDir, { recursive: true });
  const lines = Array.from({ length: 1_001 }, (_, index) => JSON.stringify({
    id: `dispatch-${index % 3}`,
    project: "fixture",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "completed",
    branch: null,
    worktreePath: null,
    startedAt: new Date(index * 1_000).toISOString(),
    endedAt: new Date(index * 1_000 + 1).toISOString(),
    turns: index,
    costUSD: 0,
    exitSummary: "done",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  }));
  await writeFile(indexPath, `${lines.join("\n")}\n`);
  _setPersistenceFileOps({
    appendFileSync,
    writeFileSync(path, contents, options) {
      if (path.includes(".tmp-")) {
        throw Object.assign(new Error("fixture compaction ENOSPC"), { code: "ENOSPC" });
      }
      writeFileSync(path, contents, options);
    },
  });
  const logLines = [];
  _setPersistenceLogger({ error: (line) => logLines.push(line) });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.list().length, 3);
  assert.deepEqual(
    dispatcher.list().map((record) => record.turns).sort((left, right) => left - right),
    [998, 999, 1_000],
  );
  assert.equal((await readFile(indexPath, "utf8")).trim().split("\n").length, 1_001);
  assert.ok(logLines.some((line) =>
    line.includes("could not compact") && line.includes("fixture compaction ENOSPC"),
  ));
  assert.equal((await readdir(dispatchDir)).some((name) => name.includes(".tmp-")), false);
});

test("deregistered project history stays visible; stop and merge still refuse, dismiss does not (atelier-2nx)", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, { project: "removed-project" });
  setup.registry.projects.length = 0;
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(dispatcher.get(seeded.id).projectRemoved, true);
  assert.equal(dispatcher.list()[0].projectRemoved, true);
  assert.equal(dispatcher.rollup().projects[0].projectRemoved, true);

  // stop and merge need project config to do anything (kill a worker inside
  // its worktree, run the merge gate) and still refuse outright.
  for (const operation of ["stop", "merge"]) {
    await assert.rejects(
      dispatcher[operation](seeded.id),
      (error) => error.status === 404 && error.message === "Project removed: removed-project",
    );
  }

  // dismiss only removes the record + worktree/branch artifacts under
  // stateDir, which a deregistered project no longer gates (live case:
  // dispatch 04e2543b, a live project).
  const dismissed = await dispatcher.dismiss(seeded.id);
  assert.ok(dismissed.dismissed);
  assert.equal(dispatcher.get(seeded.id).dismissed !== null, true);
});

test("project-less dismissal never deletes a worktree - it only warns, whatever shape the path has (atelier-2nx: warn-and-leave)", async (t) => {
  // Round 3 architect ruling: after two review rounds narrowed the deletion
  // logic (lexical prefix, then realpath + exact-depth) and still turned up
  // a blocker each time, Atelier stops wielding rm -rf against a path it
  // cannot re-verify ownership of once the project is gone. Every
  // pathological worktreePath shape below must come out UNTOUCHED - this
  // single suite replaces the four narrower containment tests from rounds
  // 1-2, which existed only to justify a deletion primitive that no longer
  // exists.
  const setup = await fixture(t);
  const worktreesRoot = join(setup.state, "worktrees");
  await mkdir(worktreesRoot, { recursive: true });

  // A sibling no scenario's record points at, proving dismissal never
  // reaches beyond the one record it was asked to act on.
  const sibling = join(worktreesRoot, "fixture", "sibling-dispatch");
  await mkdir(sibling, { recursive: true });
  await writeFile(join(sibling, "marker"), "must survive");

  const outsideRoot = await mkdtemp(join(tmpdir(), "atelier-outside-"));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const precious = join(outsideRoot, "precious");
  await writeFile(precious, "do not delete");
  const symlinkedProjectDir = join(worktreesRoot, "escaping-project");
  await symlink(outsideRoot, symlinkedProjectDir, "dir");

  const normalShapePath = join(worktreesRoot, "removed-project", "dispatch-merge");
  await mkdir(normalShapePath, { recursive: true });
  await writeFile(join(normalShapePath, "marker"), "orphaned worktree contents");

  const oneSegmentPath = join(worktreesRoot, "removed-project-shallow");
  await mkdir(oneSegmentPath, { recursive: true });
  await writeFile(join(oneSegmentPath, "marker"), "orphaned worktree contents");

  const scenarios = [
    { id: "normal-shape", worktreePath: normalShapePath },
    { id: "root-itself", worktreePath: worktreesRoot },
    { id: "one-segment", worktreePath: oneSegmentPath },
    { id: "symlink-escape", worktreePath: join(symlinkedProjectDir, "dispatch-merge") },
  ];
  await seedDispatches(setup, scenarios.map(({ id, worktreePath }) => ({
    id,
    project: "removed-project",
    worktreePath,
  })));
  setup.registry.projects.length = 0;
  // Proves zero git/br - not zero reap. dismiss() still unconditionally runs
  // reapCodexProcessTree (merged from atelier-za6's process-tree reaper), but
  // that reads /proc and signals by pid (readProcessTable/signalProcess),
  // never through commandRunner, so it cannot trip this throw. None of these
  // records carry a codexProcessTree anyway, making the reap a same-tick
  // no-op here; atelier-za6's own dismiss+reap tests cover the reap itself.
  _setRunFile(async (file, args) => {
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  for (const scenario of scenarios) {
    const dismissed = await dispatcher.dismiss(scenario.id);
    assert.ok(dismissed.dismissed, `${scenario.id} did not dismiss`);
    const warning = dismissed.warnings.find((candidate) => candidate.includes(scenario.worktreePath));
    assert.ok(warning, `${scenario.id} did not record a warning naming its worktreePath`);
    assert.match(
      warning,
      /^worktree not removed \(project deregistered\): .* — remove manually if desired$/,
    );
  }

  assert.equal(existsSync(worktreesRoot), true);
  assert.equal(existsSync(sibling), true);
  assert.equal(existsSync(join(sibling, "marker")), true);
  assert.equal(existsSync(normalShapePath), true);
  assert.equal(existsSync(join(normalShapePath, "marker")), true);
  assert.equal(existsSync(oneSegmentPath), true);
  assert.equal(existsSync(join(oneSegmentPath, "marker")), true);
  assert.equal(existsSync(precious), true);
});

test("gc surfaces the unremoved-worktree warning in its report (atelier-2nx)", async (t) => {
  const setup = await fixture(t);
  const worktreePath = join(setup.state, "worktrees", "removed-project", "dispatch-merge");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(join(worktreePath, "marker"), "orphaned worktree contents");
  const seeded = await seedDispatch(setup, { project: "removed-project", worktreePath });
  setup.registry.projects.length = 0;
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.gc({ olderThanDays: 0 });

  assert.deepEqual(result.dismissed, [seeded.id]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0],
    new RegExp(`^dispatch ${seeded.id}: worktree not removed \\(project deregistered\\):`),
  );
  assert.equal(existsSync(worktreePath), true);
});

test("dismiss still refuses a non-terminal dispatch even when its project is deregistered (atelier-2nx scope)", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const active = await dispatcher.dispatch({ project: "fixture", prompt: "still active" });
  await waitForState(dispatcher, active.id, ["running"]);

  // Deregister mid-flight: the state gate (409, not yet terminal) must still
  // fire before project resolution ever gets a chance to matter - atelier-2nx
  // only widens the TERMINAL branch, never lets a live dispatch through.
  setup.registry.projects.length = 0;
  await assert.rejects(
    dispatcher.dismiss(active.id),
    (error) =>
      error.status === 409 &&
      /state gate failed: only terminal dispatches can be dismissed/.test(error.message),
  );
  child.complete();
  await waitForState(dispatcher, active.id, ["completed"]);
});

test("gc dismisses a deregistered project's terminal dispatch without recording an error (atelier-2nx)", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, { project: "removed-project" });
  setup.registry.projects.length = 0;
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.gc({ olderThanDays: 0 });

  assert.deepEqual(result.dismissed, [seeded.id]);
  assert.deepEqual(result.errors, []);
  // The record's default worktreePath still names a (never-created) path, so
  // warn-and-leave records it as unremoved rather than silently succeeding.
  assert.equal(result.warnings.length, 1);
});

test("rollup de-duplicates persisted history and sums projects and local days", async (t) => {
  const setup = await fixture(t);
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const base = {
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    branch: null,
    worktreePath: null,
    endedAt: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    warnings: [],
  };
  const records = [
    {
      ...base,
      id: "alpha-completed",
      project: "alpha",
      state: "running",
      startedAt: localStartedAt(1),
      turns: 99,
      costUSD: 99,
    },
    {
      ...base,
      id: "alpha-completed",
      project: "alpha",
      state: "completed",
      startedAt: localStartedAt(1),
      turns: 3,
      costUSD: 1.25,
      merged: { commit: "abc", mergedAt: localStartedAt(0), strategy: "ff" },
    },
    {
      ...base,
      id: "beta-failed",
      project: "beta",
      state: "failed",
      startedAt: localStartedAt(0),
      turns: 4,
      costUSD: 2.5,
    },
    {
      ...base,
      id: "alpha-rejected",
      project: "alpha",
      state: "rejected",
      startedAt: localStartedAt(0),
      turns: 1,
      costUSD: 0.25,
    },
  ];
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.deepEqual(dispatcher.rollup(), {
    projects: [
      {
        project: "alpha",
        projectRemoved: true,
        runs: 2,
        completed: 1,
        failed: 1,
        merged: 1,
        turns: 4,
        costUSD: 1.5,
      },
      {
        project: "beta",
        projectRemoved: true,
        runs: 1,
        completed: 0,
        failed: 1,
        merged: 0,
        turns: 4,
        costUSD: 2.5,
      },
    ],
    days: [
      { day: localDay(1), runs: 1, costUSD: 1.25 },
      { day: localDay(0), runs: 2, costUSD: 2.75 },
    ],
    totals: { runs: 3, turns: 8, costUSD: 4 },
  });
});

test("dispatcher lazily merges persisted dispatches as inert history", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  _setSpawner(() => successfulChild());

  const dispatcherA = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const first = await dispatcherA.dispatch({ project: "fixture", prompt: "first task" });
  const firstRecord = await waitForState(dispatcherA, first.id, ["completed"]);

  const dispatcherB = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(dispatcherB.list().find((record) => record.id === first.id), firstRecord);
  assert.deepEqual(dispatcherB.get(first.id), firstRecord);
  assert.deepEqual(dispatcherB.getEvents(first.id), dispatcherA.getEvents(first.id));
  await assert.rejects(dispatcherB.stop(first.id), /Cannot stop inert dispatch record/);

  const second = await dispatcherA.dispatch({ project: "fixture", prompt: "later task" });
  const secondRecord = await waitForState(dispatcherA, second.id, ["completed"]);
  assert.deepEqual(dispatcherB.list().find((record) => record.id === second.id), secondRecord);
  assert.deepEqual(dispatcherB.get(second.id), secondRecord);
});

test("ticket dispatch claims in br and releases the claim on prepare failure", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCommitTracker: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options) => {
    calls.push({ file, args, cwd: options?.cwd });
    if (args[0] === "update") return "";
    if (args[2] === "diff") throw new Error("staged changes");
    if (args[2] === "worktree") throw new Error("disk full");
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-9" });
  await waitForState(dispatcher, id, ["prepare_failed"]);
  await waitForCondition(
    () => calls.filter((call) => call.file === "git" && call.args[2] === "commit").length === 2,
    "released claim was not committed",
  );
  const claim = calls.find((call) => call.args[0] === "update" && call.args.includes("--claim"));
  assert.deepEqual(claim.args, ["update", "fixture-9", "--claim", "--actor", "atelier"]);
  assert.equal(claim.cwd, setup.primary);
  const release = calls.find((call) => call.args[0] === "update" && call.args.includes("--status"));
  assert.deepEqual(release.args, ["update", "fixture-9", "--status", "open"]);
  assert.equal(release.cwd, setup.primary);
  assert.deepEqual(
    calls.filter((call) => call.file === "git" && call.args[2] === "commit")
      .map((call) => call.args[4]),
    [
      "chore(tracker): claim fixture-9 [atelier]",
      "chore(tracker): release fixture-9 [atelier]",
    ],
  );
});

test("duplicate active ticket dispatches 409 and terminal history permits redispatch", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const calls = [];
  stubTrackedPreparation(setup, calls);
  const firstChild = heldChild();
  _setSpawner(() => firstChild);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const first = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-duplicate" });
  await waitForState(dispatcher, first.id, ["running"]);

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", ticketId: "fixture-duplicate" }),
    (error) =>
      error.status === 409 &&
      error.message === `ticket already being worked by dispatch ${first.id}`,
  );
  assert.equal(
    calls.filter((call) => call.file === "/fixture/br" && call.args.includes("--claim")).length,
    1,
  );

  firstChild.complete();
  await waitForState(dispatcher, first.id, ["completed"]);
  _setSpawner(() => successfulChild());
  const redispatched = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-duplicate",
  });
  await waitForState(dispatcher, redispatched.id, ["completed"]);
  assert.equal(
    calls.filter((call) => call.file === "/fixture/br" && call.args.includes("--claim")).length,
    2,
  );
});

test("failed and stopped dispatches release claims while completed dispatches keep them", async (t) => {
  const failedSetup = await fixture(t, { tracker: "committed" });
  const failedCalls = [];
  stubTrackedPreparation(failedSetup, failedCalls);
  _setSpawner(() => failedChild());
  const failedDispatcher = createDispatcher({
    registry: failedSetup.registry,
    stateDir: failedSetup.state,
  });
  const failed = await failedDispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-failed",
  });
  await waitForState(failedDispatcher, failed.id, ["failed"]);
  await waitForCondition(
    () => failedCalls.some((call) => call.args.includes("--status")),
    "failed dispatch claim was not released",
  );
  assert.ok(
    failedCalls.some(
      (call) =>
        call.file === "/fixture/br" &&
        call.args.join("\0") ===
          ["update", "fixture-failed", "--status", "open"].join("\0"),
    ),
  );

  const completedSetup = await fixture(t, { tracker: "committed" });
  const completedCalls = [];
  stubTrackedPreparation(completedSetup, completedCalls);
  _setSpawner(() => successfulChild());
  const completedDispatcher = createDispatcher({
    registry: completedSetup.registry,
    stateDir: completedSetup.state,
  });
  const completed = await completedDispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-completed",
  });
  await waitForState(completedDispatcher, completed.id, ["completed"]);
  assert.equal(
    completedCalls.some((call) => call.args.includes("--status")),
    false,
  );

  const stoppedSetup = await fixture(t, { tracker: "committed" });
  const stoppedCalls = [];
  stubTrackedPreparation(stoppedSetup, stoppedCalls);
  const child = heldChild();
  _setSpawner(() => child);
  const stoppedDispatcher = createDispatcher({
    registry: stoppedSetup.registry,
    stateDir: stoppedSetup.state,
  });
  const stopped = await stoppedDispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-stopped",
  });
  await waitForState(stoppedDispatcher, stopped.id, ["running"]);
  await stoppedDispatcher.stop(stopped.id);
  child.complete();
  await waitForState(stoppedDispatcher, stopped.id, ["stopped"]);
  await waitForCondition(
    () => stoppedCalls.some((call) => call.args.includes("--status")),
    "stopped dispatch claim was not released",
  );
  assert.ok(
    stoppedCalls.some(
      (call) =>
        call.file === "/fixture/br" &&
        call.args.join("\0") ===
          ["update", "fixture-stopped", "--status", "open"].join("\0"),
    ),
  );
});

test("boot recovery heals queued and stopping records and releases known-project claims", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const base = {
    project: "fixture",
    ticketId: "fixture-boot",
    model: "haiku",
    effort: null,
    lane: "claude",
    branch: "atelier/boot",
    worktreePath: join(setup.state, "worktrees", "fixture", "boot"),
    startedAt: "2026-07-21T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  const records = [
    { ...base, id: "boot-queued", state: "queued", ticketId: "fixture-queued" },
    { ...base, id: "boot-resuming", state: "resuming", ticketId: "fixture-resuming" },
    { ...base, id: "boot-stopping", state: "stopping", ticketId: "fixture-stopping" },
    { ...base, id: "boot-gone", project: "gone", state: "queued", ticketId: "gone-1" },
  ];
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  await waitForCondition(
    () => calls.filter((call) => call.args[0] === "update").length === 3,
    "boot claims were not released",
  );

  for (const id of ["boot-queued", "boot-resuming", "boot-stopping", "boot-gone"]) {
    const record = dispatcher.get(id);
    assert.equal(record.state, "failed");
    assert.equal(record.exitSummary, "server restart");
  }
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["update", "fixture-queued", "--status", "open"],
      ["update", "fixture-resuming", "--status", "open"],
      ["update", "fixture-stopping", "--status", "open"],
    ],
  );
  assert.deepEqual(dispatcher.get("boot-gone").warnings, []);
});

test("boot recovery reattaches a still-running codex job instead of failing it (zero-cost restart)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex reattach liveness uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "reattach-running");
  const record = {
    id: "boot-codex-running",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/reattach-running",
    worktreePath,
    codexJobId: "codex-job-live",
    codexWorkspace: worktreePath,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
    // A prior boot's live polling already corroborated this exact pid
    // (atelier-tzw finding 4: reattach can only EXTEND an identity Atelier's own
    // poller established, never adopt a bare /proc-alive pid fresh).
    codexWorkerPid: process.pid,
    codexWorkerPidIdentity: processStartIdentity(process.pid),
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  const statusCalls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      statusCalls.push(args[2]);
      return JSON.stringify({ status: "running", job: { status: "running", pid: process.pid } });
    }
    throw new Error(`unexpected command during a live reattach: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => statusCalls.includes("codex-job-live"),
    "boot did not poll the reattached companion job",
  );

  const reattached = dispatcher.get("boot-codex-running");
  assert.equal(reattached.state, "running");
  assert.equal(reattached.exitSummary, "");
  const persisted = rawRecord(setup, "boot-codex-running");
  assert.equal(persisted.codexJobId, "codex-job-live");
  assert.equal(persisted.codexWorkerPid, process.pid);
  assert.match(persisted.codexWorkerPidIdentity, /^linux-proc-start:/);
});

test("boot recovery honors a codex job that completed during downtime through the normal finish pipeline", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "reattach-completed");
  const record = {
    id: "boot-codex-completed",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/reattach-completed",
    worktreePath,
    codexJobId: "codex-job-done",
    codexWorkspace: worktreePath,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "implemented while Atelier was down" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "implemented while Atelier was down" } });
    }
    if (file === "git") return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-completed")?.state === "completed",
    "a codex job that finished during downtime did not reach completed via the normal finish pipeline",
  );

  assert.equal(dispatcher.get("boot-codex-completed").exitSummary, "implemented while Atelier was down");
});

test("boot reattach fails closed and releases the claim when the reported codex worker pid is missing (finding 1)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "reattach-dead");
  const record = {
    id: "boot-codex-dead",
    project: "fixture",
    ticketId: "fixture-dead",
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/reattach-dead",
    worktreePath,
    codexJobId: "codex-job-dead",
    codexWorkspace: worktreePath,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      // The companion job store still says "running" (it never recorded a
      // clean exit) but reports no usable pid - the old behavior treated an
      // unverifiable pid as "still alive by default"; it must fail closed.
      return JSON.stringify({ status: "running", job: { status: "running", pid: null } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-dead")?.state === "failed",
    "reattach to a worker with no verifiable pid did not fail closed",
  );
  // The state flips to "failed" synchronously with the transition, but claim
  // release is awaited afterward inside finish() - wait for the actual br
  // call rather than racing it via the state alone.
  await waitForCondition(
    () => calls.some((call) =>
      call.file === "/fixture/br" &&
      call.args.join("\0") === ["update", "fixture-dead", "--status", "open"].join("\0")),
    "the dead codex worker's ticket claim was not released",
  );

  const failed = dispatcher.get("boot-codex-dead");
  assert.match(failed.exitSummary, /worker lost during downtime/);
});

test("boot reattach fails closed on a PID the OS has reused for an unrelated process", async (t) => {
  if (process.platform !== "linux") {
    t.skip("PID-reuse fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "reattach-reused-pid");
  const record = {
    id: "boot-codex-reused-pid",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/reattach-reused-pid",
    worktreePath,
    codexJobId: "codex-job-reused",
    codexWorkspace: worktreePath,
    // A prior boot captured this exact pid under a DIFFERENT process
    // identity - the live process at this pid right now (the test runner
    // itself) is unrelated, so the reported worker must not be trusted just
    // because kill(pid, 0) would succeed.
    codexWorkerPid: process.pid,
    codexWorkerPidIdentity: "linux-proc-start:00000000-0000-0000-0000-000000000000:1",
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "running", job: { status: "running", pid: process.pid } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-reused-pid")?.state === "failed",
    "reattach to a pid with a mismatched persisted identity did not fail closed",
  );
  assert.match(dispatcher.get("boot-codex-reused-pid").exitSummary, /worker lost during downtime/);
});

test("a claude dispatch marked resume-ready after a restart resumes via reply(), reclaiming its ticket", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "resume-ready");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "boot-claude-resume-ready",
    project: "fixture",
    ticketId: "fixture-resume",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "failed",
    branch: "atelier/resume-ready",
    worktreePath,
    sessionId: "captured-session",
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 3,
    costUSD: 0.1,
    exitSummary: "server restart",
    restartResumeReady: true,
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args });
    return "";
  });
  _setSpawner(() => claudeResultChild({ sessionId: "captured-session", summary: "resumed cleanly" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const result = await dispatcher.reply("boot-claude-resume-ready", { text: "please resume" });
  assert.equal(result.restartResumeReady, false);
  await waitForState(dispatcher, "boot-claude-resume-ready", ["completed", "failed"]);

  assert.equal(dispatcher.get("boot-claude-resume-ready").state, "completed");
  assert.ok(
    calls.some((call) =>
      call.file === "/fixture/br" &&
      call.args.join("\0") === ["update", "fixture-resume", "--claim", "--actor", "atelier"].join("\0")),
    "resume did not reclaim the ticket before resuming",
  );
});

test("reply() re-checks the restart resume ticket claim on every attempt - a second reply never bypasses a conflict (finding 2)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "resume-conflict");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "boot-claude-conflict",
    project: "fixture",
    ticketId: "fixture-conflict",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "failed",
    branch: "atelier/resume-conflict",
    worktreePath,
    sessionId: "captured-session",
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 3,
    costUSD: 0.1,
    exitSummary: "server restart",
    restartResumeReady: true,
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  stubPreparation();
  _setSpawner(() => heldChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  // A second, still-active dispatch claims the SAME ticket after the restart
  // (e.g. the human re-dispatched it manually before noticing the resume
  // affordance) - this is the conflict reply() must detect and refuse, on
  // every attempt, not just the first.
  const conflicting = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-conflict" });
  await waitForState(dispatcher, conflicting.id, ["running"]);

  await assert.rejects(
    dispatcher.reply("boot-claude-conflict", { text: "resume attempt 1" }),
    /Restart resume conflict/,
  );
  assert.equal(dispatcher.get("boot-claude-conflict").restartResumeReady, true);
  assert.equal(dispatcher.get("boot-claude-conflict").state, "failed");

  await assert.rejects(
    dispatcher.reply("boot-claude-conflict", { text: "resume attempt 2" }),
    /Restart resume conflict/,
  );
  assert.equal(dispatcher.get("boot-claude-conflict").restartResumeReady, true);
  assert.equal(dispatcher.get("boot-claude-conflict").state, "failed");
});

test("a drain lease blocks dispatch() and the reply() resume transition until released (finding 3)", async (t) => {
  const setup = await fixture(t, {});
  stubPreparation();
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "lease-reply");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${JSON.stringify({
      id: "lease-reply-target",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "completed",
      branch: "atelier/lease-reply",
      worktreePath,
      sessionId: "lease-session",
      startedAt: "2026-07-29T08:00:00.000Z",
      endedAt: "2026-07-29T08:01:00.000Z",
      turns: 1,
      costUSD: 0.1,
      exitSummary: "done",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const lease = dispatcher.acquireDrainLease({ ttlMs: 5_000 });
  assert.ok(lease.token);

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "blocked by the drain lease" }),
    /drain lease/,
  );
  await assert.rejects(
    dispatcher.reply("lease-reply-target", { text: "blocked while draining" }),
    /drain lease/,
  );
  assert.equal(dispatcher.get("lease-reply-target").state, "completed");

  assert.throws(() => dispatcher.acquireDrainLease({ ttlMs: 1_000 }), /already held/);
  assert.equal(dispatcher.releaseDrainLease(lease.token), true);

  const created = await dispatcher.dispatch({ project: "fixture", prompt: "allowed after release" });
  assert.ok(created.id);
  await waitForState(dispatcher, created.id, ["running"]);
});

test("acquireDrainLease refuses while any dispatch is active, naming it", async (t) => {
  const setup = await fixture(t, {}, { concurrentDispatchCap: 2 });
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const active = await dispatcher.dispatch({ project: "fixture", prompt: "keeps the lease refused" });
  await waitForState(dispatcher, active.id, ["running"]);

  assert.throws(
    () => dispatcher.acquireDrainLease(),
    new RegExp(`active dispatch.*${active.id}`),
  );

  child.complete();
  await waitForState(dispatcher, active.id, ["completed"]);
  const lease = dispatcher.acquireDrainLease();
  assert.ok(lease.token);
});

test("resuming a codex dispatch clears the old codexJobId atomically with the resuming transition (finding 4)", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-resume-race");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${JSON.stringify({
      id: "codex-resume-race",
      project: "fixture",
      ticketId: null,
      model: "codex-default",
      effort: null,
      lane: "codex",
      state: "completed",
      branch: "atelier/codex-resume-race",
      worktreePath,
      sessionId: "codex-thread-1",
      codexJobId: "codex-job-OLD-completed",
      codexWorkspace: worktreePath,
      startedAt: "2026-07-29T08:00:00.000Z",
      endedAt: "2026-07-29T08:01:00.000Z",
      turns: 1,
      costUSD: 0,
      exitSummary: "first turn done",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  let releaseNewLaunch;
  const newLaunchStarted = new Promise((resolvePromise) => {
    releaseNewLaunch = resolvePromise;
  });
  _setSpawner(() => codexLaunchChild("codex-job-NEW", () => {
    releaseNewLaunch();
    return new Promise(() => {}); // never resolves - the new turn stays "launching"
  }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const replyPromise = dispatcher.reply("codex-resume-race", { text: "one more thing" });
  await waitForState(dispatcher, "codex-resume-race", ["resuming"]);
  await newLaunchStarted;

  const midResume = dispatcher.get("codex-resume-race");
  assert.equal(midResume.state, "resuming");
  const persisted = rawRecord(setup, "codex-resume-race");
  assert.equal(
    persisted.codexJobId,
    null,
    "a restart mid-resume must not see the OLD completed job as reattachable",
  );
  assert.equal(persisted.codexWorkspace, null);

  void replyPromise.catch(() => {});
});

// --- atelier-tzw review round 2 ---------------------------------------------

test("boot recovery reaps an identity-matched orphaned claude worker before releasing its claim (finding 1)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const orphan = spawnAliveProcess(t);
  await orphan.ready;
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "claude-orphan");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "boot-claude-orphan",
    project: "fixture",
    ticketId: "fixture-orphan",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "running",
    branch: "atelier/claude-orphan",
    worktreePath,
    sessionId: "orphan-session",
    childPid: orphan.child.pid,
    childPidIdentity: processStartIdentity(orphan.child.pid),
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 200,
  });
  await orphan.exitPromise;
  await waitForConditionOverTime(
    () => dispatcher.get("boot-claude-orphan")?.state === "failed",
    "boot did not fail the reaped orphan's record",
  );
  await waitForConditionOverTime(
    () => calls.some((call) =>
      call.file === "/fixture/br" &&
      call.args.join("\0") === ["update", "fixture-orphan", "--status", "open"].join("\0")),
    "the reaped orphan's ticket claim was not released",
  );
  assert.equal(dispatcher.get("boot-claude-orphan").restartResumeReady, true);
  // Killed by signal (SIGTERM), not a normal exit - exitCode stays null;
  // signalCode is what actually proves it died.
  assert.notEqual(orphan.child.signalCode, null);
});

test("boot recovery never signals a claude worker pid the OS has reused, and still marks the record failed (finding 1)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const unrelated = spawnAliveProcess(t, { trapSigterm: true });
  await unrelated.ready;
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "claude-reused-pid");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "boot-claude-reused-pid",
    project: "fixture",
    ticketId: "fixture-reused",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "running",
    branch: "atelier/claude-reused-pid",
    worktreePath,
    sessionId: "reused-session",
    childPid: unrelated.child.pid,
    childPidIdentity: "linux-proc-start:00000000-0000-0000-0000-000000000000:1",
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("boot-claude-reused-pid")?.state === "failed",
    "boot did not mark the record failed",
  );
  await waitForConditionOverTime(
    () => calls.some((call) =>
      call.file === "/fixture/br" &&
      call.args.join("\0") === ["update", "fixture-reused", "--status", "open"].join("\0")),
    "the claim was not released",
  );
  assert.equal(unrelated.child.exitCode, null);
  assert.equal(unrelated.child.signalCode, null);
  assert.doesNotMatch(unrelated.output(), /SIGTERM/);
  assert.equal(dispatcher.get("boot-claude-reused-pid").restartResumeReady, true);
});

test("reply() refuses to resume when a prior worker is still alive and cannot be stopped (finding 1)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const alive = spawnAliveProcess(t);
  await alive.ready;
  _setFencedProcessSignal(() => {}); // simulate a kill signal that never actually lands
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "unkillable-orphan");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "resume-unkillable",
    project: "fixture",
    ticketId: "fixture-unkillable",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "failed",
    branch: "atelier/unkillable-orphan",
    worktreePath,
    sessionId: "unkillable-session",
    childPid: alive.child.pid,
    childPidIdentity: processStartIdentity(alive.child.pid),
    restartResumeReady: true,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 1,
    costUSD: 0,
    exitSummary: "server restart",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async () => "");
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });

  await assert.rejects(
    dispatcher.reply("resume-unkillable", { text: "please resume" }),
    /still running and could not be stopped/,
  );
  assert.equal(dispatcher.get("resume-unkillable").state, "failed");
  assert.equal(alive.child.exitCode, null);
});

test("reply() resumes normally once a prior worker is proven dead (finding 1)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const toExit = spawnAliveProcess(t);
  await toExit.ready;
  const deadPid = toExit.child.pid;
  const deadIdentity = processStartIdentity(deadPid);
  process.kill(-deadPid, "SIGKILL");
  await toExit.exitPromise;

  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "dead-orphan");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "resume-dead-orphan",
    project: "fixture",
    ticketId: "fixture-dead-orphan",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "failed",
    branch: "atelier/dead-orphan",
    worktreePath,
    sessionId: "dead-orphan-session",
    childPid: deadPid,
    childPidIdentity: deadIdentity,
    restartResumeReady: true,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 1,
    costUSD: 0,
    exitSummary: "server restart",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  _setRunFile(withDispatchChanges(async () => ""));
  _setSpawner(() => claudeResultChild({ sessionId: "dead-orphan-session", summary: "resumed" }));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const result = await dispatcher.reply("resume-dead-orphan", { text: "please resume" });
  assert.equal(result.state, "running");
  // claudeResultChild finishes asynchronously (setImmediate) after reply()
  // already returns - let it fully settle before the fixture tears down the
  // temp directory out from under it.
  await waitForState(dispatcher, "resume-dead-orphan", ["completed", "failed"]);
});

test("acquireDrainLease refuses while a dispatch's claim is in flight, and the dispatch proceeds normally once released (finding 2)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const child = heldChild();
  _setSpawner(() => child);
  let releaseClaimCall;
  const claimGate = new Promise((resolvePromise) => {
    releaseClaimCall = resolvePromise;
  });
  let claimCallSeen = false;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "update" && args.includes("--claim")) {
      claimCallSeen = true;
      await claimGate;
      return "";
    }
    if (["update", "ready", "sync"].includes(args[0])) return "";
    assert.equal(file, "git");
    if (args[2] === "status" || args[2] === "log") return "";
    assert.deepEqual(args.slice(0, 5), ["-C", args[1], "worktree", "add", "-b"]);
    await mkdir(args[6], { recursive: true });
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const dispatchPromise = dispatcher.dispatch({ project: "fixture", ticketId: "fixture-inflight" });
  await waitForCondition(() => claimCallSeen, "claimTicket did not start");

  assert.throws(() => dispatcher.acquireDrainLease(), /admission.*in flight/);

  releaseClaimCall();
  const created = await dispatchPromise;
  await waitForState(dispatcher, created.id, ["running"]);

  // Still genuinely active - the lease correctly stays refused until the
  // dispatch actually finishes, not just once its claim is no longer
  // in flight.
  assert.throws(() => dispatcher.acquireDrainLease(), /active dispatch/);
  child.complete("finished");
  await waitForState(dispatcher, created.id, ["completed"]);

  const lease = dispatcher.acquireDrainLease();
  assert.ok(lease.token);
});

test("a failed resume (spawn failure) leaves restartResumeReady armed for a successful second attempt (finding 3)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "resume-spawn-fail");
  await mkdir(worktreePath, { recursive: true });
  const record = {
    id: "boot-claude-spawn-fail",
    project: "fixture",
    ticketId: "fixture-spawn-fail",
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "failed",
    branch: "atelier/resume-spawn-fail",
    worktreePath,
    sessionId: "spawn-fail-session",
    restartResumeReady: true,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 1,
    costUSD: 0,
    exitSummary: "server restart",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args });
    return "";
  });
  let attempt = 0;
  _setSpawner(() => {
    attempt += 1;
    if (attempt === 1) throw new Error("spawn failed deliberately");
    return claudeResultChild({ sessionId: "spawn-fail-session", summary: "resumed on second try" });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await assert.rejects(
    dispatcher.reply("boot-claude-spawn-fail", { text: "attempt 1" }),
    /spawn failed deliberately/,
  );
  assert.equal(dispatcher.get("boot-claude-spawn-fail").restartResumeReady, true);
  assert.equal(dispatcher.get("boot-claude-spawn-fail").state, "failed");

  const result = await dispatcher.reply("boot-claude-spawn-fail", { text: "attempt 2" });
  assert.equal(result.state, "running");
  assert.equal(result.restartResumeReady, false);
  assert.ok(
    calls.filter((call) =>
      call.file === "/fixture/br" &&
      call.args.join("\0") === ["update", "fixture-spawn-fail", "--claim", "--actor", "atelier"].join("\0"),
    ).length >= 2,
    "the second attempt did not re-run the full reclaim",
  );
  // claudeResultChild finishes asynchronously (setImmediate) after reply()
  // already returns - let it fully settle before the fixture tears down.
  await waitForState(dispatcher, "boot-claude-spawn-fail", ["completed", "failed"]);
});

test("boot reattach on a live pid it cannot corroborate goes UNRESOLVED, keeping the claim (finding 4 / round-4 I1a)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex reattach liveness uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "reattach-no-corroboration");
  const record = {
    id: "boot-codex-no-corroboration",
    project: "fixture",
    ticketId: "fixture-no-corroboration",
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/reattach-no-corroboration",
    worktreePath,
    codexJobId: "codex-job-no-corroboration",
    codexWorkspace: worktreePath,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "running", job: { status: "running", pid: process.pid } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-no-corroboration")?.state === "failed",
    "reattach with no prior corroboration trusted a bare-alive pid",
  );

  // It still fails closed - it must never keep polling a job it cannot vouch
  // for - but round 4 corrects WHERE it fails to. The reported pid is a live
  // process; Atelier simply cannot tell whether it is this dispatch's worker. That
  // is not death, so the claim stays held, the pid is recorded as an
  // uncorroborated fence (deliberately with no identity: reattach may extend
  // trust, never mint it), and the ticket stays blocked.
  const settled = dispatcher.get("boot-codex-no-corroboration");
  assert.match(settled.exitSummary, /could not be confirmed alive or dead/);
  assert.equal(settled.orphanUnresolved, true);
  assert.equal(settled.restartResumeReady, false);
  const persisted = rawRecord(setup, "boot-codex-no-corroboration");
  assert.equal(persisted.codexWorkerPid, process.pid);
  assert.equal(persisted.codexWorkerPidIdentity, null);
  assert.equal(
    claimReleased(calls, "fixture-no-corroboration"),
    false,
    "an uncorroborated live worker released its claim",
  );
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", ticketId: "fixture-no-corroboration" }),
    /has not proven dead/,
  );
});

test("a verify:false codex job that completes during downtime runs no verification (finding 5)", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "verify-false-downtime");
  const record = {
    id: "boot-codex-verify-false",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/verify-false-downtime",
    worktreePath,
    codexJobId: "codex-job-verify-false",
    codexWorkspace: worktreePath,
    verifyRequested: false,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  let spawnedVerify = false;
  _setSpawner(() => {
    spawnedVerify = true;
    return verifyChild({ code: 0 });
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "done while down" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "done while down" } });
    }
    assert.equal(file, "git");
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-verify-false")?.state === "completed",
    "verify:false reattach did not complete",
  );
  assert.equal(dispatcher.get("boot-codex-verify-false").verify.state, "skipped");
  assert.equal(spawnedVerify, false, "verify:false must never spawn a verify command after a downtime completion");
});

test("a verify:true codex job that completes during downtime still runs verification (finding 5)", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "verify-true-downtime");
  const record = {
    id: "boot-codex-verify-true",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/verify-true-downtime",
    worktreePath,
    codexJobId: "codex-job-verify-true",
    codexWorkspace: worktreePath,
    verifyRequested: true,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  let verifyRan = false;
  _setSpawner(() => {
    verifyRan = true;
    return verifyChild({ code: 0 });
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "done while down" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "done while down" } });
    }
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "remove") return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") return `${FIXTURE_RESULT_TREE}\n`;
    if (args[2] === "rev-parse") return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-list") return "0\n";
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-codex-verify-true")?.state === "completed",
    "verify:true reattach did not complete",
  );
  assert.ok(verifyRan, "verify:true must still run verification after a downtime completion");
  assert.equal(dispatcher.get("boot-codex-verify-true").verify.state, "passed");
});

test("an unrecognized companion status fails closed, but only releases the claim when the worker is proven gone (finding 6 / round-5 item 1)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const codexRecord = (id, ticketId) => ({
    id,
    project: "fixture",
    ticketId,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: `atelier/${id}`,
    worktreePath: join(setup.state, "worktrees", "fixture", id),
    codexJobId: `codex-job-${id}`,
    codexWorkspace: join(setup.state, "worktrees", "fixture", id),
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${[
      codexRecord("boot-codex-bad-status", "fixture-bad-status"),
      codexRecord("boot-codex-bad-status-gone", "fixture-bad-status-gone"),
    ].map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      // Round 3/4 returned here BEFORE looking at the reported pid at all, so a
      // live worker's ticket was freed on the strength of a status string this
      // adapter does not even understand.
      return args[2] === "codex-job-boot-codex-bad-status"
        ? JSON.stringify({ status: "sleeping", job: { status: "sleeping", pid: process.pid } })
        : JSON.stringify({ status: "sleeping", job: { status: "sleeping", pid: null } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  // Control: an unrecognized status with nothing alive to point at still fails
  // closed AND releases, exactly as before.
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-bad-status-gone"),
    "an unrecognized status with no reported worker did not release its claim",
  );
  assert.match(
    dispatcher.get("boot-codex-bad-status-gone").exitSummary,
    /unrecognized status/,
  );

  // The live-pid shape: still fails closed - it must never keep polling a status
  // it cannot interpret - but failing closed now means proving death first.
  const fenced = dispatcher.get("boot-codex-bad-status");
  assert.equal(fenced.state, "failed");
  assert.match(fenced.exitSummary, /unrecognized status.*could not be confirmed dead/);
  assert.equal(fenced.orphanUnresolved, true);
  const persisted = rawRecord(setup, "boot-codex-bad-status");
  assert.equal(persisted.codexWorkerPid, process.pid);
  assert.equal(persisted.codexWorkerPidIdentity, null);
  assert.equal(
    claimReleased(calls, "fixture-bad-status"),
    false,
    "an unrecognized status released the claim of a worker that is still alive",
  );
});

test("dispatch()/reply()/plan()/drainQueuesOnce() refuse once shutdown() has been called (finding 7a)", async (t) => {
  const setup = await fixture(t, {});
  stubPreparation();
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "shutdown-guard");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${JSON.stringify({
      id: "shutdown-guard-target",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "completed",
      branch: "atelier/shutdown-guard",
      worktreePath,
      sessionId: "shutdown-guard-session",
      startedAt: "2026-07-29T08:00:00.000Z",
      endedAt: "2026-07-29T08:01:00.000Z",
      turns: 1,
      costUSD: 0.1,
      exitSummary: "done",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${readFileSync(join(dispatchDir, "index.jsonl"), "utf8")}${JSON.stringify({
      id: "shutdown-guard-plan",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "plan_ready",
      branch: "atelier/shutdown-guard-plan",
      worktreePath,
      sessionId: "shutdown-guard-plan-session",
      plan: { state: "ready", text: "do the thing" },
      startedAt: "2026-07-29T08:00:00.000Z",
      endedAt: null,
      turns: 1,
      costUSD: 0.1,
      exitSummary: "",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const shutdownPromise = dispatcher.shutdown({ graceMs: 10 });

  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "blocked by shutdown" }),
    /shutting down/,
  );
  await assert.rejects(
    dispatcher.reply("shutdown-guard-target", { text: "blocked by shutdown" }),
    /shutting down/,
  );
  await assert.rejects(
    dispatcher.plan("shutdown-guard-plan", { action: "approve" }),
    /shutting down/,
  );
  assert.equal(dispatcher.get("shutdown-guard-plan").state, "plan_ready");
  await dispatcher.drainQueuesOnce(); // must not throw - a silent no-op
  await shutdownPromise;
});

test("boot recovery fails a malformed-lane record honestly instead of throwing out of createDispatcher (finding 7b)", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const record = {
    id: "boot-malformed-lane",
    project: "fixture",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "not-a-real-lane",
    state: "running",
    branch: "atelier/malformed-lane",
    worktreePath: join(setup.state, "worktrees", "fixture", "malformed-lane"),
    sessionId: null,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.get("boot-malformed-lane")?.state === "failed",
    "a malformed lane crashed or hung boot recovery instead of failing that record",
  );
  assert.equal(dispatcher.get("boot-malformed-lane").restartResumeReady, false);
});

test("boot recovery and shutdown() both SET restartResumeReady through the real dispatch lifecycle, not hand-written fixtures (finding 7c)", async (t) => {
  const setup = await fixture(t, {});
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const created = await dispatcher.dispatch({
    project: "fixture",
    prompt: "restart survival producer test",
  });
  await waitForState(dispatcher, created.id, ["running"]);
  child.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      model: "fixture-model",
      session_id: "producer-session",
    })}\n`,
  );
  await waitForCondition(
    () => dispatcher.get(created.id)?.sessionId === "producer-session",
    "sessionId was never captured on the live entry",
  );

  // Producer 1: the graceful shutdown sweep.
  await dispatcher.shutdown({ graceMs: 200 });

  const afterShutdown = dispatcher.get(created.id);
  assert.equal(afterShutdown.state, "failed");
  assert.equal(afterShutdown.restartResumeReady, true);

  // Producer 2: boot recovery. An UNCLEAN death leaves the record "running" on
  // disk with no sweep having touched it, so re-arm the on-disk state to what
  // the live entry looked like before the sweep and boot a second dispatcher
  // over the SAME stateDir - the only way this assertion goes through the real
  // boot lifecycle rather than a hand-written fixture.
  const unclean = { ...rawRecord(setup, created.id), state: "running", endedAt: null, exitSummary: "", restartResumeReady: false };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(unclean)}\n`,
  );
  const rebooted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => rebooted.get(created.id)?.state === "failed",
    "boot recovery never settled the uncleanly-killed record",
  );
  const afterBoot = rebooted.get(created.id);
  assert.equal(afterBoot.exitSummary, "server restart");
  assert.equal(afterBoot.restartResumeReady, true);
});

test("shutdown() is lane-asymmetric through the real dispatch lifecycle: codex is detached, claude is terminated and resume-ready (finding 7d)", async (t) => {
  const setup = await fixture(t, { tracker: "none" }, { concurrentDispatchCap: 4 });
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const claudeChild = heldChild();
  let codexLaunchCompleted;
  const codexReady = new Promise((resolvePromise) => {
    codexLaunchCompleted = resolvePromise;
  });
  _setSpawner((file) => {
    if (file === "claude") return claudeChild;
    return codexLaunchChild("codex-job-shutdown-sweep", () => {
      codexLaunchCompleted();
    });
  });
  _setRunFile(async (file, args) => {
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const claudeCreated = await dispatcher.dispatch({
    project: "fixture",
    prompt: "claude side of the sweep",
  });
  await waitForState(dispatcher, claudeCreated.id, ["running"]);
  claudeChild.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      model: "fixture-model",
      session_id: "sweep-session",
    })}\n`,
  );
  await waitForCondition(
    () => dispatcher.get(claudeCreated.id)?.sessionId === "sweep-session",
    "claude sessionId not captured",
  );

  const codexCreated = await dispatcher.dispatch({
    project: "fixture",
    prompt: "codex side of the sweep",
    lane: "codex",
  });
  await codexReady;
  await waitForState(dispatcher, codexCreated.id, ["running"]);

  await dispatcher.shutdown({ graceMs: 200 });

  const claudeAfter = dispatcher.get(claudeCreated.id);
  assert.equal(claudeAfter.state, "failed");
  assert.equal(claudeAfter.restartResumeReady, true);

  const codexAfter = dispatcher.get(codexCreated.id);
  assert.equal(codexAfter.state, "running");
  assert.equal(rawRecord(setup, codexCreated.id).codexJobId, "codex-job-shutdown-sweep");
});

test("a drain lease blocks plan() continuation (finding 7e)", async (t) => {
  const setup = await fixture(t, {});
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = join(setup.state, "worktrees", "fixture", "lease-plan");
  await mkdir(worktreePath, { recursive: true });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${JSON.stringify({
      id: "lease-plan-target",
      project: "fixture",
      ticketId: null,
      model: "haiku",
      effort: null,
      lane: "claude",
      state: "plan_ready",
      branch: "atelier/lease-plan",
      worktreePath,
      sessionId: "lease-plan-session",
      plan: { state: "ready", text: "do the thing" },
      startedAt: "2026-07-29T08:00:00.000Z",
      endedAt: null,
      turns: 1,
      costUSD: 0.1,
      exitSummary: "",
      strandedBrWrites: false,
      verify: null,
      merged: null,
      dismissed: null,
      warnings: [],
    })}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const lease = dispatcher.acquireDrainLease();
  assert.ok(lease.token);

  await assert.rejects(
    dispatcher.plan("lease-plan-target", { action: "approve" }),
    /drain lease/,
  );
  assert.equal(dispatcher.get("lease-plan-target").state, "plan_ready");
  assert.equal(dispatcher.releaseDrainLease(lease.token), true);
});

// --- atelier-tzw review round 3: "cannot confirm death" is not death ---------

async function seedIndex(setup, records) {
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  await writeFile(
    join(dispatchDir, "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return records;
}

function fencedRecord(setup, overrides) {
  const id = overrides.id ?? "fenced-record";
  return {
    id,
    project: "fixture",
    ticketId: null,
    model: "haiku",
    effort: null,
    lane: "claude",
    state: "running",
    branch: `atelier/${id}`,
    worktreePath: join(setup.state, "worktrees", "fixture", id),
    sessionId: `${id}-session`,
    startedAt: "2026-07-30T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
    ...overrides,
  };
}

function claimReleased(calls, ticketId) {
  return calls.some((call) =>
    call.file === "/fixture/br" &&
    call.args.join("\0") === ["update", ticketId, "--status", "open"].join("\0"));
}

function claimTaken(calls, ticketId) {
  return calls.filter((call) =>
    call.file === "/fixture/br" &&
    call.args.join("\0") === ["update", ticketId, "--claim", "--actor", "atelier"].join("\0")).length;
}

test("boot keeps the fence, the claim and the ticket blocked when a live worker's identity cannot be corroborated (I1/I3)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const uncorroborated = spawnAliveProcess(t, { trapSigterm: true });
  await uncorroborated.ready;
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-uncorroborated",
      ticketId: "fixture-uncorroborated",
      childPid: uncorroborated.child.pid,
      // The crash window: the pid reached the record but the identity did not
      // (equally: a host with no /proc). Round 2 read a missing identity as
      // "not a match, therefore dead" and released the claim.
      childPidIdentity: null,
    }),
    fencedRecord(setup, {
      id: "orphan-control",
      ticketId: "fixture-control",
      state: "queued",
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  // The control record's boot chain is the uncorroborated one's chain PLUS the
  // claim release, and both start in the same tick - so once the control
  // release lands, the uncorroborated record has provably finished settling.
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-control"),
    "boot never settled the control record",
  );

  const record = dispatcher.get("orphan-uncorroborated");
  assert.equal(record.state, "failed");
  assert.match(record.exitSummary, /could not be confirmed dead/);
  assert.equal(record.orphanUnresolved, true);
  assert.equal(record.restartResumeReady, false);
  assert.ok(
    record.warnings.some((warning) => warning.startsWith("unresolved orphaned worker:")),
    "the unresolved condition was not surfaced on the record",
  );
  const persisted = rawRecord(setup, "orphan-uncorroborated");
  assert.equal(persisted.childPid, uncorroborated.child.pid);
  assert.equal(persisted.orphanUnresolved, true);
  assert.equal(
    claimReleased(calls, "fixture-uncorroborated"),
    false,
    "the claim was released for a worker Atelier could not prove dead",
  );
  // Never signal a pid there is no identity for - it might be anyone's.
  assert.equal(uncorroborated.child.exitCode, null);
  assert.equal(uncorroborated.child.signalCode, null);
  assert.doesNotMatch(uncorroborated.output(), /SIGTERM/);
});

test("a child that outlives the shutdown kill stays fenced across the restart and is reaped by the next boot (I1/I2)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, {});
  stubPreparation();
  // Traps SIGTERM, so the shutdown sweep's graceful kill provably lands and
  // provably does not finish the job - the exact window the fence exists for.
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  const child = heldChild();
  child.pid = survivor.child.pid;
  _setSpawner(() => child);

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const created = await dispatcher.dispatch({ project: "fixture", prompt: "outlives the sweep" });
  await waitForState(dispatcher, created.id, ["running"]);

  await dispatcher.shutdown({ graceMs: 50 });
  assert.equal(dispatcher.get(created.id).state, "failed");
  await waitForConditionOverTime(
    () => /SIGTERM/.test(survivor.output()),
    "the shutdown sweep never signalled the child",
  );
  assert.equal(survivor.child.exitCode, null, "the child was supposed to survive the SIGTERM");
  const persisted = rawRecord(setup, created.id);
  assert.equal(persisted.childPid, survivor.child.pid);
  assert.match(persisted.childPidIdentity, /^linux-proc-start:/);

  // The next boot is the fail-safe. This record is now TERMINAL, which is
  // precisely the shape round 2's BOOT_RECOVERY_STATES-only scan could never
  // reach again - the child would have escaped every later boot forever.
  const rebooted = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 200,
  });
  await withDeadline(
    survivor.exitPromise,
    "the next boot never reaped the child that outlived the shutdown kill",
  );
  assert.notEqual(survivor.child.signalCode, null);
  await waitForConditionOverTime(
    () => rawRecord(setup, created.id).childPid === null,
    "the fence was not cleared once death was finally confirmed",
  );
  assert.equal(rebooted.get(created.id).orphanUnresolved, false);
});

test("boot reaps an identity-matched worker on a TERMINAL record and clears the fence only then (I2)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const survivor = spawnAliveProcess(t);
  await survivor.ready;
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-terminal",
      // The shutdown sweep already marked this record failed and deliberately
      // kept the pid, because its SIGTERM was still in flight. Round 2 scanned
      // only BOOT_RECOVERY_STATES, so a child that outlived that kill escaped
      // this boot - and every later one - forever.
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      restartResumeReady: true,
      childPid: survivor.child.pid,
      childPidIdentity: processStartIdentity(survivor.child.pid),
    }),
  ]);
  _setRunFile(async () => "");

  createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 200,
  });
  await withDeadline(
    survivor.exitPromise,
    "boot never reaped the identity-matched worker on the terminal record",
  );
  assert.notEqual(survivor.child.signalCode, null);
  await waitForConditionOverTime(
    () => rawRecord(setup, "orphan-terminal").childPid === null,
    "the fence was not cleared after death was confirmed",
  );

  const persisted = rawRecord(setup, "orphan-terminal");
  assert.equal(persisted.childPidIdentity, null);
  assert.equal(persisted.orphanUnresolved, false);
  // A terminal record is settled: the pass proves death, it does not re-run
  // recovery or rewrite the outcome.
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.exitSummary, "server restart");
  assert.equal(persisted.restartResumeReady, true);
});

test("a zombie worker counts as dead: boot clears the fence, releases the claim and signals nothing (I6)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("zombie detection reads Linux /proc state");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const zombie = await spawnZombieProcess(t);
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-zombie",
      ticketId: "fixture-zombie",
      childPid: zombie.pid,
      // A zombie's /proc entry still reads back the matching identity, so
      // round 2 signalled it, saw the identity again, and concluded the worker
      // was unkillable - a permanent refusal for a process that had exited.
      childPidIdentity: processStartIdentity(zombie.pid),
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-zombie"),
    "a zombie worker did not release its claim",
  );

  const record = dispatcher.get("orphan-zombie");
  assert.equal(record.state, "failed");
  assert.equal(record.exitSummary, "server restart");
  assert.equal(record.orphanUnresolved, false);
  assert.equal(record.restartResumeReady, true);
  assert.equal(rawRecord(setup, "orphan-zombie").childPid, null);
  // The zombie's living parent must not be collateral damage.
  assert.equal(zombie.parent.exitCode, null);
  assert.equal(zombie.parent.signalCode, null);
});

test("reply() re-verifies the tracker claim on a dispatch that was never restart-resume-ready (I4)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "post-success-failure");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "post-success-failure",
      ticketId: "fixture-post-success",
      // A failure AFTER a successful turn: finish() released the claim, and
      // restartResumeReady was never set (this is not a restart). Round 2
      // gated the reclaim on that flag, so this resume ran unclaimed.
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "verification failed",
      worktreePath,
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args });
    return "";
  });
  _setSpawner(() =>
    claudeResultChild({ sessionId: "post-success-failure-session", summary: "resumed" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const result = await dispatcher.reply("post-success-failure", { text: "fix the verify failure" });
  assert.equal(result.state, "running");
  assert.equal(
    claimTaken(calls, "fixture-post-success"),
    1,
    "the resume did not re-take the tracker claim",
  );
  await waitForState(dispatcher, "post-success-failure", ["completed", "failed"]);
});

test("an unresolved orphan refuses reply() and a fresh dispatch for the same ticket (I3/I4)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const unkillable = spawnAliveProcess(t);
  await unkillable.ready;
  _setFencedProcessSignal(() => {}); // a kill signal that never lands
  const worktreePath = join(setup.state, "worktrees", "fixture", "orphan-blocked");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-blocked",
      ticketId: "fixture-blocked",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      restartResumeReady: true,
      worktreePath,
      childPid: unkillable.child.pid,
      childPidIdentity: processStartIdentity(unkillable.child.pid),
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async () => "");
  stubPreparation();

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("orphan-blocked")?.orphanUnresolved === true,
    "boot did not mark the surviving worker unresolved",
  );

  await assert.rejects(
    dispatcher.reply("orphan-blocked", { text: "resume anyway" }),
    /still running and could not be stopped/,
  );
  // A fresh dispatch gets a fresh worktree, which is no defence at all: the
  // surviving worker may still be committing to this ticket's branch.
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", ticketId: "fixture-blocked" }),
    /has not proven dead/,
  );
  assert.equal(dispatcher.get("orphan-blocked").orphanUnresolved, true);
  // The fixture is seeded restartResumeReady:true, which is exactly the shape the
  // terminal boot pass has to correct: offering "Resume after restart" while the
  // worker may be alive advertises a button that can only 409 (round 4, item 7).
  assert.equal(dispatcher.get("orphan-blocked").restartResumeReady, false);
  assert.equal(unkillable.child.exitCode, null);
});

test("plan() continuation passes the same gate: refused while an orphan is unresolved (I4)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const unkillable = spawnAliveProcess(t);
  await unkillable.ready;
  _setFencedProcessSignal(() => {});
  const worktreePath = join(setup.state, "worktrees", "fixture", "orphan-plan");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-plan",
      state: "plan_ready",
      plan: { state: "ready", text: "do the thing" },
      worktreePath,
      childPid: unkillable.child.pid,
      childPidIdentity: processStartIdentity(unkillable.child.pid),
    }),
  ]);
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("orphan-plan")?.orphanUnresolved === true,
    "the plan_ready record's surviving worker was never resolved",
  );

  await assert.rejects(
    dispatcher.plan("orphan-plan", { action: "approve" }),
    /still running and could not be stopped/,
  );
  assert.equal(dispatcher.get("orphan-plan").state, "plan_ready");
  assert.equal(unkillable.child.exitCode, null);
});

test("plan() continuation re-verifies the tracker claim before spawning (I4)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "plan-claim");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "plan-claim",
      ticketId: "fixture-plan-claim",
      state: "plan_ready",
      plan: { state: "ready", text: "do the thing" },
      worktreePath,
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args });
    return "";
  });
  _setSpawner(() => claudeResultChild({ sessionId: "plan-claim-session", summary: "executed" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const result = await dispatcher.plan("plan-claim", { action: "approve" });
  assert.equal(result.state, "running");
  assert.equal(
    claimTaken(calls, "fixture-plan-claim"),
    1,
    "plan continuation did not re-take the tracker claim",
  );
  await waitForState(dispatcher, "plan-claim", ["completed", "failed", "verifying"]);
});

test("acquireDrainLease refuses while a bake-off's shared claim is in flight (I5)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" }, { concurrentDispatchCap: 4 });
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  let claudeChild;
  _setSpawner((file) => {
    if (file === "claude") {
      claudeChild = heldChild();
      return claudeChild;
    }
    return codexLaunchChild();
  });
  let releaseClaimCall;
  const claimGate = new Promise((resolvePromise) => {
    releaseClaimCall = resolvePromise;
  });
  let claimCallSeen = false;
  _setRunFile(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "update" && args.includes("--claim")) {
      claimCallSeen = true;
      await claimGate;
      return "";
    }
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "running", job: { status: "running" } });
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const bakeoff = dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-bakeoff",
    lanes: ["claude", "codex"],
  });
  await waitForCondition(() => claimCallSeen, "the bake-off's shared claim never started");

  // Round 2 wrapped only the per-leg dispatch() calls, so at exactly this point
  // - shared claim mid-flight, not one record created yet - inFlightAdmissions
  // was 0 and no dispatch was active: the lease was granted and a restart could
  // land on top of a bake-off that was about to spawn two agents.
  assert.throws(() => dispatcher.acquireDrainLease(), /admission.*in flight/);

  releaseClaimCall();
  const created = await bakeoff;
  assert.equal(created.ids.length, 2);
  await waitForState(dispatcher, created.ids[0], ["running"]);
  // Still refused, now for the honest reason.
  assert.throws(() => dispatcher.acquireDrainLease(), /active dispatch/);
  assert.ok(claudeChild);
});

test("dismissing an unresolved orphan lifts the condition, and the next boot does not re-derive it (I3)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("orphan PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const unkillable = spawnAliveProcess(t);
  await unkillable.ready;
  _setFencedProcessSignal(() => {});
  const worktreePath = join(setup.state, "worktrees", "fixture", "orphan-dismissed");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "orphan-dismissed",
      ticketId: "fixture-dismissed",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      worktreePath,
      childPid: unkillable.child.pid,
      childPidIdentity: processStartIdentity(unkillable.child.pid),
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("orphan-dismissed")?.orphanUnresolved === true,
    "boot did not mark the surviving worker unresolved",
  );

  const dismissed = await dispatcher.dismiss("orphan-dismissed");
  assert.equal(dismissed.orphanUnresolved, false);
  assert.ok(dismissed.dismissed);
  assert.ok(
    !dismissed.warnings.some((warning) => warning.startsWith("unresolved orphaned worker:")),
    "the unresolved warning outlived the dismissal",
  );
  const persisted = rawRecord(setup, "orphan-dismissed");
  assert.equal(persisted.childPid, null);
  assert.equal(persisted.childPidIdentity, null);

  // The fence has to go with the flag: keeping the pid would have the next
  // boot's pass re-derive the same condition and silently undo the dismissal.
  const rebooted = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  assert.equal(rebooted.get("orphan-dismissed").orphanUnresolved, false);
  assert.equal(unkillable.child.exitCode, null);
});

test("dispatch gates model and effort before any preparation", async (t) => {
  const setup = await fixture(t, {});
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "task", model: "fable" }),
    /Unsupported model: fable.*reserved for the architect/,
  );
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "task", model: "claude-fable-5" }),
    /Unsupported model/,
  );
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "task", effort: "ultra" }),
    /effort must be one of/,
  );
});

test("dispatch rejects over-cap work and traversal before another preparation", async (t) => {
  const setup = await fixture(t, {}, { concurrentDispatchCap: 1 });
  stubPreparation();
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const first = await dispatcher.dispatch({ project: "fixture", prompt: "safe task" });
  await waitForState(dispatcher, first.id, ["running"]);
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "second task" }),
    /cap exceeded/,
  );
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", prompt: "..\/escape" }),
    /traversal or dots/,
  );
  child.complete();
  await waitForState(dispatcher, first.id, ["completed"]);
});

test("dispatch harvests worktree-only issues through br and auto-commits the result", async (t) => {
  const setup = await fixture(t, { tracker: "committed", autoCommitTracker: true });
  const primaryLine = `${JSON.stringify({
    id: "fixture-primary",
    title: "Primary",
    updated_at: "2026-07-21T08:00:00.000Z",
  })}\n`;
  const strandedLine = `${JSON.stringify({
    id: "fixture-stranded",
    title: "Stranded",
    updated_at: "2026-07-21T08:01:00.000Z",
  })}\n`;
  const calls = await stubHarvestScenario(setup, {
    primaryIssues: primaryLine,
    worktreeIssues: `${primaryLine}${strandedLine}`,
    brHandler: async () => "{}\n",
    staged: true,
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-ticket",
  });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.equal(record.strandedBrWrites, true);
  assert.deepEqual(record.harvest, {
    state: "harvested",
    detail: "Imported 1 new issue id(s) through br.",
  });
  assert.equal(
    record.warnings.includes("harvest needed: agent wrote .beads inside the dispatch worktree"),
    false,
  );
  const brCalls = calls.filter((call) => call.file === "/fixture/br");
  assert.deepEqual(brCalls.map((call) => call.args), [
    ["update", "fixture-ticket", "--claim", "--actor", "atelier"],
    ["sync", "--flush-only"],
    ["sync", "--import-only", "--allow-external-jsonl", "--json"],
    ["sync", "--flush-only"],
  ]);
  assert.equal(brCalls[2].cwd, setup.primary);
  assert.equal(
    brCalls[2].env.BEADS_JSONL,
    join(record.worktreePath, ".beads", "issues.jsonl"),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.file === "git" &&
        call.args.join("\0") ===
          [
            "-C",
            setup.primary,
            "commit",
            "-m",
            "chore(tracker): harvest fixture-ticket [atelier]",
            "--",
            ".beads",
          ].join("\0"),
    ),
  );
});

test("conflicting stranded issue stays manual-needed without advertised br merge", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const primaryLine = `${JSON.stringify({
    id: "fixture-same",
    title: "Primary",
    updated_at: "2026-07-21T08:00:00.000Z",
  })}\n`;
  const worktreeLine = `${JSON.stringify({
    id: "fixture-same",
    title: "Worktree",
    updated_at: "2026-07-21T08:01:00.000Z",
  })}\n`;
  const calls = await stubHarvestScenario(setup, {
    primaryIssues: primaryLine,
    worktreeIssues: worktreeLine,
    brHandler: async (args) => {
      assert.deepEqual(args, ["sync", "--help"]);
      return "Sync supports --import-only.\n";
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "edit tracker" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.deepEqual(record.harvest, {
    state: "manual-needed",
    detail: "1 conflicting issue id(s); br does not advertise its safe three-way JSONL merge.",
  });
  assert.ok(
    record.warnings.includes("harvest needed: agent wrote .beads inside the dispatch worktree"),
  );
  assert.deepEqual(
    calls.filter((call) => call.file === "/fixture/br").map((call) => call.args),
    [["sync", "--help"]],
  );
});

test("conflicting stranded issue uses advertised br three-way merge", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const primaryLine = `${JSON.stringify({
    id: "fixture-same",
    title: "Primary",
    updated_at: "2026-07-21T08:00:00.000Z",
  })}\n`;
  const worktreeLine = `${JSON.stringify({
    id: "fixture-same",
    title: "Worktree",
    updated_at: "2026-07-21T08:01:00.000Z",
  })}\n`;
  const calls = await stubHarvestScenario(setup, {
    primaryIssues: primaryLine,
    worktreeIssues: worktreeLine,
    brHandler: async (args) =>
      args.includes("--help")
        ? "--merge performs three-way merge with .beads/beads.base.jsonl\n"
        : "{}\n",
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "edit tracker" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.deepEqual(record.harvest, {
    state: "harvested",
    detail: "Merged 1 conflicting and 0 new issue id(s) through br.",
  });
  assert.deepEqual(
    calls.filter((call) => call.file === "/fixture/br").map((call) => call.args),
    [
      ["sync", "--help"],
      ["sync", "--merge", "--force", "--allow-external-jsonl", "--json"],
      ["sync", "--flush-only"],
    ],
  );
});

test("missing br marks a stranded harvest failed and retains warnings", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const primaryLine = `${JSON.stringify({ id: "fixture-primary" })}\n`;
  const strandedLine = `${JSON.stringify({ id: "fixture-stranded" })}\n`;
  await stubHarvestScenario(setup, {
    primaryIssues: primaryLine,
    worktreeIssues: `${primaryLine}${strandedLine}`,
    brHandler: async () => {
      throw new Error("spawn /fixture/br ENOENT");
    },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "edit tracker" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  assert.deepEqual(record.harvest, {
    state: "failed",
    detail: "Could not harvest tracker writes: spawn /fixture/br ENOENT",
  });
  assert.ok(
    record.warnings.includes("harvest needed: agent wrote .beads inside the dispatch worktree"),
  );
  assert.ok(record.warnings.includes("tracker harvest failed: spawn /fixture/br ENOENT"));
});

test("stranded check stays quiet when the worktree's own .beads is untouched", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await mkdir(join(setup.primary, ".beads"));
  // Primary content is irrelevant to the check: even a primary that differs
  // from the dispatch base (different branch) must not trip the flag.
  await writeFile(join(setup.primary, ".beads", "issues.jsonl"), '{"id":"other-branch"}\n');
  stubPreparation({ strandedStatus: "" });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "read only" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(record.strandedBrWrites, false);
  assert.equal(record.harvest, null);
});

test("integration: a real git worktree is added for a dispatch", async (t) => {
  const setup = await fixture(t);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: setup.primary });
  await writeFile(join(setup.primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: setup.primary });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atelier Test",
      "-c",
      "user.email=atelier@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: setup.primary },
  );
  _setProbe();
  _setRunFile();
  // Writes a real file into the real worktree, so real git reports real work and
  // the run is an ordinary completion rather than atelier-8r6's completed_empty.
  _setSpawner((_file, _args, options) =>
    successfulChild(async () => {
      await writeFile(join(options.cwd, "feature.txt"), "work\n");
    }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "real worktree" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(existsSync(record.worktreePath), true);
  const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: setup.primary,
    encoding: "utf8",
  });
  assert.match(worktreeList, new RegExp(record.worktreePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal((await readFile(join(record.worktreePath, "README.md"), "utf8")), "fixture\n");
});

test("integration: a self-committing agent's dirty result is clean, attested, and survives worktree deletion", async (t) => {
  const setup = await fixture(t);
  _setResultFinalizer();
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.name", "Atelier Test"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.email", "atelier@example.invalid"], {
    cwd: setup.primary,
  });
  await writeFile(join(setup.primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: setup.primary });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: setup.primary });
  _setProbe();
  _setRunFile();
  _setSpawner((_file, _args, options) =>
    successfulChild(async () => {
      await writeFile(join(options.cwd, "feature.mjs"), "export const ready = true;\n");
      await writeFile(join(options.cwd, "feature.test.mjs"), "assert.equal(ready, true);\n");
    }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    prompt: "leave dirty implementation and test output",
    lane: "claude",
  });
  const record = await waitForState(dispatcher, id, ["completed", "failed"]);
  assert.equal(record.state, "completed", record.exitSummary);

  const cleanStatus = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude).beads",
    ],
    { cwd: record.worktreePath, encoding: "utf8" },
  );
  const changedPaths = execFileSync(
    "git",
    ["diff", "--name-only", record.result.base, record.result.commit],
    { cwd: record.worktreePath, encoding: "utf8" },
  ).trim().split("\n");
  const independentTree = execFileSync(
    "git",
    ["rev-parse", `${record.result.commit}^{tree}`],
    { cwd: record.worktreePath, encoding: "utf8" },
  ).trim();

  assert.equal(cleanStatus, "");
  assert.deepEqual(changedPaths, ["feature.mjs", "feature.test.mjs"]);
  assert.equal(record.result.tree, independentTree);
  assert.equal(record.result.workspaceClean, true);
  assert.equal(record.result.selfCommitted, true);
  assert.equal(record.result.commitCreated, true);
  assert.deepEqual(
    record.result.manifest.map(({ path }) => path),
    ["feature.mjs", "feature.test.mjs"],
  );

  execFileSync("git", ["worktree", "remove", "--force", record.worktreePath], {
    cwd: setup.primary,
  });
  assert.equal(existsSync(record.worktreePath), false);
  assert.equal(
    execFileSync("git", ["show", `${record.result.commit}:feature.mjs`], {
      cwd: setup.primary,
      encoding: "utf8",
    }),
    "export const ready = true;\n",
  );
});

test("integration: Atelier commits real Codex work without committing .beads", async (t) => {
  const setup = await fixture(t);
  _setResultFinalizer();
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.name", "Atelier Test"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.email", "atelier@example.invalid"], {
    cwd: setup.primary,
  });
  await writeFile(join(setup.primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: setup.primary });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: setup.primary });
  _setProbe();
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setRunFile(async (file, args, options = {}) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "real implementation" });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "real implementation" } });
    }
    return execFileSync(file, args, {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
    });
  });
  _setSpawner((_file, _args, options) =>
    codexLaunchChild("codex-real", async () => {
      await writeFile(join(options.cwd, "feature.mjs"), "export const ready = true;\n");
      await mkdir(join(options.cwd, ".beads"));
      await writeFile(join(options.cwd, ".beads", "issues.jsonl"), "stranded\n");
    }),
  );

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-real",
    lane: "codex",
  });
  const record = await waitForState(
    dispatcher,
    id,
    ["completed", "failed", "prepare_failed", "stopped"],
  );
  assert.equal(record.state, "completed", record.exitSummary);
  const message = execFileSync("git", ["log", "-1", "--format=%s%n%b"], {
    cwd: record.worktreePath,
    encoding: "utf8",
  });
  const committedPaths = execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], {
    cwd: record.worktreePath,
    encoding: "utf8",
  });
  const trackerStatus = execFileSync("git", ["status", "--short", "--", ".beads"], {
    cwd: record.worktreePath,
    encoding: "utf8",
  });

  assert.equal(
    message,
    "chore(dispatch): finalize result [atelier-finalized]\n\n",
  );
  assert.equal(committedPaths.trim(), "feature.mjs");
  assert.equal(trackerStatus, "?? .beads/\n");
  assert.equal(record.result.workspaceClean, true);
  assert.equal(record.result.selfCommitted, false);
  assert.equal(record.result.commitCreated, true);
  assert.equal(record.result.commit, execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: record.worktreePath,
    encoding: "utf8",
  }).trim());
  assert.deepEqual(record.result.manifest.map(({ path }) => path), ["feature.mjs"]);
});

test("terminal transitions fire one redacted push to the configured notifyUrl", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  setup.registry.defaults.notifyUrl = "https://ntfy.example/topic";
  stubPreparation();
  _setSpawner(() => successfulChild());
  const pushes = [];
  _setPushFetch(async (url, options) => {
    pushes.push({ url, title: options.headers.Title, body: options.body });
    return { ok: true };
  });
  t.after(() => _setPushFetch());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "notify me sk-abcdefghijklmnopqrstu" });
  await waitForState(dispatcher, id, ["completed"]);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, "https://ntfy.example/topic");
  assert.match(pushes[0].title, /Atelier: fixture completed/);
  assert.match(pushes[0].body, new RegExp(id));
  assert.doesNotMatch(pushes[0].body, /sk-abcdefghijklmnop/);
});

test("no push fires when notifyUrl is not configured", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  stubPreparation();
  _setSpawner(() => successfulChild());
  const pushes = [];
  _setPushFetch(async (...args) => pushes.push(args));
  t.after(() => _setPushFetch());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "quiet" });
  await waitForState(dispatcher, id, ["completed"]);
  assert.equal(pushes.length, 0);
});

test("steering window closes on a result with no pending reply, stays open with one", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const child = heldChild();
  child.stdin = new PassThrough();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "long task" });
  await waitForState(dispatcher, id, ["running"]);

  await dispatcher.reply(id, { text: "steer once" });
  child.stdout.write(`${JSON.stringify({ type: "result", result: "turn one", is_error: false })}\n`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(child.stdin.writableEnded, false, "window stays open for the pending reply's turn");

  child.stdout.write(`${JSON.stringify({ type: "result", result: "turn two", is_error: false })}\n`);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(child.stdin.writableEnded, true, "window closes once no reply is pending");
  child.complete();
  await waitForState(dispatcher, id, ["completed"]);
});

test("external trackerPath routes ready-queue and claim br calls away from the primary", async (t) => {
  const setup = await fixture(t, { tracker: "personal" });
  const trackerPath = join(setup.state, "trackers", "fixture");
  await mkdir(trackerPath, { recursive: true });
  setup.project.trackerPath = trackerPath;
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") {
      return JSON.stringify([{ id: "fixture-42" }]);
    }
    if (file === "/fixture/br") return "";
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner(() => successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const queued = dispatcher.list().find((record) => record.ticketId === "fixture-42");
  await waitForState(dispatcher, queued.id, ["completed"]);
  const brCalls = calls.filter((call) => call.file === "/fixture/br");
  assert.deepEqual(brCalls.map((call) => call.args[0]), ["ready", "update"]);
  assert.ok(brCalls.every((call) => call.cwd === trackerPath));
});

test("external trackerPath routes claim release after prepare failure", async (t) => {
  const setup = await fixture(t, { tracker: "personal" });
  const trackerPath = join(setup.state, "trackers", "fixture");
  await mkdir(trackerPath, { recursive: true });
  setup.project.trackerPath = trackerPath;
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const calls = [];
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") return "";
    if (file === "git" && args[2] === "worktree") throw new Error("disk full");
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const { id } = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-9" });
  await waitForState(dispatcher, id, ["prepare_failed"]);
  await waitForCondition(
    () => calls.some((call) => call.args.includes("--status")),
    "external tracker claim was not released",
  );
  const brCalls = calls.filter((call) => call.file === "/fixture/br");
  assert.deepEqual(brCalls.map((call) => call.args), [
    ["update", "fixture-9", "--claim", "--actor", "atelier"],
    ["update", "fixture-9", "--status", "open"],
  ]);
  assert.ok(brCalls.every((call) => call.cwd === trackerPath));
});

test("external trackerPath routes stranded-write harvest br calls", async (t) => {
  const setup = await fixture(t, { tracker: "personal" });
  const trackerPath = join(setup.state, "trackers", "fixture");
  setup.project.trackerPath = trackerPath;
  const primaryLine = `${JSON.stringify({ id: "fixture-primary", title: "Primary" })}\n`;
  const strandedLine = `${JSON.stringify({ id: "fixture-stranded", title: "Stranded" })}\n`;
  const calls = await stubHarvestScenario(setup, {
    primaryIssues: primaryLine,
    worktreeIssues: `${primaryLine}${strandedLine}`,
    brHandler: async () => "{}\n",
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const { id } = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-ticket" });
  const record = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(record.harvest.state, "harvested");
  const brCalls = calls.filter((call) => call.file === "/fixture/br");
  assert.deepEqual(brCalls.map((call) => call.args[0]), [
    "update",
    "sync",
    "sync",
    "sync",
  ]);
  assert.ok(brCalls.every((call) => call.cwd === trackerPath));
});

test("external trackerPath routes merge auto-close br calls", async (t) => {
  const setup = await fixture(t, { tracker: "personal", autoCloseOnMerge: true });
  const trackerPath = join(setup.state, "trackers", "fixture");
  await mkdir(trackerPath, { recursive: true });
  setup.project.trackerPath = trackerPath;
  const seeded = await seedDispatch(setup);
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "show") {
      return `${JSON.stringify([{ id: seeded.ticketId, status: "open" }])}\n`;
    }
    if (file === "/fixture/br") return "";
    if (file === "git" && args[2] === "rev-parse" && args[3] === "main") {
      return "abcdef1234567890\n";
    }
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const record = await dispatcher.merge(seeded.id);
  assert.equal(record.mergedClose.ticketId, seeded.ticketId);
  const brCalls = calls.filter((call) => call.file === "/fixture/br");
  assert.deepEqual(brCalls.map((call) => call.args[0]), ["show", "close"]);
  assert.ok(brCalls.every((call) => call.cwd === trackerPath));
});

test("planning runs carry a hard --disallowedTools deny alongside the allow list", async (t) => {
  const setup = await fixture(t);
  stubPreparation();
  const launches = [];
  _setSpawner((command, args) => {
    launches.push(args);
    return successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "plan me", planFirst: true });
  await waitForState(dispatcher, id, ["plan_ready"]);
  const deny = launches[0].indexOf("--disallowedTools");
  assert.notEqual(deny, -1, "planning launch must hard-deny mutating tools");
  assert.match(launches[0][deny + 1], /Bash/);
  assert.match(launches[0][deny + 1], /Edit/);
  assert.match(launches[0][deny + 1], /Write/);
  const allow = launches[0].indexOf("--allowedTools");
  assert.equal(launches[0][allow + 1], "Read,Grep,Glob");
});

test("review dispatches pin one audited SHA under Claude's strict no-tools posture", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup);
  await mkdir(seeded.worktreePath, { recursive: true });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({
      id: seeded.ticketId,
      description: "The implementation must preserve the security gate.",
      acceptance_criteria: "The regression test is present.",
    })}\n`,
  );
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const launches = [];
  const reviewCommands = [];
  _setSpawner((command, args) => {
    launches.push({ command, args });
    return claudeResultChild({
      summary: "Review complete.\nVERDICT: PASS\n[NIT] server.mjs:1 - No blocking findings.",
    });
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    reviewCommands.push(args);
    if (args[2] === "diff") {
      return args.at(-1) === "HEAD"
        ? ""
        : "diff --git a/server.mjs b/server.mjs\n+security regression test";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  const completed = await waitForState(dispatcher, review.id, ["completed"]);
  const target = dispatcher.get(seeded.id);

  assert.equal(review.reviewOf, seeded.id);
  assert.equal(review.reviewedHead, "reviewed-head");
  assert.equal(review.readOnly, true);
  assert.deepEqual(completed.verify, { state: "skipped", steps: [] });
  assert.match(
    launches[0].args[1],
    /\[BLOCKER\|MAJOR\|MINOR\|NIT\] file:line/,
  );
  assert.equal(target.review.current, target.review.rounds[0]);
  assert.equal(target.review.rounds.length, 1);
  assert.equal(target.review.current.dispatchId, review.id);
  assert.equal(target.review.current.reviewedHead, "reviewed-head");
  assert.equal(target.review.current.verdict, "pass");
  assert.equal(target.review.current.findingCount, 1);
  assert.equal(
    target.review.current.summary,
    "Review complete.\nVERDICT: PASS\n[NIT] server.mjs:1 - No blocking findings.",
  );
  assert.deepEqual(
    reviewCommands.filter((args) =>
      args[1] === seeded.worktreePath && args[2] === "rev-parse" && args[3] === "HEAD"),
    [["-C", seeded.worktreePath, "rev-parse", "HEAD"]],
  );
  assert.deepEqual(
    reviewCommands.filter((args) => args[1] === seeded.worktreePath && args[2] === "diff"),
    [["-C", seeded.worktreePath, "diff", "--no-ext-diff", "main...reviewed-head"]],
  );
  assert.match(launches[0].args[1], /The implementation must preserve the security gate/);
  assert.match(launches[0].args[1], /The regression test is present/);
  assert.match(launches[0].args[1], /security regression test/);
  assert.equal(
    launches[0].args[launches[0].args.indexOf("--allowedTools") + 1],
    "",
  );
  assert.ok(launches[0].args.includes("--safe-mode"));
  assert.ok(launches[0].args.includes("--strict-mcp-config"));
  assert.ok(launches[0].args.includes("--disable-slash-commands"));
  assert.equal(launches[0].args[launches[0].args.indexOf("--tools") + 1], "");
  assert.match(
    launches[0].args[launches[0].args.indexOf("--disallowedTools") + 1],
    /Bash.*Edit.*Write/,
  );
  assert.match(
    launches[0].args[launches[0].args.indexOf("--disallowedTools") + 1],
    /mcp__\*/,
  );
  assert.ok(
    dispatcher.getEvents(seeded.id).some((event) =>
      event.type === "review" &&
      event.reviewDispatchId === review.id &&
      event.verdict === "pass"),
  );

  const resumed = await dispatcher.reply(review.id, { text: "Audit the same diff once more." });
  assert.equal(resumed.state, "running");
  await waitForState(dispatcher, review.id, ["completed"]);
  assert.equal(launches.length, 2);
  const resumedArgs = launches[1].args;
  assert.equal(resumedArgs[resumedArgs.indexOf("--allowedTools") + 1], "");
  assert.ok(resumedArgs.includes("--safe-mode"));
  assert.ok(resumedArgs.includes("--strict-mcp-config"));
  assert.ok(resumedArgs.includes("--disable-slash-commands"));
  assert.equal(resumedArgs[resumedArgs.indexOf("--tools") + 1], "");
  assert.match(resumedArgs[resumedArgs.indexOf("--disallowedTools") + 1], /mcp__\*/);
});

test("queue completion automatically launches review and reports a failed verdict", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    verifyCommands: ["node --test"],
  });
  await enablePersistedQueue(setup);
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({
      id: "fixture-auto-review",
      description: "Keep the automatic review ladder gated.",
      acceptance_criteria: "A failed review remains visible on the target.",
    })}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let ready = true;
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        if (!ready) return "[]";
        ready = false;
        return JSON.stringify([{ id: "fixture-auto-review", priority: 0 }]);
      }
      if (["update", "sync"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "remove") return "";
    if (file === "git" && args[2] === "diff") {
      return args.at(-1) === "HEAD"
        ? ""
        : "diff --git a/server.mjs b/server.mjs\n+automatic review candidate";
    }
    if (file === "git" && args[2] === "rev-parse" && args[3] === "HEAD") {
      return args[1].includes(`${join("verify-worktrees", "fixture")}`)
        ? `${FIXTURE_BASE_COMMIT}\n`
        : "reviewed-head\n";
    }
    if (file === "git" && args[2] === "rev-parse" && args[3] === "HEAD^{tree}") {
      return `${FIXTURE_RESULT_TREE}\n`;
    }
    if (file === "git" && args[2] === "rev-parse") return "reviewed-head\n";
    if (file === "git" && args[2] === "rev-list") return "0\n";
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  let agentLaunch = 0;
  _setSpawner((file) => {
    if (file === "node") return verifyChild();
    assert.equal(file, "claude");
    agentLaunch += 1;
    return agentLaunch === 1
      ? successfulChild()
      : claudeResultChild({
          summary: [
            "VERDICT: FAIL",
            "SUMMARY",
            "[MAJOR] server/lib/dispatch.test.mjs:1 - Required regression coverage is missing.",
          ].join("\n"),
        });
  });
  const pushes = [];
  _setPushFetch(async (url, options) => {
    pushes.push({ url, title: options.headers.Title, body: options.body });
    return { ok: true };
  });
  t.after(() => _setPushFetch());
  setup.registry.defaults.notifyUrl = "https://ntfy.example/reviews";
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const target = dispatcher.list().find((record) => record.ticketId === "fixture-auto-review");
  assert.ok(target);
  await waitForCondition(
    () => dispatcher.get(target.id).review?.verdict === "fail",
    "automatic review did not settle on the queue target",
  );

  const completed = dispatcher.get(target.id);
  const review = dispatcher.get(completed.review.dispatchId);
  assert.equal(completed.queueLaunched, true);
  assert.equal(completed.verify.state, "passed");
  assert.equal(review.reviewOf, target.id);
  assert.equal(review.readOnly, true);
  assert.equal(completed.review.current, completed.review.rounds[0]);
  assert.equal(completed.review.rounds.length, 1);
  assert.equal(completed.review.current.dispatchId, review.id);
  assert.equal(completed.review.current.reviewedHead, "reviewed-head");
  assert.equal(completed.review.current.verdict, "fail");
  assert.equal(completed.review.current.findingCount, 1);
  assert.equal(
    completed.review.current.summary,
    [
      "VERDICT: FAIL",
      "SUMMARY",
      "[MAJOR] server/lib/dispatch.test.mjs:1 - Required regression coverage is missing.",
    ].join("\n"),
  );
  assert.deepEqual(dispatcher.getQueue("fixture"), {
    enabled: true,
    consecutiveFailures: 0,
    lastError: null,
    failureLimit: 2,
    parkedTickets: [],
  });
  await assert.rejects(
    dispatcher.merge(target.id),
    /review gate failed: 1 open review finding/,
  );
  assert.ok(pushes.some((push) =>
    /review fail/.test(push.title) &&
    push.body.includes(target.id) &&
    push.body.includes("Required regression coverage is missing.")),
  );
});

test("boot recovers a missing automatic review exactly once after the completion handoff", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Recover the review after restart.",
    queueLaunched: true,
    review: null,
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "diff") {
      return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+recovered review";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  let reviewLaunches = 0;
  _setSpawner(() => {
    reviewLaunches += 1;
    return claudeResultChild({
      summary: "VERDICT: PASS\nSUMMARY: The recovered review passed.",
    });
  });

  const first = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => first.get(target.id).review?.verdict === "pass",
    "boot did not recover the missing automatic review",
  );
  const reviewId = first.get(target.id).review.dispatchId;
  assert.equal(reviewLaunches, 1);
  assert.equal(first.get(reviewId).reviewOf, target.id);

  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(reviewLaunches, 1, "a second boot must not duplicate the recovered review");
  assert.equal(restarted.get(target.id).review.dispatchId, reviewId);
  assert.equal(
    restarted.list().filter((record) => record.reviewOf === target.id).length,
    1,
  );
});

test("merge and automatic review startup share the target lifecycle reservation", async (t) => {
  const reviewSetup = await fixture(t, { requireReview: true });
  const reviewTarget = await seedDispatch(reviewSetup, {
    ticketId: null,
    prompt: "Keep automatic review startup atomic with merge.",
    queueLaunched: true,
    review: null,
  });
  await mkdir(reviewTarget.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const reviewCalls = [];
  let headReads = 0;
  let markReviewStarted;
  const reviewStarted = new Promise((resolvePromise) => {
    markReviewStarted = resolvePromise;
  });
  let releaseReview;
  const reviewGate = new Promise((resolvePromise) => {
    releaseReview = resolvePromise;
  });
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    reviewCalls.push(args);
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      headReads += 1;
      if (headReads === 1) {
        markReviewStarted();
        await reviewGate;
      }
      return "automatic-review-head\n";
    }
    if (args[2] === "diff") return "diff --git a/a b/a\n+review this exact tree";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const reviewChild = heldChild();
  let markReviewSpawned;
  const reviewSpawned = new Promise((resolvePromise) => {
    markReviewSpawned = resolvePromise;
  });
  _setSpawner(() => {
    markReviewSpawned();
    return reviewChild;
  });
  const reviewDispatcher = createDispatcher({
    registry: reviewSetup.registry,
    stateDir: reviewSetup.state,
  });

  await reviewStarted;
  await assert.rejects(
    reviewDispatcher.merge(reviewTarget.id, { force: true, ...FORCE_AUDIT }),
    (error) => error.status === 409 && error.message === "dispatch review is starting",
  );
  releaseReview();
  await reviewSpawned;
  const automaticReview = reviewDispatcher.list().find(
    (record) => record.reviewOf === reviewTarget.id,
  );
  assert.ok(automaticReview, "automatic review did not create its dispatch record");
  await waitForState(reviewDispatcher, automaticReview.id, ["running"]);
  assert.equal(
    reviewCalls.some(
      (args) => args[2] === "worktree" && args[3] === "remove" && args[4] === reviewTarget.worktreePath,
    ),
    false,
  );
  assert.equal(reviewDispatcher.get(reviewTarget.id).merged, null);
  reviewChild.complete("VERDICT: PASS\nSUMMARY: The reserved review startup passed.");
  await waitForCondition(
    () => reviewDispatcher.get(reviewTarget.id).review?.verdict === "pass",
    "automatic review did not settle after winning the lifecycle reservation",
  );

  const mergeSetup = await fixture(t, { requireReview: true });
  const mergeTarget = await seedDispatch(mergeSetup, {
    ticketId: null,
    prompt: "Do not review a target after merge wins.",
    queueLaunched: true,
    review: null,
  });
  await mkdir(mergeTarget.worktreePath, { recursive: true });
  const mergeCalls = [];
  let reviewLaunches = 0;
  let markMergeStarted;
  const mergeStarted = new Promise((resolvePromise) => {
    markMergeStarted = resolvePromise;
  });
  let releaseMerge;
  const mergeGate = new Promise((resolvePromise) => {
    releaseMerge = resolvePromise;
  });
  _setSpawner(() => {
    reviewLaunches += 1;
    return heldChild();
  });
  _setRunFile(async (_file, args) => {
    mergeCalls.push(args);
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      markMergeStarted();
      await mergeGate;
      return "merge-wins-head\n";
    }
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-target-head\n";
    return "";
  });
  const mergeDispatcher = createDispatcher({
    registry: mergeSetup.registry,
    stateDir: mergeSetup.state,
  });

  const mergePromise = mergeDispatcher.merge(mergeTarget.id, { force: true, ...FORCE_AUDIT });
  await mergeStarted;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  releaseMerge();
  const merged = await mergePromise;
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(merged.merged.commit, "merged-target-head");
  assert.equal(reviewLaunches, 0);
  assert.equal(
    mergeDispatcher.list().filter((record) => record.reviewOf === mergeTarget.id).length,
    0,
  );
  assert.equal(mergeCalls.some((args) => args[2] === "diff"), false);
});

test("reply-changed HEAD makes a passed review stale and boot launches a fresh gated review", async (t) => {
  const setup = await fixture(t, {
    requireReview: true,
    verifyCommands: ["node --test"],
  });
  let currentHead = "head-before-reply";
  _setResultFinalizer(async ({ baseCommit }) => ({
    resultCommit: currentHead,
    resultTree: FIXTURE_RESULT_TREE,
    baseCommit,
    manifest: [],
    workspaceClean: true,
    commitCreated: false,
  }));
  const target = await seedDispatch(setup, {
    ticketId: null,
    branchHead: "head-before-reply",
    prompt: "Review every changed fix-round tree.",
    queueLaunched: true,
    sessionId: "fix-round-session",
    review: null,
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "diff-tree") return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${currentHead}\n`;
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") {
      return `${FIXTURE_RESULT_TREE}\n`;
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return `${currentHead}\n`;
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    if (["fetch", "branch"].includes(args[2])) return "";
    if (args[2] === "worktree" && args[3] === "remove") return "";
    if (args[2] === "rev-list") return "0\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const freshReviewChild = heldChild();
  let launches = 0;
  _setSpawner((file) => {
    if (file === "node") return verifyChild();
    launches += 1;
    if (launches === 1) {
      return claudeResultChild({
        summary: "VERDICT: PASS\nSUMMARY: The original tree passed.",
      });
    }
    if (launches === 2) {
      return successfulChild(() => {
        currentHead = "head-after-reply";
      });
    }
    return freshReviewChild;
  });

  const first = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => first.get(target.id).review?.verdict === "pass",
    "the original automatic review did not pass",
  );
  const staleReviewId = first.get(target.id).review.dispatchId;
  assert.equal(first.get(staleReviewId).reviewedHead, "head-before-reply");
  currentHead = "head-after-external-change";
  await assert.rejects(
    first.merge(target.id),
    /EATELIER_VERIFICATION_HEAD_MISMATCH: /,
  );
  currentHead = "head-before-reply";

  setup.project.requireReview = false;
  await first.reply(target.id, { text: "Apply the requested fix round." });
  await waitForState(first, target.id, ["completed"]);
  assert.equal(first.get(target.id).review.rounds.length, 1);
  assert.equal(first.get(target.id).review.current.reviewedHead, "head-before-reply");
  assert.equal(currentHead, "head-after-reply");

  setup.project.requireReview = true;
  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => Boolean(
      restarted.get(target.id).review?.dispatchId &&
      restarted.get(target.id).review.dispatchId !== staleReviewId,
    ),
    "boot reattached the stale PASS instead of launching a fresh review",
  );
  const freshReviewId = restarted.get(target.id).review.dispatchId;
  assert.equal(restarted.get(target.id).review.verdict, "pending");
  assert.equal(restarted.get(freshReviewId).reviewedHead, "head-after-reply");
  await assert.rejects(
    restarted.merge(target.id),
    /review gate failed: expected pass, got pending/,
  );

  freshReviewChild.complete("VERDICT: PASS\nSUMMARY: The changed tree passed.");
  await waitForCondition(
    () => restarted.get(target.id).review?.verdict === "pass",
    "the fresh review did not settle",
  );
  assert.equal((await restarted.merge(target.id)).merged.commit, "merged-head");
  assert.equal(launches, 3);
  await Promise.all([
    first.shutdown({ graceMs: 150 }),
    restarted.shutdown({ graceMs: 150 }),
  ]);
});

test("concurrent manual reviews serialize per target and create only one dispatch", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Serialize concurrent review creation.",
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "concurrent-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const reviewChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return reviewChild;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const results = await Promise.allSettled([
    dispatcher.review(target.id),
    dispatcher.review(target.id),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.match(
    results.find((result) => result.status === "rejected").reason.message,
    /already active/,
  );
  const created = results.find((result) => result.status === "fulfilled").value;
  await waitForState(dispatcher, created.id, ["running"]);
  assert.equal(launches, 1);
  assert.equal(
    dispatcher.list().filter((record) => record.reviewOf === target.id).length,
    1,
  );

  reviewChild.complete("VERDICT: PASS\nSUMMARY: The serialized review passed.");
  await waitForCondition(
    () => dispatcher.get(target.id).review?.verdict === "pass",
    "the serialized review did not settle",
  );

  const mixedSetup = await fixture(t, { requireReview: true });
  const mixedTarget = await seedDispatch(mixedSetup, {
    id: "mixed-review-target",
    ticketId: null,
    prompt: "Serialize manual and automatic review creation.",
    queueLaunched: true,
    review: null,
  });
  await mkdir(mixedTarget.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "mixed-head\n";
    if (args[2] === "diff") return "diff --git a/a b/a\n+x";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const mixedChild = heldChild();
  let mixedLaunches = 0;
  _setSpawner(() => {
    mixedLaunches += 1;
    return mixedChild;
  });
  const mixedDispatcher = createDispatcher({
    registry: mixedSetup.registry,
    stateDir: mixedSetup.state,
  });
  const manualAttempt = mixedDispatcher.review(mixedTarget.id).catch(() => undefined);
  await waitForCondition(
    () => mixedDispatcher.list().some(
      (record) => record.reviewOf === mixedTarget.id && record.state === "running",
    ),
    "manual and automatic review race did not produce a review",
  );
  await manualAttempt;
  assert.equal(mixedLaunches, 1);
  assert.equal(
    mixedDispatcher.list().filter((record) => record.reviewOf === mixedTarget.id).length,
    1,
  );
  mixedChild.complete("VERDICT: PASS\nSUMMARY: The mixed review passed.");
  await waitForCondition(
    () => mixedDispatcher.get(mixedTarget.id).review?.verdict === "pass",
    "the mixed review did not settle",
  );
});

test("fast review preparation failure settles its linked target with the error summary", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Audit preparation failure handling.",
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => {
    throw new Error("fixture review preparation failed");
  });
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForCondition(
    () => dispatcher.get(target.id).review?.verdict === "error",
    "preparation failure did not settle on the review target",
  );

  assert.equal(dispatcher.get(review.id).state, "prepare_failed");
  const settled = dispatcher.get(target.id).review;
  assert.equal(settled.rounds.length, 1);
  assert.equal(settled.current.dispatchId, review.id);
  assert.equal(settled.current.reviewedHead, "reviewed-head");
  assert.equal(settled.current.verdict, "error");
  assert.equal(settled.current.summary, "fixture review preparation failed");
  assert.equal(settled.current.findingCount, null);
});

test("reply refuses an auto-review target while its review is active without orphaning the verdict", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Keep the active review attached.",
    queueLaunched: true,
    sessionId: "target-session",
    review: null,
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  const reviewChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return reviewChild;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => dispatcher.list().some(
      (record) => record.reviewOf === target.id && record.state === "running",
    ),
    "automatic review did not become active",
  );
  const review = dispatcher.list().find((record) => record.reviewOf === target.id);

  await assert.rejects(
    dispatcher.reply(target.id, { text: "Change the completed implementation." }),
    (error) => error.status === 409 && error.message.includes(review.id),
  );
  assert.equal(dispatcher.get(target.id).state, "completed");
  assert.equal(dispatcher.get(target.id).review.dispatchId, review.id);

  reviewChild.complete("VERDICT: PASS\nSUMMARY: The original audited diff passed.");
  await waitForCondition(
    () => dispatcher.get(target.id).review?.verdict === "pass",
    "the active review verdict was lost after the refused reply",
  );
  assert.equal(launches, 1);
  assert.equal(
    dispatcher.list().filter((record) => record.reviewOf === target.id).length,
    1,
  );
  assert.equal(
    dispatcher.get(target.id).review.summary,
    "The original audited diff passed.",
  );
});

test("passed manual dispatches do not auto-review", async (t) => {
  const setup = await fixture(t, {
    requireReview: true,
    verifyCommands: ["node --test"],
  });
  stubPreparation();
  _setSpawner((file) => file === "node" ? verifyChild() : successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "manual work" });
  const completed = await waitForState(dispatcher, id, ["completed"]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(completed.queueLaunched, false);
  assert.equal(completed.verify.state, "passed");
  assert.equal(completed.review, null);
  assert.equal(dispatcher.list().length, 1);
});

test("queue completion with failed verification does not auto-review", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    verifyCommands: ["node --test"],
  });
  await enablePersistedQueue(setup);
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") {
      if (args[0] === "ready") return JSON.stringify([{ id: "fixture-verify-fail" }]);
      if (args[0] === "update") return "";
    }
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner((file) => file === "node" ? verifyChild({ code: 1 }) : successfulChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.drainQueuesOnce();
  const target = dispatcher.list().find((record) => record.ticketId === "fixture-verify-fail");
  const completed = await waitForState(dispatcher, target.id, ["completed"]);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(completed.queueLaunched, true);
  assert.equal(completed.verify.state, "failed");
  assert.equal(completed.review, null);
  assert.equal(dispatcher.list().length, 1);
});

test("standalone prompts persist as review specs and malformed verdicts fail closed", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Preserve the standalone prompt contract.",
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let launchPrompt = "";
  _setSpawner((_command, args) => {
    launchPrompt = args[1];
    return claudeResultChild({ summary: "The implementation looks plausible." });
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForState(dispatcher, review.id, ["completed"]);

  assert.match(launchPrompt, /Preserve the standalone prompt contract/);
  assert.equal(dispatcher.get(seeded.id).review.verdict, "malformed");
  assert.equal(dispatcher.get(seeded.id).review.summary, "The implementation looks plausible.");
});

test("review briefs carry bounded redacted dispositions and adjudication rules", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Honor the recorded review adjudications.",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "prior-review",
        reviewedHead: "prior-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "major",
          file: "server/lib/dispatch.mjs",
          line: 88,
          summary: "The redirected subsystem needs separate ownership.",
          novelty: "new",
        }],
      }],
    },
    reviewDispositions: [{
      ref: "disposition-1",
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: "atelier-gg0",
      note: `OPENAI_API_KEY=super-secret ${"x".repeat(5_000)}`,
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let launchPrompt = "";
  _setSpawner((_command, args) => {
    launchPrompt = args[1];
    return claudeResultChild({ summary: "VERDICT: PASS\nSUMMARY: Adjudications honored." });
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForState(dispatcher, review.id, ["completed"]);

  assert.match(launchPrompt, /Redirected findings are OUT OF SCOPE/);
  assert.match(launchPrompt, /redirect-disputed/);
  assert.match(launchPrompt, /explicit rebuttal/);
  assert.match(launchPrompt, /atelier-gg0/);
  assert.match(launchPrompt, /fixture-architect/);
  assert.doesNotMatch(launchPrompt, /super-secret/);
  const dispositionJson = launchPrompt.match(
    /CURRENT DISPOSITIONS \(latest timestamped entry per finding; \[\] means none\):\n([\s\S]*?)\n\nTARGET DISPATCH:/,
  )?.[1];
  assert.ok(dispositionJson, "the disposition prompt boundary must remain inspectable");
  assert.doesNotThrow(() => JSON.parse(dispositionJson));
  assert.ok(dispositionJson.length <= 6_000);
  assert.equal(
    launchPrompt.includes("x".repeat(1_001)),
    false,
    "one disposition note cannot consume the review prompt",
  );
});

test("review brief recency keeps disposition 41 superseding finding 1", async (t) => {
  const setup = await fixture(t);
  const dispositions = Array.from({ length: 40 }, (_, index) => ({
    ref: `disposition-${index + 1}`,
    findingRef: `round-1:finding-${index + 1}`,
    disposition: "accepted",
    note: `Architect adjudication ${index + 1} for recency selection.`,
    actor: "fixture-architect",
    at: new Date(Date.UTC(2026, 6, 31, 0, 0, index)).toISOString(),
  }));
  dispositions.push({
    ref: "disposition-41",
    findingRef: "round-1:finding-1",
    disposition: "refuted",
    note: "The latest evidence supersedes the first disposition.",
    actor: "fixture-architect",
    at: "2026-07-31T00:01:00.000Z",
  });
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Show the reviewer the most recent disposition for every finding.",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "prior-review",
        reviewedHead: "prior-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "major",
          file: "server/lib/dispatch.mjs",
          line: 670,
          summary: "The disposition brief must preserve current adjudication.",
          novelty: "new",
        }],
      }],
    },
    reviewDispositions: dispositions,
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let launchPrompt = "";
  _setSpawner((_command, args) => {
    launchPrompt = args[1];
    return claudeResultChild({ summary: "VERDICT: PASS\nSUMMARY: Current rulings honored." });
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForState(dispatcher, review.id, ["completed"]);
  const dispositionJson = launchPrompt.match(
    /CURRENT DISPOSITIONS \(latest timestamped entry per finding; \[\] means none\):\n([\s\S]*?)\n\nTARGET DISPATCH:/,
  )?.[1];
  assert.ok(dispositionJson);
  const brief = JSON.parse(dispositionJson);
  assert.ok(brief.length < 40, "the bounded brief must exercise recency selection");
  assert.equal(brief.some(({ ref }) => ref === "disposition-1"), false);
  assert.equal(brief.some(({ ref }) => ref === "disposition-41"), true);
  assert.equal(brief.at(-1).ref, "disposition-41");
});

test("review verdict parsing retains multiline summaries and only lacks a verdict when malformed", async (t) => {
  const parseWithFindings = (exitSummary) =>
    _parsedReviewResult({ state: "completed", exitSummary });
  const parse = (exitSummary) => {
    const {
      findingCount: _findingCount,
      findingsText: _findingsText,
      findings: _findings,
      ...result
    } = parseWithFindings(exitSummary);
    return result;
  };

  const complete = "Audit notes first.\nVERDICT: PASS\n[NIT] server.mjs:1 - No blocking findings.";
  assert.deepEqual(parse(complete), { verdict: "pass", summary: complete });
  const passAfterSummary = "Audit notes.\nSUMMARY: Safe.\nVERDICT: PASS\nNo findings.";
  assert.deepEqual(parse(passAfterSummary), { verdict: "pass", summary: "Safe." });
  const failAfterSummary = "Audit notes.\nSUMMARY: Unsafe.\nVERDICT: FAIL\n[MAJOR] Missing coverage.";
  assert.deepEqual(parse(failAfterSummary), { verdict: "fail", summary: "Unsafe." });
  const multilineSummary = [
    "VERDICT: PASS",
    "SUMMARY: The implementation satisfies the ticket.",
    "The regression fixture covers continuation lines.",
    "The merge gate remains unchanged.",
    "[NIT] server.mjs:1 - A separate finding.",
  ].join("\n");
  assert.deepEqual(parse(multilineSummary), {
    verdict: "pass",
    summary: [
      "The implementation satisfies the ticket.",
      "The regression fixture covers continuation lines.",
      "The merge gate remains unchanged.",
    ].join("\n"),
  });
  const blankBoundary = "VERDICT: PASS\nSUMMARY: First paragraph.\nContinued.\n\nTrailing notes.";
  assert.equal(parse(blankBoundary).summary, "First paragraph.\nContinued.");
  const lowercaseMarker = "summary: Lowercase markers work.\nContinued.\nverdict: pass";
  assert.deepEqual(parse(lowercaseMarker), {
    verdict: "pass",
    summary: "Lowercase markers work.\nContinued.",
  });
  const oversizedSummary = `VERDICT: PASS\nSUMMARY: ${"x".repeat(2_100)}`;
  assert.equal(parse(oversizedSummary).summary.length, 2_000);
  assert.match(parse(oversizedSummary).summary, /\.\.\.\[truncated\]$/);
  assert.deepEqual(parse("VERDICT: PASS"), { verdict: "pass", summary: "VERDICT: PASS" });
  assert.equal(parse("VERDICT: PASS\nVERDICT: PASS").verdict, "malformed");
  assert.equal(parse("VERDICT: PASS\nVERDICT: FAIL").verdict, "malformed");
  const fencedOnlyPass = parse("```text\nVERDICT: PASS\n```");
  assert.equal(fencedOnlyPass.verdict, "malformed");
  assert.equal(parse("`VERDICT: PASS`").verdict, "malformed");
  assert.equal(parse("SUMMARY: No verdict was returned.").verdict, "malformed");
  assert.equal(parse("VERDICT: MAYBE").verdict, "malformed");
  assert.equal(parseWithFindings(complete).findingCount, 1);
  assert.equal(parseWithFindings("VERDICT: PASS\nSUMMARY: clean").findingCount, 0);
  const untagged = parseWithFindings("VERDICT: FAIL\nSUMMARY: no contract finding");
  assert.equal(untagged.findingCount, 1);
  assert.deepEqual(untagged.findings, [{
    severity: "major",
    file: "(untagged-review)",
    line: 1,
    summary: "no contract finding",
  }]);
  const mixed = parseWithFindings([
    "VERDICT: FAIL",
    "SUMMARY: One tagged and two untagged findings remain.",
    "[MINOR] ui/app.js:17 - Clarify the policy label.",
    "server/lib/dispatch.mjs:812 - Persist the debt with the merge record.",
    "- The merge reservation still admits a concurrent disposition change.",
  ].join("\n"));
  assert.deepEqual(mixed.findings, [
    {
      severity: "minor",
      file: "ui/app.js",
      line: 17,
      summary: "Clarify the policy label.",
    },
    {
      severity: "major",
      file: "server/lib/dispatch.mjs",
      line: 812,
      summary: "Persist the debt with the merge record.",
    },
    {
      severity: "major",
      file: null,
      line: null,
      summary: "The merge reservation still admits a concurrent disposition change.",
    },
  ]);
  assert.equal(mixed.findingCount, 3);
  const codeExamples = [
    "VERDICT: FAIL",
    "SUMMARY: One real finding follows.",
    "```text",
    "[BLOCKER] example.mjs:1 - This is contract documentation, not a finding.",
    "```",
    "Inline contract example: `[MAJOR] inline example`",
    "[[MINOR]] nested bracket noise",
    "[MINOR] server.mjs:2 - This is the only real finding.",
  ].join("\n");
  assert.equal(parseWithFindings(codeExamples).findingCount, 1);
  assert.equal(
    parseWithFindings(codeExamples).findingsText,
    "[MINOR] server.mjs:2 - This is the only real finding.",
  );
  assert.equal(
    parseWithFindings(
      "VERDICT: PASS\nSUMMARY: Examples only.\n~~~\n[BLOCKER] example only\n~~~",
    ).findingCount,
    0,
  );

  const malformed = parse("SUMMARY: No valid verdict was returned.");
  for (const result of [fencedOnlyPass, parse("VERDICT: PASS\nVERDICT: PASS")]) {
    assert.equal(
      _reviewMergeAssessment({
        review: { rounds: [{ round: 1, ...result }] },
      }, { requireReview: true }).eligible,
      false,
      "zero or duplicate unfenced verdict markers must gate",
    );
  }
  assert.equal(
    _reviewMergeAssessment({
      review: { rounds: [{ round: 1, ...parse("VERDICT: PASS") }] },
    }, { requireReview: true }).eligible,
    true,
    "one clean unfenced PASS marker must pass the verdict gate",
  );
  const setup = await fixture(t, { requireReview: true });
  const seeded = await seedDispatch(setup, {
    id: "dispatch-malformed-review",
    review: { dispatchId: "review-malformed-review", ...malformed },
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) =>
      error.status === 409 &&
      /review gate failed: expected pass, got malformed/.test(error.message),
    "a response without a valid verdict line must fail the requireReview merge gate",
  );

  const untaggedSetup = await fixture(t, { requireReview: true });
  const untaggedReview = parseWithFindings(
    "VERDICT: FAIL\nSUMMARY: An untagged merge-safety defect remains.",
  );
  const untaggedSeeded = await seedDispatch(untaggedSetup, {
    review: {
      dispatchId: "review-untagged-fail",
      reviewedHead: "reviewed-head",
      ...untaggedReview,
    },
  });
  const untaggedDispatcher = createDispatcher({
    registry: untaggedSetup.registry,
    stateDir: untaggedSetup.state,
  });
  await assert.rejects(
    untaggedDispatcher.merge(untaggedSeeded.id),
    (error) => error.status === 409 && /1 open review finding/.test(error.message),
    "a synthetic MAJOR from untagged FAIL output must gate strict merge",
  );

  const contradictory = parseWithFindings([
    "VERDICT: PASS",
    "VERDICT: FAIL",
    "SUMMARY: The response contradicts itself.",
    "[MAJOR] server/lib/dispatch.mjs:941 - Preserve the first tagged finding.",
    "[NIT] docs/CHANGELOG.md:12 - Preserve the second tagged finding.",
  ].join("\n"));
  assert.equal(contradictory.verdict, "malformed");
  assert.equal(contradictory.findingCount, 2);
  assert.deepEqual(contradictory.findings.map(({ severity }) => severity), ["major", "nit"]);
  const contradictoryRecord = {
    id: "contradictory-statistics",
    project: "fixture",
    review: { rounds: [{ round: 1, ...contradictory }] },
  };
  assert.equal(
    gatesFor(contradictoryRecord).find(({ gate }) => gate === "review")?.state,
    "failed",
  );
  assert.deepEqual(
    chronicleFor([contradictoryRecord], "fixture").summary.finalRoundSeverityDistribution,
    { blocker: 0, major: 1, minor: 0, nit: 1 },
  );

  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const contradictorySetup = await fixture(t, { requireReview: true, reviewPolicy });
    const contradictorySeeded = await seedDispatch(contradictorySetup, {
      review: {
        dispatchId: `review-contradictory-${reviewPolicy}`,
        reviewedHead: "reviewed-head",
        ...contradictory,
      },
    });
    const contradictoryDispatcher = createDispatcher({
      registry: contradictorySetup.registry,
      stateDir: contradictorySetup.state,
    });
    await assert.rejects(
      contradictoryDispatcher.merge(contradictorySeeded.id),
      (error) => error.status === 409 && /expected pass, got malformed/.test(error.message),
      `${reviewPolicy} admitted a contradictory review response`,
    );
  }

  const mixedSetup = await fixture(t, { requireReview: true, reviewPolicy: "tiered" });
  const mixedSeeded = await seedDispatch(mixedSetup, {
    review: {
      dispatchId: "review-mixed-untagged",
      reviewedHead: "reviewed-head",
      ...mixed,
    },
  });
  const mixedDispatcher = createDispatcher({
    registry: mixedSetup.registry,
    stateDir: mixedSetup.state,
  });
  await assert.rejects(
    mixedDispatcher.merge(mixedSeeded.id),
    (error) => error.status === 409 && /2 open MAJOR findings/.test(error.message),
    "each untagged finding must gate tiered merge even beside a tagged MINOR",
  );
});

test("structured review findings parse severity, location, summary, and tolerate bullets and NIT", () => {
  const parsed = _parsedReviewResult({
    state: "completed",
    exitSummary: [
      "VERDICT: FAIL",
      "[BLOCKER] server/lib/dispatch.mjs:42 - Unsafe request path remains reachable.",
      "- [MAJOR] ui/app.js:17:8 — The gate badge hides the failed state.",
      "* [NIT] docs/THEMES.md:9 - Clarify the additive contract word.",
    ].join("\n"),
  });
  assert.deepEqual(parsed.findings, [
    {
      severity: "blocker",
      file: "server/lib/dispatch.mjs",
      line: 42,
      summary: "Unsafe request path remains reachable.",
    },
    {
      severity: "major",
      file: "ui/app.js",
      line: 17,
      summary: "The gate badge hides the failed state.",
    },
    {
      severity: "nit",
      file: "docs/THEMES.md",
      line: 9,
      summary: "Clarify the additive contract word.",
    },
  ]);
  assert.equal(parsed.findingCount, 3);

  const immediateBody = _parsedReviewResult({
    state: "completed",
    exitSummary: "VERDICT: FAIL\n[BLOCKER]server.mjs:42 - No separator follows the tag.",
  });
  assert.deepEqual(immediateBody.findings, [{
    severity: "blocker",
    file: "server.mjs",
    line: 42,
    summary: "No separator follows the tag.",
  }]);
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment({
      review: { rounds: [{ round: 1, ...immediateBody }] },
    }, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted an immediate BLOCKER tag`);
  }

  const opaque = _parsedReviewResult({
    state: "completed",
    exitSummary: "VERDICT: FAIL\n[MAJOR] No file and line were supplied.",
  });
  assert.equal(opaque.findingCount, 1, "opaque behavior keeps the mechanical count");
  assert.deepEqual(opaque.findings, [{
    severity: "major",
    file: null,
    line: null,
    summary: "No file and line were supplied.",
  }], "a malformed tagged line retains its own severity with location unknown");

  const punctuated = _parsedReviewResult({
    state: "completed",
    exitSummary: [
      "VERDICT: FAIL",
      "[BLOCKER]: The punctuation after the tag must not erase its severity.",
      "[MINOR] ui/app.js:18 - A valid sibling remains independently parseable.",
    ].join("\n"),
  });
  assert.deepEqual(punctuated.findings, [
    {
      severity: "blocker",
      file: null,
      line: null,
      summary: "The punctuation after the tag must not erase its severity.",
    },
    {
      severity: "minor",
      file: "ui/app.js",
      line: 18,
      summary: "A valid sibling remains independently parseable.",
    },
  ]);
  assert.equal(
    _normalizedFindingIdentity({ file: "./ui\\app.js", summary: "UNFIXED: Gate leaks, new example." }),
    "ui/app.js\nunknown\ngate leaks new example",
  );
  assert.equal(
    _normalizedFindingIdentity({
      file: "server/lib/dispatch.mjs",
      summary: "dispatch.mjs loses the human actor. A second failure scenario follows.",
    }),
    "server/lib/dispatch.mjs\nunknown\ndispatch mjs loses the human actor",
    "a filename extension inside the claim is not a sentence boundary",
  );

  const inlineTerm = _parsedReviewResult({
    state: "completed",
    exitSummary: "VERDICT: FAIL\n[MINOR] ui/app.js:22 - Validate `reviewPolicy`.",
  });
  assert.equal(inlineTerm.findings[0].summary, "Validate reviewPolicy.");
});

test("same-file findings that differ after a comma have distinct identities", () => {
  const first = {
    ref: "round-1:finding-1",
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 42,
    summary: "The review path shares an introduction, but loses the first policy.",
  };
  const second = {
    ref: "round-1:finding-2",
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 44,
    summary: "The review path shares an introduction, but loses the second policy.",
  };
  assert.notEqual(
    _normalizedFindingIdentity(first),
    _normalizedFindingIdentity(second),
    "the full first sentence remains identity-bearing inside one line band",
  );
  assert.notEqual(
    _normalizedFindingIdentity(first),
    _normalizedFindingIdentity({
      ...first,
      summary: "The review path shares an introduction — but loses the third policy.",
    }),
    "an em-dash clause remains part of the complete first sentence",
  );
  const repeatedSecond = { ...second, ref: "round-2:finding-1" };
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findings: [first, second] },
      { round: 2, verdict: "fail", findings: [repeatedSecond] },
    ] },
    reviewDispositions: [{
      ref: "redirect-first",
      findingRef: first.ref,
      disposition: "redirected",
      redirectTicket: "atelier-first-policy",
      note: "Only the first policy belongs in the follow-up.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  };

  const [classified] = _classifiedReviewFindings(record, record.review.rounds[1]);
  assert.equal(classified.novelty, "repeated");
  assert.equal(Object.hasOwn(classified, "dispositionRef"), false);
  assert.equal(
    _reviewMergeAssessment(record, { requireReview: true, reviewPolicy: "strict" }).eligible,
    false,
    "redirecting the first comma-distinct finding must not neutralize the second",
  );
});

test("same-file finding identities retain differentiators after e.g. abbreviations", () => {
  const shared = {
    file: "server/lib/dispatch.mjs",
    line: 42,
  };
  assert.notEqual(
    _normalizedFindingIdentity({
      ...shared,
      summary: "The parser drops examples, e.g. alpha remains misclassified.",
    }),
    _normalizedFindingIdentity({
      ...shared,
      summary: "The parser drops examples, e.g. beta remains misclassified.",
    }),
  );
});

test("inline-code severity examples remain content and never start findings", () => {
  const literal = "[BLOCKER] example.mjs:1 - illustrative";
  const parsed = _parsedReviewResult({
    state: "completed",
    exitSummary: [
      "VERDICT: FAIL",
      `[MINOR] docs/review.md:18 - Preserve the literal \`${literal}\` as documentation.`,
      `\`${literal}\``,
    ].join("\n"),
  });
  assert.equal(parsed.findingCount, 1);
  assert.deepEqual(parsed.findings, [{
    severity: "minor",
    file: "docs/review.md",
    line: 18,
    summary: `Preserve the literal ${literal} as documentation.`,
  }]);
});

test("untagged FAIL findings recognize markdown, ordered, and common Unicode bullets", () => {
  const bullets = ["+", "1.", "2)", "\u2022", "\u2023", "\u25e6", "\u2043", "\u2219"];
  for (const [index, bullet] of bullets.entries()) {
    const parsed = _parsedReviewResult({
      state: "completed",
      exitSummary: `VERDICT: FAIL\n${bullet} untagged finding form ${index + 1}`,
    });
    assert.equal(parsed.findingCount, 1, `${bullet} was not counted`);
    assert.deepEqual(parsed.findings, [{
      severity: "major",
      file: null,
      line: null,
      summary: `untagged finding form ${index + 1}`,
    }]);
  }
});

test("untagged PASS finding bullets become synthetic MAJORs and gate strict policy", () => {
  const parsed = _parsedReviewResult({
    state: "completed",
    exitSummary: [
      "VERDICT: PASS",
      "- server/lib/dispatch.mjs:965 - This defect was reported beside a PASS verdict.",
    ].join("\n"),
  });
  assert.deepEqual(parsed.findings, [{
    severity: "major",
    file: "server/lib/dispatch.mjs",
    line: 965,
    summary: "This defect was reported beside a PASS verdict.",
  }]);
  assert.equal(parsed.findingCount, 1);

  const assessment = _reviewMergeAssessment({
    review: { rounds: [{
      round: 1,
      verdict: parsed.verdict,
      findingCount: parsed.findingCount,
      findings: parsed.findings,
    }] },
  }, {
    requireReview: true,
    reviewPolicy: "strict",
  });
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reason, /1 open review finding/);
  assert.equal(assessment.findings[0].severity, "major");
});

test("structured review capture bounds arrays and preserves every overflow finding text", () => {
  const longFile = `${"f".repeat(600)}.mjs`;
  const longSummary = "s".repeat(3_000);
  const lines = [
    "VERDICT: FAIL",
    `[MINOR] ${longFile}:1 - ${longSummary}`,
    ...Array.from({ length: 9 }, (_, index) =>
      `[MINOR] file-${index + 2}.mjs:${index + 2} - bounded finding ${index + 2}`),
    `[BLOCKER] late-blocker.mjs:99 - ${"b".repeat(3_000)}`,
  ];

  const parsed = _parsedReviewResult({ state: "completed", exitSummary: lines.join("\n") });

  assert.equal(parsed.findingCount, 10);
  assert.equal(parsed.findings.length, 10);
  assert.equal(parsed.findingsTruncated, true);
  assert.equal(parsed.findings[0].file.length, 500);
  assert.match(parsed.findings[0].file, /\.\.\.\[truncated\]$/);
  assert.equal(parsed.findings[0].summary.length, 1_000);
  assert.match(parsed.findings[0].summary, /\.\.\.\[truncated\]$/);
  assert.deepEqual(parsed.findings.at(-1), {
    severity: "minor",
    file: "file-10.mjs",
    line: 10,
    summary: "bounded finding 10",
  });
  assert.equal(parsed.findingOverflowCount, 1);
  assert.equal(parsed.findingOverflowSeverity, "blocker");
  assert.deepEqual(parsed.findingOverflowSeverityCounts, {
    blocker: 1,
    major: 0,
    minor: 0,
    nit: 0,
  });
  assert.deepEqual(parsed.findingOverflowSeverities, ["blocker"]);
  assert.equal(parsed.findingOverflowText, lines.at(-1));
  assert.equal(parsed.findingsText.length, 4_000);
  assert.match(parsed.findingsText, /\.\.\.\[truncated\]$/);

  const assessment = _reviewMergeAssessment({
    review: { rounds: [{ round: 1, ...parsed }] },
  }, {
    requireReview: true,
    reviewPolicy: "tiered",
  });
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reason, /BLOCKER/);
});

test("review merge policy is per-project, untagged FAIL is MAJOR, and BLOCKER always gates", () => {
  const finding = (severity, ref = `round-1:${severity}`) => ({
    ref,
    severity,
    file: "server/lib/dispatch.mjs",
    line: 1,
    summary: `${severity} fixture finding`,
    novelty: "new",
  });
  const recordWith = (findings, verdict = "fail") => ({
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-policy",
        reviewedHead: "reviewed-head",
        verdict,
        findings,
      }],
    },
    reviewDispositions: [],
  });
  const minor = recordWith([finding("minor")]);
  assert.equal(
    _reviewMergeAssessment(minor, { requireReview: true }).eligible,
    false,
    "strict remains the default",
  );
  assert.equal(
    _reviewMergeAssessment(minor, { requireReview: true, reviewPolicy: "tiered" }).eligible,
    true,
  );
  const major = recordWith([finding("major")]);
  assert.equal(
    _reviewMergeAssessment(major, { requireReview: true, reviewPolicy: "tiered" }).eligible,
    false,
  );
  assert.equal(
    _reviewMergeAssessment(major, { requireReview: true, reviewPolicy: "advisory" }).eligible,
    true,
  );
  const dispositionForMajor = (disposition) => {
    const record = recordWith([finding("major")]);
    record.reviewDispositions = [{
      ref: "disposition-1",
      findingRef: "round-1:major",
      disposition,
      ...(disposition === "redirected" ? { redirectTicket: "atelier-follow-up" } : {}),
      note: `${disposition} with explicit human evidence.`,
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }];
    return record;
  };
  for (const disposition of ["refuted", "redirected", "waived"]) {
    assert.equal(
      _reviewMergeAssessment(dispositionForMajor(disposition), {
        requireReview: true,
        reviewPolicy: "strict",
      }).eligible,
      true,
      `${disposition} did not neutralize a MAJOR finding under strict policy`,
    );
  }
  assert.equal(
    _reviewMergeAssessment(dispositionForMajor("accepted"), {
      requireReview: true,
      reviewPolicy: "strict",
    }).eligible,
    false,
    "bare acceptance must remain open until fixed and re-reviewed or explicitly waived",
  );

  const redirectDispute = recordWith([{
    ...finding("major", "round-2:finding-1"),
    novelty: "redirect-disputed",
    dispositionRef: "disposition-1",
  }]);
  redirectDispute.reviewDispositions = [{
    ref: "disposition-1",
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "Move this finding to its own ticket.",
    actor: "fixture-architect",
    at: "2026-07-31T00:00:00.000Z",
  }];
  assert.equal(
    _reviewMergeAssessment(redirectDispute, {
      requireReview: true,
      reviewPolicy: "strict",
    }).eligible,
    true,
    "the unresolved redirect dispute is excluded while the redirect remains current",
  );
  redirectDispute.reviewDispositions.push({
    ref: "disposition-2",
    findingRef: "round-2:finding-1",
    disposition: "accepted",
    note: "The disputed re-flag is accepted and must be fixed.",
    actor: "fixture-architect",
    at: "2026-07-31T00:01:00.000Z",
  });
  assert.equal(
    _reviewMergeAssessment(redirectDispute, {
      requireReview: true,
      reviewPolicy: "strict",
    }).eligible,
    false,
    "redirect -> dispute -> accept must reopen and gate the finding",
  );
  redirectDispute.reviewDispositions.pop();
  redirectDispute.reviewDispositions.push({
    ref: "disposition-2",
    findingRef: "round-2:finding-1",
    disposition: "waived",
    note: "The disputed re-flag was temporarily waived.",
    actor: "fixture-architect",
    at: "2026-07-31T00:01:00.000Z",
  }, {
    ref: "disposition-3",
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "The original redirect is superseded; this work is back in scope.",
    actor: "fixture-architect",
    at: "2026-07-31T00:02:00.000Z",
  });
  assert.equal(
    _reviewMergeAssessment(redirectDispute, {
      requireReview: true,
      reviewPolicy: "strict",
    }).eligible,
    false,
    "accepting the original redirected finding must also reopen its disputed re-flag",
  );

  const untagged = recordWith(undefined);
  const untaggedAssessment = _reviewMergeAssessment(untagged, {
    requireReview: true,
    reviewPolicy: "strict",
  });
  assert.equal(untaggedAssessment.eligible, false);
  assert.equal(untaggedAssessment.findings[0].severity, "major");

  const malformedBlockerBesideMinor = _parsedReviewResult({
    state: "completed",
    exitSummary: [
      "VERDICT: FAIL",
      "[BLOCKER] The location was accidentally omitted.",
      "[MINOR] ui/app.js:17 - Clarify the policy label.",
    ].join("\n"),
  });
  assert.deepEqual(malformedBlockerBesideMinor.findings, [
    {
      severity: "blocker",
      file: null,
      line: null,
      summary: "The location was accidentally omitted.",
    },
    {
      severity: "minor",
      file: "ui/app.js",
      line: 17,
      summary: "Clarify the policy label.",
    },
  ], "one malformed line must not discard an independently parsed sibling");
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment(
      recordWith(malformedBlockerBesideMinor.findings),
      { requireReview: true, reviewPolicy },
    );
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted a malformed BLOCKER`);
    assert.match(assessment.reason, /BLOCKER/);
  }

  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const blocked = recordWith([finding("blocker")]);
    blocked.reviewDispositions = [{
      ref: "disposition-1",
      findingRef: "round-1:blocker",
      disposition: "accepted",
      note: "The blocker is acknowledged.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }];
    const assessment = _reviewMergeAssessment(blocked, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted a disposed blocker`);
    assert.match(assessment.reason, /BLOCKER/);
  }
});

test("trajectory decisions use only false reports, strict count shrinkage, and the round backstop", () => {
  const record = (rounds) => ({ review: { rounds } });
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3, falseReport: true },
    ]), 4).code,
    "false-self-report",
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "fail", findingCount: 3 },
    ]), 4).code,
    "non-convergence",
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "fail", findingCount: null },
    ]), 4).code,
    "non-convergence",
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 8 },
      { round: 2, verdict: "fail", findingCount: 6 },
      { round: 3, verdict: "fail", findingCount: 4 },
      { round: 4, verdict: "fail", findingCount: 2 },
      { round: 5, verdict: "pass", findingCount: 1 },
    ]), 4).code,
    "hard-backstop",
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "pending", findingCount: null },
      { round: 3, verdict: "fail", findingCount: 2 },
    ]), 4),
    null,
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "fail", findingCount: 2 },
      { round: 3, verdict: "fail", findingCount: 3 },
    ]), 4, 2),
    null,
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "error", findingCount: null },
      { round: 3, verdict: "fail", findingCount: 2 },
    ]), 4),
    null,
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 8 },
      { round: 2, verdict: "error", findingCount: null },
      { round: 3, verdict: "fail", findingCount: 4 },
      { round: 4, verdict: "error", findingCount: null },
      { round: 5, verdict: "error", findingCount: null },
    ]), 4).code,
    "hard-backstop",
  );

  // Negative controls: a first ordinary FAIL and a shrinking second round both
  // earn another round; the same round-five ladder stays live when configured
  // with a five-round backstop.
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3, falseReport: false },
    ]), 4),
    null,
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 3 },
      { round: 2, verdict: "fail", findingCount: 2 },
    ]), 4),
    null,
  );
  assert.equal(
    _reviewParkingDecision(record([
      { round: 1, verdict: "fail", findingCount: 8 },
      { round: 2, verdict: "fail", findingCount: 6 },
      { round: 3, verdict: "fail", findingCount: 4 },
      { round: 4, verdict: "fail", findingCount: 2 },
      { round: 5, verdict: "pass", findingCount: 1 },
    ]), 5),
    null,
  );
});

function scenarioFinding(index, severity = "major", prefix = "finding") {
  return {
    severity,
    file: `server/${prefix}-${index}.mjs`,
    line: index + 1,
    summary: `${prefix} claim ${index}, the failure scenario can be reworded`,
  };
}

function dispositionHistory(round, count, disposition = "waived") {
  return Array.from({ length: count }, (_, index) => ({
    ref: `disposition-${round}-${index + 1}`,
    findingRef: `round-${round}:finding-${index + 1}`,
    disposition,
    ...(disposition === "redirected" ? { redirectTicket: "atelier-gg0" } : {}),
    note: "Architect adjudication with evidence.",
    actor: "fixture-architect",
    at: "2026-07-31T00:00:00.000Z",
  }));
}

test("live scenario 1: 6 to 8 all-new second-order findings does not park", () => {
  const prior = Array.from({ length: 6 }, (_, index) => scenarioFinding(index, "major", "first-order"));
  const current = Array.from({ length: 8 }, (_, index) => scenarioFinding(index, "major", "second-order"));
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 6, findings: prior },
      { round: 2, verdict: "fail", findingCount: 8, findings: current },
    ] },
    reviewDispositions: dispositionHistory(1, 6),
  };
  assert.ok(_classifiedReviewFindings(record, record.review.rounds[1]).every(
    (finding) => finding.novelty === "new",
  ));
  assert.equal(_reviewParkingDecision(record, 4), null);
});

test("live scenario 2: 5 to 5 all-new findings does not park", () => {
  const record = {
    review: { rounds: [
      {
        round: 1,
        verdict: "fail",
        findingCount: 5,
        findings: Array.from({ length: 5 }, (_, index) => scenarioFinding(index, "minor", "surface")),
      },
      {
        round: 2,
        verdict: "fail",
        findingCount: 5,
        findings: Array.from({ length: 5 }, (_, index) => scenarioFinding(index, "minor", "follow-up")),
      },
    ] },
    reviewDispositions: dispositionHistory(1, 5, "refuted"),
  };
  assert.equal(_reviewParkingDecision(record, 4), null);
});

test("parseable legacy findingsText classifies all-new same-count rounds instead of parking opaque", () => {
  const textFor = (findings) => findings
    .map((finding) => `[${finding.severity.toUpperCase()}] ${finding.file}:${finding.line} - ${finding.summary}`)
    .join("\n");
  const prior = Array.from({ length: 5 }, (_, index) =>
    scenarioFinding(index, "minor", "legacy-surface"));
  const current = Array.from({ length: 5 }, (_, index) =>
    scenarioFinding(index, "minor", "legacy-follow-up"));
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 5, findingsText: textFor(prior) },
      { round: 2, verdict: "fail", findingCount: 5, findingsText: textFor(current) },
    ] },
    reviewDispositions: dispositionHistory(1, 5, "refuted"),
  };

  assert.ok(_classifiedReviewFindings(record, record.review.rounds[1]).every(
    (finding) => finding.novelty === "new",
  ));
  assert.equal(_reviewParkingDecision(record, 4), null);
});

test("parseable legacy findingsText catches a repeated MAJOR while unparseable text stays opaque", () => {
  const repeated = scenarioFinding(0, "major", "legacy-repeat");
  const findingText = `[MAJOR] ${repeated.file}:${repeated.line} - ${repeated.summary}`;
  const parsed = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 1, findingsText: findingText },
      { round: 2, verdict: "fail", findingCount: 1, findingsText: findingText },
    ] },
    reviewDispositions: [],
  };
  const opaque = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 1, findingsText: "One concern remains." },
      { round: 2, verdict: "fail", findingCount: 1, findingsText: "Still one concern." },
    ] },
    reviewDispositions: [],
  };

  assert.equal(
    _reviewParkingDecision(parsed, 4).code,
    "repeated-severe-finding",
  );
  assert.equal(_classifiedReviewFindings(opaque, opaque.review.rounds[1]), null);
  assert.equal(_reviewParkingDecision(opaque, 4).code, "non-convergence");
});

test("live scenario 3: five redirected re-flags are redirect-disputed and excluded", () => {
  const redirected = Array.from({ length: 5 }, (_, index) => scenarioFinding(index, "major", "redirected"));
  const prior = Array.from({ length: 2 }, (_, index) => scenarioFinding(index, "minor", "prior-open"));
  const current = [
    ...redirected.map((finding) => ({ ...finding })),
    ...Array.from({ length: 2 }, (_, index) => scenarioFinding(index, "minor", "new-surface")),
  ];
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 5, findings: redirected },
      { round: 2, verdict: "fail", findingCount: 2, findings: prior },
      { round: 3, verdict: "fail", findingCount: 7, findings: current },
    ] },
    reviewDispositions: [
      ...dispositionHistory(1, 5, "redirected"),
      ...dispositionHistory(2, 2, "waived"),
    ],
  };
  const classified = _classifiedReviewFindings(record, record.review.rounds[2]);
  assert.deepEqual(
    classified.map((finding) => finding.novelty),
    [
      "redirect-disputed",
      "redirect-disputed",
      "redirect-disputed",
      "redirect-disputed",
      "redirect-disputed",
      "new",
      "new",
    ],
  );
  assert.ok(classified.slice(0, 5).every((finding) => finding.dispositionRef));
  assert.equal(_reviewParkingDecision(record, 4), null);
});

test("trajectory parking includes a repeated severe finding in overflow position eleven", () => {
  const repeated = scenarioFinding(10, "major", "overflow-repeat");
  const roundWithOverflow = (round, visiblePrefix) => ({
    round,
    verdict: "fail",
    findingCount: 10,
    findings: Array.from({ length: 10 }, (_, index) =>
      scenarioFinding(index, "minor", visiblePrefix)),
    findingsTruncated: true,
    findingOverflowCount: 1,
    findingOverflowSeverity: "major",
    findingOverflowSeverityCounts: { blocker: 0, major: 1, minor: 0, nit: 0 },
    findingOverflowSeverities: ["major"],
    findingOverflowText:
      `\`${repeated.file}:${repeated.line}\` - ${repeated.summary}`,
  });
  const record = {
    review: { rounds: [
      roundWithOverflow(1, "prior-visible"),
      roundWithOverflow(2, "current-visible"),
    ] },
    reviewDispositions: [dispositionHistory(1, 1, "waived")[0]],
  };

  const current = _classifiedReviewFindings(record, record.review.rounds[1]);
  assert.equal(current.length, 11);
  assert.deepEqual(
    {
      ref: current[10].ref,
      severity: current[10].severity,
      file: current[10].file,
      line: current[10].line,
      novelty: current[10].novelty,
    },
    {
      ref: "round-2:overflow-1",
      severity: "major",
      file: repeated.file,
      line: repeated.line,
      novelty: "repeated",
    },
  );
  assert.equal(_reviewParkingDecision(record, 4).code, "repeated-severe-finding");
});

test("redirect disposition lineage keeps a round-three verbatim defect open after acceptance", () => {
  const finding = scenarioFinding(0, "major", "redirect-lineage");
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
      { round: 2, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
      { round: 3, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
    ] },
    reviewDispositions: [{
      ref: "disposition-redirect",
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: "atelier-follow-up",
      note: "Move the original finding to its own ticket.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  };

  const roundTwo = _classifiedReviewFindings(record, record.review.rounds[1]);
  assert.equal(roundTwo[0].novelty, "redirect-disputed");
  record.review.rounds[1].findings = roundTwo;
  record.reviewDispositions.push({
    ref: "disposition-accept-dispute",
    findingRef: "round-2:finding-1",
    disposition: "accepted",
    note: "The disputed re-flag is accepted and must be fixed here.",
    actor: "fixture-architect",
    at: "2026-07-31T00:01:00.000Z",
  });

  const roundThree = _classifiedReviewFindings(record, record.review.rounds[2]);
  assert.equal(roundThree[0].novelty, "repeated");
  assert.equal(Object.hasOwn(roundThree[0], "dispositionRef"), false);
  record.review.rounds[2].findings = roundThree;
  assert.equal(
    _reviewMergeAssessment(record, { requireReview: true, reviewPolicy: "strict" }).eligible,
    false,
    "the original redirect must never neutralize an accepted disputed re-flag",
  );

  record.reviewDispositions.push({
    ref: "disposition-waive-round-three",
    findingRef: "round-3:finding-1",
    disposition: "waived",
    note: "The still-open round-three defect is explicitly waived.",
    actor: "fixture-architect",
    at: "2026-07-31T00:02:00.000Z",
  });
  assert.equal(
    _reviewMergeAssessment(record, { requireReview: true, reviewPolicy: "strict" }).eligible,
    true,
    "a later explicit waiver remains capable of neutralizing the open defect",
  );
});

test("redirect lineage uses the latest disposition timestamp across rounds", () => {
  const finding = scenarioFinding(0, "major", "redirect-lineage-timestamp");
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
      { round: 2, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
      { round: 3, verdict: "fail", findingCount: 1, findings: [{ ...finding }] },
    ] },
    reviewDispositions: [{
      ref: "disposition-r1-redirect",
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: "atelier-follow-up",
      note: "Redirect the original finding.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  };

  const roundTwo = _classifiedReviewFindings(record, record.review.rounds[1]);
  record.review.rounds[1].findings = roundTwo;
  record.reviewDispositions.push({
    ref: "disposition-r2-waiver",
    findingRef: "round-2:finding-1",
    disposition: "waived",
    note: "Waive the round-two re-flag.",
    actor: "fixture-architect",
    at: "2026-07-31T00:01:00.000Z",
  });

  const roundThree = _classifiedReviewFindings(record, record.review.rounds[2]);
  assert.equal(roundThree[0].novelty, "redirect-disputed");
  assert.equal(roundThree[0].dispositionRef, "disposition-r2-waiver");
  record.review.rounds[2].findings = roundThree;
  record.reviewDispositions.push({
    ref: "disposition-r3-settlement",
    findingRef: "round-3:finding-1",
    disposition: "waived",
    note: "Settle the round-three re-flag.",
    actor: "fixture-architect",
    at: "2026-07-31T00:02:00.000Z",
  });
  assert.equal(
    _reviewMergeAssessment(record, { requireReview: true, reviewPolicy: "strict" }).eligible,
    true,
    "the round-three settlement should control before a later lineage disposition",
  );

  record.reviewDispositions.push({
    ref: "disposition-r1-acceptance",
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "Later evidence accepts the original finding back into scope.",
    actor: "fixture-architect",
    at: "2026-07-31T00:03:00.000Z",
  });
  assert.equal(
    _reviewMergeAssessment(record, { requireReview: true, reviewPolicy: "strict" }).eligible,
    false,
    "the later round-one acceptance must reopen the settled round-three finding",
  );
});

test("redirected re-flags reopen only with the explicit new-evidence marker", () => {
  const prior = [
    scenarioFinding(0, "major", "redirected"),
    scenarioFinding(1, "major", "redirected"),
    scenarioFinding(2, "major", "redirected"),
  ];
  const current = [
    {
      ...prior[0],
      summary: prior[0].summary,
    },
    {
      ...prior[1],
      summary: `${prior[1].summary} — NEW EVIDENCE: server/redirected-1.mjs changed since atelier-gg0`,
    },
    {
      ...prior[2],
      summary: `${prior[2].summary} — New Evidence: case variants are not the convention`,
    },
  ];
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 3, findings: prior },
      { round: 2, verdict: "fail", findingCount: 3, findings: current },
    ] },
    reviewDispositions: dispositionHistory(1, 3, "redirected"),
  };

  const classified = _classifiedReviewFindings(record, record.review.rounds[1]);
  assert.deepEqual(
    classified.map(({ novelty }) => novelty),
    ["redirect-disputed", "new", "redirect-disputed"],
    "only a non-empty exact marker reopens redirected work",
  );
  assert.equal(classified[0].dispositionRef, "disposition-1-1");
  assert.equal(Object.hasOwn(classified[1], "dispositionRef"), false);
  assert.equal(classified[2].dispositionRef, "disposition-1-3");
  record.review.rounds[1].findings = classified;
  const assessment = _reviewMergeAssessment(record, {
    requireReview: true,
    reviewPolicy: "strict",
  });
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reason, /1 open review finding/);
});

test("new evidence after character 1000 reopens a redirected finding before summary truncation", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const finding = scenarioFinding(0, "major", "redirected-long");
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Keep redirected work outside this dispatch unless evidence changes.",
    review: { rounds: [{
      round: 1,
      dispatchId: "review-round-1-long",
      reviewedHead: "prior-head",
      verdict: "fail",
      findingCount: 1,
      findings: [{ ...finding, ref: "round-1:finding-1", novelty: "new" }],
    }] },
    reviewDispositions: dispositionHistory(1, 1, "redirected"),
  });
  await mkdir(target.worktreePath, { recursive: true });
  const fullSummary = `${finding.summary}. ${"x".repeat(1_050)} — NEW EVIDENCE: the redirect target no longer contains the fix`;
  assert.ok(fullSummary.indexOf("NEW EVIDENCE") > 1_000);
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: `VERDICT: FAIL\n[MAJOR] ${finding.file}:${finding.line} - ${fullSummary}`,
  }));
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);

  const surfaced = dispatcher.get(target.id).review.current.findings[0];
  assert.equal(surfaced.summary.length, 1_000);
  assert.doesNotMatch(surfaced.summary, /NEW EVIDENCE/);
  assert.equal(surfaced.novelty, "new");
  assert.equal(surfaced.explicitNewEvidence, true);
  assert.equal(Object.hasOwn(surfaced, "dispositionRef"), false);
  const assessment = _reviewMergeAssessment(dispatcher.get(target.id), {
    requireReview: true,
    reviewPolicy: "strict",
  });
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reason, /1 open review finding/);
});

test("redirect-disputed is persisted and surfaced on the target record and review event", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const finding = scenarioFinding(0, "major", "redirected");
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Keep redirected work outside this dispatch.",
    review: { rounds: [{
      round: 1,
      dispatchId: "review-round-1",
      reviewedHead: "prior-head",
      verdict: "fail",
      findingCount: 1,
      findings: [{ ...finding, ref: "round-1:finding-1", novelty: "new" }],
    }] },
    reviewDispositions: dispositionHistory(1, 1, "redirected"),
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: [
      "VERDICT: FAIL",
      `[MAJOR] ${finding.file}:${finding.line} - ${finding.summary}`,
    ].join("\n"),
  }));
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);

  const surfaced = dispatcher.get(target.id).review.current.findings[0];
  assert.equal(surfaced.novelty, "redirect-disputed");
  assert.equal(surfaced.dispositionRef, "disposition-1-1");
  assert.equal(dispatcher.get(target.id).reviewParking, null);
  const event = dispatcher.getEvents(target.id).findLast((candidate) => candidate.type === "review");
  assert.deepEqual(event.findings, [surfaced]);
});

test("review events preserve overflow severities so live clients see a late BLOCKER", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Surface every overflow severity to live clients.",
  });
  await mkdir(target.worktreePath, { recursive: true });
  const findings = [
    ...Array.from({ length: 10 }, (_, index) =>
      `[NIT] file-${index + 1}.mjs:${index + 1} - Bounded finding ${index + 1}.`),
    "[BLOCKER] overflow.mjs:99 - The late blocker must reach every client.",
  ];
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: ["VERDICT: FAIL", ...findings].join("\n"),
  }));
  _setRunFile(async (_file, args) => {
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);

  const event = dispatcher.getEvents(target.id).findLast((candidate) => candidate.type === "review");
  assert.equal(event.findings.length, 10);
  assert.equal(event.findingsTruncated, true);
  assert.equal(event.findingOverflowCount, 1);
  assert.equal(event.findingOverflowSeverity, "blocker");
  assert.deepEqual(event.findingOverflowSeverityCounts, {
    blocker: 1,
    major: 0,
    minor: 0,
    nit: 0,
  });
  assert.deepEqual(event.findingOverflowSeverities, ["blocker"]);
  assert.equal(event.findingOverflowText, findings.at(-1));
  assert.equal(
    event.gates.find((gate) => gate.gate === "review")?.state,
    "failed",
  );
});

test("a repeated undispositioned blocker or major parks even when weighted count shrinks", () => {
  const repeat = scenarioFinding(1, "major", "repeat");
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 2, findings: [repeat, scenarioFinding(2)] },
      { round: 2, verdict: "fail", findingCount: 1, findings: [{ ...repeat, line: 9 }] },
    ] },
    reviewDispositions: [
      ...dispositionHistory(1, 1, "refuted"),
      {
        ...dispositionHistory(1, 2, "accepted")[1],
        findingRef: "round-1:finding-2",
      },
    ],
  };
  assert.equal(_reviewParkingDecision(record, 4).code, "repeated-severe-finding");
});

test("a repeated undispositioned MAJOR parks when no disposition exists anywhere", () => {
  const repeated = scenarioFinding(0, "major", "zero-disposition-repeat");
  const record = {
    review: { rounds: [
      { round: 1, verdict: "fail", findingCount: 1, findings: [{ ...repeated }] },
      { round: 2, verdict: "fail", findingCount: 1, findings: [{ ...repeated }] },
    ] },
    reviewDispositions: [],
  };
  assert.equal(_reviewParkingDecision(record, 4).code, "repeated-severe-finding");
});

test("weighted non-convergence parks without dispositions even when raw count shrinks", () => {
  const record = {
    review: { rounds: [
      {
        round: 1,
        verdict: "fail",
        findingCount: 2,
        findings: [
          scenarioFinding(0, "minor", "prior-minor"),
          scenarioFinding(1, "minor", "prior-minor"),
        ],
      },
      {
        round: 2,
        verdict: "fail",
        findingCount: 1,
        findings: [scenarioFinding(0, "major", "new-major")],
      },
    ] },
    reviewDispositions: [],
  };
  const decision = _reviewParkingDecision(record, 4);
  assert.equal(decision.code, "non-convergence");
  assert.match(decision.reason, /weighted open-finding score did not improve \(2 to 2\)/);
});

test("review dispositions require an actor and remain append-only across restart", async (t) => {
  const setup = await fixture(t, { requireReview: true, tracker: "committed" });
  const target = await seedDispatch(setup, {
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-disposition-round",
        reviewedHead: "fixture-head",
        verdict: "fail",
        findingCount: 1,
        findings: [{
          ref: "round-1:finding-1",
          severity: "major",
          file: "server/lib/dispatch.mjs",
          line: 10,
          summary: "The finding needs a human ruling.",
          novelty: "new",
        }],
      }],
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({ id: target.ticketId, status: "in_progress" })}\n` +
      `${JSON.stringify({ id: "atelier-follow-up", status: "open" })}\n`,
  );
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.reviewDisposition(target.id, {
      findingRef: "round-1:finding-1",
      disposition: "refuted",
      note: "Mechanical evidence disproves this finding.",
    }),
    /actor must be a non-empty string/,
  );
  await assert.rejects(
    dispatcher.reviewDisposition(target.id, {
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      note: "Owned elsewhere.",
      actor: "fixture-architect",
    }),
    /redirectTicket must be a non-empty string/,
  );

  const first = await dispatcher.reviewDisposition(target.id, {
    findingRef: "round-1:finding-1",
    disposition: "accepted",
    note: "Accepted for implementation, but not fixed or waived.",
    actor: "fixture-architect",
  });
  assert.equal(first.reviewDispositions.length, 1);
  assert.equal(
    first.gates.find((gate) => gate.gate === "review").state,
    "failed",
  );

  const second = await dispatcher.reviewDisposition(target.id, {
    findingRef: "round-1:finding-1",
    disposition: "refuted",
    note: "New evidence supersedes the earlier acceptance without deleting it.",
    actor: "fixture-architect",
  });
  assert.deepEqual(
    second.reviewDispositions.map(({ ref, disposition }) => ({ ref, disposition })),
    [
      { ref: "disposition-1", disposition: "accepted" },
      { ref: "disposition-2", disposition: "refuted" },
    ],
  );
  assert.equal(
    second.gates.find((gate) => gate.gate === "review").state,
    "passed-with-dispositions",
  );
  assert.equal(rawRecord(setup, target.id).reviewDispositions.length, 2);

  const waived = await dispatcher.reviewDisposition(target.id, {
    findingRef: "round-1:finding-1",
    disposition: "waived",
    note: "Explicit human waiver for the unforced merge path.",
    actor: "fixture-architect",
  });
  assert.equal(waived.reviewDispositions.at(-1).disposition, "waived");
  assert.equal(
    waived.gates.find((gate) => gate.gate === "review").state,
    "passed-with-dispositions",
  );

  await assert.rejects(
    dispatcher.reviewDisposition(target.id, {
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: target.ticketId,
      note: "A finding cannot be redirected back onto its source ticket.",
      actor: "fixture-architect",
    }),
    /redirectTicket must differ from the dispatch source ticket/,
  );
  await assert.rejects(
    dispatcher.reviewDisposition(target.id, {
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: "atelier-missing",
      note: "A missing ticket cannot carry redirected work.",
      actor: "fixture-architect",
    }),
    /redirectTicket must identify an existing tracker ticket/,
  );

  const third = await dispatcher.reviewDisposition(target.id, {
    findingRef: "round-1:finding-1",
    disposition: "redirected",
    redirectTicket: "atelier-follow-up",
    note: "Move the finding to the separately owned ticket.",
    actor: "fixture-architect",
  });
  assert.equal(third.reviewDispositions.at(-1).redirectTicket, "atelier-follow-up");
  assert.equal(third.reviewDispositions.at(-1).redirectProject, "fixture");
  assert.equal(
    rawRecord(setup, target.id).reviewDispositions.at(-1).redirectTicket,
    "atelier-follow-up",
    "the persisted redirect must name the existing separate carrier ticket",
  );
  assert.equal(
    rawRecord(setup, target.id).reviewDispositions.at(-1).redirectProject,
    "fixture",
    "the persisted redirect must scope its carrier ticket to the source project",
  );

  const restarted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(restarted.get(target.id).reviewDispositions, third.reviewDispositions);
});

test("legacy redirect-ticket secrets are redacted from exposed disposition records", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const target = await seedDispatch(setup, {
    reviewDispositions: [{
      ref: "disposition-1",
      findingRef: "round-1:finding-1",
      disposition: "redirected",
      redirectTicket: "atelier-OPENAI_API_KEY=legacy-secret-value",
      note: "Legacy persisted disposition.",
      actor: "fixture-architect",
      at: "2026-07-31T00:00:00.000Z",
    }],
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  assert.equal(
    dispatcher.get(target.id).reviewDispositions[0].redirectTicket,
    "atelier-OPENAI_API_KEY=[redacted]",
  );
});

test("review backstop resolution follows project override, registry default, then registry constant", () => {
  assert.equal(_reviewMaxFixRounds({ maxFixRounds: 2 }, { defaults: { maxFixRounds: 3 } }), 2);
  assert.equal(_reviewMaxFixRounds({}, { defaults: { maxFixRounds: 3 } }), 3);
  assert.equal(_reviewMaxFixRounds({}, { defaults: {} }), 4);
});

test("overlapping review heads settle out of order against each completed round's own predecessor", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Keep overlapping review trajectories independent.",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-round-1",
        verdict: "fail",
        summary: "Three findings.",
        at: "2026-07-30T08:00:00.000Z",
        reviewedHead: "prior-head",
        findingCount: 3,
      }],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const heads = ["review-head-a", "review-head-b"];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return args[1] === target.worktreePath
        ? `${heads.shift()}\n`
        : "review-dispatch-head\n";
    }
    if (args[2] === "diff") return "diff --git a/a b/a\n+reviewed change";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const children = [heldChild(), heldChild()];
  let launches = 0;
  _setSpawner(() => children[launches++]);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const reviewA = await dispatcher.review(target.id);
  await waitForState(dispatcher, reviewA.id, ["running"]);
  const reviewB = await dispatcher.review(target.id);
  await waitForState(dispatcher, reviewB.id, ["running"]);

  children[1].complete(
    "VERDICT: FAIL\nSUMMARY: One finding remains.\n[MINOR] b.mjs:2 - last issue",
  );
  await waitForCondition(
    () => dispatcher.get(target.id).review.rounds.find(
      (round) => round.dispatchId === reviewB.id,
    )?.verdict === "fail",
    "the later-head review did not settle first",
  );
  assert.equal(dispatcher.get(target.id).reviewParking, null);

  children[0].complete(
    [
      "VERDICT: FAIL",
      "SUMMARY: Two findings remain.",
      "[MAJOR] a.mjs:1 - first issue",
      "[MINOR] b.mjs:2 - second issue",
    ].join("\n"),
  );
  await waitForCondition(
    () => dispatcher.get(target.id).review.rounds.find(
      (round) => round.dispatchId === reviewA.id,
    )?.verdict === "fail",
    "the earlier-head review did not settle second",
  );

  const rounds = dispatcher.get(target.id).review.rounds;
  assert.deepEqual(
    rounds.map((round) => [round.round, round.verdict, round.findingCount]),
    [[1, "fail", 3], [2, "fail", 2], [3, "fail", 1]],
  );
  // Negative control: last-created evaluation would compare round 3 with the
  // pending round 2 when B settles first and falsely park this shrinking ladder.
  assert.equal(dispatcher.get(target.id).reviewParking, null);
});

test("review startup rechecks parking after its awaited target diff", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Refuse a new round when parking lands during git.",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-round-1",
        verdict: "fail",
        summary: "Two findings remain.",
        at: "2026-07-30T08:00:00.000Z",
        reviewedHead: "prior-head",
        findingCount: 2,
      }],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let releaseDiff;
  const diffGate = new Promise((resolvePromise) => {
    releaseDiff = resolvePromise;
  });
  let signalDiff;
  const diffStarted = new Promise((resolvePromise) => {
    signalDiff = resolvePromise;
  });
  const heads = ["review-head-a", "review-head-b"];
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return args[1] === target.worktreePath
        ? `${heads.shift()}\n`
        : "review-dispatch-head\n";
    }
    if (args[2] === "diff") {
      if (args.at(-1) === "main...review-head-b") {
        signalDiff();
        await diffGate;
      }
      return "diff --git a/a b/a\n+reviewed change";
    }
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const firstChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? firstChild : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const firstReview = await dispatcher.review(target.id);
  await waitForState(dispatcher, firstReview.id, ["running"]);
  const secondReview = dispatcher.review(target.id);
  await diffStarted;
  firstChild.complete(
    [
      "VERDICT: FAIL",
      "SUMMARY: The same two findings remain.",
      "[MAJOR] a.mjs:1 - first issue",
      "[MINOR] b.mjs:2 - second issue",
    ].join("\n"),
  );
  await waitForCondition(
    () => dispatcher.get(target.id).reviewParking?.state === "parked",
    "the first review did not park while the next round awaited git",
  );
  releaseDiff();

  await assert.rejects(
    secondReview,
    (error) => error.status === 409 && /Review thread is parked/.test(error.message),
  );
  // Negative control: without the post-await check, the second review child
  // launches despite the park that settled while git diff was gated.
  assert.equal(launches, 1);
  assert.equal(dispatcher.get(target.id).review.rounds.length, 2);
});

test("reply resume preserves every completed review round through its transition", async (t) => {
  const setup = await fixture(t);
  const rounds = [
    {
      round: 1,
      dispatchId: "review-round-1",
      verdict: "fail",
      summary: "Two findings.",
      at: "2026-07-30T08:00:00.000Z",
      reviewedHead: "review-head-1",
      findingCount: 2,
    },
    {
      round: 2,
      dispatchId: "review-round-2",
      verdict: "pass",
      summary: "Approved.",
      at: "2026-07-30T09:00:00.000Z",
      reviewedHead: "review-head-2",
      findingCount: 0,
    },
  ];
  const target = await seedDispatch(setup, {
    ticketId: null,
    sessionId: "review-history-resume-session",
    review: { rounds },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setRunFile(async (_file, args) =>
    isOutcomeDiffProbe(args) ? PROBE_CHANGED_FILE : "");
  const child = heldChild();
  _setSpawner(() => child);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const resumed = await dispatcher.reply(target.id, { text: "Implement the next fix." });
  assert.equal(resumed.state, "running");
  assert.deepEqual(resumed.review.rounds, rounds);

  child.complete("The next fix round completed.");
  const completed = await waitForState(dispatcher, target.id, ["completed"]);
  assert.deepEqual(completed.review.rounds, rounds);
  assert.equal(completed.review.current.dispatchId, "review-round-2");
  // Negative control: restoring the old `review: null` resume transition would
  // make both the running and completed assertions lose the entire history.
});

test("a retained three-round shrinking FAIL to PASS ladder merges without force", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const reviewedHead = "cccccccccccccccccccccccccccccccccccccccc";
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Retain the full converging review ladder.",
    branchHead: reviewedHead,
    review: {
      rounds: [
        {
          round: 1,
          dispatchId: "review-round-1",
          verdict: "fail",
          summary: "Three findings.",
          at: "2026-07-30T08:00:00.000Z",
          reviewedHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          findingCount: 3,
        },
        {
          round: 2,
          dispatchId: "review-round-2",
          verdict: "fail",
          summary: "Two findings.",
          at: "2026-07-30T09:00:00.000Z",
          reviewedHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          findingCount: 2,
        },
      ],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: "VERDICT: PASS\nSUMMARY: The final round is clean.",
  }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--verify") return `${reviewedHead}\n`;
    if (args[2] === "rev-parse") return `${reviewedHead}\n`;
    if (args[2] === "diff") return "diff --git a/a b/a\n+final fix";
    if (args[2] === "diff-tree") return "";
    if (["status", "log", "fetch", "branch", "worktree"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);
  const completed = dispatcher.get(target.id);
  assert.deepEqual(
    completed.review.rounds.map((round) => [round.round, round.verdict, round.findingCount]),
    [[1, "fail", 3], [2, "fail", 2], [3, "pass", 0]],
  );
  assert.equal(completed.reviewParking, null);
  assert.equal((await dispatcher.merge(target.id)).merged.commit, reviewedHead);
});

test("the default hard backstop parks a still-shrinking fifth review round", async (t) => {
  const setup = await fixture(t);
  const reviewedHead = "dddddddddddddddddddddddddddddddddddddddd";
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Exercise the default review backstop.",
    review: {
      rounds: [
        {
          round: 1,
          dispatchId: "review-round-1",
          verdict: "fail",
          summary: "Eight findings.",
          at: "2026-07-30T08:00:00.000Z",
          reviewedHead,
          findingCount: 8,
        },
        {
          round: 2,
          dispatchId: "review-round-2",
          verdict: "fail",
          summary: "Six findings.",
          at: "2026-07-30T08:10:00.000Z",
          reviewedHead,
          findingCount: 6,
        },
        {
          round: 3,
          dispatchId: "review-round-3",
          verdict: "fail",
          summary: "Four findings.",
          at: "2026-07-30T08:20:00.000Z",
          reviewedHead,
          findingCount: 4,
        },
        {
          round: 4,
          dispatchId: "review-round-4",
          verdict: "fail",
          summary: "Two findings.",
          at: "2026-07-30T08:30:00.000Z",
          reviewedHead,
          findingCount: 2,
        },
      ],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: "VERDICT: FAIL\nSUMMARY: One finding remains.\n[MINOR] a.mjs:1 - final issue",
  }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${reviewedHead}\n`;
    if (args[2] === "diff") return "diff --git a/a b/a\n+almost complete";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);
  await waitForCondition(
    () => dispatcher.get(target.id).reviewParking?.state === "parked",
    "the fifth review round did not hit the default backstop",
  );

  const parked = dispatcher.get(target.id);
  assert.deepEqual(
    parked.review.rounds.map((round) => round.findingCount),
    [8, 6, 4, 2, 1],
  );
  assert.equal(parked.reviewParking.round, 5);
  assert.equal(parked.reviewParking.reasonCode, "hard-backstop");
  // Negative control: the immediately preceding round did shrink, so this
  // park cannot be attributed to the non-convergence rule.
  assert.match(parked.reviewParking.reason, /exceeded the 4-round hard backstop/);
});

test("a fifth error review is trajectory-neutral but still trips the total-round backstop", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Count an infrastructure error only for the hard backstop.",
    review: {
      rounds: [8, 6, 4, 2].map((findingCount, index) => ({
        round: index + 1,
        dispatchId: `review-round-${index + 1}`,
        verdict: "fail",
        summary: `${findingCount} findings remain.`,
        at: `2026-07-30T08:${String(index).padStart(2, "0")}:00.000Z`,
        reviewedHead: `review-head-${index + 1}`,
        findingCount,
      })),
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => {
    throw new Error("fixture review infrastructure failed");
  });
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "review-head-5\n";
    if (args[2] === "diff") return "diff --git a/a b/a\n+reviewed change";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForCondition(
    () => dispatcher.get(target.id).reviewParking?.state === "parked",
    "the fifth error round did not reach the hard backstop",
  );

  assert.equal(dispatcher.get(review.id).state, "prepare_failed");
  const parked = dispatcher.get(target.id);
  assert.equal(parked.review.rounds.at(-1).verdict, "error");
  assert.equal(parked.review.rounds.at(-1).findingCount, null);
  assert.equal(parked.reviewParking.round, 5);
  assert.equal(parked.reviewParking.reasonCode, "hard-backstop");
  // Negative control: the pure trajectory test above proves an error between
  // two shrinking FAIL rounds is skipped rather than treated as degradation.
});

test("repeated severe legacy review parks durably, posts the re-spec, releases the claim, and refuses continuation", async (t) => {
  const setup = await fixture(t, {
    tracker: "committed",
    requireReview: true,
    maxFixRounds: 4,
  });
  const target = await seedDispatch(setup, {
    review: {
      rounds: [{
        round: 1,
        dispatchId: "prior-review",
        verdict: "fail",
        summary: "Two findings remain.",
        findingsText: "[MAJOR] a.mjs:1 - first\n[MINOR] b.mjs:2 - second",
        at: "2026-07-30T08:00:00.000Z",
        reviewedHead: "prior-head",
        findingCount: 2,
      }],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({
      id: target.ticketId,
      description: "Park a non-converging review with a structured handoff.",
      comments: [],
    })}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setSpawner(() => claudeResultChild({
    summary: [
      "VERDICT: FAIL",
      "SUMMARY: Two findings still remain.",
      "[MAJOR] a.mjs:1 - first",
      "[MINOR] b.mjs:2 - second",
    ].join("\n"),
  }));
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") return "";
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "diff") return "diff --git a/a b/a\n+still incomplete";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const eventLog = createEventLog({ stateDir: setup.state });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    eventLog,
  });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["completed"]);
  await waitForConditionOverTime(
    () => Boolean(dispatcher.get(target.id).reviewParking?.claimReleasedAt),
    "review park did not finish its tracker handoff",
  );

  const parked = dispatcher.get(target.id);
  assert.equal(parked.reviewParking.reasonCode, "repeated-severe-finding");
  assert.equal(parked.review.rounds.length, 2);
  const commentCall = calls.find((call) =>
    call.file === "/fixture/br" && call.args[0] === "comments" && call.args[1] === "add");
  assert.ok(commentCall);
  assert.match(commentCall.args[3], /ATELIER AUTO-PARKED REVIEW THREAD/);
  assert.match(commentCall.args[3], /Last review: round 2; verdict FAIL; findingCount 2/);
  assert.match(commentCall.args[3], new RegExp(`Salvage: ${target.branch} at reviewed-head`));
  assert.ok(calls.some((call) =>
    call.file === "/fixture/br" &&
    call.args[0] === "update" &&
    call.args.includes("--status") &&
    call.args.includes("open")));
  const parkEvent = eventLog.read({ kind: "dispatch.review" }).at(-1);
  assert.equal(parkEvent.parked, true);
  assert.equal(parkEvent.parkReasonCode, "repeated-severe-finding");
  await assert.rejects(
    dispatcher.reply(target.id, { text: "Try another fix in this parked thread." }),
    (error) => error.status === 409 && /major finding repeated undispositioned/.test(error.message),
  );
  await assert.rejects(
    dispatcher.review(target.id),
    (error) => error.status === 409 && /Review thread is parked/.test(error.message),
  );
});

test("a review park landing after force-merge records locally without reopening the ticket", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const target = await seedDispatch(setup, {
    review: {
      rounds: [{
        round: 1,
        dispatchId: "prior-review",
        verdict: "fail",
        summary: "Two findings remain.",
        at: "2026-07-30T08:00:00.000Z",
        reviewedHead: "prior-head",
        findingCount: 2,
      }],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({
      id: target.ticketId,
      status: "in_progress",
      description: "Do not reopen a force-merged review target.",
      comments: [],
    })}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  const reviewChild = heldChild();
  _setSpawner(() => reviewChild);
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "/fixture/br") return "";
    assert.equal(file, "git");
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "--verify") return "reviewed-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "merged-main\n";
    if (args[2] === "diff") return "diff --git a/a b/a\n+reviewed change";
    if (args[2] === "diff-tree") return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log", "fetch", "branch", "worktree"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["running"]);
  const merged = await dispatcher.merge(target.id, { force: true, ...FORCE_AUDIT });
  assert.equal(merged.merged.commit, "merged-main");

  reviewChild.complete(
    [
      "VERDICT: FAIL",
      "SUMMARY: The same two findings remain.",
      "[MAJOR] a.mjs:1 - first issue",
      "[MINOR] b.mjs:2 - second issue",
    ].join("\n"),
  );
  await waitForCondition(
    () => dispatcher.get(target.id).reviewParking?.state === "parked",
    "the late failing review did not record its park",
  );
  await settleAsyncWork();

  const parked = dispatcher.get(target.id);
  assert.equal(parked.merged.commit, "merged-main");
  assert.equal(parked.reviewParking.reasonCode, "non-convergence");
  // Negative control: the old parking tail would post a comment and issue
  // `br update --status open` after the merge had made the ticket terminal.
  assert.deepEqual(calls.filter((call) => call.file === "/fixture/br"), []);
});

test("a pending review park never mutates a ticket already closed in the tracker", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const target = await seedDispatch(setup, {
    review: {
      round: 2,
      dispatchId: "review-round-2",
      verdict: "fail",
      summary: "The count stopped shrinking.",
      at: "2026-07-30T10:00:00.000Z",
      reviewedHead: "closed-ticket-head",
      findingCount: 2,
    },
    reviewParking: {
      state: "parked",
      at: "2026-07-30T10:00:00.000Z",
      round: 2,
      reasonCode: "non-convergence",
      reason: "finding count did not strictly shrink (2 to 2)",
      parkCommentPending: true,
      commentPostedAt: null,
      claimReleasedAt: null,
    },
  });
  await mkdir(join(setup.primary, ".beads"), { recursive: true });
  await writeFile(
    join(setup.primary, ".beads", "issues.jsonl"),
    `${JSON.stringify({ id: target.ticketId, status: "closed", comments: [] })}\n`,
  );
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();

  assert.equal(dispatcher.get(target.id).reviewParking.state, "parked");
  // Negative control: treating only merged/dismissed records as terminal would
  // miss an independently closed tracker ticket and issue a reopen mutation.
  assert.deepEqual(calls, []);
});

test("observer boot exposes a pending parked review without completing its handoff", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const target = await seedDispatch(setup, {
    review: {
      dispatchId: "review-round-2",
      reviewedHead: "observer-salvage-head",
      verdict: "fail",
      summary: "The count stopped shrinking.",
      round: 2,
      at: "2026-07-30T10:00:00.000Z",
      findingCount: 2,
      findingsText: "[MAJOR] a.mjs:1 - still present\n[MINOR] b.mjs:2 - still present",
    },
    reviewParking: {
      state: "parked",
      at: "2026-07-30T10:00:00.000Z",
      round: 2,
      reasonCode: "non-convergence",
      reason: "finding count did not strictly shrink (2 to 2)",
      parkCommentPending: true,
      commentPostedAt: null,
      claimReleasedAt: null,
    },
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  await settleAsyncWork();

  assert.equal(dispatcher.get(target.id).review.current.round, 2);
  assert.equal(dispatcher.get(target.id).reviewParking.commentPostedAt, null);
  assert.equal(dispatcher.get(target.id).reviewParking.claimReleasedAt, null);
  assert.equal(rawRecord(setup, target.id).reviewParking.commentPostedAt, null);
  assert.equal(rawRecord(setup, target.id).reviewParking.claimReleasedAt, null);
  // Negative control: a non-observer boot would call br for the comment and
  // release; observing the same pending shape must perform neither mutation.
  assert.deepEqual(calls, []);
});

test("reply rechecks parking after an active review settles during HEAD lookup", async (t) => {
  const setup = await fixture(t);
  const target = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Keep reply admission serialized with review settlement.",
    sessionId: "reply-race-session",
    review: {
      rounds: [{
        round: 1,
        dispatchId: "review-round-1",
        verdict: "fail",
        summary: "Two findings remain.",
        at: "2026-07-30T08:00:00.000Z",
        reviewedHead: "prior-head",
        findingCount: 2,
      }],
    },
  });
  await mkdir(target.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let holdReplyHead = false;
  let releaseReplyHead;
  const replyHeadGate = new Promise((resolvePromise) => {
    releaseReplyHead = resolvePromise;
  });
  let signalReplyHead;
  const replyHeadStarted = new Promise((resolvePromise) => {
    signalReplyHead = resolvePromise;
  });
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    assert.equal(file, "git");
    if (args[2] === "diff") return "diff --git a/a b/a\n+still incomplete";
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      if (holdReplyHead) {
        signalReplyHead();
        await replyHeadGate;
      }
      return "reply-race-head\n";
    }
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const reviewChild = heldChild();
  let launches = 0;
  _setSpawner(() => {
    launches += 1;
    return launches === 1 ? reviewChild : successfulChild();
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(target.id);
  await waitForState(dispatcher, review.id, ["running"]);
  holdReplyHead = true;
  const reply = dispatcher.reply(target.id, { text: "Continue after this review." });
  await replyHeadStarted;
  reviewChild.complete([
    "VERDICT: FAIL",
    "SUMMARY: The same two findings remain.",
    "[MAJOR] a.mjs:1 - first",
    "[MINOR] b.mjs:2 - second",
  ].join("\n"));
  await waitForCondition(
    () => dispatcher.get(target.id).reviewParking?.state === "parked",
    "the review did not park while reply HEAD lookup was pending",
  );
  releaseReplyHead();

  await assert.rejects(
    reply,
    (error) => error.status === 409 && /review thread was parked/i.test(error.message),
  );
  // Negative control: without the post-await park check, terminal resume would
  // launch a second child and overwrite the now-parked thread.
  assert.equal(launches, 1);
  assert.equal(dispatcher.get(target.id).state, "completed");
});

test("mechanically contradicted merge and test claims each park on round one", async (t) => {
  const mainTip = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const reviewedHead = "cccccccccccccccccccccccccccccccccccccccc";
  const scenarios = [
    {
      label: "merge ancestry",
      exitSummary: "Merged main into the branch.",
      verify: { state: "passed", mainTip, steps: [] },
      reason: /merge-base .* differs from verified main snapshot/,
      mergeBaseCalls: 1,
    },
    {
      label: "test verdict",
      exitSummary: "All tests passed.",
      verify: { state: "failed", mainTip, steps: [] },
      reason: /tests passed, but verify\.state is failed/,
      mergeBaseCalls: 0,
      reviewSummary: `VERDICT: PASS\nSUMMARY: ${"x".repeat(2_100)}`,
      expectTruncationMarker: true,
    },
  ];

  for (const scenario of scenarios) {
    const setup = await fixture(t, { maxFixRounds: 4 });
    const target = await seedDispatch(setup, {
      ticketId: null,
      prompt: `Catch a false ${scenario.label} handoff.`,
      exitSummary: scenario.exitSummary,
      verify: scenario.verify,
    });
    await mkdir(target.worktreePath, { recursive: true });
    _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
    _setSpawner(() => claudeResultChild({
      summary: scenario.reviewSummary ??
        "VERDICT: PASS\nSUMMARY: The diff itself looks correct.",
    }));
    let mergeBaseCalls = 0;
    _setRunFile(async (file, args) => {
      if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
      assert.equal(file, "git");
      if (args[2] === "merge-base") {
        mergeBaseCalls += 1;
        return "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n";
      }
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[6], { recursive: true });
        return "";
      }
      if (args[2] === "rev-parse" && args[3] === "HEAD") return `${reviewedHead}\n`;
      if (args[2] === "diff") return "diff --git a/a b/a\n+claimed complete";
      if (["status", "log"].includes(args[2])) return "";
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    const review = await dispatcher.review(target.id);
    await waitForState(dispatcher, review.id, ["completed"]);
    await waitForCondition(
      () => dispatcher.get(target.id).reviewParking?.state === "parked",
      `false ${scenario.label} report did not park on its first round`,
    );
    const parked = dispatcher.get(target.id);
    assert.equal(parked.reviewParking.round, 1);
    assert.equal(parked.reviewParking.reasonCode, "false-self-report");
    assert.equal(parked.review.current.verdict, "fail");
    assert.match(parked.review.current.summary, /Mechanical contradiction/);
    if (scenario.expectTruncationMarker) {
      assert.equal(parked.review.current.summary.length, 2_000);
      assert.match(parked.review.current.summary, /\.\.\.\[truncated\]$/);
    }
    assert.match(parked.reviewParking.reason, scenario.reason);
    assert.equal(mergeBaseCalls, scenario.mergeBaseCalls);
  }

  // Negative controls: narration about checks that did not happen is not an
  // affirmative claim, and quoted/reported UI copy is not the implementer's
  // direct claim, so neither can produce a false positive.
  assert.equal(_claimsMainMerged("Main was not merged; merge is still pending.", "main"), false);
  assert.equal(_claimsMainMerged("Main isn't merged; merge is still pending.", "main"), false);
  assert.equal(_claimsTestsPassed("Tests did not pass and the suite was not green."), false);
  assert.equal(_claimsTestsPassed("The UI now says 'tests passed'."), false);
  assert.equal(_claimsMainMerged('The UI says "main was merged".', "main"), false);
  // Accepted residual risk: this evasive paraphrase is intentionally outside
  // the tripwire's direct test/suite/check vocabulary.
  assert.equal(_claimsTestsPassed("The validation run was entirely successful."), false);
});

test("merge-claim tripwire warns and skips when verify.mainTip evidence is absent or malformed", async (t) => {
  for (const [label, mainTip] of [["missing", undefined], ["malformed", "not-a-sha"]]) {
    const setup = await fixture(t);
    const target = await seedDispatch(setup, {
      ticketId: null,
      prompt: `Skip the ${label} merge evidence check without false parking.`,
      exitSummary: "Merged main into the branch.",
      verify: {
        state: "passed",
        steps: [],
        ...(mainTip === undefined ? {} : { mainTip }),
      },
    });
    await mkdir(target.worktreePath, { recursive: true });
    _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
    _setSpawner(() => claudeResultChild({
      summary: "VERDICT: PASS\nSUMMARY: The diff itself looks correct.",
    }));
    let mergeBaseCalls = 0;
    _setRunFile(async (file, args) => {
      if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
      assert.equal(file, "git");
      if (args[2] === "merge-base") {
        mergeBaseCalls += 1;
        return "";
      }
      if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
      if (args[2] === "diff") return "diff --git a/a b/a\n+claimed complete";
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[6], { recursive: true });
        return "";
      }
      if (["status", "log"].includes(args[2])) return "";
      return "";
    });
    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

    const review = await dispatcher.review(target.id);
    await waitForState(dispatcher, review.id, ["completed"]);
    const completed = dispatcher.get(target.id);

    assert.equal(completed.review.current.verdict, "pass");
    assert.equal(completed.reviewParking, null);
    assert.ok(completed.warnings.includes(
      "review contradiction tripwire skipped merge ancestry: verify.mainTip is missing or malformed",
    ));
    // Negative control: treating absent evidence as contradiction would park;
    // silently accepting it would omit the durable warning.
    assert.equal(mergeBaseCalls, 0);
  }
});

test("Codex review dispatches preserve companion rawOutput and omit --write", async (t) => {
  const setup = await fixture(t);
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Audit this Codex change.",
    lane: "codex",
    model: "codex-default",
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const finalMessage = [
    "Review notes before the required fields.",
    "SUMMARY: A blocker remains beyond the display-summary boundary.",
    "VERDICT: FAIL",
    `Context before the finding: ${"x".repeat(2_100)}`,
    "[BLOCKER] server/lib/dispatch.test.mjs:1 - The complete finding remains visible.",
  ].join("\n");
  let companionArgs;
  _setSpawner((file, args) => {
    assert.equal(file, "node");
    companionArgs = args;
    return codexLaunchChild();
  });
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        job: { status: "completed", summary: "Review notes before the required fields." },
      });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({
        job: { status: "completed", summary: "Review notes before the required fields." },
        storedJob: { result: { rawOutput: finalMessage } },
      });
    }
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForCondition(
    () => dispatcher.get(seeded.id).review?.verdict === "fail",
    "Codex review verdict was not linked to the target",
  );

  assert.equal(companionArgs.includes("--write"), false);
  const target = dispatcher.get(seeded.id);
  const completedReview = dispatcher.get(review.id);
  assert.equal(completedReview.capturedReviewResult, undefined);
  assert.equal(completedReview.exitSummary.length, 2_000);
  assert.doesNotMatch(completedReview.exitSummary, /\[BLOCKER\]/);
  assert.equal(target.review.verdict, "fail");
  assert.equal(target.review.summary, "A blocker remains beyond the display-summary boundary.");
  assert.equal(target.review.current.findings[0].severity, "blocker");
  assert.match(target.review.current.findings[0].summary, /complete finding remains visible/);
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment(target, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted a late BLOCKER`);
    assert.match(assessment.reason, /BLOCKER/);
  }
  assert.equal(
    rawRecord(setup, review.id).capturedReviewResult.findings[0].severity,
    "blocker",
    "the full-output parse must survive terminal persistence for boot recovery",
  );
});

test("a completed review with an unreadable full result is malformed under every policy", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Audit this change without trusting a bounded status snapshot.",
    lane: "codex",
    model: "codex-default",
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setSpawner(() => codexLaunchChild("codex-review-missing-result"));
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        job: {
          status: "completed",
          summary: "VERDICT: PASS\nSUMMARY: The bounded status snapshot says approved.",
        },
      });
    }
    if (file === "node" && args[1] === "result") {
      throw new Error("companion result retrieval failed");
    }
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForCondition(
    () => dispatcher.get(seeded.id).review?.verdict === "malformed",
    "unreadable review result was not classified malformed",
  );

  const target = dispatcher.get(seeded.id);
  const persistedReview = rawRecord(setup, review.id);
  assert.match(persistedReview.exitSummary, /VERDICT: PASS/);
  assert.equal(persistedReview.capturedReviewResult.verdict, "malformed");
  assert.match(persistedReview.capturedReviewResult.summary, /full result unavailable/i);
  assert.equal(target.review.current.verdict, "malformed");
  assert.doesNotMatch(target.review.current.summary, /bounded status snapshot says approved/i);
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment(target, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted an unavailable review result`);
    assert.match(assessment.reason, /expected pass, got malformed/);
  }
});

test("a completed Codex review with only a bounded PASS summary is malformed", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const seeded = await seedDispatch(setup, {
    ticketId: null,
    prompt: "Audit this change without treating the display summary as a full capture.",
    lane: "codex",
    model: "codex-default",
  });
  await mkdir(seeded.worktreePath, { recursive: true });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setSpawner(() => codexLaunchChild("codex-review-summary-only"));
  const boundedPass = "VERDICT: PASS\nSUMMARY: The bounded result summary says approved.";
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ job: { status: "completed", summary: boundedPass } });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ storedJob: { result: { summary: boundedPass } } });
    }
    if (args[2] === "diff") return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+x";
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "--git-dir") return ".atelier-git\n";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const review = await dispatcher.review(seeded.id);
  await waitForCondition(
    () => dispatcher.get(seeded.id).review?.verdict === "malformed",
    "summary-only review result was not classified malformed",
  );

  const target = dispatcher.get(seeded.id);
  const persistedReview = rawRecord(setup, review.id);
  assert.equal(persistedReview.exitSummary, boundedPass);
  assert.equal(persistedReview.capturedReviewResult.verdict, "malformed");
  assert.match(persistedReview.capturedReviewResult.summary, /no final message/i);
  assert.equal(target.review.current.verdict, "malformed");
  assert.doesNotMatch(target.review.current.summary, /bounded result summary says approved/i);
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment(target, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted a summary-only result`);
    assert.match(assessment.reason, /expected pass, got malformed/);
  }
});

test("boot settlement rejects a completed legacy review without a full capture", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const target = fencedRecord(setup, {
    id: "upgrade-window-target",
    state: "completed",
    endedAt: "2026-07-31T08:01:00.000Z",
    verify: { state: "passed", steps: [] },
    review: { rounds: [{
      round: 1,
      dispatchId: "upgrade-window-review",
      reviewedHead: "upgrade-window-head",
      verdict: "pending",
      summary: "",
      findingCount: null,
      findingsText: "",
      at: "2026-07-31T08:02:00.000Z",
    }] },
  });
  const review = fencedRecord(setup, {
    id: "upgrade-window-review",
    state: "completed",
    endedAt: "2026-07-31T08:03:00.000Z",
    reviewOf: target.id,
    reviewedHead: "upgrade-window-head",
    exitSummary: "VERDICT: PASS\nSUMMARY: This persisted snapshot is truncated.",
  });
  await seedIndex(setup, [target, review]);

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const recovered = dispatcher.get(target.id);

  assert.equal(recovered.review.current.verdict, "malformed");
  assert.match(recovered.review.current.summary, /persisted review record.*no captured full result/i);
  assert.doesNotMatch(recovered.review.current.summary, /persisted snapshot is truncated/i);
  assert.equal(rawRecord(setup, review.id).capturedReviewResult, undefined);
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    const assessment = _reviewMergeAssessment(recovered, { requireReview: true, reviewPolicy });
    assert.equal(assessment.eligible, false, `${reviewPolicy} admitted the upgrade-window record`);
    assert.match(assessment.reason, /expected pass, got malformed/);
  }
});

test("requireReview preserves flat and mid-upgrade passes for merge and never merges review dispatches", async (t) => {
  const setup = await fixture(t, { requireReview: true });
  const seeded = await seedDispatch(setup);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 && /review gate failed: expected pass, got missing/.test(error.message),
  );

  _setRunFile(async (_file, args) =>
    args[2] === "rev-parse" && ["--verify", "main"].includes(args[3])
      ? "abcdef1234567890\n"
      : "",
  );
  const pass = {
    dispatchId: "review-pass",
    reviewedHead: "abcdef1234567890",
    verdict: "pass",
    summary: "Approved.",
  };
  const shapes = [
    { label: "flat", review: { ...pass } },
    { label: "empty rounds", review: { current: { ...pass }, rounds: [] } },
    { label: "missing rounds", review: { current: { ...pass } } },
  ];
  for (const shape of shapes) {
    const passedSetup = await fixture(t, { requireReview: true });
    const passed = await seedDispatch(passedSetup, {
      branchHead: "abcdef1234567890",
      review: shape.review,
    });
    const passedDispatcher = createDispatcher({
      registry: passedSetup.registry,
      stateDir: passedSetup.state,
    });
    const migrated = passedDispatcher.get(passed.id);
    assert.equal(migrated.review.current.verdict, "pass", shape.label);
    assert.deepEqual(migrated.review.rounds.map((round) => round.round), [1], shape.label);
    assert.equal(migrated.review.rounds[0].reviewedHead, "abcdef1234567890", shape.label);
    assert.equal(
      (await passedDispatcher.merge(passed.id)).merged.commit,
      "abcdef1234567890",
      shape.label,
    );
  }

  const reviewSetup = await fixture(t);
  const reviewRecord = await seedDispatch(reviewSetup, { reviewOf: "target-dispatch" });
  const reviewDispatcher = createDispatcher({
    registry: reviewSetup.registry,
    stateDir: reviewSetup.state,
  });
  await assert.rejects(
    reviewDispatcher.merge(reviewRecord.id, { force: true, ...FORCE_AUDIT }),
    /review dispatches are read-only audit records/,
  );
  // Negative control: the no-review record above still fails the unforced
  // merge gate, so normalization does not synthesize a PASS from nothing.
});

// --- atelier-tzw review round 4: propagate the death decision -----------------

test("a transient status failure during reattach keeps the claim when the fence is still alive (round 4 I1b)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const worker = spawnAliveProcess(t, { trapSigterm: true });
  await worker.ready;
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-status-blip");
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "codex-status-blip",
      lane: "codex",
      model: "codex-default",
      ticketId: "fixture-status-blip",
      worktreePath,
      codexJobId: "codex-job-blip",
      codexWorkspace: worktreePath,
      // Corroborated by an earlier boot's live polling - this worker really is
      // ours, and it really is running.
      codexWorkerPid: worker.child.pid,
      codexWorkerPidIdentity: processStartIdentity(worker.child.pid),
    }),
  ]);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    // The companion CLI is unavailable for a moment. Round 3 read that as the
    // worker having died and released the ticket.
    if (file === "node" && args[1] === "status") throw new Error("companion socket refused");
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("codex-status-blip")?.orphanUnresolved === true,
    "a transient status failure did not land in the unresolved state",
  );

  const record = dispatcher.get("codex-status-blip");
  assert.equal(record.state, "failed");
  assert.match(record.exitSummary, /status unavailable after restart/);
  assert.equal(
    claimReleased(calls, "fixture-status-blip"),
    false,
    "a transient status failure released the claim of a worker that is still running",
  );
  assert.equal(rawRecord(setup, "codex-status-blip").codexWorkerPid, worker.child.pid);
  // Never signalled: a status blip is not authorization to kill anything.
  assert.equal(worker.child.exitCode, null);
  assert.doesNotMatch(worker.output(), /SIGTERM/);
});

test("stop() reaps its worker and keeps the claim when cancellation throws and the worker survives (round 4 I1c)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const worker = spawnAliveProcess(t, { trapSigterm: true });
  await worker.ready;
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setBrResolver(() => "/fixture/br");
  _setFencedProcessSignal(() => {}); // the reap's signal never lands
  _setSpawner(() => codexLaunchChild("codex-job-stop"));
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      // Live polling is the one place a worker identity may legitimately be
      // established, so this corroborates the pid for real.
      return JSON.stringify({
        status: "running",
        job: { status: "running", pid: worker.child.pid },
      });
    }
    if (file === "node" && args[1] === "cancel") throw new Error("companion cancel failed");
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  const created = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-stop-throw",
    lane: "codex",
  });
  await waitForCondition(
    () => rawRecord(setup, created.id).codexWorkerPid === worker.child.pid,
    "live polling never corroborated the worker pid",
  );

  await dispatcher.stop(created.id);

  // Round 3: codex stop() returned finish:true even when cancellation threw, so
  // the claim was released while the worker was still running.
  assert.equal(dispatcher.get(created.id).orphanUnresolved, true);
  assert.equal(
    claimReleased(calls, "fixture-stop-throw"),
    false,
    "a stop whose cancellation threw released the claim of a surviving worker",
  );
  assert.equal(rawRecord(setup, created.id).codexWorkerPid, worker.child.pid);
  assert.equal(worker.child.exitCode, null);
});

test("stop() whose cancellation threw still reaps the worker, and the claim goes back once it dies (round 4 I1c)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const worker = spawnAliveProcess(t);
  await worker.ready;
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setBrResolver(() => "/fixture/br");
  _setSpawner(() => codexLaunchChild("codex-job-stop-reap"));
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        status: "running",
        job: { status: "running", pid: worker.child.pid },
      });
    }
    if (file === "node" && args[1] === "cancel") throw new Error("companion cancel failed");
    if (file === "git" && args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 300,
  });
  const created = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-stop-reap",
    lane: "codex",
  });
  await waitForCondition(
    () => rawRecord(setup, created.id).codexWorkerPid === worker.child.pid,
    "live polling never corroborated the worker pid",
  );

  await dispatcher.stop(created.id);

  // A user-initiated stop IS authorization to kill an identity-matched worker,
  // so the reap runs even though the lane's own cancellation threw - and once
  // death is confirmed the ordinary release proceeds.
  await withDeadline(worker.exitPromise, "stop() never reaped the worker");
  assert.notEqual(worker.child.signalCode, null);
  assert.equal(dispatcher.get(created.id).orphanUnresolved, false);
  assert.equal(rawRecord(setup, created.id).codexWorkerPid, null);
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-stop-reap"),
    "the claim was not released after the worker was proven dead",
  );
});

test("an observed child exit clears the fence, so a completed dispatch's ticket admits the next one freely (round 4 I2)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" }, { concurrentDispatchCap: 4 });
  stubPreparation();
  // The pid stays ALIVE on purpose: an observed exit is confirmed death without
  // any probe (node reaped the child), and this proves the clear is driven by the
  // observation rather than by a lucky probe.
  const survivor = spawnAliveProcess(t);
  await survivor.ready;
  _setSpawner(() => {
    const child = claudeResultChild({ sessionId: "cycle-session", summary: "done" });
    child.pid = survivor.child.pid;
    return child;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const first = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-cycle" });
  await waitForState(dispatcher, first.id, ["completed", "failed"]);
  assert.equal(dispatcher.get(first.id).state, "completed");

  const persisted = rawRecord(setup, first.id);
  assert.equal(persisted.childPid, null, "an observed exit did not clear the fence");
  assert.equal(persisted.childPidIdentity, null);
  assert.equal(persisted.orphanUnresolved, false);

  // Without that clear, blocking admission on the raw fence would wedge every
  // ticket that ever completed.
  const second = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-cycle" });
  assert.ok(second.id);
  await waitForState(dispatcher, second.id, ["completed", "failed"]);
});

test("admission blocks on the RAW fence, before the boot pass has derived the flag (round 4 I2)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  _setFencedProcessSignal(() => {});
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "raw-fence-blocker",
      ticketId: "fixture-raw-fence",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      // The flag is explicitly NOT set: this is the on-disk shape the shutdown
      // sweep leaves behind, and the boot pass that derives the flag is async.
      orphanUnresolved: false,
      childPid: survivor.child.pid,
      childPidIdentity: processStartIdentity(survivor.child.pid),
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async () => "");
  stubPreparation();

  // A 2s grace keeps the boot pass inside its kill wait for the whole assertion
  // below, so the refusal provably comes from the raw fence and not the flag.
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 2_000,
  });
  assert.equal(dispatcher.get("raw-fence-blocker").orphanUnresolved, false);
  await assert.rejects(
    dispatcher.dispatch({ project: "fixture", ticketId: "fixture-raw-fence" }),
    /has not proven dead/,
  );
  assert.equal(
    dispatcher.get("raw-fence-blocker").orphanUnresolved,
    false,
    "the flag was derived before the assertion - the test no longer proves the raw-fence path",
  );

  await waitForConditionOverTime(
    () => dispatcher.get("raw-fence-blocker")?.orphanUnresolved === true,
    "the boot pass never settled",
    { timeoutMs: 10_000 },
  );
});

test("merge refuses to remove a worktree from under an unproven worker, and force overrides (round 4 item 3)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t);
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  _setFencedProcessSignal(() => {});
  const seeded = await seedDispatch(setup, {
    childPid: survivor.child.pid,
    childPidIdentity: processStartIdentity(survivor.child.pid),
  });
  _setRunFile(async (file, args) => {
    if (args[2] === "rev-parse" && args[3] === "--verify") {
      throw new Error("past-the-fence-gate marker");
    }
    return "";
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 2_000,
  });

  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 && /fence gate failed/.test(error.message),
  );
  // force reaches the ordinary merge machinery, which is how we know the gate
  // itself is what refused above and that force is not silently swallowed.
  await assert.rejects(
    dispatcher.merge(seeded.id, { force: true, ...FORCE_AUDIT }),
    /past-the-fence-gate marker/,
  );
  assert.equal(survivor.child.exitCode, null);
});

test("a bake-off's shared claim survives a failed sibling whose worker is unproven (round 4 item 5)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  _setFencedProcessSignal(() => {});
  await seedIndex(setup, [
    // Batch A: the failed sibling's worker is still unproven, so the shared
    // claim must stay held. Round 3 counted it as nonviable and freed the ticket.
    fencedRecord(setup, {
      id: "bakeoff-a-fenced",
      ticketId: "fixture-bakeoff-fenced",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      batchKind: "bakeoff",
      batchId: "batch-fenced",
      batchSeq: 1,
      childPid: survivor.child.pid,
      childPidIdentity: processStartIdentity(survivor.child.pid),
    }),
    fencedRecord(setup, {
      id: "bakeoff-a-live",
      ticketId: "fixture-bakeoff-fenced",
      state: "running",
      batchKind: "bakeoff",
      batchId: "batch-fenced",
      batchSeq: 2,
    }),
    // Batch B, the control: same shape, no fence anywhere - its shared claim
    // must still be released, or the assertion above proves nothing.
    fencedRecord(setup, {
      id: "bakeoff-b-dead",
      ticketId: "fixture-bakeoff-clean",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      batchKind: "bakeoff",
      batchId: "batch-clean",
      batchSeq: 1,
    }),
    fencedRecord(setup, {
      id: "bakeoff-b-live",
      ticketId: "fixture-bakeoff-clean",
      state: "running",
      batchKind: "bakeoff",
      batchId: "batch-clean",
      batchSeq: 2,
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-bakeoff-clean"),
    "the control bake-off never released its shared claim",
  );
  // Wait for the fenced record's own pass to settle too, so "no release" is a
  // statement about the finished boot rather than a race against it.
  await waitForConditionOverTime(
    () => dispatcher.get("bakeoff-a-fenced")?.orphanUnresolved === true,
    "the fenced sibling never settled into the unresolved state",
  );

  assert.equal(
    claimReleased(calls, "fixture-bakeoff-fenced"),
    false,
    "a failed-but-unproven sibling was treated as finished and freed the shared claim",
  );
});

test("dismiss reaps and clears a raw fence with no flag set, and the next boot does not re-derive it (round 4 item 6)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  stubPreparation();
  // The shutdown sweep is the real producer of a RAW fence with no flag: it
  // retains the pid and leaves the verdict to the next boot. Dismissal has to
  // act on that shape, which round 3 - keyed on the flag alone - never touched.
  const worker = spawnAliveProcess(t, { trapSigterm: true });
  await worker.ready;
  const child = heldChild();
  child.pid = worker.child.pid;
  _setSpawner(() => child);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (["update", "ready", "sync"].includes(args[0])) return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 300,
  });
  const created = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-dismiss-raw" });
  await waitForState(dispatcher, created.id, ["running"]);
  await dispatcher.shutdown({ graceMs: 50 });

  const swept = rawRecord(setup, created.id);
  assert.equal(swept.childPid, worker.child.pid, "the sweep did not retain the fence");
  assert.equal(swept.orphanUnresolved, false, "the sweep flagged - this test needs the raw shape");
  assert.equal(claimReleased(calls, "fixture-dismiss-raw"), false);

  const dismissed = await dispatcher.dismiss(created.id);

  // One authorized reap, then the fence is cleared unconditionally - and only
  // then may the claim go back, which round 3 could never reach for this shape.
  await withDeadline(worker.exitPromise, "dismiss never reaped the fenced worker");
  assert.notEqual(worker.child.signalCode, null);
  assert.equal(dismissed.orphanUnresolved, false);
  const persisted = rawRecord(setup, created.id);
  assert.equal(persisted.childPid, null, "dismissal left the fence behind");
  assert.equal(persisted.childPidIdentity, null);
  assert.ok(claimReleased(calls, "fixture-dismiss-raw"), "dismissal did not hand the ticket back");

  const rebooted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(rebooted.get(created.id).orphanUnresolved, false);
});

test("the shutdown sweep keeps a claim whose worker outlived its kill, and the next boot releases it once dead (round 4 item 4)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  stubPreparation();
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  const child = heldChild();
  child.pid = survivor.child.pid;
  _setSpawner(() => child);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (["update", "ready", "sync"].includes(args[0])) return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const created = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-sweep-claim" });
  await waitForState(dispatcher, created.id, ["running"]);
  child.stdout.write(
    `${JSON.stringify({
      type: "system",
      subtype: "init",
      model: "fixture-model",
      session_id: "sweep-claim-session",
    })}\n`,
  );
  await waitForCondition(
    () => dispatcher.get(created.id)?.sessionId === "sweep-claim-session",
    "sessionId was never captured",
  );

  await dispatcher.shutdown({ graceMs: 50 });

  const afterSweep = dispatcher.get(created.id);
  assert.equal(afterSweep.state, "failed");
  assert.equal(
    claimReleased(calls, "fixture-sweep-claim"),
    false,
    "the sweep freed a ticket whose worker it had only just signalled",
  );
  // The sweep leaves the FLAG to the next boot, so an ordinary restart keeps its
  // "Resume after restart" affordance.
  assert.equal(afterSweep.restartResumeReady, true);
  assert.equal(afterSweep.orphanUnresolved, false);
  assert.equal(rawRecord(setup, created.id).childPid, survivor.child.pid);

  // Now the worker really dies, and the next boot is the authority the sweep
  // deferred to: fence cleared, ticket handed back to the board.
  process.kill(-survivor.child.pid, "SIGKILL");
  await withDeadline(survivor.exitPromise, "the survivor never died");
  const rebooted = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-sweep-claim"),
    "the next boot never released the claim the sweep retained",
  );
  assert.equal(rawRecord(setup, created.id).childPid, null);
  assert.equal(rebooted.get(created.id).orphanUnresolved, false);
  assert.equal(rebooted.get(created.id).restartResumeReady, true);
});

// --- atelier-tzw review round 5: the snapshot edges and the ticket-wide claim ---

test("a terminal snapshot whose worker Atelier never captured is fenced, not completed (round 5 item 2)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const worker = spawnAliveProcess(t, { trapSigterm: true });
  await worker.ready;
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-crash-window");
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "codex-crash-window",
      lane: "codex",
      model: "codex-default",
      ticketId: "fixture-crash-window",
      worktreePath,
      codexJobId: "codex-job-crash-window",
      codexWorkspace: worktreePath,
      // The crash window: Atelier died before its first capture, so the job store
      // knows this worker and our record does not. Round 4 examined the fence and
      // found none, so a terminal snapshot completed the turn - and made it
      // mergeable - while the worker was still writing.
    }),
  ]);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        status: "completed",
        job: { status: "completed", pid: worker.child.pid },
        summary: "claims to be done",
      });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "claims to be done" } });
    }
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("codex-crash-window")?.orphanUnresolved === true,
    "a terminal snapshot reporting a live worker was not fenced",
  );

  const record = dispatcher.get("codex-crash-window");
  assert.equal(record.state, "failed", "the turn completed on top of a live worker");
  assert.match(record.exitSummary, /reported completed but its worker could not be confirmed dead/);
  const persisted = rawRecord(setup, "codex-crash-window");
  assert.equal(persisted.codexWorkerPid, worker.child.pid, "the reported pid was not fenced");
  assert.equal(persisted.codexWorkerPidIdentity, null);
  assert.equal(
    claimReleased(calls, "fixture-crash-window"),
    false,
    "the claim was released while the worker was still alive",
  );
  // Never signalled: a status report is not authorization to kill.
  assert.equal(worker.child.exitCode, null);
  assert.doesNotMatch(worker.output(), /SIGTERM/);
});

test("a terminal snapshot whose reported worker is gone completes normally (round 5 item 2 control)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const gone = spawnAliveProcess(t);
  await gone.ready;
  const gonePid = gone.child.pid;
  process.kill(-gonePid, "SIGKILL");
  await withDeadline(gone.exitPromise, "the control worker never exited");

  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-crash-window-gone");
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "codex-crash-window-gone",
      lane: "codex",
      model: "codex-default",
      ticketId: "fixture-crash-gone",
      worktreePath,
      codexJobId: "codex-job-crash-gone",
      codexWorkspace: worktreePath,
    }),
  ]);
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        status: "completed",
        job: { status: "completed", pid: gonePid },
        summary: "finished while Atelier was down",
      });
    }
    if (file === "node" && args[1] === "result") {
      return JSON.stringify({ job: { summary: "finished while Atelier was down" } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForConditionOverTime(
    () => dispatcher.get("codex-crash-window-gone")?.state === "completed",
    "extending the fence to a DEAD reported pid blocked an honest completion",
  );
  assert.equal(dispatcher.get("codex-crash-window-gone").orphanUnresolved, false);
  assert.equal(rawRecord(setup, "codex-crash-window-gone").codexWorkerPid, null);
});

test("a ticket's claim is retained while a SIBLING record still fences a worker (round 5 item 3)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "committed" });
  const survivor = spawnAliveProcess(t, { trapSigterm: true });
  await survivor.ready;
  _setFencedProcessSignal(() => {});
  await seedIndex(setup, [
    // The record being released is spotless. Its SIBLING for the same ticket is
    // the one holding an unproven worker - which round 4's record-local guard
    // never looked at, so the ticket went back to the board anyway.
    fencedRecord(setup, {
      id: "sibling-fenced",
      ticketId: "fixture-sibling",
      state: "failed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "server restart",
      childPid: survivor.child.pid,
      childPidIdentity: processStartIdentity(survivor.child.pid),
    }),
    fencedRecord(setup, { id: "sibling-clean", ticketId: "fixture-sibling", state: "queued" }),
    // The other half of "ticket-wide": a sibling that is not fenced but is not
    // finished either. plan_ready is neither terminal nor boot-recoverable, so it
    // survives this boot untouched and must keep the ticket claimed.
    fencedRecord(setup, {
      id: "successor-live",
      ticketId: "fixture-successor",
      state: "plan_ready",
      plan: { state: "ready", text: "still mid-flight" },
    }),
    fencedRecord(setup, { id: "successor-queued", ticketId: "fixture-successor", state: "queued" }),
    // Control ticket: same shape, no fence and no live sibling, so it must release.
    fencedRecord(setup, { id: "control-clean", ticketId: "fixture-control", state: "queued" }),
  ]);
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => claimReleased(calls, "fixture-control"),
    "the control ticket never released",
  );
  await waitForConditionOverTime(
    () => dispatcher.get("sibling-fenced")?.orphanUnresolved === true,
    "the fenced sibling never settled",
  );

  assert.equal(
    claimReleased(calls, "fixture-sibling"),
    false,
    "a clean record freed a ticket whose sibling still fences a live worker",
  );
  assert.equal(
    claimReleased(calls, "fixture-successor"),
    false,
    "a finished record freed a ticket a non-terminal sibling is still working",
  );
  assert.equal(dispatcher.get("successor-live").state, "plan_ready");
});

test("a claim is not released while an admission holds the ticket reservation (round 5 item 3)", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  stubPreparation();
  const worktreePath = join(setup.state, "worktrees", "fixture", "reservation-race");
  await mkdir(worktreePath, { recursive: true });
  await seedIndex(setup, [
    fencedRecord(setup, {
      id: "reservation-race",
      ticketId: "fixture-reservation",
      state: "completed",
      endedAt: "2026-07-30T08:05:00.000Z",
      exitSummary: "done",
      worktreePath,
      verify: { state: "passed", steps: [] },
    }),
  ]);
  _setBrResolver(() => "/fixture/br");
  let releaseClaimGate;
  const claimGate = new Promise((resolvePromise) => {
    releaseClaimGate = resolvePromise;
  });
  let claimInFlight = false;
  const calls = [];
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file === "/fixture/br" && args[0] === "update" && args.includes("--claim")) {
      claimInFlight = true;
      await claimGate;
      return "";
    }
    if (["update", "ready", "sync"].includes(args[0])) return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    return "";
  });
  _setSpawner(() => heldChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  // A successor is mid-claim for the same ticket: its reservation is held across
  // the awaited br mutation.
  const successor = dispatcher.dispatch({ project: "fixture", ticketId: "fixture-reservation" });
  await waitForCondition(() => claimInFlight, "the successor's claim never started");

  // Dismissing the old record releases its claim - which would yank the ticket
  // out from under the admission that is claiming it right now.
  await dispatcher.dismiss("reservation-race");
  assert.equal(
    claimReleased(calls, "fixture-reservation"),
    false,
    "a claim was released while an admission held the ticket reservation",
  );

  releaseClaimGate();
  const created = await successor;
  await waitForState(dispatcher, created.id, ["running"]);
  assert.equal(
    claimReleased(calls, "fixture-reservation"),
    false,
    "the ticket was freed even after the successor became active",
  );
});

test("merge re-derives the fence instead of gating on a stale verdict (round 5 item 4)", async (t) => {
  if (process.platform !== "linux") {
    t.skip("worker fencing uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t);
  const worker = spawnAliveProcess(t, { trapSigterm: true });
  await worker.ready;
  _setFencedProcessSignal(() => {});
  const seeded = await seedDispatch(setup, {
    childPid: worker.child.pid,
    childPidIdentity: processStartIdentity(worker.child.pid),
  });
  _setRunFile(async (file, args) => {
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 2_000,
  });

  // While the worker lives, the gate holds.
  await assert.rejects(
    dispatcher.merge(seeded.id),
    (error) => error.status === 409 && /fence gate failed/.test(error.message),
  );
  await waitForConditionOverTime(
    () => dispatcher.get(seeded.id)?.orphanUnresolved === true,
    "the record never carried the unresolved verdict",
  );

  // The worker exits. The verdict on the record is now stale, and a human
  // clicking merge must not be told to force what is genuinely finished.
  process.kill(-worker.child.pid, "SIGKILL");
  await withDeadline(worker.exitPromise, "the worker never exited");

  const merged = await dispatcher.merge(seeded.id);
  assert.equal(merged.merged.commit, "abcdef1234567890");
  assert.equal(merged.orphanUnresolved, false);
  assert.equal(rawRecord(setup, seeded.id).childPid, null);
});

// ---------------------------------------------------------------------------
// atelier-8r6: needs_input / completed_empty outcome detection.
//
// Live incident these cover: an autonomous dispatch spent $2.88, wrote zero
// code, ended on "Want me to go with (1) or (2)?" - and recorded `completed`
// with `verify: passed` (green suite on an unchanged tree), claim held, queue
// moved on, nobody notified.
// ---------------------------------------------------------------------------

const NO_QUESTION_WARNING = "the agent's final message ends in a question - answer it with reply & resume if this work is not finished";

// A stub runner for a dispatch that produced NOTHING: the change probe is
// answered honestly with an empty diff and a clean worktree.
function stubEmptyDispatch({ calls = [], verifySpawns = [] } = {}) {
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") return "";
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse") return "1111111111111111111111111111111111111111\n";
    if (args[2] === "status") return "";
    if (args[2] === "log") return "";
    if (isOutcomeDiffProbe(args)) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  return { calls, verifySpawns };
}

function claimReleases(calls) {
  return calls.filter(({ args }) =>
    args[0] === "update" && args[2] === "--status" && args[3] === "open");
}

test("the incident shape - empty diff plus a closing question - records needs_input, not completed", async (t) => {
  const setup = await fixture(t, { tracker: "committed", verifyCommands: ["node --test"] });
  setup.registry.defaults.notifyUrl = "https://ntfy.example/topic";
  const { calls } = stubEmptyDispatch();
  const spawns = [];
  _setSpawner((file, args) => {
    spawns.push({ file, args });
    return claudeResultChild({ summary: "I looked at both designs.\nWant me to go with (1) or (2)?" });
  });
  const pushes = [];
  _setPushFetch(async (url, options) => {
    pushes.push({ title: options.headers.Title, tags: options.headers.Tags, body: options.body });
    return { ok: true };
  });
  t.after(() => _setPushFetch());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-iwx" });
  const record = await waitForState(dispatcher, id, ["needs_input"]);

  assert.equal(record.state, "needs_input");
  // Verification is SKIPPED, never passed: a green suite on an unchanged tree is
  // exactly the false evidence that made the incident look like success.
  assert.equal(record.verify.state, "skipped");
  assert.match(record.verify.detail, /nothing to verify/);
  assert.deepEqual(record.verify.steps, []);
  assert.equal(spawns.filter(({ file }) => file === "node").length, 0);

  assert.equal(record.outcome.kind, "needs_input");
  assert.equal(record.outcome.changes, "empty");
  assert.equal(record.outcome.finalMessage, "retrieved");
  assert.equal(record.outcome.question, "Want me to go with (1) or (2)?");
  assert.equal(record.outcome.answerPath, "reply");
  assert.equal(Number.isFinite(Date.parse(record.outcome.detectedAt)), true);

  // The claim goes back to the board like any failure, and the alert says what
  // the operator has to DO.
  await waitForCondition(
    () => claimReleases(calls).length === 1,
    "a needs_input dispatch did not release its ticket claim",
  );
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].title, /Atelier: fixture needs input/);
  assert.equal(pushes[0].tags, "question");
  assert.match(pushes[0].body, /Want me to go with \(1\) or \(2\)\?/);
  assert.match(pushes[0].body, /reply & resume to answer/);

  // The verdict survives a restart as persisted state, not as a live-only field.
  assert.equal(rawRecord(setup, id).outcome.kind, "needs_input");
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.equal(successor.get(id).state, "needs_input");
  assert.equal(successor.get(id).outcome.question, "Want me to go with (1) or (2)?");
});

test("an empty diff with no question is completed_empty, and neither outcome is mergeable or reviewable", async (t) => {
  const setup = await fixture(t, { tracker: "committed", verifyCommands: ["node --test"] });
  const { calls } = stubEmptyDispatch();
  const spawns = [];
  _setSpawner((file) => {
    spawns.push(file);
    return claudeResultChild({ summary: "Nothing to do - the fix is already on main." });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-empty" });
  const record = await waitForState(dispatcher, id, ["completed_empty"]);

  assert.equal(record.state, "completed_empty");
  assert.equal(record.verify.state, "skipped");
  assert.match(record.verify.detail, /produced no changes/);
  assert.equal(record.outcome.kind, "completed_empty");
  assert.equal(record.outcome.changes, "empty");
  assert.equal(record.outcome.question, null);
  assert.equal(record.outcome.answerPath, null);
  assert.equal(spawns.filter((file) => file === "node").length, 0);
  await waitForCondition(
    () => claimReleases(calls).length === 1,
    "a completed_empty dispatch did not release its ticket claim",
  );

  // The gates that used to be handed a green record refuse it by state.
  await assert.rejects(
    dispatcher.merge(id),
    (error) => error.status === 409 && /must be completed/.test(error.message),
  );
  await assert.rejects(
    dispatcher.review(id, {}),
    (error) => error.status === 409 && /must be completed/.test(error.message),
  );
});

test("a closing question on top of real changes stays completed, warned, and verified", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  stubPreparation();
  _setSpawner((file) => {
    if (file === "node") return verifyChild({ stdout: ["ok"] });
    return claudeResultChild({
      summary: "Implemented the parser and added tests.\nShould I also wire the CLI flag?",
    });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "parser" });
  const record = await waitForState(dispatcher, id, ["completed"]);

  // Real work exists, so this is NOT needs_input - but the trailing question is
  // recorded rather than swallowed. Deliberately no third gate for this cell.
  assert.equal(record.state, "completed");
  assert.equal(record.verify.state, "passed");
  assert.equal(record.outcome.kind, "completed");
  assert.equal(record.outcome.changes, "changed");
  assert.equal(record.outcome.question, "Should I also wire the CLI flag?");
  assert.ok(record.warnings.includes(NO_QUESTION_WARNING));
});

test("a long final message is classified from its tail, not the truncated display summary", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  stubEmptyDispatch();
  const question = "Do you want the strict or lenient parser?";
  const summary = `${"analysis. ".repeat(400)}\n${question}`;
  _setSpawner(() => claudeResultChild({ summary }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "long answer" });
  const record = await waitForState(dispatcher, id, ["needs_input"]);

  // The persisted display summary is head-truncated at 2,000 chars, so the
  // question is NOT in it. Classification must not be reading that field.
  assert.equal(record.exitSummary.length, 2_000);
  assert.equal(record.exitSummary.includes(question), false);
  assert.equal(record.state, "needs_input");
  assert.equal(record.outcome.question, question);
});

test("codex: an unreadable companion result classifies conservatively instead of trusting the status summary", async (t) => {
  // The archived attempt's disqualifying MAJOR: when the companion `result` call
  // or its JSON parse failed, question detection silently degraded to the status
  // snapshot's bounded summary - so a run that ended on a question recorded as a
  // clean `completed`. Both failure modes must now fail closed.
  for (const [label, resultBehavior] of [
    ["call failure", () => { throw new Error("companion crashed"); }],
    ["malformed JSON", () => "<html>gateway timeout</html>"],
  ]) {
    const setup = await fixture(t, { tracker: "none" });
    _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
    _setCompanionResolver(() => "/fixture/codex-companion.mjs");
    _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
    _setSpawner(() => codexLaunchChild(`codex-${label.replace(/\s+/g, "-")}`));
    _setRunFile(async (file, args) => {
      if (file === "node" && args[1] === "status") {
        // Innocuous, question-free, and NOT the real final output.
        return JSON.stringify({ status: "completed", summary: "implemented the parser" });
      }
      if (file === "node" && args[1] === "result") return resultBehavior();
      assert.equal(file, "git");
      if (args[2] === "worktree" && args[3] === "add") {
        await mkdir(args[6], { recursive: true });
        return "";
      }
      if (args[2] === "rev-parse") return "2222222222222222222222222222222222222222\n";
      if (args[2] === "status") return "";
      if (args[2] === "log") return "";
      if (isOutcomeDiffProbe(args)) return "";
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    });

    const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
    const { id } = await dispatcher.dispatch({
      project: "fixture",
      prompt: `codex ${label}`,
      lane: "codex",
    });
    const record = await waitForState(dispatcher, id, ["needs_input", "completed", "completed_empty"]);

    assert.equal(record.state, "needs_input", `${label} must not pass as a clean outcome`);
    assert.equal(record.outcome.finalMessage, "unavailable");
    assert.equal(record.outcome.kind, "needs_input");
    assert.equal(record.verify.state, "skipped");
    assert.ok(
      record.warnings.some((warning) =>
        warning.startsWith("outcome classified conservatively: ") &&
        /companion result could not be read/.test(warning)),
      `${label} did not record the retrieval failure: ${JSON.stringify(record.warnings)}`,
    );
    // The status snapshot is still good enough for the DISPLAY summary - it is
    // only barred from deciding the outcome.
    assert.match(record.exitSummary, /implemented the parser/);
  }
});

test("codex: a companion result with no final message is a retrieval failure, not an empty answer", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  _setSpawner(() => codexLaunchChild("codex-no-final"));
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "completed", summary: "work done" });
    }
    if (file === "node" && args[1] === "result") return JSON.stringify({ job: {} });
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse") return "3333333333333333333333333333333333333333\n";
    if (["status", "log"].includes(args[2])) return "";
    if (isOutcomeDiffProbe(args)) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "codex silent", lane: "codex" });
  const record = await waitForState(dispatcher, id, ["needs_input", "completed", "completed_empty"]);
  assert.equal(record.state, "needs_input");
  assert.equal(record.outcome.finalMessage, "unavailable");
  assert.ok(record.warnings.some((warning) => /carried no final message/.test(warning)));
});

test("claude: a result event with no final message fails closed on both change states", async (t) => {
  // The claude-lane twin of the archived MAJOR: a `result` record whose payload
  // is missing is a retrieval failure. With no changes it is needs_input; with
  // real changes it stays completed (there is no third gate) but is warned.
  function resultWithoutPayload() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: "result", num_turns: 1, is_error: false })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    });
    return child;
  }

  const emptySetup = await fixture(t, { tracker: "none" });
  stubEmptyDispatch();
  _setSpawner(() => resultWithoutPayload());
  const emptyDispatcher = createDispatcher({
    registry: emptySetup.registry,
    stateDir: emptySetup.state,
  });
  const empty = await emptyDispatcher.dispatch({ project: "fixture", prompt: "silent claude" });
  const emptyRecord = await waitForState(emptyDispatcher, empty.id, [
    "needs_input",
    "completed",
    "completed_empty",
  ]);
  assert.equal(emptyRecord.state, "needs_input");
  assert.equal(emptyRecord.outcome.finalMessage, "unavailable");
  assert.ok(emptyRecord.warnings.some((warning) =>
    warning.startsWith("outcome classified conservatively: ") &&
    /claude result event carried no final message/.test(warning)));

  const changedSetup = await fixture(t, { tracker: "none" });
  stubPreparation();
  _setSpawner(() => resultWithoutPayload());
  const changedDispatcher = createDispatcher({
    registry: changedSetup.registry,
    stateDir: changedSetup.state,
  });
  const changed = await changedDispatcher.dispatch({ project: "fixture", prompt: "silent claude" });
  const changedRecord = await waitForState(changedDispatcher, changed.id, [
    "needs_input",
    "completed",
    "completed_empty",
  ]);
  assert.equal(changedRecord.state, "completed");
  assert.equal(changedRecord.outcome.changes, "changed");
  assert.equal(changedRecord.outcome.finalMessage, "unavailable");
  assert.ok(changedRecord.warnings.some((warning) =>
    warning.startsWith("outcome classified conservatively: ")));
});

test("an unknown change state plus an unreadable final message still fails closed", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "log") return "";
    // Every probe git call fails: Atelier cannot tell whether work exists.
    throw new Error("git is unavailable");
  });
  _setSpawner(() => claudeResultChild({ summary: "Which approach do you prefer?" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "no git" });
  const record = await waitForState(dispatcher, id, ["needs_input", "completed", "completed_empty"]);

  // Unknown is not proof of work, so a question makes this needs_input - and the
  // admission is on the record instead of a fabricated "empty" claim.
  assert.equal(record.state, "needs_input");
  assert.equal(record.outcome.changes, "unknown");
  assert.ok(record.warnings.some((warning) =>
    warning.startsWith("Atelier could not compare this dispatch against its base: ")));
});

test("a dispatch base is validated at capture AND at use, never interpolated raw", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  // A persisted record whose base is an option-shaped string: the only way this
  // value can reach a git revision argument is if nothing re-checks it.
  await seedDispatch(setup, {
    id: "tampered-base",
    ticketId: null,
    prompt: "seeded",
    sessionId: "tampered-session",
    baseCommit: "--upload-pack=/tmp/pwned",
  });
  const revisions = [];
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (isOutcomeDiffProbe(args)) {
      revisions.push(args[5]);
      return "";
    }
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    // A hostile or broken HEAD read must not become the recorded base either.
    if (args[2] === "rev-parse") return "--upload-pack=/tmp/pwned\n";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  _setSpawner(() => claudeResultChild({ sessionId: "tampered-session", summary: "no changes" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  // Capture-time guard: the option-shaped HEAD is rejected, so the record keeps no
  // base at all and classification falls back to the configured mainBranch.
  const fresh = await dispatcher.dispatch({ project: "fixture", prompt: "fresh" });
  await waitForState(dispatcher, fresh.id, ["completed_empty"]);
  assert.equal(dispatcher.get(fresh.id).baseCommit, null);

  // Use-time guard: the already-persisted bad base is re-checked when the resumed
  // turn is classified, and is likewise replaced by the mainBranch merge-base.
  await mkdir(dispatcher.get("tampered-base").worktreePath, { recursive: true });
  await dispatcher.reply("tampered-base", { text: "carry on" });
  await waitForState(dispatcher, "tampered-base", ["completed_empty"]);
  assert.equal(dispatcher.get("tampered-base").baseCommit, "--upload-pack=/tmp/pwned");

  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions, ["main...HEAD", "main...HEAD"]);

  // And when the comparison itself fails, the warning names the base git was
  // actually asked about - never the rejected persisted value.
  _setRunFile(async (file, args) => {
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "log") return "";
    if (args[2] === "rev-parse") return "--upload-pack=/tmp/pwned\n";
    throw new Error("git is unavailable");
  });
  // Resuming the record that still CARRIES the rejected base is what discriminates:
  // naming record.baseCommit here would print the option-shaped string back at the
  // operator as though git had been asked about it.
  await dispatcher.reply("tampered-base", { text: "again" });
  const brokenRecord = await waitForState(dispatcher, "tampered-base", [
    "completed",
    "completed_empty",
    "needs_input",
  ]);
  const comparisonWarning = brokenRecord.warnings.find((warning) =>
    warning.startsWith("Atelier could not compare this dispatch against its base: "));
  assert.ok(comparisonWarning, JSON.stringify(brokenRecord.warnings));
  assert.match(comparisonWarning, /against main:/);
  assert.doesNotMatch(comparisonWarning, /upload-pack/);
});

test("a needs_input queue dispatch is a non-success attempt that parks on repeat", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  await enablePersistedQueue(setup);
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-asks", priority: 0, created_at: "2026-01-01T00:00:00Z" }]);
      }
      if (["update", "comments"].includes(args[0])) return "";
    }
    if (file === "git" && args[2] === "worktree") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (file === "git" && args[2] === "rev-parse") {
      return "4444444444444444444444444444444444444444\n";
    }
    if (file === "git" && ["status", "log"].includes(args[2])) return "";
    if (file === "git" && isOutcomeDiffProbe(args)) return "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  const prompts = [];
  _setSpawner((file, args) => {
    prompts.push(args[1]);
    return claudeResultChild({ summary: "Should this use the RTS kit or the colony kit?" });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await dispatcher.drainQueuesOnce();
  const first = dispatcher.list().find((record) => record.ticketId === "fixture-asks");
  await waitForCondition(
    () => dispatcher.get(first.id)?.state === "needs_input",
    "the queue dispatch did not land needs_input",
  );

  // Counted as a queue FAILURE through the existing failure-kind path.
  assert.equal(dispatcher.get(first.id).queueOutcome.status, "failure");
  assert.equal(dispatcher.get(first.id).queueOutcome.attempt.attempts, 1);
  assert.equal(dispatcher.get(first.id).queueOutcome.attempt.lastFailureKind, "needs_input");
  await waitForCondition(
    () => claimReleases(calls).length === 1,
    "the needs_input queue dispatch never released its claim",
  );
  // Prevention: the unattended launch was told not to end on a question.
  assert.match(prompts[0], /UNATTENDED QUEUE RULE/);

  await dispatcher.drainQueuesOnce();
  const second = dispatcher.list().find(
    (record) => record.ticketId === "fixture-asks" && record.id !== first.id,
  );
  await waitForCondition(
    () => dispatcher.get(second.id)?.state === "needs_input",
    "the second queue dispatch did not land needs_input",
  );
  await waitForCondition(
    () => dispatcher.getQueue("fixture").parkedTickets.length === 1,
    "two needs_input attempts did not park the ticket",
  );
  const parked = dispatcher.getQueue("fixture").parkedTickets[0];
  assert.equal(parked.ticketId, "fixture-asks");
  assert.equal(parked.attempts, 2);
  assert.equal(parked.lastFailureKind, "needs_input");
  assert.match(parked.parkReason, /needs_input after 2 failed attempts/);
  // Exactly once per attempt, not once per settle call.
  await waitForCondition(
    () => claimReleases(calls).length === 2,
    "the second needs_input attempt never released its claim",
  );
  assert.equal(claimReleases(calls).length, 2);
  assert.equal(dispatcher.get(second.id).queueOutcome.attempt.attempts, 2);
});

test("boot settles a queue outcome the crash window swallowed, once and only once", async (t) => {
  // The crash window: transition() persisted a terminal record, and the process
  // died before settleQueueOutcome/releaseClaim ran. Nothing counted the attempt,
  // nothing parked the ticket, and the claim stayed held - and only boot can see
  // it. Seeded here with needs_input; the same repair covers failed/stopped.
  const setup = await fixture(t, { tracker: "committed", queueFailureLimit: 1 });
  await enablePersistedQueue(setup);
  await seedDispatch(setup, {
    id: "crashed-needs-input",
    ticketId: "fixture-crashed",
    state: "needs_input",
    queueLaunched: true,
    verify: { state: "skipped", detail: "nothing to verify", steps: [] },
    outcome: {
      kind: "needs_input",
      changes: "empty",
      finalMessage: "retrieved",
      question: "Which option?",
      answerPath: "reply",
      detectedAt: "2026-07-21T08:01:00.000Z",
      detail: null,
    },
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") return "[]";
      return "";
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  // The settlement's accounting is synchronous with boot; its park comment and
  // claim release are the awaited tail.
  const releases = () => calls.filter(({ args }) =>
    args[0] === "update" && args[2] === "--status" && args[3] === "open").length;
  await waitForCondition(
    () => dispatcher.getQueue("fixture").parkedTickets.length === 1 && releases() === 1,
    "boot did not settle and release the crash-window record",
  );

  const settled = dispatcher.get("crashed-needs-input");
  assert.equal(settled.queueOutcome.status, "failure");
  assert.equal(settled.queueOutcome.attempt.attempts, 1);
  assert.equal(settled.queueOutcome.attempt.lastFailureKind, "needs_input");
  const parked = dispatcher.getQueue("fixture").parkedTickets;
  assert.equal(parked.length, 1);
  assert.equal(parked[0].ticketId, "fixture-crashed");
  assert.equal(parked[0].attempts, 1);
  assert.equal(parked[0].lastFailureKind, "needs_input");
  // Claim handling matches the live failure paths.
  assert.equal(releases(), 1);
  const persistedQueue = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(persistedQueue.fixture.ticketAttempts["fixture-crashed"].attempts, 1);
  assert.equal(persistedQueue.fixture.ticketAttempts["fixture-crashed"].parked, true);

  // A second boot must NOT re-count the same terminal record: the settled outcome
  // is now on disk, so the repair is a one-shot, not a per-boot increment.
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();
  assert.equal(successor.get("crashed-needs-input").queueOutcome.attempt.attempts, 1);
  assert.equal(successor.getQueue("fixture").parkedTickets[0].attempts, 1);
  assert.equal(releases(), 1, "the second boot released the claim again");
  assert.equal(
    calls.filter(({ args }) => args[0] === "comments" && args[1] === "add").length,
    1,
    "the second boot re-commented the park",
  );
});

test("boot repairs the same crash window for an ordinary failed queue dispatch", async (t) => {
  // The item exists because the class is older than the new states: a `failed`
  // record caught in the same window was never counted either.
  const setup = await fixture(t, { tracker: "committed", queueFailureLimit: 2 });
  await enablePersistedQueue(setup);
  await seedDispatch(setup, {
    id: "crashed-failed",
    ticketId: "fixture-crashed-failed",
    state: "failed",
    queueLaunched: true,
    exitSummary: "agent exploded",
    verify: null,
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") return "[]";
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => calls.some(({ args }) =>
      args[0] === "update" && args[2] === "--status" && args[3] === "open"),
    "boot did not release the crash-window failure's claim",
  );

  const settled = dispatcher.get("crashed-failed");
  assert.equal(settled.queueOutcome.status, "failure");
  assert.equal(settled.queueOutcome.attempt.attempts, 1);
  assert.equal(settled.queueOutcome.attempt.lastFailureKind, "agent_error");
  // Below the limit, so counted but not parked.
  assert.deepEqual(dispatcher.getQueue("fixture").parkedTickets, []);
  assert.equal(
    calls.filter(({ args }) =>
      args[0] === "update" && args[2] === "--status" && args[3] === "open").length,
    1,
  );
});

test("boot does not re-count an attempt the queue snapshot already recorded", async (t) => {
  // settleQueueOutcome writes queue.json BEFORE the record, so a
  // persistence-degraded window (snapshot written, index append failed, crash)
  // leaves the attempt counted with no record-side outcome. "No queueOutcome
  // therefore nothing ran" is false there, and re-counting would let ONE failure
  // reach the park threshold on its own. queue.json's own memory decides.
  const setup = await fixture(t, { tracker: "committed", queueFailureLimit: 1 });
  await mkdir(setup.state, { recursive: true });
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({
      fixture: {
        enabled: true,
        ticketAttempts: {
          "fixture-degraded": {
            attempts: 1,
            lastFailureAt: "2026-07-21T08:01:00.000Z",
            lastFailureKind: "needs_input",
            lastDispatchId: "degraded-record",
            outcomeSequence: 1,
            parked: false,
            parkedAt: null,
            parkReason: null,
            parkCommentPending: false,
          },
        },
      },
    })}\n`,
  );
  await seedDispatch(setup, {
    id: "degraded-record",
    ticketId: "fixture-degraded",
    state: "needs_input",
    queueLaunched: true,
    verify: { state: "skipped", detail: "nothing to verify", steps: [] },
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") return "[]";
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForCondition(
    () => calls.some(({ args }) =>
      args[0] === "update" && args[2] === "--status" && args[3] === "open"),
    "boot did not repair the degraded record",
  );
  await settleAsyncWork();

  // Counted once, still once. At limit 1 a re-count would reach 2, and settling
  // would park and comment it - so the STORED attempt is the discriminator.
  // (getQueue().parkedTickets is derived from attempts >= limit, which the seeded
  // attempt already satisfies, so it cannot tell the two paths apart.)
  const persistedQueue = JSON.parse(await readFile(join(setup.state, "queue.json"), "utf8"));
  assert.equal(persistedQueue.fixture.ticketAttempts["fixture-degraded"].attempts, 1);
  assert.equal(persistedQueue.fixture.ticketAttempts["fixture-degraded"].parked, false);
  assert.deepEqual(
    calls.filter(({ args }) => args[0] === "comments" && args[1] === "add"),
    [],
    "an already-counted attempt must not be parked or commented at boot",
  );

  // The missing half IS repaired: the record now carries the outcome the crash lost,
  // rebuilt from the attempt the queue already had.
  const repaired = dispatcher.get("degraded-record");
  assert.equal(repaired.queueOutcome.status, "failure");
  assert.equal(repaired.queueOutcome.dispatchId, "degraded-record");
  assert.equal(repaired.queueOutcome.sequence, 1);
  assert.equal(repaired.queueOutcome.attempt.attempts, 1);
  assert.equal(repaired.queueOutcome.attempt.lastFailureKind, "needs_input");
  assert.equal(rawRecord(setup, "degraded-record").queueOutcome.attempt.attempts, 1);
  // And the claim still went back exactly once.
  assert.equal(
    calls.filter(({ args }) =>
      args[0] === "update" && args[2] === "--status" && args[3] === "open").length,
    1,
  );
});

test("a fenced crash-window record is released exactly once per boot", async (t) => {
  if (process.platform !== "linux") {
    t.skip("fencing identity resolution uses Linux /proc");
    return;
  }
  // Reachable when the shutdown sweep's grace budget expires: the record lands
  // terminal with its fencing pid deliberately kept AND no queueOutcome. Two boot
  // passes then target it - the orphan reap (which can prove death) and the
  // crash-window repair - and a second release means a duplicate `br update` plus a
  // duplicate beads commit on a ticket that only needed handing back once.
  const setup = await fixture(t, { tracker: "committed", queueFailureLimit: 2 });
  await enablePersistedQueue(setup);
  await seedDispatch(setup, {
    id: "fenced-crash-window",
    ticketId: "fixture-fenced",
    state: "failed",
    queueLaunched: true,
    exitSummary: "server restart - a prior worker could not be confirmed dead",
    verify: null,
    // A live pid whose recorded identity cannot match: the reap resolves this to
    // DEAD without anything needing to be killed.
    childPid: process.pid,
    childPidIdentity: "linux-proc-start:00000000-0000-0000-0000-000000000000:1",
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") return "[]";
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const releases = () => calls.filter(({ args }) =>
    args[0] === "update" && args[2] === "--status" && args[3] === "open");
  await waitForCondition(
    () => releases().length >= 1,
    "neither boot pass released the fenced crash-window claim",
  );
  await settleAsyncWork();

  // Both passes did their own half of the work...
  assert.equal(dispatcher.get("fenced-crash-window").orphanUnresolved, false);
  assert.equal(rawRecord(setup, "fenced-crash-window").childPid, null);
  assert.equal(dispatcher.get("fenced-crash-window").queueOutcome.attempt.attempts, 1);
  assert.equal(
    dispatcher.get("fenced-crash-window").queueOutcome.attempt.lastFailureKind,
    "agent_error",
  );
  // ...and the ticket was handed back exactly once.
  assert.equal(releases().length, 1, JSON.stringify(releases().map(({ args }) => args)));
  assert.equal(
    calls.filter(({ args }) =>
      args[0] === "commit" || (args[2] === "commit")).length <= 1,
    true,
  );
});

test("boot leaves an already-settled terminal queue record alone", async (t) => {
  const setup = await fixture(t, { tracker: "committed", queueFailureLimit: 1 });
  await enablePersistedQueue(setup);
  await seedDispatch(setup, {
    id: "already-settled",
    ticketId: "fixture-settled",
    state: "needs_input",
    queueLaunched: true,
    endedAt: "2026-07-21T08:01:00.000Z",
    queueOutcome: {
      status: "failure",
      endedAt: "2026-07-21T08:01:00.000Z",
      dispatchId: "already-settled",
      sequence: 1,
      attempt: {
        attempts: 1,
        lastFailureAt: "2026-07-21T08:01:00.000Z",
        lastFailureKind: "needs_input",
        lastDispatchId: "already-settled",
        outcomeSequence: 1,
        parked: true,
        parkedAt: "2026-07-21T08:01:00.000Z",
        parkReason: "needs_input after 1 failed attempts",
        parkCommentPending: false,
      },
    },
  });
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br" && args[0] === "ready") return "[]";
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();

  assert.equal(dispatcher.get("already-settled").queueOutcome.attempt.attempts, 1);
  assert.equal(dispatcher.getQueue("fixture").parkedTickets[0].attempts, 1);
  assert.deepEqual(
    calls.filter(({ args }) =>
      args[0] === "update" && args[2] === "--status" && args[3] === "open"),
    [],
    "a settled record must not have its claim released again",
  );
});

test("answering a needs_input dispatch clears the stale outcome and lets the resumed turn verify", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  let produceChanges = false;
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args) => {
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "remove") return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") return `${FIXTURE_RESULT_TREE}\n`;
    if (
      args[2] === "rev-parse" &&
      args[3] === "HEAD" &&
      args[1].includes(`${join("verify-worktrees", "fixture")}`)
    ) return `${FIXTURE_BASE_COMMIT}\n`;
    if (args[2] === "rev-parse") return "5555555555555555555555555555555555555555\n";
    if (args[2] === "rev-list") return "0\n";
    if (["status", "log"].includes(args[2])) return "";
    if (isOutcomeDiffProbe(args)) return produceChanges ? PROBE_CHANGED_FILE : "";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  });
  _setSpawner((file) => {
    if (file === "node") return verifyChild({ stdout: ["ok"] });
    return claudeResultChild({
      sessionId: "answerable-session",
      summary: produceChanges ? "Used option 2 as instructed." : "Option 1 or option 2?",
    });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "ambiguous" });
  const asked = await waitForState(dispatcher, id, ["needs_input"]);
  assert.equal(asked.outcome.answerPath, "reply");

  produceChanges = true;
  const resumed = await dispatcher.reply(id, { text: "go with option 2" });
  assert.ok(["resuming", "running"].includes(resumed.state), resumed.state);
  // The prior turn's verdict must not survive its own answer: a record showing
  // needs_input beside a fresh verify: passed would be the same lie in reverse.
  assert.equal(resumed.outcome, null);
  const answered = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(answered.state, "completed");
  assert.equal(answered.verify.state, "passed");
  assert.equal(answered.outcome.kind, "completed");
  assert.equal(answered.outcome.changes, "changed");
});

test("a resume that never spawns keeps the question it was meant to answer", async (t) => {
  // Same discipline as restartResumeReady (atelier-tzw finding 3): the prior turn's
  // verdict is cleared only when a new turn genuinely reaches a live child. A
  // resume that dies on spawn must not eat the question on its way out - the
  // operator would be left with a terminal record and no idea what was asked.
  const setup = await fixture(t, { tracker: "none" });
  stubEmptyDispatch();
  _setSpawner(() => claudeResultChild({
    sessionId: "unspawnable-session",
    summary: "Should I use the strict or lenient parser?",
  }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "ambiguous" });
  const asked = await waitForState(dispatcher, id, ["needs_input"]);
  assert.equal(asked.outcome.question, "Should I use the strict or lenient parser?");

  _setSpawner(() => {
    throw new Error("spawn failed");
  });
  await assert.rejects(
    dispatcher.reply(id, { text: "strict, please" }),
    /spawn failed/,
  );

  const afterFailure = dispatcher.get(id);
  assert.equal(afterFailure.state, "failed");
  assert.equal(afterFailure.outcome.kind, "needs_input");
  assert.equal(afterFailure.outcome.question, "Should I use the strict or lenient parser?");
  assert.equal(rawRecord(setup, id).outcome.question, "Should I use the strict or lenient parser?");

  // The next resume, which does reach a live child, is what clears it.
  _setSpawner(() => claudeResultChild({
    sessionId: "unspawnable-session",
    summary: "Used the strict parser.",
  }));
  await dispatcher.reply(id, { text: "strict, please" });
  await waitForCondition(
    () => dispatcher.get(id)?.state === "running" || dispatcher.get(id)?.outcome === null,
    "the resumed turn never reached running",
  );
  await waitForState(dispatcher, id, ["completed_empty", "completed"]);
  assert.notEqual(dispatcher.get(id).outcome.question, "Should I use the strict or lenient parser?");
});

test("an async spawn failure after the running transition still keeps the question", async (t) => {
  // The claude lane transitions to `running` before the child has proven it exists,
  // so an ENOENT that arrives as an 'error' event (not a synchronous throw) lands
  // AFTER the outcome was cleared. The clear stays reversible until 'spawn'
  // confirms a real process, so this resume loses nothing.
  const setup = await fixture(t, { tracker: "none" });
  stubEmptyDispatch();
  _setSpawner(() => claudeResultChild({
    sessionId: "async-enoent-session",
    summary: "Ship it behind a flag, or unconditionally?",
  }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "ambiguous" });
  const asked = await waitForState(dispatcher, id, ["needs_input"]);
  assert.equal(asked.outcome.question, "Ship it behind a flag, or unconditionally?");

  // A child that never spawns: 'error' arrives asynchronously, exactly as an
  // ENOENT on the claude binary does. Note it never emits 'spawn'.
  _setSpawner(() => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    setImmediate(() => {
      child.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
      child.stdout.end();
      child.stderr.end();
      child.emit("close", null, null);
    });
    return child;
  });

  const resumed = await dispatcher.reply(id, { text: "behind a flag" });
  // The clear IS visible while the turn looks live - lifecycle timing is unchanged.
  assert.equal(resumed.outcome, null);

  const failed = await waitForState(dispatcher, id, ["failed"]);
  assert.equal(failed.state, "failed");
  assert.match(failed.exitSummary, /ENOENT/);
  // ...and the question is back on the record, in memory and on disk.
  assert.equal(failed.outcome.kind, "needs_input");
  assert.equal(failed.outcome.question, "Ship it behind a flag, or unconditionally?");
  assert.equal(
    rawRecord(setup, id).outcome.question,
    "Ship it behind a flag, or unconditionally?",
  );
});

test("a real needs_input status event carries the outcome and REST-identical gates", async (t) => {
  // The SSE contract, read off the dispatcher's own event log rather than a
  // hand-built event: observers must be able to see the question without a
  // follow-up record fetch.
  const setup = await fixture(t, { tracker: "none" });
  stubEmptyDispatch();
  _setSpawner(() => claudeResultChild({ summary: "Ship it behind a flag, or unconditionally?" }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const observed = [];
  const stop = dispatcher.onEvent((event) => {
    if (event.type === "status") observed.push(event);
  });
  t.after(() => stop());
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "flag it" });
  await waitForState(dispatcher, id, ["needs_input"]);

  const persisted = dispatcher.getEvents(id).filter(
    (event) => event.type === "status" && event.state === "needs_input",
  );
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].outcome.kind, "needs_input");
  assert.equal(persisted[0].outcome.question, "Ship it behind a flag, or unconditionally?");
  assert.equal(persisted[0].outcome.answerPath, "reply");
  assert.deepEqual(
    persisted[0].gates,
    dispatcher.get(id).gates,
    "persisted SSE gates drifted from the REST record after the same transition",
  );

  const live = observed.filter((event) => event.state === "needs_input");
  assert.equal(live.length, 1);
  assert.equal(live[0].outcome.question, "Ship it behind a flag, or unconditionally?");
  assert.deepEqual(live[0].gates, dispatcher.get(id).gates);

  // Ordinary states stay lean - the field is not bolted onto every status event.
  assert.equal(observed.some((event) => event.state === "running" && event.outcome), false);
});

test("the unattended no-question rule reaches queue launches only", async (t) => {
  const setup = await fixture(t, { tracker: "committed" });
  const prompts = [];
  const calls = [];
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (file, args, options = {}) => {
    calls.push({ file, args, cwd: options.cwd });
    if (file === "/fixture/br") {
      if (args[0] === "ready") {
        return JSON.stringify([{ id: "fixture-queued", priority: 0, created_at: "2026-01-01T00:00:00Z" }]);
      }
      return "";
    }
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse") return "6666666666666666666666666666666666666666\n";
    if (["status", "log"].includes(args[2])) return "";
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    return "";
  });
  _setSpawner((file, args) => {
    prompts.push(args[1]);
    return claudeResultChild({ summary: "done" });
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const manual = await dispatcher.dispatch({ project: "fixture", ticketId: "fixture-manual" });
  await waitForState(dispatcher, manual.id, ["completed"]);
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /UNATTENDED QUEUE RULE/);
  assert.match(prompts[0], /Work ticket fixture-manual/);

  await enablePersistedQueue(setup);
  const queued = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await queued.drainQueuesOnce();
  const drained = queued.list().find((record) => record.ticketId === "fixture-queued");
  await waitForState(queued, drained.id, ["completed"]);
  const queuePrompt = prompts.at(-1);
  assert.match(queuePrompt, /^UNATTENDED QUEUE RULE/);
  assert.match(queuePrompt, /never end on a clarifying question/);
  assert.match(queuePrompt, /Work ticket fixture-queued/);
});

test("a review dispatch is never classified as an unfinished outcome", async (t) => {
  // A read-only audit has an empty diff by construction, so classifying it would
  // turn every review into completed_empty and break the merge gate.
  const setup = await fixture(t, { tracker: "none" });
  const seeded = await seedDispatch(setup, {
    id: "review-target",
    ticketId: null,
    prompt: "implement the parser",
    branch: "atelier/review-target",
    verify: { state: "passed", steps: [] },
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  await mkdir(seeded.worktreePath, { recursive: true });
  _setRunFile(async (file, args) => {
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse") return "7777777777777777777777777777777777777777\n";
    if (args[2] === "diff" && !isOutcomeDiffProbe(args)) return "diff --git a/x b/x\n";
    if (isOutcomeDiffProbe(args)) return "";
    if (["status", "log"].includes(args[2])) return "";
    return "";
  });
  _setSpawner(() => claudeResultChild({ summary: "VERDICT: PASS\nSUMMARY: looks right." }));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const review = await dispatcher.review("review-target", {});
  const record = await waitForState(dispatcher, review.id, [
    "completed",
    "completed_empty",
    "needs_input",
  ]);
  assert.equal(record.state, "completed");
  assert.equal(record.outcome, null);
  assert.equal(dispatcher.get("review-target").review.verdict, "pass");
});

test("records persisted before the outcome fields existed load unchanged", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const legacy = await seedDispatch(setup, { id: "legacy-record" });
  assert.equal("outcome" in legacy, false);
  assert.equal("baseCommit" in legacy, false);

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const loaded = dispatcher.get("legacy-record");
  assert.equal(loaded.state, "completed");
  assert.equal(loaded.verify.state, "passed");
  assert.equal(loaded.exitSummary, "done");
  // New fields read as absent rather than fabricated.
  assert.equal(loaded.outcome, null);
  assert.equal(loaded.baseCommit, null);
  assert.deepEqual(loaded.warnings, []);
});

test("integration: real git decides emptiness - an untouched branch is completed_empty and a question is needs_input", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.name", "Atelier Test"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.email", "atelier@example.invalid"], { cwd: setup.primary });
  await writeFile(join(setup.primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: setup.primary });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: setup.primary });
  _setProbe();
  _setRunFile();

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  _setSpawner(() => successfulChild());
  const quiet = await dispatcher.dispatch({ project: "fixture", prompt: "touch nothing" });
  const quietRecord = await waitForState(dispatcher, quiet.id, ["completed_empty"]);
  assert.equal(quietRecord.state, "completed_empty");
  assert.equal(quietRecord.outcome.changes, "empty");
  assert.match(quietRecord.baseCommit, /^[0-9a-f]{40}$/);

  _setSpawner(() => claudeResultChild({ summary: "Which of the two schemas should I use?" }));
  const asking = await dispatcher.dispatch({ project: "fixture", prompt: "ask instead" });
  const askingRecord = await waitForState(dispatcher, asking.id, ["needs_input"]);
  assert.equal(askingRecord.state, "needs_input");
  assert.equal(askingRecord.outcome.question, "Which of the two schemas should I use?");

  // And real work on the branch is an ordinary completion.
  _setSpawner((_file, _args, options) =>
    claudeResultChild({
      onLaunch: async () => {
        await writeFile(join(options.cwd, "feature.txt"), "work\n");
      },
      summary: "Added feature.txt.",
    }));
  const working = await dispatcher.dispatch({ project: "fixture", prompt: "do work" });
  const workingRecord = await waitForState(dispatcher, working.id, ["completed"]);
  assert.equal(workingRecord.outcome.changes, "changed");
});

// --- atelier-9dt: verification re-run ------------------------------------------
//
// One flaky verify run must not permanently strand a completed dispatch. The
// coverage below is deliberately shaped around the three ways that promise can
// be broken: the eligibility gate letting a meaningless re-run through, the
// admission race the archived attempt shipped (capacity checked, then awaited),
// and an interrupted re-run leaving the record somewhere merge will not accept.

// verifyCommands are whitespace-split argv, so the interpreter path must not
// contain whitespace; fall back to a PATH lookup if this runner's does.
const NODE_COMMAND = /\s/.test(process.execPath) ? "node" : process.execPath;

function parsedPersistedRecord(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    return undefined;
  }
}

function deferredValue() {
  let settle;
  const promise = new Promise((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

const FAILED_VERIFY = Object.freeze({
  state: "failed",
  steps: [Object.freeze({ command: "node --test", exitCode: 1, durationMs: 4, tail: "not ok 1" })],
});

// seedDispatch() writes the whole index, so several records need one final
// write. Each override still goes through it, keeping one canonical shape.
async function seedDispatches(setup, overridesList) {
  const records = [];
  for (const overrides of overridesList) {
    // seedDispatch hardcodes the worktree path to its default id, so several
    // records would otherwise share one directory - and "the worktree is gone"
    // would be unprovable.
    records.push(await seedDispatch(setup, {
      worktreePath: join(setup.state, "worktrees", "fixture", overrides.id ?? "dispatch-merge"),
      ...overrides,
    }));
  }
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return records;
}

async function seedRerunnable(setup, overrides = {}) {
  const [record] = await seedDispatches(setup, [{
    id: "dispatch-rerun",
    verify: { ...FAILED_VERIFY, steps: FAILED_VERIFY.steps.map((step) => ({ ...step })) },
    result: null,
    attestation: null,
    ...overrides,
  }]);
  await mkdir(record.worktreePath, { recursive: true });
  return record;
}

// Answers only what a verification needs: its git provenance probe. Anything
// else is recorded so a test can assert what was NOT run (no tracker mutation).
function stubVerificationRuntime({ calls = [], onRevParseHead } = {}) {
  _setBrResolver(() => "/fixture/br");
  _setRunFile(async (file, args) => {
    calls.push({ file, args });
    if (file !== "git") return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      if (onRevParseHead) await onRevParseHead();
      return "1111111111111111111111111111111111111111\n";
    }
    if (args[2] === "rev-parse") return "2222222222222222222222222222222222222222\n";
    if (args[2] === "rev-list") return "0\n";
    return "";
  });
  return calls;
}

test("integration: a flaky verification is recoverable - the re-run passes, both attempts survive, and merge needs no force", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  _setResultFinalizer();
  // A REAL command whose exit code the fixture flips, not a mocked child: the
  // whole point is that the same suite fails then passes.
  const flake = join(setup.root, "flake.mjs");
  const green = join(setup.root, "green-marker");
  await writeFile(
    flake,
    `import { existsSync } from "node:fs";\nprocess.exit(existsSync(${JSON.stringify(green)}) ? 0 : 1);\n`,
  );
  setup.project.verifyCommands = [`${NODE_COMMAND} ${flake}`];
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.name", "Atelier Test"], { cwd: setup.primary });
  execFileSync("git", ["config", "user.email", "atelier@example.invalid"], { cwd: setup.primary });
  await writeFile(join(setup.primary, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: setup.primary });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: setup.primary });
  _setProbe();
  _setRunFile();
  _setSpawner((file, args, options) =>
    file === "claude"
      ? claudeResultChild({
          // The claude adapter commits its own work, so the fixture must too -
          // otherwise there is nothing for the merge half of this test to move.
          onLaunch: async () => {
            await writeFile(join(options.cwd, "feature.txt"), "work\n");
            execFileSync("git", ["add", "feature.txt"], { cwd: options.cwd });
            execFileSync("git", ["commit", "-q", "-m", "dispatch work"], { cwd: options.cwd });
          },
          summary: "Added feature.txt.",
        })
      : spawn(file, args, options));

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const { id } = await dispatcher.dispatch({ project: "fixture", prompt: "flaky suite" });
  const flaked = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(flaked.verify.state, "failed");
  assert.deepEqual(flaked.verify.steps.map((step) => step.exitCode), [1]);
  assert.equal(flaked.verify.attempt, 1);
  assert.deepEqual(flaked.verify.attempts.map((attempt) => attempt.state), ["failed"]);
  await assert.rejects(
    dispatcher.merge(id),
    /verify gate failed: expected passed, got failed/,
  );

  await writeFile(green, "the suite is green now\n");
  const admitted = await dispatcher.rerunVerification(id);
  assert.equal(admitted.state, "verifying");
  assert.equal(admitted.verify.state, "running");
  assert.equal(admitted.verify.attempt, 2);

  const passed = await waitForState(dispatcher, id, ["completed"]);
  assert.equal(passed.verify.state, "passed");
  assert.equal(passed.verify.attempt, 2);
  assert.deepEqual(passed.verify.attempts.map(({ attempt, state }) => ({ attempt, state })), [
    { attempt: 1, state: "failed" },
    { attempt: 2, state: "passed" },
  ]);
  // Both verdicts keep their own evidence, not just their labels.
  assert.deepEqual(passed.verify.attempts[0].steps.map((step) => step.exitCode), [1]);
  assert.deepEqual(passed.verify.attempts[1].steps.map((step) => step.exitCode), [0]);
  assert.match(passed.verify.attempts[0].testedTree, /^[0-9a-f]{40}$/);
  assert.equal(passed.verify.attempts[0].testedTree, passed.verify.attempts[1].testedTree);
  assert.equal(passed.verify.rerun, undefined);
  // The flip is announced on its own event kind, and says it flipped.
  assert.deepEqual(
    dispatcher.getEvents(id)
      .filter((event) => event.type === "verify-rerun")
      .map(({ phase, attempt, verdict, previousState, flipped }) => ({
        phase,
        attempt,
        verdict,
        previousState,
        flipped,
      })),
    [
      { phase: "start", attempt: 2, verdict: undefined, previousState: "failed", flipped: undefined },
      { phase: "end", attempt: 2, verdict: "passed", previousState: "failed", flipped: true },
    ],
  );

  const merged = await dispatcher.merge(id);
  assert.match(merged.merged.commit, /^[0-9a-f]{40}$/);
  // The primary checkout is ON main here, so this is the protected in-primary
  // merge rather than a fast-forward - either way it took no force.
  assert.equal(merged.merged.strategy, "primary-merge");
  assert.equal(
    execFileSync("git", ["show", "main:feature.txt"], { cwd: setup.primary, encoding: "utf8" }),
    "work\n",
  );
  await waitForConditionOverTime(
    () => ["passed", "failed", "skipped"].includes(dispatcher.get(id).postMerge?.state),
    "post-merge verification never settled",
  );
  assert.equal(dispatcher.get(id).postMerge.state, "passed");
});

test("a verification re-run refuses every ineligible record with an honest 409", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const ineligible = [
    { id: "already-merged", verify: FAILED_VERIFY, merged: { commit: "abc1234", mergedAt: "2026-07-21T09:00:00.000Z", strategy: "ff" } },
    { id: "already-dismissed", verify: FAILED_VERIFY, dismissed: { at: "2026-07-21T09:00:00.000Z" } },
    { id: "verify-passed", verify: { state: "passed", steps: [] } },
    { id: "verify-skipped", verify: { state: "skipped", steps: [], detail: "nothing to verify - this dispatch produced no changes" } },
    { id: "verify-missing", verify: null },
    { id: "needs-input", state: "needs_input", verify: { state: "skipped", steps: [] } },
    { id: "completed-empty", state: "completed_empty", verify: { state: "skipped", steps: [] } },
    { id: "already-failed", state: "failed", verify: FAILED_VERIFY },
    { id: "still-planning", state: "plan_ready", verify: null, plan: { state: "ready", text: "a plan" } },
    { id: "audit-record", verify: FAILED_VERIFY, reviewOf: "some-target" },
    { id: "orphan-unresolved", verify: FAILED_VERIFY, orphanUnresolved: true },
    { id: "worktree-gone", verify: FAILED_VERIFY },
  ];
  // Distinct tickets on purpose: the unresolved-orphan refusal is TICKET-wide,
  // so one fenced record sharing a ticket would refuse every other row for the
  // wrong reason.
  const records = await seedDispatches(
    setup,
    ineligible.map((overrides) => ({ ticketId: `ticket-${overrides.id}`, ...overrides })),
  );
  for (const record of records) {
    if (record.id === "worktree-gone") continue;
    await mkdir(record.worktreePath, { recursive: true });
  }
  stubVerificationRuntime();
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const refusals = [
    ["missing-entirely", 404, /Unknown dispatch: missing-entirely/],
    ["already-merged", 409, /dispatch is already merged/],
    ["already-dismissed", 409, /dispatch is dismissed/],
    ["verify-passed", 409, /verify gate failed: expected failed, got passed/],
    ["verify-skipped", 409, /verify gate failed: expected failed, got skipped/],
    ["verify-missing", 409, /verify gate failed: expected failed, got missing/],
    ["needs-input", 409, /a needs_input dispatch has nothing to verify/],
    ["completed-empty", 409, /a completed_empty dispatch has nothing to verify/],
    ["already-failed", 409, /only a completed dispatch can re-run verification, got failed/],
    ["still-planning", 409, /only a completed dispatch can re-run verification, got plan_ready/],
    ["audit-record", 409, /review dispatches are read-only audit records/],
    ["orphan-unresolved", 409, /has a worker Atelier has not proven dead/],
    ["worktree-gone", 409, /dispatch worktree is missing/],
  ];
  for (const [id, status, message] of refusals) {
    await assert.rejects(
      dispatcher.rerunVerification(id),
      (error) => {
        assert.equal(error.status, status, `${id} refusal status`);
        assert.match(error.message, message);
        return true;
      },
      `${id} must be refused`,
    );
  }
  // Nothing ran: a refusal must never spawn a verifier or move a record.
  for (const record of records) {
    assert.equal(dispatcher.get(record.id).state, record.state);
  }
});

test("a verification re-run refuses a project with nothing to re-run, and a tracker-only project", async (t) => {
  const commandless = await fixture(t, { verifyCommands: [] });
  await seedRerunnable(commandless);
  stubVerificationRuntime();
  const withoutCommands = createDispatcher({
    registry: commandless.registry,
    stateDir: commandless.state,
  });
  await assert.rejects(
    withoutCommands.rerunVerification("dispatch-rerun"),
    /project has no worktree verification commands/,
  );

  const containerized = await fixture(t, {
    verifyMode: "container",
    verifyCommands: ["node --test"],
  });
  await seedRerunnable(containerized);
  const withoutWorktreeMode = createDispatcher({
    registry: containerized.registry,
    stateDir: containerized.state,
  });
  await assert.rejects(
    withoutWorktreeMode.rerunVerification("dispatch-rerun"),
    /project has no worktree verification commands/,
  );

  const trackerOnly = await fixture(t, {
    archetype: "tracker-only",
    verifyCommands: ["node --test"],
  });
  await seedRerunnable(trackerOnly);
  const trackerOnlyDispatcher = createDispatcher({
    registry: trackerOnly.registry,
    stateDir: trackerOnly.state,
  });
  await assert.rejects(
    trackerOnlyDispatcher.rerunVerification("dispatch-rerun"),
    /Verification re-run unavailable: tracker-only project/,
  );
});

test("a verification re-run refuses while a sibling record for the ticket fences an unproven worker", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const records = await seedDispatches(setup, [
    { id: "dispatch-rerun", verify: FAILED_VERIFY },
    { id: "sibling-fenced", state: "failed", ticketId: "fixture-1", orphanUnresolved: true },
  ]);
  for (const record of records) await mkdir(record.worktreePath, { recursive: true });
  stubVerificationRuntime();
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await assert.rejects(
    dispatcher.rerunVerification("dispatch-rerun"),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(
        error.message,
        /Verification re-run refused: dispatch sibling-fenced holds a worker Atelier has not proven dead for ticket fixture-1/,
      );
      return true;
    },
  );
});

test("a verification re-run is refused by a restart drain lease and by shutdown", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  await seedRerunnable(setup);
  stubVerificationRuntime();
  _setSpawner(() => verifyChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const lease = dispatcher.acquireDrainLease();
  await assert.rejects(
    dispatcher.rerunVerification("dispatch-rerun"),
    /Verification re-run is paused by a restart drain lease/,
  );
  assert.equal(dispatcher.get("dispatch-rerun").state, "completed");
  assert.equal(dispatcher.releaseDrainLease(lease.token), true);

  await dispatcher.shutdown();
  await assert.rejects(
    dispatcher.rerunVerification("dispatch-rerun"),
    /Verification re-run is unavailable - the server is shutting down/,
  );
  assert.equal(dispatcher.get("dispatch-rerun").state, "completed");
});

test("a running verification re-run is single-flight, while stop alone preempts it", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  await seedRerunnable(setup, { sessionId: "fixture-session" });
  stubVerificationRuntime();
  const held = heldChild();
  _setSpawner(() => held);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.rerunVerification("dispatch-rerun");
  await waitForState(dispatcher, "dispatch-rerun", ["verifying"]);

  for (const attempt of [
    () => dispatcher.rerunVerification("dispatch-rerun"),
    () => dispatcher.merge("dispatch-rerun"),
    () => dispatcher.dismiss("dispatch-rerun"),
    () => dispatcher.reply("dispatch-rerun", { text: "meanwhile" }),
  ]) {
    await assert.rejects(attempt(), (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /dispatch verification is running/);
      return true;
    });
  }

  const stopped = await dispatcher.stop("dispatch-rerun");
  assert.equal(stopped.state, "completed");
  assert.equal(stopped.verify.state, "failed");
  assert.equal(stopped.verify.detail, "interrupted by stop");
  held.complete();
  await settleAsyncWork();
});

test("two dispatches cannot re-verify past one concurrency slot (the archived capacity race)", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] }, { concurrentDispatchCap: 1 });
  const records = await seedDispatches(setup, [
    { id: "rerun-first", ticketId: "fixture-1", verify: FAILED_VERIFY, result: null, attestation: null },
    { id: "rerun-second", ticketId: "fixture-2", verify: FAILED_VERIFY, result: null, attestation: null },
  ]);
  for (const record of records) await mkdir(record.worktreePath, { recursive: true });
  // The provenance probe is held open, so the first re-run is unambiguously
  // mid-await when the second asks for the same slot. An implementation that
  // becomes active only AFTER this await hands out the slot twice.
  const gate = deferredValue();
  stubVerificationRuntime({ onRevParseHead: () => gate.promise });
  _setSpawner(() => verifyChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.rerunVerification("rerun-first");
  assert.equal(dispatcher.get("rerun-first").state, "verifying");
  await assert.rejects(
    dispatcher.rerunVerification("rerun-second"),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /Concurrent dispatch cap exceeded \(1\)/);
      return true;
    },
  );
  assert.equal(dispatcher.get("rerun-second").state, "completed");
  assert.equal(dispatcher.get("rerun-second").verify.state, "failed");

  gate.settle();
  const first = await waitForState(dispatcher, "rerun-first", ["completed"]);
  assert.equal(first.verify.state, "passed");
  // ...and the slot comes back: the refusal was capacity, not a permanent gate.
  await dispatcher.rerunVerification("rerun-second");
  const second = await waitForState(dispatcher, "rerun-second", ["completed"]);
  assert.equal(second.verify.state, "passed");
});

test("a verification re-run persists its attempt before it emits anything about it", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  await seedRerunnable(setup);
  stubVerificationRuntime();
  const held = heldChild();
  _setSpawner(() => held);
  const writes = [];
  _setPersistenceFileOps({
    appendFileSync(path, contents, encoding) {
      writes.push({ path, contents });
      appendFileSync(path, contents, encoding);
    },
    writeFileSync,
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  await dispatcher.rerunVerification("dispatch-rerun");
  await waitForState(dispatcher, "dispatch-rerun", ["verifying"]);

  // Matched on the PARSED record, not a substring: `"attempt":2` also appears
  // inside a retained attempt list, which would let an unrelated write satisfy
  // the ordering claim.
  const persistedVerify = (write) =>
    write.path.endsWith("index.jsonl") ? parsedPersistedRecord(write.contents)?.verify : undefined;
  const attemptPersisted = writes.findIndex((write) => {
    const verify = persistedVerify(write);
    return verify?.attempt === 2 && verify.state === "running";
  });
  const firstAnnouncement = writes.findIndex((write) =>
    write.path.endsWith("dispatch-rerun.jsonl") && /"verify-rerun"|"state":"verifying"/.test(write.contents));
  assert.ok(attemptPersisted >= 0, "the attempt was never persisted");
  assert.ok(firstAnnouncement >= 0, "the attempt was never announced");
  assert.ok(
    attemptPersisted < firstAnnouncement,
    "the attempt record must be durable before any event announces it",
  );
  // Durable, not just in memory: a successor process reads this off disk.
  const raw = rawRecord(setup, "dispatch-rerun");
  assert.equal(raw.state, "verifying");
  assert.equal(raw.verify.state, "running");
  assert.equal(raw.verify.attempt, 2);
  assert.deepEqual(raw.verify.rerun, { attempt: 2, from: "completed", previousState: "failed" });
  assert.deepEqual(raw.verify.attempts.map((attempt) => attempt.state), ["failed"]);

  // Same ordering on the way out: the SETTLED attempt is durable before the
  // event that reports its verdict, so a crash between the two loses an
  // announcement rather than the verdict.
  await dispatcher.shutdown();
  const verdictPersisted = writes.findIndex((write) => {
    const verify = persistedVerify(write);
    return verify?.attempt === 2 && verify.state === "failed";
  });
  const verdictAnnounced = writes.findIndex((write) =>
    write.path.endsWith("dispatch-rerun.jsonl") && write.contents.includes('"phase":"end"'));
  assert.ok(verdictPersisted >= 0, "the settled attempt was never persisted");
  assert.ok(verdictAnnounced >= 0, "the verdict was never announced");
  assert.ok(
    verdictPersisted < verdictAnnounced,
    "the attempt verdict must be durable before the event that reports it",
  );
});

test("a restart during a verification re-run restores the completed record instead of wedging it", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  await seedRerunnable(setup);
  stubVerificationRuntime();
  const held = heldChild();
  _setSpawner(() => held);
  const interrupted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await interrupted.rerunVerification("dispatch-rerun");
  await waitForState(interrupted, "dispatch-rerun", ["verifying"]);
  // Park the doomed process on its held verifier before booting the successor:
  // it is only a stand-in for a dead one, and an in-flight await of its own
  // would otherwise re-persist the stale `verifying` state after the recovery.
  await waitForCondition(
    () => interrupted.getEvents("dispatch-rerun")
      .some((event) => event.type === "verify" && event.phase === "start"),
    "the re-run never spawned its verifier",
  );

  // The crash: this process never settles the attempt. A successor boots on the
  // same state directory and has to make the record honest from the index alone.
  _setSpawner(() => verifyChild());
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const recovered = successor.get("dispatch-rerun");
  assert.equal(recovered.state, "completed", "an interrupted re-run must not fail the dispatch");
  assert.equal(recovered.verify.state, "failed");
  assert.equal(recovered.verify.attempt, 2);
  assert.equal(recovered.verify.rerun, undefined);
  assert.deepEqual(recovered.verify.attempts.map(({ attempt, state }) => ({ attempt, state })), [
    { attempt: 1, state: "failed" },
    { attempt: 2, state: "failed" },
  ]);
  assert.equal(recovered.verify.attempts[1].detail, "interrupted by a Atelier restart");
  assert.equal(recovered.exitSummary, "done");
  assert.deepEqual(
    successor.getEvents("dispatch-rerun")
      .filter((event) => event.type === "verify-rerun" && event.phase === "end")
      .map(({ attempt, verdict, interrupted: wasInterrupted, flipped }) => ({
        attempt,
        verdict,
        wasInterrupted,
        flipped,
      })),
    [{ attempt: 2, verdict: "failed", wasInterrupted: true, flipped: false }],
  );

  // Never a wedge: the record is eligible again, and a third attempt can pass.
  await successor.rerunVerification("dispatch-rerun");
  const retried = await waitForState(successor, "dispatch-rerun", ["completed"]);
  assert.equal(retried.verify.state, "passed");
  assert.equal(retried.verify.attempt, 3);
  assert.deepEqual(retried.verify.attempts.map((attempt) => attempt.state), [
    "failed",
    "failed",
    "passed",
  ]);
});

test("the shutdown sweep puts an in-flight verification re-run back where it came from", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  await seedRerunnable(setup);
  stubVerificationRuntime();
  const held = heldChild();
  _setSpawner(() => held);
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await dispatcher.rerunVerification("dispatch-rerun");
  await waitForState(dispatcher, "dispatch-rerun", ["verifying"]);
  await waitForCondition(
    () => dispatcher.getEvents("dispatch-rerun")
      .some((event) => event.type === "verify" && event.phase === "start"),
    "the re-run never spawned its verifier",
  );

  await dispatcher.shutdown();

  const swept = dispatcher.get("dispatch-rerun");
  assert.equal(swept.state, "completed");
  assert.notEqual(swept.exitSummary, "server restart");
  assert.equal(swept.verify.state, "failed");
  assert.equal(swept.verify.attempt, 2);
  assert.equal(swept.verify.rerun, undefined);
  assert.equal(swept.verify.attempts[1].detail, "interrupted by a Atelier restart");
  assert.equal(rawRecord(setup, "dispatch-rerun").state, "completed");
});

test("a record persisted before verification attempts existed re-runs with its flat verdict as attempt 1", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const [legacy] = await seedDispatches(setup, [{
    id: "dispatch-rerun",
    // Exactly the pre-atelier-9dt shape: a verdict, steps, and nothing else.
    verify: { state: "failed", steps: [{ command: "node --test", exitCode: 3, durationMs: 9, tail: "legacy tail" }] },
    result: null,
    attestation: null,
  }]);
  await mkdir(legacy.worktreePath, { recursive: true });
  stubVerificationRuntime();
  _setSpawner(() => verifyChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  // Loaded unchanged: no attempts array is fabricated on read.
  const loaded = dispatcher.get("dispatch-rerun");
  assert.equal(loaded.verify.attempts, undefined);
  assert.equal(loaded.verify.attempt, undefined);
  assert.equal(loaded.verify.state, "failed");

  await dispatcher.rerunVerification("dispatch-rerun");
  const record = await waitForState(dispatcher, "dispatch-rerun", ["completed"]);
  assert.equal(record.verify.state, "passed");
  assert.equal(record.verify.attempt, 2);
  assert.deepEqual(record.verify.attempts.map(({ attempt, state }) => ({ attempt, state })), [
    { attempt: 1, state: "failed" },
    { attempt: 2, state: "passed" },
  ]);
  // The legacy verdict's own evidence is carried into attempt 1, not invented.
  assert.deepEqual(record.verify.attempts[0].steps, [
    { command: "node --test", exitCode: 3, durationMs: 9, tail: "legacy tail" },
  ]);
});

test("a verification re-run mutates no tracker state and does not un-park a queue attempt", async (t) => {
  const setup = await fixture(t, { tracker: "committed", verifyCommands: ["node --test"] });
  const parkedAttempt = {
    attempts: 2,
    lastFailureAt: "2026-07-21T08:01:00.000Z",
    lastFailureKind: "verify_failed",
    lastDispatchId: "dispatch-rerun",
    outcomeSequence: 1,
    parked: true,
    parkedAt: "2026-07-21T08:01:00.000Z",
    parkReason: "verify_failed after 2 failed attempts",
    parkCommentPending: false,
  };
  await mkdir(setup.state, { recursive: true });
  await writeFile(
    join(setup.state, "queue.json"),
    `${JSON.stringify({ fixture: { enabled: false, ticketAttempts: { "fixture-1": parkedAttempt } } })}\n`,
  );
  await seedRerunnable(setup, {
    queueLaunched: true,
    queueOutcome: {
      status: "failure",
      endedAt: "2026-07-21T08:01:00.000Z",
      dispatchId: "dispatch-rerun",
      sequence: 1,
      attempt: parkedAttempt,
    },
  });
  const calls = stubVerificationRuntime();
  _setSpawner(() => verifyChild());
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  assert.deepEqual(
    dispatcher.getQueue("fixture").parkedTickets.map(({ ticketId, attempts }) => ({ ticketId, attempts })),
    [{ ticketId: "fixture-1", attempts: 2 }],
  );
  calls.length = 0;

  await dispatcher.rerunVerification("dispatch-rerun");
  const record = await waitForState(dispatcher, "dispatch-rerun", ["completed"]);
  assert.equal(record.verify.state, "passed");

  // Parking is queue bookkeeping: the operator re-ran this deliberately and can
  // merge it, but an explicit resume is still what un-parks the ticket.
  assert.deepEqual(
    dispatcher.getQueue("fixture").parkedTickets.map(({ ticketId, attempts }) => ({ ticketId, attempts })),
    [{ ticketId: "fixture-1", attempts: 2 }],
  );
  assert.equal(record.queueOutcome.status, "failure");
  assert.equal(record.queueOutcome.endedAt, "2026-07-21T08:01:00.000Z");
  assert.equal(record.endedAt, "2026-07-21T08:01:00.000Z");
  // No claim, no release, no beads commit - the re-run touches git provenance only.
  assert.deepEqual(
    calls.filter(({ file, args }) => file === "/fixture/br" || args[2] === "commit"),
    [],
  );
});

test("a flipped verdict re-opens the automatic review the failed one had closed", async (t) => {
  const setup = await fixture(t, { requireReview: true, verifyCommands: ["node --test"] });
  const target = await seedRerunnable(setup, {
    ticketId: null,
    prompt: "Re-open the review after a flake.",
    queueLaunched: true,
    review: null,
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(async (_file, args) => {
    if (isOutcomeDiffProbe(args)) return PROBE_CHANGED_FILE;
    if (args[2] === "diff") {
      return args.at(-1) === "HEAD" ? "" : "diff --git a/a b/a\n+flaked then passed";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "reviewed-head\n";
    if (args[2] === "rev-parse") return "main-tip\n";
    if (args[2] === "rev-list") return "0\n";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });
  let reviewLaunches = 0;
  _setSpawner((file) => {
    if (file === "claude") {
      reviewLaunches += 1;
      return claudeResultChild({ summary: "VERDICT: PASS\nSUMMARY: The re-verified diff passed." });
    }
    return verifyChild();
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();
  // A failed verdict is not a review candidate, so boot recovers nothing.
  assert.equal(reviewLaunches, 0);
  assert.equal(dispatcher.get(target.id).review, null);

  await dispatcher.rerunVerification(target.id);
  const passed = await waitForState(dispatcher, target.id, ["completed"]);
  assert.equal(passed.verify.state, "passed");
  await waitForCondition(
    () => dispatcher.get(target.id).review?.verdict === "pass",
    "the flipped verdict did not re-open the automatic review",
  );
  assert.equal(reviewLaunches, 1);
  assert.equal(
    dispatcher.list().filter((record) => record.reviewOf === target.id).length,
    1,
  );
  // And the merge gate the flake had closed is now fully open, un-forced.
  assert.deepEqual(mergeGateReasonsFor(dispatcher.get(target.id)), []);
});

// The UI's merge-gate contract, applied to a dispatcher record: verify passed,
// review passed against the current head, nothing stranded.
function mergeGateReasonsFor(record) {
  const reasons = [];
  if (record.orphanUnresolved) reasons.push("unproven worker");
  if (record.verify?.state !== "passed") reasons.push(`verification ${record.verify?.state}`);
  if (record.strandedBrWrites) reasons.push("stranded tracker writes");
  if (record.review?.verdict !== "pass") reasons.push(`review ${record.review?.verdict}`);
  return reasons;
}

// Round-1 BLOCKER: the attempt is persisted BEFORE the transition into
// `verifying`, so a crash in that window leaves `completed` + a running attempt.
// Boot used to key its repair on the dispatch state and skipped this shape
// entirely, leaving a record BOTH gates refuse forever - the re-run because the
// verdict is not `failed`, the merge because it is not `passed`.
test("boot repairs a re-run that crashed before the dispatch left completed", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const records = await seedDispatches(setup, [
    {
      id: "crashed-before-verifying",
      ticketId: "ticket-crashed",
      // Exactly what beginVerifyAttempt persists, with the transition lost.
      verify: {
        state: "running",
        steps: [],
        attempt: 2,
        attempts: [{ attempt: 1, state: "failed", steps: [{ command: "node --test", exitCode: 1 }] }],
        startedAt: "2026-07-21T08:02:00.000Z",
        rerun: { attempt: 2, from: "completed", previousState: "failed" },
      },
      result: null,
      attestation: null,
    },
    {
      // The same class with no marker: a terminal record can never legitimately
      // carry a running attempt, and leaving one wedges both gates just as hard.
      id: "markerless-running-attempt",
      ticketId: "ticket-markerless",
      verify: { state: "running", steps: [], attempt: 1, attempts: [] },
      result: null,
      attestation: null,
    },
  ]);
  for (const record of records) await mkdir(record.worktreePath, { recursive: true });
  stubVerificationRuntime();
  _setSpawner(() => verifyChild());

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const repaired = dispatcher.get("crashed-before-verifying");
  assert.equal(repaired.state, "completed");
  assert.equal(repaired.verify.state, "failed");
  assert.equal(repaired.verify.attempt, 2);
  assert.equal(repaired.verify.rerun, undefined);
  assert.deepEqual(repaired.verify.attempts.map((attempt) => attempt.state), ["failed", "failed"]);
  assert.equal(repaired.verify.attempts[1].detail, "interrupted by a Atelier restart");

  const markerless = dispatcher.get("markerless-running-attempt");
  assert.equal(markerless.state, "completed");
  assert.equal(markerless.verify.state, "failed");
  assert.deepEqual(markerless.verify.attempts.map((attempt) => attempt.state), ["failed"]);

  // Idempotent: the sweep must not conclude an attempt boot already concluded.
  await dispatcher.shutdown();
  const sweptEvents = dispatcher.getEvents("crashed-before-verifying")
    .filter((event) => event.type === "verify-rerun" && event.phase === "end");
  assert.equal(sweptEvents.length, 1);
  assert.equal(sweptEvents[0].interrupted, true);
  assert.equal(dispatcher.get("crashed-before-verifying").state, "completed");

  // Never a wedge: both records are re-runnable again in a fresh process.
  const successor = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  for (const id of ["crashed-before-verifying", "markerless-running-attempt"]) {
    await successor.rerunVerification(id);
    const rerun = await waitForState(successor, id, ["completed"]);
    assert.equal(rerun.verify.state, "passed", `${id} must be re-runnable`);
  }
});

// Round-1 MAJOR: a dispatch that is past its own capacity check but still
// awaiting claimTicket is counted by inFlightAdmissions and by nothing else -
// scanning ACTIVE_STATES alone let it and a re-run share one slot.
test("a verification re-run counts a dispatch admission that is still mid-claim", async (t) => {
  const setup = await fixture(
    t,
    { tracker: "committed", verifyCommands: ["node --test"] },
    { concurrentDispatchCap: 1 },
  );
  const [seeded] = await seedDispatches(setup, [
    {
      id: "dispatch-rerun",
      ticketId: "ticket-rerun",
      verify: FAILED_VERIFY,
      result: null,
      attestation: null,
    },
  ]);
  await mkdir(seeded.worktreePath, { recursive: true });
  const claimGate = deferredValue();
  let claimSeen = false;
  _setBrResolver(() => "/fixture/br");
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setRunFile(withDispatchChanges(async (file, args) => {
    if (file === "/fixture/br" && args[0] === "update" && args.includes("--claim")) {
      claimSeen = true;
      await claimGate.promise;
      return "";
    }
    if (file !== "git") return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return "1111111111111111111111111111111111111111\n";
    if (args[2] === "rev-parse") return "2222222222222222222222222222222222222222\n";
    if (args[2] === "rev-list") return "0\n";
    return "";
  }));
  _setSpawner((file) => (file === "claude" ? successfulChild() : verifyChild()));
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const admission = dispatcher.dispatch({ project: "fixture", ticketId: "fixture-new" });
  await waitForCondition(() => claimSeen, "the dispatch never reached its tracker claim");
  // The admission holds the only slot while it awaits br - no record of it is
  // active yet, so nothing but the in-flight counter can see it.
  await assert.rejects(
    dispatcher.rerunVerification("dispatch-rerun"),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /Concurrent dispatch cap exceeded \(1\)/);
      return true;
    },
  );
  assert.equal(dispatcher.get("dispatch-rerun").state, "completed");

  claimGate.settle();
  const created = await admission;
  await waitForState(dispatcher, created.id, ["completed"]);
  // ...and the slot is genuinely released, not permanently consumed.
  await dispatcher.rerunVerification("dispatch-rerun");
  const rerun = await waitForState(dispatcher, "dispatch-rerun", ["completed"]);
  assert.equal(rerun.verify.state, "passed");
});

// Round-1 MINOR: record.endedAt stays fixed across a re-run (the queue outcome
// is keyed to it), so GC has to read the attempt clock or it collects the
// worktree of a dispatch that was re-verified a minute ago.
test("gc measures staleness by the latest verification attempt, not the frozen endedAt", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const staleEndedAt = "2026-06-20T08:01:00.000Z";
  const records = await seedDispatches(setup, [
    {
      id: "reverified-recently",
      ticketId: "ticket-reverified",
      endedAt: staleEndedAt,
      verify: {
        state: "passed",
        steps: [],
        attempt: 2,
        attempts: [
          { attempt: 1, state: "failed", steps: [], endedAt: staleEndedAt },
          { attempt: 2, state: "passed", steps: [], endedAt: "2026-07-30T09:00:00.000Z" },
        ],
      },
    },
    {
      id: "untouched-since",
      ticketId: "ticket-untouched",
      endedAt: staleEndedAt,
      verify: {
        state: "failed",
        steps: [],
        attempt: 1,
        attempts: [{ attempt: 1, state: "failed", steps: [], endedAt: staleEndedAt }],
      },
    },
  ]);
  for (const record of records) await mkdir(record.worktreePath, { recursive: true });
  stubVerificationRuntime();
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });

  const collected = await dispatcher.gc({
    olderThanDays: 7,
    dryRun: true,
    now: new Date("2026-07-30T10:00:00.000Z"),
  });
  assert.deepEqual(collected.dismissed, ["untouched-since"]);
});

// ---------------------------------------------------------------------------
// atelier-za6: codex companion process-tree reaping.
//
// SAFETY: every pid these tests point the reaper at was spawned by the test
// itself, and the sweep's own scope is <stateDir>/worktrees/<project>/<dir> -
// a per-test temp directory no other process on the host can be sitting in.
// That is structural, not conventional: a real codex app-server belonging to a
// human's Claude Code session cannot match a mkdtemp path.

// The companion-shaped fixture. Its argv is NOT what makes it reapable - round 3
// struck companion shape as a kill qualifier, and the spec's constraint 1 with it:
// the only proof of ownership is an identity Atelier itself persisted. The shape is
// here so these fixtures stand in for a real leaked app-server faithfully, and so
// the report-annotation path has something to annotate. The script lives under a
// `codex/` path segment and is invoked the way the real task-worker is.
//
// It spawns its children DETACHED, i.e. each in its own process group, because
// kill(-rootPid) - all the companion's own cancel does - is exactly what fails to
// reach them.
const FIXTURE_COMPANION_SCRIPT = `
import { spawn } from "node:child_process";
if (process.env.FIXTURE_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    // A root that ignores SIGTERM keeps running, and a root that keeps running keeps
    // FORKING. This child does not exist in the pre-SIGTERM closure.
    if (process.env.FIXTURE_FORK_ON_SIGTERM === "1") {
      const late = kid();
      console.log("forked " + late.pid);
    }
  });
}
// trap ''+exec makes SIGTERM SIG_IGN and keeps it across the exec, so a wedged
// tree is wedged all the way down.
const body = process.env.FIXTURE_IGNORE_SIGTERM === "1"
  ? "trap '' TERM; exec sleep 120"
  : "exec sleep 120";
const kid = (cwd) => spawn("sh", ["-c", body], { cwd, detached: true, stdio: "ignore" });
kid();
kid();
if (process.env.FIXTURE_STRAY_CWD) kid(process.env.FIXTURE_STRAY_CWD);
console.log("ready");
setInterval(() => {}, 1000);
`;

async function companionScriptPath(root) {
  const dir = join(root, "codex", "scripts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "codex-companion.mjs");
  await writeFile(path, FIXTURE_COMPANION_SCRIPT);
  return path;
}

async function fixtureCodexTree(t, cwd, { strayCwd, ignoreSigterm = false, forkOnSigterm = false, root } = {}) {
  const scriptRoot = root ?? dirname(dirname(dirname(cwd)));
  const script = await companionScriptPath(scriptRoot);
  return spawnFixtureTree(t, {
    command: process.execPath,
    args: [script, "task-worker", "--cwd", cwd, "--job-id", "fixture-job"],
    cwd,
    strayCwd,
    ignoreSigterm,
    forkOnSigterm,
  });
}

// The same tree shape with argv that is NOT the companion family: a user's shell
// standing in a dispatch worktree. The sweep must report it and never signal it,
// however corroborated its cwd looks.
async function fixtureForeignTree(t, cwd, { strayCwd, ignoreSigterm = false } = {}) {
  const trap = ignoreSigterm ? `trap '' TERM; ` : "";
  const stray = strayCwd ? ` (cd ${JSON.stringify(strayCwd)} && exec setsid sleep 120) &` : "";
  return spawnFixtureTree(t, {
    command: "sh",
    args: ["-c", `${trap}setsid sleep 120 & setsid sleep 120 &${stray} echo ready; wait`],
    cwd,
    strayCwd,
    ignoreSigterm: false,
  });
}

async function spawnFixtureTree(t, { command, args, cwd, strayCwd, ignoreSigterm, forkOnSigterm }) {
  const root = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(ignoreSigterm ? { FIXTURE_IGNORE_SIGTERM: "1" } : {}),
      ...(forkOnSigterm ? { FIXTURE_FORK_ON_SIGTERM: "1" } : {}),
      ...(strayCwd ? { FIXTURE_STRAY_CWD: strayCwd } : {}),
    },
  });
  let output = "";
  root.stdout.setEncoding("utf8");
  root.stdout.on("data", (chunk) => {
    output += chunk;
    const forked = /forked (\d+)/.exec(String(chunk));
    if (forked) spawned.add(Number(forked[1]));
  });
  const exitPromise = once(root, "exit");
  // Children are captured as they are discovered, NOT re-derived at teardown: once
  // the root dies its children reparent to init, so a teardown that walked the tree
  // then would find nothing and leak two `sleep 120` processes per test.
  const spawned = new Set([root.pid]);
  const cleanup = () => {
    for (const pid of testChildPids(root.pid)) spawned.add(pid);
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone: that is the outcome these tests are asserting.
      }
    }
  };
  t.after(async () => {
    cleanup();
    await exitPromise.catch(() => {});
  });
  await withDeadline(once(root.stdout, "data"), "the fixture tree never reported ready");
  const expectedChildren = strayCwd ? 3 : 2;
  let children = [];
  await waitForConditionOverTime(
    () => (children = testChildPids(root.pid)).length === expectedChildren,
    "the fixture tree did not spawn all of its children",
  );
  for (const pid of children) spawned.add(pid);
  const pids = [root.pid, ...children];
  const strayPid = strayCwd
    ? children.find((pid) => {
      try {
        return readlinkSync(`/proc/${pid}/cwd`) === strayCwd;
      } catch {
        return false;
      }
    })
    : undefined;
  if (strayCwd) {
    assert.ok(strayPid, "the fixture tree's stray child never landed in its own directory");
  }
  return {
    rootPid: root.pid,
    pids,
    strayPid,
    exitPromise,
    lateForkedPid() {
      const match = /forked (\d+)/.exec(output);
      if (!match) return undefined;
      spawned.add(Number(match[1]));
      return Number(match[1]);
    },
    // The persisted shape a live poll would have captured.
    persistedTree: {
      rootPid: root.pid,
      capturedAt: "2026-07-30T00:00:00.000Z",
      processes: pids.map((pid, index) => ({
        pid,
        identity: processStartIdentity(pid),
        depth: index === 0 ? 0 : 1,
        command: index === 0 ? "node" : "sleep",
      })),
    },
  };
}

// Deliberately an independent reimplementation of the parentage read: a test
// that reused descendantPids could not catch the walk breaking.
function testChildPids(parentPid) {
  const found = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    if (Number(fields[1]) === parentPid) found.push(Number(name));
  }
  return found.sort((left, right) => left - right);
}

function allReaped(pids) {
  return pids.every((pid) => {
    const state = procState(pid);
    return state === undefined || state === "Z";
  });
}

function anyAlive(pids) {
  return pids.some((pid) => {
    const state = procState(pid);
    return state !== undefined && state !== "Z";
  });
}

async function seedCodexRecord(setup, overrides = {}) {
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const worktreePath = overrides.worktreePath ??
    join(setup.state, "worktrees", "fixture", `${overrides.id ?? "codex-leak"}`);
  const record = {
    id: "codex-leak",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "running",
    branch: "atelier/codex-leak",
    worktreePath,
    codexJobId: "codex-job-1",
    codexWorkspace: worktreePath,
    codexWorkerPid: null,
    codexWorkerPidIdentity: null,
    codexProcessTree: null,
    startedAt: "2026-07-30T08:00:00.000Z",
    endedAt: null,
    turns: 0,
    costUSD: 0,
    sessionId: null,
    exitSummary: "",
    strandedBrWrites: false,
    verify: null,
    merged: null,
    dismissed: null,
    warnings: [],
    ...overrides,
    worktreePath,
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  return record;
}

test("a terminal companion job with no resume path has its whole process tree reaped, leaves before roots", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // sessionId null: nothing can resume from this record, so the resume rule
  // does not protect its app-server.
  await seedCodexRecord(setup, { sessionId: null, codexProcessTree: tree.persistedTree });

  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  // The job stays "running" until this test says otherwise, so the boot sweep
  // provably runs and finishes FIRST. After it has, the terminal transition is
  // the only thing left that can reap - which is what makes this test fail if
  // the transition hook goes away.
  let releaseTerminal;
  const terminal = new Promise((resolvePromise) => {
    releaseTerminal = resolvePromise;
  });
  _setRunFile(async (file, args) => {
    if (file === "node" && (args[1] === "status" || args[1] === "result")) {
      await terminal;
      // A terminal job whose worker the store no longer knows: the tzw fence is
      // clean, so this test isolates the process-tree reap.
      return JSON.stringify({ status: "failed", job: { status: "failed", pid: null } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const beforeTerminal = await dispatcher.sweepCodexProcesses();
  assert.deepEqual(beforeTerminal.reaped, [], "a still-running dispatch's tree was reaped");
  assert.deepEqual(beforeTerminal.reported, [], "a still-running dispatch's tree was reported");
  assert.ok(anyAlive(tree.pids), "the sweep killed a live companion's process tree");

  releaseTerminal();
  await waitForCondition(
    () => dispatcher.get("codex-leak")?.state === "failed",
    "the reattached companion job never reached a terminal state",
  );
  await waitForConditionOverTime(
    () => allReaped(tree.pids),
    "the terminal transition left the companion process tree resident",
  );
  // The reap is never exposed on the API surface, only persisted.
  assert.equal(dispatcher.get("codex-leak").codexProcessTree, undefined);
});

test("the sweep reaps a terminal record's tree even though that record could still be resumed", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    // Everything a resume needs is intact: a usable sessionId and a worktree
    // that still exists. Under the flipped default (architect ruling) that is
    // NOT a reason to keep an app-server alive - the resume cold-starts its own,
    // and retaining these bounded memory by unmerged-undismissed dispatch count.
    sessionId: "codex-thread-1",
    codexProcessTree: tree.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForConditionOverTime(
    () => allReaped(tree.pids),
    "a terminal record kept its companion process tree because it was resumable",
  );
  // The resume affordance itself is untouched - only the processes went.
  const record = dispatcher.get("codex-leak");
  assert.equal(record.sessionId, "codex-thread-1");
  assert.equal(existsSync(worktreePath), true);
});

test("dismissal escalates a wedged companion tree to SIGKILL inside its own call", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // A tree that ignores SIGTERM all the way down, standing in for a wedged
  // app-server. Only an escalation can collect it.
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: wedged.persistedTree,
  });
  _setRunFile(async () => "");

  const escalationMs = 120;
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: escalationMs,
    // No boot sweep: this test's subject is dismissal's OWN reap, and the record
    // is seeded terminal so no transition hook fires either. Nothing has signalled
    // this tree before the dismiss call.
    sweepCodexProcessesAtBoot: false,
  });
  assert.ok(anyAlive(wedged.pids), "the fixture tree was not alive to begin with");

  const started = Date.now();
  await dispatcher.dismiss("codex-leak");
  const elapsed = Date.now() - started;

  // Synchronous assertions right after the await: no polling, so the wait and the
  // SIGKILL provably happened INSIDE dismiss() rather than in a later sweep. The
  // worktree is already gone by now, which is the property that matters.
  assert.ok(
    allReaped(wedged.pids),
    "dismissal returned with a wedged companion tree still resident under a destroyed worktree",
  );
  assert.ok(
    elapsed >= escalationMs,
    `dismissal SIGKILLed without waiting out the SIGTERM grace (${elapsed}ms < ${escalationMs}ms)`,
  );
});

test("the sweep reports a Atelier-adjacent tree it cannot attribute and never looks outside Atelier's worktree root", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  // Inside Atelier's own worktree root, directory present, but no record owns it.
  const unattributed = join(setup.state, "worktrees", "fixture", "nobody-owns-this");
  await mkdir(unattributed, { recursive: true });
  const adjacent = await fixtureForeignTree(t, unattributed);
  // A path that LOOKS like a dispatch worktree but is not under Atelier's state
  // dir: the user's own Claude Code sessions run codex companions in ordinary
  // checkouts, and those are not Atelier's to name, let alone signal.
  const outside = join(setup.root, "not-atelier-state", "worktrees", "fixture", "someone-elses");
  await mkdir(outside, { recursive: true });
  const foreign = await fixtureForeignTree(t, outside);
  await seedCodexRecord(setup, { state: "running", codexProcessTree: null });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const swept = await dispatcher.sweepCodexProcesses();

  assert.deepEqual(swept.reaped, [], "the sweep killed something it could not corroborate");
  const reportedPids = swept.reported.map((entry) => entry.pid).sort((a, b) => a - b);
  assert.deepEqual(
    reportedPids,
    adjacent.pids.slice().sort((a, b) => a - b),
    "the unattributed Atelier-adjacent tree was not surfaced for an operator",
  );
  for (const entry of swept.reported) {
    assert.match(entry.reason, /no Atelier dispatch owns this worktree/);
    assert.equal(entry.worktreePath, unattributed);
    assert.equal(entry.cwd, unattributed);
    assert.equal(entry.cwdDeleted, false);
  }
  for (const pid of foreign.pids) {
    assert.ok(
      !reportedPids.includes(pid),
      `a process outside Atelier's worktree root was named by the sweep (pid ${pid})`,
    );
  }
  assert.ok(anyAlive(adjacent.pids), "an uncorroborated process must be reported, never killed");
  assert.ok(anyAlive(foreign.pids), "the sweep signalled a process outside Atelier's scope");
});

test("the boot sweep reaps a crash-window tree whose worktree is gone", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // The stray child sits OUTSIDE Atelier's worktree root, so no cwd pass can see it:
  // only the parent-chain closure of a corroborated member reaches it. That is the
  // 3-per-job + MCP-children reality the reap has to cover.
  const tree = await fixtureCodexTree(t, worktreePath, { strayCwd: setup.root });
  // What an unclean death actually leaves: a record still claiming to be running,
  // a sessionId that would once have protected it, a worktree that is gone - and a
  // PERSISTED tree, because the capture path runs on every live poll. That last
  // part is why an identity-only kill set costs almost nothing here.
  await seedCodexRecord(setup, {
    state: "running",
    sessionId: "codex-thread-1",
    codexProcessTree: tree.persistedTree,
  });
  await rm(worktreePath, { recursive: true, force: true });
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setRunFile(async (file, args) => {
    if (file === "node" && (args[1] === "status" || args[1] === "result")) {
      return JSON.stringify({ status: "failed", job: { status: "failed", pid: null } });
    }
    return "";
  });

  createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForConditionOverTime(
    () => allReaped(tree.pids),
    "boot left a crash-window companion tree resident under a deleted worktree",
  );
  assert.ok(
    allReaped([tree.strayPid]),
    "the reap missed a child whose own cwd was outside Atelier's worktree root",
  );
});

test("the cwd pass reaps a corroborated member whose record never reached a terminal state", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // plan_ready is neither active nor terminal, so boot recovery leaves this record
  // alone and the identity pass (which gates on TERMINAL) skips it. The cwd pass is
  // the only thing that can act, which is what this test isolates: its distinct
  // value now is reaping a corroborated member whose RECORD never got to terminal.
  await seedCodexRecord(setup, {
    state: "plan_ready",
    codexJobId: null,
    codexProcessTree: tree.persistedTree,
  });
  await rm(worktreePath, { recursive: true, force: true });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const swept = await dispatcher.sweepCodexProcesses();
  assert.deepEqual(
    swept.reaped.map((entry) => entry.pid).sort((left, right) => left - right),
    tree.pids.slice().sort((left, right) => left - right),
  );
  await waitForConditionOverTime(
    () => allReaped(tree.pids),
    "the cwd pass left a corroborated member of a deleted worktree resident",
  );
});

test("merge escalates a wedged companion tree to SIGKILL inside its own call", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    branchHead: "validated-head",
    result: { commit: "validated-head", manifest: [], version: 1 },
    attestation: { resultCommit: "validated-head", resultVersion: 1 },
    codexProcessTree: wedged.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  const order = [];
  _setRunFile(async (file, args) => {
    // The reap is awaited before this command is issued, so by the time git runs
    // the tree is already gone. Asserted after the await rather than by probing
    // liveness here: racing a just-delivered SIGKILL would be a flake, not a proof.
    if (args[2] === "worktree" && args[3] === "remove") order.push("worktree-remove");
    if (args[2] === "rev-parse" && args[3] === "--verify") return "validated-head\n";
    if (args[2] === "rev-parse" && args[3] === "main") return "abcdef1234567890\n";
    return "";
  });

  const escalationMs = 120;
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: escalationMs,
    sweepCodexProcessesAtBoot: false,
  });
  assert.ok(anyAlive(wedged.pids), "the fixture tree was not alive to begin with");

  const started = Date.now();
  const merged = await dispatcher.merge("codex-leak");
  const elapsed = Date.now() - started;

  assert.equal(merged.merged.commit, "abcdef1234567890");
  assert.ok(
    allReaped(wedged.pids),
    "merge removed the worktree but returned with a wedged companion tree resident",
  );
  assert.ok(
    elapsed >= escalationMs,
    `merge SIGKILLed without waiting out the SIGTERM grace (${elapsed}ms < ${escalationMs}ms)`,
  );
  assert.deepEqual(order, ["worktree-remove"]);
});

test("a live companion poll captures the worker's process tree and keeps a member that reparented away", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // A separate process, standing in for a broker that has already reparented to
  // init: it is NOT a descendant of the reported worker, so only the union with
  // the previous capture can keep it in the reap set.
  const reparented = spawnAliveProcess(t);
  await withDeadline(reparented.ready, "the reparented stand-in never started");
  await seedCodexRecord(setup, {
    // A prior live poll already corroborated this worker, which is the only way
    // atelier-tzw's reattach will keep polling rather than fail closed.
    codexWorkerPid: tree.rootPid,
    codexWorkerPidIdentity: processStartIdentity(tree.rootPid),
    codexProcessTree: {
      rootPid: tree.rootPid,
      capturedAt: "2026-07-30T07:59:00.000Z",
      processes: [{
        pid: reparented.child.pid,
        identity: processStartIdentity(reparented.child.pid),
        depth: 1,
        command: "broker",
      }],
    },
  });
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({
        status: "running",
        job: { status: "running", pid: tree.rootPid },
      });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await waitForConditionOverTime(
    () => (rawRecord(setup, "codex-leak").codexProcessTree?.processes?.length ?? 0) >= 4,
    "the live poll never captured the companion's process tree",
  );

  const captured = rawRecord(setup, "codex-leak").codexProcessTree;
  assert.equal(captured.rootPid, tree.rootPid);
  const capturedPids = captured.processes.map((member) => member.pid).sort((a, b) => a - b);
  assert.deepEqual(
    capturedPids,
    [...tree.pids, reparented.child.pid].sort((a, b) => a - b),
    "the capture lost either a descendant or the reparented member",
  );
  for (const member of captured.processes) {
    assert.match(member.identity, /^linux-proc-start:/);
  }
});

test("atelier doctor --gc surfaces the report-only list, and --dry-run names a reap without carrying it out", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  // Two trees in Atelier's own worktree root. One is a corroborated member of a tree
  // Atelier captured, so it is the sweep's only signalable candidate; the other is a
  // companion-shaped process Atelier never captured, which may only ever be listed.
  const owned = join(setup.state, "worktrees", "fixture", "codex-leak");
  const unowned = join(setup.state, "worktrees", "fixture", "nobody-captured-this");
  await mkdir(owned, { recursive: true });
  await mkdir(unowned, { recursive: true });
  const reapable = await fixtureCodexTree(t, owned);
  const reportable = await fixtureCodexTree(t, unowned);
  await seedCodexRecord(setup, {
    state: "plan_ready",
    codexJobId: null,
    codexProcessTree: reapable.persistedTree,
  });
  // Both worktrees go, so the situational criterion is satisfied for both and only
  // the identity evidence separates them.
  await rm(owned, { recursive: true, force: true });
  await rm(unowned, { recursive: true, force: true });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const dry = await dispatcher.gc({
    olderThanDays: 7,
    dryRun: true,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });

  assert.deepEqual(
    dry.codexProcesses.reaped.map((entry) => entry.pid).sort((left, right) => left - right),
    reapable.pids.slice().sort((left, right) => left - right),
    "the corroborated tree was not named as a reap candidate",
  );
  for (const reaped of dry.codexProcesses.reaped) {
    assert.equal(reaped.signal, null, "--dry-run named a signal it had no business sending");
  }
  const reportedPids = dry.codexProcesses.reported.map((entry) => entry.pid);
  for (const pid of reportable.pids) {
    assert.ok(reportedPids.includes(pid), `an uncapturable process was not listed (${pid})`);
  }
  assert.ok(anyAlive(reapable.pids), "--gc --dry-run killed a process");
  assert.ok(anyAlive(reportable.pids), "--gc killed a process it could only report");

  // Without --dry-run the corroborated tree goes; the one Atelier never captured
  // stays, however much its cwd and its argv look like a leak.
  await dispatcher.gc({ olderThanDays: 7, now: new Date("2026-08-30T12:00:00.000Z") });
  await waitForConditionOverTime(
    () => allReaped(reapable.pids),
    "atelier doctor --gc left a corroborated deleted-worktree tree resident",
  );
  assert.ok(
    anyAlive(reportable.pids),
    "atelier doctor --gc signalled a process it had no identity evidence for",
  );
});

test("a deleted SUBDIRECTORY is not a deleted worktree - the tree in it is retained, never reaped", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  const scratch = join(worktreePath, "build-scratch");
  await mkdir(scratch, { recursive: true });
  const tree = await fixtureForeignTree(t, scratch);
  // The scratch directory goes; the WORKTREE does not. Reading each process's own
  // " (deleted)" cwd marker as corroboration would condemn a whole dispatch on
  // the strength of a `rm -rf build/` (spec risk area (a)).
  await rm(scratch, { recursive: true, force: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: null,
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const swept = await dispatcher.sweepCodexProcesses();
  assert.deepEqual(swept.reaped, [], "a present worktree was treated as deleted");
  assert.ok(anyAlive(tree.pids), "a process in a live worktree was signalled");
  // Listed, not killed: this record carries no captured tree (the cwd pass is all
  // there is here), and a cwd is not enough corroboration to signal on while the
  // worktree is still there. The persisted-tree pass is what collects a terminal
  // record's processes, with a pid+identity for each.
  assert.deepEqual(
    swept.reported.map((entry) => entry.pid).sort((left, right) => left - right),
    tree.pids.slice().sort((left, right) => left - right),
  );
  for (const entry of swept.reported) {
    assert.match(entry.reason, /is completed and its worktree is still present/);
    assert.equal(entry.cwdDeleted, true);
    assert.equal(entry.worktreePath, worktreePath);
  }
});

// The contract the flipped default rests on: reaping a terminal record's process
// tree costs a resume ONE COLD START, never its session. Codex thread state is a
// persisted rollout file, and the companion's ensureBrokerSession(cwd) starts a
// fresh broker on demand.
async function reapedThenResumable(t, { onResume }) {
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: tree.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const spawns = [];
  _setSpawner((file, args) => {
    spawns.push({ file, args });
    return onResume();
  });
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "running", job: { status: "running", pid: null } });
    }
    return "";
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  // The boot sweep collects the tree first: this record is terminal, so nothing
  // needs its app-server any more.
  await waitForConditionOverTime(
    () => allReaped(tree.pids),
    "the terminal record kept its companion process tree",
  );
  return { setup, dispatcher, spawns, tree, worktreePath };
}

test("a terminal record whose process tree was reaped still resumes - the reap costs a cold start, not the session", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const { dispatcher, spawns, setup } = await reapedThenResumable(t, {
    onResume: () => codexLaunchChild("codex-job-resumed"),
  });

  const resumed = await dispatcher.reply("codex-leak", { text: "carry on" });
  assert.equal(resumed.state, "resuming");
  await waitForCondition(
    () => dispatcher.get("codex-leak").state === "running",
    "the resume never reached a live companion job after its tree was reaped",
  );

  // A real relaunch: the companion is invoked with --resume, against the same
  // worktree, and it mints a NEW job rather than reattaching to the dead one.
  const resume = spawns.find((spawn) => spawn.args[1] === "task");
  assert.ok(resume, "the resume never launched a companion");
  assert.ok(resume.args.includes("--resume"), "the relaunch was not a resume");
  const record = dispatcher.get("codex-leak");
  assert.equal(record.sessionId, "codex-thread-1");
  assert.equal(record.exitSummary, "");
  assert.deepEqual(record.warnings, []);
  const persisted = rawRecord(setup, "codex-leak");
  assert.equal(persisted.codexJobId, "codex-job-resumed");
  // The reaped turn's members may still be listed until a later pass clears them
  // (a signalled member is deliberately kept so escalation cannot lose track of
  // it). What must be true is that every one of them is provably dead, so the
  // stale entries can never make a future reap signal anything: each is
  // reclassified before it could be, and the next live capture drops it.
  for (const member of persisted.codexProcessTree?.processes ?? []) {
    const state = procState(member.pid);
    assert.ok(
      state === undefined || state === "Z",
      `a reaped member is still alive on the resumed record (pid ${member.pid}, state ${state})`,
    );
  }
});

test("a resume whose cold start fails says so, instead of reporting a turn nothing ran", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  // The honest failure mode of the flipped default: the app-server is gone AND
  // the relaunch cannot start one. That must surface, not pass as success.
  const { dispatcher } = await reapedThenResumable(t, {
    onResume: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = undefined;
      setImmediate(() => {
        child.stderr.write("codex app-server broker failed to start\n");
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 1, null);
      });
      return child;
    },
  });

  await dispatcher.reply("codex-leak", { text: "carry on" });
  await waitForCondition(
    () => dispatcher.get("codex-leak").state === "failed",
    "a resume whose companion could not start never settled",
  );
  const failed = dispatcher.get("codex-leak");
  assert.match(failed.exitSummary, /Codex companion launch failed/);
  assert.match(failed.exitSummary, /broker failed to start/);
  // Still resumable: the session outlived both the reap and the failed cold start.
  assert.equal(failed.sessionId, "codex-thread-1");
});

test("the cwd sweep lists a companion-SHAPED process Atelier never captured, and never signals it", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // Companion-shaped argv AND a cwd in a Atelier worktree AND that worktree deleted
  // AND the dispatch dismissed. Every situational signal points at "leaked
  // app-server" - and it is still not ownership, because argv is self-reported and
  // a user's OWN companion can legitimately run with a cwd in here. Only a tree
  // Atelier captured proves ownership (spec constraint 1 as amended).
  const shaped = await fixtureCodexTree(t, worktreePath);
  // A plain shell in the same worktree: same treatment, weaker annotation.
  const plain = await fixtureForeignTree(t, worktreePath);
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    dismissed: { at: "2026-07-30T08:06:00.000Z" },
    codexProcessTree: null,
  });
  await rm(worktreePath, { recursive: true, force: true });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const swept = await dispatcher.sweepCodexProcesses();

  assert.deepEqual(swept.reaped, [], "the sweep signalled a process it could not tie to Atelier");
  assert.deepEqual(
    swept.reported.map((entry) => entry.pid).sort((left, right) => left - right),
    [...shaped.pids, ...plain.pids].sort((left, right) => left - right),
  );
  for (const entry of swept.reported) {
    assert.match(entry.reason, /Atelier never captured this process as a member/);
  }
  // The shape survives as an annotation for whoever reads the listing - it is the
  // difference between "go look at this" and "some process" - but it is not a
  // licence, and the plain shell must not carry it.
  const shapedReport = swept.reported.find((entry) => entry.pid === shaped.rootPid);
  assert.match(shapedReport.reason, /looks like a codex companion process, which is not proof/);
  const plainReport = swept.reported.find((entry) => entry.pid === plain.rootPid);
  assert.doesNotMatch(plainReport.reason, /looks like a codex companion process/);

  assert.ok(anyAlive(shaped.pids), "a companion-shaped process Atelier never captured was killed");
  assert.ok(anyAlive(plain.pids), "a non-companion process under a deleted worktree was killed");
});

test("a reported pid that does not match the fence is neither adopted nor captured", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // Poll 1 corroborates the fence Atelier already holds, which is what lets the
  // reattach keep going and hand the ORDINARY branch the wheel. Poll 2 then
  // reports a DIFFERENT live pid - an unrelated process with a tree of its own.
  // Deriving an identity from that pid would prove only that the pid exists, not
  // that it is Atelier's, and capturing its descendants would arm the reaper against
  // a stranger's children (blocker 1).
  const owned = await fixtureCodexTree(t, worktreePath);
  const stranger = await fixtureForeignTree(t, worktreePath);
  await seedCodexRecord(setup, {
    state: "running",
    codexWorkerPid: owned.rootPid,
    codexWorkerPidIdentity: processStartIdentity(owned.rootPid),
    codexProcessTree: null,
  });
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  // Only the second poll onwards runs the ordinary branch.
  _setCodexPollIntervalMs(5);
  let polls = 0;
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      polls += 1;
      return JSON.stringify({
        status: "running",
        job: { status: "running", pid: polls === 1 ? owned.rootPid : stranger.rootPid },
      });
    }
    return "";
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  await waitForConditionOverTime(() => polls >= 3, "the companion was never polled twice");
  assert.equal(dispatcher.get("codex-leak").state, "running");

  const persisted = rawRecord(setup, "codex-leak");
  assert.equal(
    persisted.codexWorkerPid,
    owned.rootPid,
    "the fence was moved to an uncorroborated reported pid",
  );
  assert.match(persisted.codexWorkerPidIdentity, /^linux-proc-start:/);
  // Poll 1's corroborated capture is expected; the stranger's tree is not.
  const capturedPids = (persisted.codexProcessTree?.processes ?? []).map((member) => member.pid);
  for (const pid of stranger.pids) {
    assert.ok(!capturedPids.includes(pid), `a stranger's process was captured as Atelier's (${pid})`);
  }
  assert.ok(anyAlive(stranger.pids), "a stranger's process tree was signalled");
});

test("a reap kills a child forked after the capture, not only the members it recorded", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // The record remembers only the root. An MCP server the app-server forks after
  // the last poll is invisible to the capture and must still die with its tree
  // (major 4) - the reap refreshes the closure against a live /proc read.
  const persistedTree = {
    rootPid: tree.rootPid,
    capturedAt: "2026-07-30T00:00:00.000Z",
    processes: [{
      pid: tree.rootPid,
      identity: processStartIdentity(tree.rootPid),
      depth: 0,
      command: "node",
    }],
  };
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: persistedTree,
  });
  const laterChildren = tree.pids.filter((pid) => pid !== tree.rootPid);
  assert.equal(laterChildren.length, 2, "the fixture tree lost its children");
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  await dispatcher.dismiss("codex-leak");
  assert.ok(
    allReaped(tree.pids),
    "the reap collected only its recorded members and left the rest of the live tree behind",
  );
});

test("a resume clears the previous turn's tree before it cold-starts, never mid-SIGTERM", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // A wedged app-server from the previous turn. ensureBrokerSession(cwd) would
  // REUSE whatever broker is up for this workspace, so relaunching now could
  // attach to a process Atelier is in the middle of killing (major 6).
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: wedged.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const spawns = [];
  _setSpawner((file, args) => {
    spawns.push({ file, args, treeAlive: anyAlive(wedged.pids) });
    return codexLaunchChild("codex-job-resumed");
  });
  _setRunFile(async (file, args) => {
    if (file === "node" && args[1] === "status") {
      return JSON.stringify({ status: "running", job: { status: "running", pid: null } });
    }
    return "";
  });

  const escalationMs = 120;
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: escalationMs,
    sweepCodexProcessesAtBoot: false,
  });
  const started = Date.now();
  await dispatcher.reply("codex-leak", { text: "carry on" });
  const elapsed = Date.now() - started;

  const launch = spawns.find((spawn) => spawn.args[1] === "task");
  assert.ok(launch, "the resume never launched a companion");
  assert.ok(launch.args.includes("--resume"), "the relaunch was not a resume");
  assert.equal(
    launch.treeAlive,
    false,
    "the companion was relaunched while the previous turn's app-server was still up",
  );
  assert.ok(
    elapsed >= escalationMs,
    `the resume did not wait out the SIGTERM grace before escalating (${elapsed}ms)`,
  );
});

test("an identity-null tree member is never signalled, and is reported and warned about instead", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // A member captured in the crash window, before any identity could be derived.
  // "Cannot corroborate" is not a licence to kill - but it is also not a licence
  // to stay silent: memory nobody will reclaim has to reach an operator (major 7).
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: {
      rootPid: tree.rootPid,
      capturedAt: "2026-07-30T00:00:00.000Z",
      processes: [{ pid: tree.rootPid, identity: null, depth: 0, command: "node" }],
    },
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const swept = await dispatcher.sweepCodexProcesses();

  assert.deepEqual(swept.reaped, [], "an uncorroborated member was signalled");
  assert.ok(anyAlive(tree.pids), "an uncorroborated member was killed");
  const reported = swept.reported.find((entry) => entry.pid === tree.rootPid);
  assert.ok(reported, "an uncorroborated member was not reported");
  assert.match(reported.reason, /without a start-time identity/);
  // And on the record, where an operator looking at the dispatch will see it.
  assert.ok(
    dispatcher.get("codex-leak").warnings.some((warning) =>
      /^uncorroborated codex process:/.test(warning) && warning.includes("start-time identity")),
    "the record carries no warning about the process Atelier refused to touch",
  );
  // The member stays on the record: dropping it would lose Atelier's only handle.
  assert.equal(rawRecord(setup, "codex-leak").codexProcessTree.processes.length, 1);
});

test("a record written before process trees existed is reaped over safely - no tree, no reap, no crash", async (t) => {
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // Exactly the on-disk shape atelier-tzw left behind: no codexProcessTree key at
  // all. Every reap path must be a no-op over it, and the sweep must not throw.
  const dispatchDir = join(setup.state, "dispatches");
  await mkdir(dispatchDir, { recursive: true });
  const record = {
    id: "codex-old",
    project: "fixture",
    ticketId: null,
    model: "codex-default",
    effort: null,
    lane: "codex",
    state: "completed",
    branch: "atelier/codex-old",
    worktreePath,
    codexJobId: "codex-job-old",
    codexWorkspace: worktreePath,
    startedAt: "2026-07-29T08:00:00.000Z",
    endedAt: "2026-07-29T08:05:00.000Z",
    turns: 1,
    costUSD: 0,
    sessionId: "codex-thread-old",
    exitSummary: "done",
    strandedBrWrites: false,
    verify: { state: "passed", steps: [] },
    merged: null,
    dismissed: null,
    warnings: [],
  };
  await writeFile(join(dispatchDir, "index.jsonl"), `${JSON.stringify(record)}\n`);
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const swept = await dispatcher.sweepCodexProcesses();
  assert.deepEqual(swept.reaped, []);
  assert.deepEqual(swept.errors, []);

  // And the lifecycle verbs that reap still work on it.
  const dismissed = await dispatcher.dismiss("codex-old");
  assert.ok(dismissed.dismissed.at);
  assert.deepEqual(rawRecord(setup, "codex-old").codexProcessTree, null);
  assert.deepEqual(
    dispatcher.get("codex-old").warnings.filter((warning) =>
      /^uncorroborated codex process:/.test(warning)),
    [],
  );
});

test("a dispatcher built with the boot sweep disabled never sweeps on another server's behalf", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: tree.persistedTree,
  });
  await rm(worktreePath, { recursive: true, force: true });
  _setRunFile(async () => "");

  // What `atelier doctor --gc` constructs: a Dispatcher for the length of one
  // command. Its constructor must not reap - least of all under --dry-run, which
  // has to be side-effect-free (item 9).
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const dry = await dispatcher.gc({
    olderThanDays: 7,
    dryRun: true,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  assert.ok(dry.codexProcesses.reaped.length > 0, "the dry run named nothing at all");
  for (const reaped of dry.codexProcesses.reaped) assert.equal(reaped.signal, null);
  assert.ok(anyAlive(tree.pids), "a --dry-run gc killed a process");
});

test("escalation re-walks the closure, so a child forked during the SIGTERM grace still dies", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // A root that ignores SIGTERM keeps running, and a root that keeps running keeps
  // forking. This fixture forks a fresh child the moment it is asked to die, so that
  // child exists in NEITHER the persisted tree nor the pre-SIGTERM closure - only a
  // re-walk at the SIGKILL step can see it (round-3 review, major 3).
  const wedged = await fixtureCodexTree(t, worktreePath, {
    ignoreSigterm: true,
    forkOnSigterm: true,
  });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: wedged.persistedTree,
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: 200,
    sweepCodexProcessesAtBoot: false,
  });
  await dispatcher.dismiss("codex-leak");

  const late = wedged.lateForkedPid();
  assert.ok(late, "the fixture never forked a child during the grace window");
  assert.ok(
    !wedged.persistedTree.processes.some((member) => member.pid === late),
    "the late child was already a persisted member, so this test proves nothing",
  );
  assert.ok(
    allReaped([...wedged.pids, late]),
    `a child forked during the SIGTERM grace outlived its tree (pid ${late})`,
  );
});

test("a shutdown that completes during the pre-resume reap refuses the resume", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  // A wedged tree makes the pre-resume reap take its full grace period, which is the
  // window this test drives: everything assertAdmissionOpen answers was decided
  // BEFORE that await (round-3 review, major 4).
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: wedged.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const spawns = [];
  _setSpawner((file, args) => {
    spawns.push({ file, args });
    return codexLaunchChild("codex-job-resumed");
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: 300,
    sweepCodexProcessesAtBoot: false,
  });
  const resume = dispatcher.reply("codex-leak", { text: "carry on" });
  // Land the shutdown inside the reap's wait.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  const stopping = dispatcher.shutdown({ graceMs: 10 });

  await assert.rejects(
    resume,
    (error) => error.status === 409 && /shutting down/.test(error.message),
    "a resume spawned into a server that finished shutting down while it waited",
  );
  assert.deepEqual(spawns, [], "the companion was launched despite the shutdown");
  await stopping;
});

test("a resume refuses when the previous turn's tree could not be signalled", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    sessionId: "codex-thread-1",
    codexProcessTree: wedged.persistedTree,
    verify: { state: "passed", steps: [] },
  });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setCompanionResolver(() => "/fixture/codex-companion.mjs");
  _setGitDirFileOps({ writeFileSync() {}, unlinkSync() {} });
  const spawns = [];
  _setSpawner((file, args) => {
    spawns.push({ file, args });
    return codexLaunchChild("codex-job-resumed");
  });
  _setRunFile(async () => "");
  // The SIGTERM still lands (and is ignored); the SIGKILL comes back EPERM. That is
  // a SIGNAL FAILURE, which lands in the reap's `errors` and never in its
  // `retained` - so a gate that consulted `retained` alone would cold-start beside
  // a broker it never managed to kill (round-3 review, major 5).
  _setCodexProcessOps({
    kill(pid, signal) {
      if (signal === "SIGKILL") {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      process.kill(pid, signal);
    },
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: 100,
    sweepCodexProcessesAtBoot: false,
  });
  await assert.rejects(
    dispatcher.reply("codex-leak", { text: "carry on" }),
    (error) =>
      error.status === 409 &&
      /codex process gate failed/.test(error.message) &&
      /operation not permitted/.test(error.message) &&
      new RegExp(String(wedged.rootPid)).test(error.message),
    "a resume cold-started beside a tree Atelier had failed to signal",
  );
  assert.deepEqual(spawns, [], "the companion was launched despite the failed reap");
  assert.ok(anyAlive(wedged.pids), "the fixture tree was expected to survive an EPERM kill");
});

test("the SIGKILL pass re-checks identity, so a pid that died before its turn is never signalled", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const wedged = await fixtureCodexTree(t, worktreePath, { ignoreSigterm: true });
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: wedged.persistedTree,
  });
  _setRunFile(async () => "");

  // Survivors are killed leaves-first, so the root is last. This stub kills the
  // root out from under the loop while an earlier member is being signalled - the
  // real hazard being modelled is a pid that exits (and could be recycled) between
  // the liveness check and its own kill, and SIGKILL cannot be blocked or handled,
  // so an unguarded pass would deliver it to whoever inherited the number.
  const signals = [];
  let sprung = false;
  _setCodexProcessOps({
    kill(pid, signal) {
      signals.push({ pid, signal });
      if (signal === "SIGKILL" && !sprung && pid !== wedged.rootPid) {
        sprung = true;
        try {
          process.kill(wedged.rootPid, "SIGKILL");
        } catch {
          // Already gone.
        }
        // kill(2) returns before the target is off the run queue, and this stub is
        // synchronous, so spin (bounded) until /proc agrees. Without this the guard
        // would be racing a process that is still alive - which is not the case
        // under test.
        const spinUntil = Date.now() + 250;
        while (Date.now() < spinUntil) {
          const state = procState(wedged.rootPid);
          if (state === undefined || state === "Z") break;
        }
      }
      process.kill(pid, signal);
    },
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    codexReapEscalationMs: 80,
    sweepCodexProcessesAtBoot: false,
  });
  await dispatcher.dismiss("codex-leak");

  assert.ok(sprung, "the stub never got to kill the root, so this test proves nothing");
  const killed = signals.filter((entry) => entry.signal === "SIGKILL").map((entry) => entry.pid);
  assert.ok(killed.length > 0, "nothing was escalated at all");
  assert.ok(
    !killed.includes(wedged.rootPid),
    "a SIGKILL was delivered to a pid that was no longer alive when its turn came",
  );
  // The rest of the tree still goes: the guard skips, it does not abort the pass.
  assert.ok(allReaped(wedged.pids), "the guard stopped the escalation instead of skipping one pid");
});

test("an observer dispatcher cannot signal even when a caller explicitly asks for a real sweep", async (t) => {
  if (process.platform !== "linux") {
    t.skip("codex process reaping is Linux-only (identity = /proc start time)");
    return;
  }
  const setup = await fixture(t, { tracker: "none" });
  const worktreePath = join(setup.state, "worktrees", "fixture", "codex-leak");
  await mkdir(worktreePath, { recursive: true });
  const tree = await fixtureCodexTree(t, worktreePath);
  // A member that is provably gone, so a real reap would TRIM the tree and persist.
  // An observer must not rewrite the record either - being kill-free is not enough
  // if it still edits state a live server owns.
  const stale = {
    ...tree.persistedTree,
    processes: [
      ...tree.persistedTree.processes,
      { pid: 2_147_483_646, identity: "linux-proc-start:absent:1", depth: 1, command: "gone" },
    ],
  };
  await seedCodexRecord(setup, {
    state: "completed",
    endedAt: "2026-07-30T08:05:00.000Z",
    codexProcessTree: stale,
  });
  await rm(worktreePath, { recursive: true, force: true });
  const signals = [];
  _setCodexProcessOps({
    kill(pid, signal) {
      signals.push({ pid, signal });
      process.kill(pid, signal);
    },
  });
  _setRunFile(async () => "");

  // Everything about this record says "reap me": terminal, tree captured and
  // identity-corroborated, worktree gone. The ONLY thing standing between it and a
  // signal is observer mode - and it must hold structurally, not because the caller
  // remembered to pair it with dryRun.
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  const swept = await dispatcher.sweepCodexProcesses({ dryRun: false });
  assert.ok(swept.reaped.length > 0, "the observer sweep named no candidates at all");
  for (const reaped of swept.reaped) {
    assert.equal(reaped.signal, null, "an observer sweep reported sending a signal");
  }
  const collected = await dispatcher.gc({
    olderThanDays: 0,
    dryRun: false,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  assert.equal(collected.dryRun, true, "an observer gc did not report itself as a preview");

  // gc's `dismissed` lists what a preview WOULD collect; the sweep and the gc must
  // have changed nothing themselves - not the processes, and not the record.
  assert.deepEqual(collected.dismissed, ["codex-leak"], "the observer gc previewed nothing");
  assert.deepEqual(
    rawRecord(setup, "codex-leak").codexProcessTree,
    stale,
    "an observer sweep rewrote the record's captured tree",
  );
  assert.deepEqual(
    dispatcher.get("codex-leak").warnings,
    [],
    "an observer sweep wrote a warning onto the record",
  );
  assert.equal(dispatcher.get("codex-leak").dismissed, null, "an observer gc dismissed a record");

  // Finally a lifecycle verb called DIRECTLY. That is an operator explicitly asking
  // to mutate, so the record may change - but it reaches the reaper WITHOUT passing
  // through the sweep's dryRun, so it proves the kill-freeness holds at the choke
  // point and not merely where a caller happens to forward a flag.
  await dispatcher.dismiss("codex-leak");

  assert.deepEqual(signals, [], "an observer dispatcher delivered a signal");
  assert.ok(anyAlive(tree.pids), "an observer dispatcher killed a process");
});

test("observer boot leaves an interrupted verification re-run untouched", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  // atelier-9dt's boot repair runs BEFORE the boot-recovery block and is keyed on the
  // attempt, not the dispatch state - so it fires for a `completed` record too. Both
  // of its branches persist, emit and transition, and transition() now reaps a
  // terminal record's codex process tree. An observer dispatcher must therefore skip
  // it: `atelier doctor --gc --dry-run` builds one, and a read-only command that
  // rewrites verification history (or signals) is not read-only.
  const [crashed, markerless] = await seedDispatches(setup, [
    {
      id: "observer-crashed-rerun",
      ticketId: "ticket-observer-crashed",
      verify: {
        state: "running",
        steps: [],
        attempt: 2,
        attempts: [{ attempt: 1, state: "failed", steps: [{ command: "node --test", exitCode: 1 }] }],
        startedAt: "2026-07-21T08:02:00.000Z",
        rerun: { attempt: 2, from: "completed", previousState: "failed" },
      },
    },
    {
      id: "observer-markerless-attempt",
      ticketId: "ticket-observer-markerless",
      verify: { state: "running", steps: [], attempt: 1, attempts: [] },
    },
  ]);
  for (const record of [crashed, markerless]) await mkdir(record.worktreePath, { recursive: true });
  stubVerificationRuntime();
  _setSpawner(() => verifyChild());

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
  });
  await dispatcher.gc({ olderThanDays: 0, dryRun: false, now: new Date("2026-08-30T12:00:00.000Z") });

  // Both records still carry the interrupted shape, in memory AND on disk: nothing
  // concluded the attempt, nothing settled it, nothing emitted for it.
  for (const id of ["observer-crashed-rerun", "observer-markerless-attempt"]) {
    assert.equal(dispatcher.get(id).verify.state, "running", `${id} was repaired by an observer`);
    assert.equal(rawRecord(setup, id).verify.state, "running", `${id} was rewritten on disk`);
    assert.deepEqual(
      dispatcher.getEvents(id).filter((event) => event.type === "verify-rerun"),
      [],
      `${id} emitted a re-run event from an observer boot`,
    );
  }
  assert.deepEqual(
    rawRecord(setup, "observer-crashed-rerun").verify.rerun,
    { attempt: 2, from: "completed", previousState: "failed" },
    "the observer boot consumed the re-run marker",
  );
});

// ---------------------------------------------------------------------------
// atelier-yqk + atelier-kaz: verification-runner fencing
//
// A verify child is a process Atelier spawns that can outlive it - and on this
// programme's own repos it is the HEAVIEST one (a full `cargo nextest` tree).
// Before this, none of the three verify spawn paths (first-run, explicit re-run,
// post-merge) carried a fence, so a crash mid-verification orphaned the suite
// with no boot coverage: the record healed honestly while the process ran on.
// The post-merge pair existed but sat outside the vocabulary, with its own boot
// recovery that folded "cannot confirm death" into death.

// A verifier that traps SIGTERM and holds a CHILD in its own process group, so a
// reap can be proven to have been a group kill rather than a single-pid kill: the
// grandchild is the thing a `kill(pid)` would leave behind burning CPU.
async function spawnFixtureVerifier(t, { trapSigterm = true } = {}) {
  const trap = trapSigterm ? "trap '' TERM; " : "";
  const root = spawn(
    "sh",
    ["-c", `${trap}sleep 300 & printf 'ready %s\\n' "$!"; wait`],
    { stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  let output = "";
  root.stdout.setEncoding("utf8");
  root.stdout.on("data", (chunk) => {
    output += chunk;
  });
  const exitPromise = once(root, "exit");
  await withDeadline(once(root.stdout, "data"), "the fixture verifier never reported ready");
  const childPid = Number(/ready (\d+)/.exec(output)?.[1]);
  assert.ok(Number.isInteger(childPid) && childPid > 0, `no fixture grandchild pid in ${output}`);
  t.after(async () => {
    for (const pid of [root.pid, childPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone: that is what these tests assert.
      }
    }
    await exitPromise.catch(() => {});
  });
  return { root, childPid, exitPromise, output: () => output };
}

// A record mid-verification, exactly as a crash leaves it: the attempt persisted
// as `running`, the runner's pid + identity on the record, and no observed exit.
function verifyFencedRecord(setup, overrides) {
  return fencedRecord(setup, {
    state: "verifying",
    verify: { state: "running", steps: [], attempt: 1, attempts: [] },
    ...overrides,
  });
}

test("boot reaps a crash-window verification runner on identity match, and the kill is a GROUP kill", async (t) => {
  if (process.platform !== "linux") {
    t.skip("verifier PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const verifier = await spawnFixtureVerifier(t);
  await seedIndex(setup, [
    verifyFencedRecord(setup, {
      id: "verify-crash-window",
      verifyPid: verifier.root.pid,
      verifyPidIdentity: processStartIdentity(verifier.root.pid),
    }),
  ]);
  const spawns = [];
  _setRunFile(async () => "");
  _setSpawner((file, args) => {
    spawns.push([file, ...args].join(" "));
    return verifyChild();
  });

  createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 400,
  });

  await withDeadline(
    verifier.exitPromise,
    "boot never reaped the identity-matched verification runner",
  );
  // SIGTERM was trapped, so only the escalation could have ended it - and the
  // grandchild proves the signal went to the process GROUP. A single-pid kill
  // would leave `sleep 300` running with nothing left to reap it.
  assert.notEqual(verifier.root.signalCode, null);
  await waitForConditionOverTime(
    () => allReaped([verifier.childPid]),
    "the reap killed the runner but left its child running - not a group kill",
  );
  await waitForConditionOverTime(
    () => rawRecord(setup, "verify-crash-window").verifyPid === null,
    "the verifier fence was not cleared once death was confirmed",
  );

  const persisted = rawRecord(setup, "verify-crash-window");
  assert.equal(persisted.verifyPidIdentity, null);
  assert.equal(persisted.orphanUnresolved, false);
  assert.equal(persisted.state, "failed");
  assert.equal(persisted.verify.state, "failed");
  // Single-flight: a boot that reaps a live verifier must not start another.
  assert.deepEqual(spawns, [], "boot started a second verifier beside the one it reaped");
});

test("an unconfirmable verification runner lands unresolved, refuses the re-run, and dismissal is the way out", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const verifier = await spawnFixtureVerifier(t, { trapSigterm: false });
  const [record] = await seedDispatches(setup, [{
    id: "verify-unconfirmable",
    ticketId: "fixture-unconfirmable",
    verify: { ...FAILED_VERIFY, steps: FAILED_VERIFY.steps.map((step) => ({ ...step })) },
    // The crash window: the pid reached the record, the identity did not. A live
    // pid Atelier cannot corroborate is NOT dead, so it is never signalled either.
    verifyPid: verifier.root.pid,
    verifyPidIdentity: null,
  }]);
  await mkdir(record.worktreePath, { recursive: true });
  const calls = stubVerificationRuntime();
  const spawns = [];
  _setSpawner((file) => {
    spawns.push(file);
    return verifyChild();
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("verify-unconfirmable")?.orphanUnresolved === true,
    "boot never flagged the uncorroborated verification runner",
  );

  const flagged = rawRecord(setup, "verify-unconfirmable");
  assert.equal(flagged.verifyPid, verifier.root.pid, "the fence was cleared without proof");
  assert.equal(flagged.orphanUnresolved, true);
  assert.ok(
    flagged.warnings.some((warning) =>
      warning.startsWith("unresolved orphaned worker:") && /verification runner/.test(warning)),
    `the unresolved verifier was not surfaced: ${JSON.stringify(flagged.warnings)}`,
  );
  assert.equal(verifier.root.exitCode, null, "an uncorroborated pid was signalled");
  assert.equal(verifier.root.signalCode, null);
  assert.equal(claimReleased(calls, "fixture-unconfirmable"), false);

  // The whole point of the fence: no second suite in that worktree.
  await assert.rejects(
    dispatcher.rerunVerification("verify-unconfirmable"),
    (error) => {
      assert.equal(error.status, 409);
      assert.match(error.message, /has a worker Atelier has not proven dead/);
      return true;
    },
  );
  assert.deepEqual(spawns, [], "a re-run spawned beside an unproven verifier");

  // Dismissal is the operator's "I have dealt with that process", and it has to
  // clear unconditionally or the next boot re-derives the condition and silently
  // undoes it.
  const dismissed = await dispatcher.dismiss("verify-unconfirmable");
  assert.equal(dismissed.orphanUnresolved, false);
  assert.equal(rawRecord(setup, "verify-unconfirmable").verifyPid, null);
  assert.equal(rawRecord(setup, "verify-unconfirmable").verifyPidIdentity, null);
  const rebooted = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await settleAsyncWork();
  assert.equal(rebooted.get("verify-unconfirmable").orphanUnresolved, false);
});

test("a first-run verification fences its runner at spawn and clears it on the observed exit", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  stubPreparation();
  let fencedDuringRun;
  let verifyChildProcess;
  const release = deferredValue();
  _setSpawner((file, args, options) => {
    if (file !== "node") return successfulChild();
    verifyChildProcess = spawn(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    verifyChildProcess.stdout.once("data", () => {
      // Read the fence off the INDEX while the runner is provably alive: this is
      // the only window in which a crash could orphan it, so it is the window the
      // pid has to be persisted in.
      fencedDuringRun = rawRecord(setup, created.id);
      process.kill(verifyChildProcess.pid, "SIGKILL");
    });
    once(verifyChildProcess, "exit").then(() => release.settle());
    return verifyChildProcess;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  const created = await dispatcher.dispatch({ project: "fixture", prompt: "fence the verifier" });
  await waitForState(dispatcher, created.id, ["completed", "failed"]);
  await release.promise;
  t.after(() => {
    try {
      process.kill(verifyChildProcess.pid, "SIGKILL");
    } catch {
      // Already reaped by the test itself.
    }
  });

  assert.equal(fencedDuringRun.verifyPid, verifyChildProcess.pid, "the runner was never fenced");
  if (process.platform === "linux") {
    assert.match(fencedDuringRun.verifyPidIdentity, /^linux-proc-start:/);
  }
  // The exit was OBSERVED (node reaped the child), which is confirmed death with
  // no probe involved - so the fence is gone by the time verification settles.
  const settled = rawRecord(setup, created.id);
  assert.equal(settled.verifyPid, null);
  assert.equal(settled.verifyPidIdentity, null);
  assert.equal(settled.orphanUnresolved, false);
  assert.equal(dispatcher.get(created.id).verify.state, "failed");
});

test("an explicit verification re-run fences its runner on the same pair and clears it the same way", async (t) => {
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const record = await seedRerunnable(setup);
  stubVerificationRuntime();
  let fencedDuringRun;
  let verifyChildProcess;
  _setSpawner((_file, _args, options) => {
    verifyChildProcess = spawn(
      process.execPath,
      ["-e", "console.log('ready');setInterval(()=>{},1000)"],
      { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    verifyChildProcess.stdout.once("data", () => {
      fencedDuringRun = rawRecord(setup, record.id);
      process.kill(verifyChildProcess.pid, "SIGKILL");
    });
    return verifyChildProcess;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await dispatcher.rerunVerification(record.id);
  await waitForConditionOverTime(
    () => dispatcher.get(record.id).verify.attempts?.length === 2,
    "the re-run never produced a second attempt",
  );
  t.after(() => {
    try {
      process.kill(verifyChildProcess.pid, "SIGKILL");
    } catch {
      // Already reaped by the test itself.
    }
  });

  assert.equal(fencedDuringRun.verifyPid, verifyChildProcess.pid, "the re-run runner was unfenced");
  const settled = rawRecord(setup, record.id);
  assert.equal(settled.verifyPid, null, "the observed exit did not clear the re-run fence");
  assert.equal(settled.orphanUnresolved, false);
});

test("boot restores an interrupted re-run and says its prior runner is unconfirmed", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const verifier = await spawnFixtureVerifier(t, { trapSigterm: false });
  const [record] = await seedDispatches(setup, [{
    id: "verify-rerun-crash",
    state: "verifying",
    verify: {
      state: "running",
      steps: [],
      attempt: 2,
      attempts: [{ ...FAILED_VERIFY, attempt: 1 }],
      rerun: { attempt: 2, from: "completed", previousState: "failed" },
    },
    verifyPid: verifier.root.pid,
    verifyPidIdentity: null,
  }]);
  await mkdir(record.worktreePath, { recursive: true });
  stubVerificationRuntime();
  _setSpawner(() => verifyChild());

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => dispatcher.get("verify-rerun-crash")?.orphanUnresolved === true,
    "boot never flagged the interrupted re-run's runner",
  );

  const restored = dispatcher.get("verify-rerun-crash");
  // atelier-9dt's restoration is unchanged - the record goes BACK to `completed`
  // rather than being failed - but the attempt now says WHY it cannot be trusted
  // to have finished, and there is exactly one conclusion for it.
  assert.equal(restored.state, "completed");
  assert.equal(restored.verify.state, "failed");
  assert.equal(
    restored.verify.detail,
    "interrupted by a Atelier restart; prior verification runner unconfirmed",
  );
  assert.equal(restored.verify.attempts.length, 2);
  assert.equal(restored.verify.attempts.at(-1).attempt, 2);
  assert.equal(restored.verify.rerun, undefined);
});

test("kaz: an uncorroborated post-merge verifier is retained and surfaced, never silently cleared", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const verifier = await spawnFixtureVerifier(t, { trapSigterm: false });
  const commit = "5555555555555555555555555555555555555555";
  const seeded = await seedDispatch(setup, {
    merged: { commit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
    postMerge: {
      state: "running",
      commit,
      mergeCommit: commit,
      // The branch the old recovery deleted unconditionally: a LIVE pid with no
      // persisted identity. It killed nothing (no identity to match), then wiped
      // the only evidence that a suite was still running on main.
      pid: verifier.root.pid,
      steps: [],
      startedAt: "2026-07-30T09:01:00.000Z",
    },
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => rawRecord(setup, seeded.id).postMerge.state === "failed",
    "boot never concluded the interrupted post-merge verification",
  );

  const persisted = rawRecord(setup, seeded.id);
  assert.equal(persisted.postMerge.pid, verifier.root.pid, "the fence was cleared without proof");
  assert.match(persisted.postMerge.error, /could not be confirmed dead/);
  assert.ok(
    persisted.warnings.some((warning) =>
      warning.startsWith("unresolved orphaned worker:") &&
      /post-merge verification runner/.test(warning)),
    `the unproven post-merge verifier was not surfaced: ${JSON.stringify(persisted.warnings)}`,
  );
  // Never signal a pid there is no identity for.
  assert.equal(verifier.root.exitCode, null);
  assert.equal(verifier.root.signalCode, null);
  // ...and it holds no ticket: a post-merge verifier runs in a throwaway worktree
  // against a commit already on main, for a record whose ticket merge() closed.
  assert.equal(persisted.orphanUnresolved, false);
  assert.equal(dispatcher.get(seeded.id).orphanUnresolved, false);

  // Still resolvable the two ordinary ways: dismissal, or a later boot that can
  // finally prove death.
  process.kill(verifier.root.pid, "SIGKILL");
  await verifier.exitPromise;
  const rebooted = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => rawRecord(setup, seeded.id).postMerge.pid === undefined,
    "a later boot never cleared the fence it could finally prove dead",
  );
  assert.ok(
    rebooted.get(seeded.id).warnings.every((warning) =>
      !warning.startsWith("unresolved orphaned worker:")),
    "the warning outlived the proof of death",
  );
});

test("a post-merge verification clears its own fence on the observed exit", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const seeded = await seedDispatch(setup);
  const commit = "6666666666666666666666666666666666666666";
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${commit}\n`;
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD") return `${commit}\n`;
    return "";
  });
  let fencedDuringRun;
  let runner;
  _setSpawner((_file, _args, options) => {
    // Long-lived and self-announcing, so the fence can be read off the index
    // while the runner is provably alive - the pid has to be persisted DURING the
    // run, not merely mentioned on its way out.
    runner = spawn(
      process.execPath,
      ["-e", "console.log('ready');setTimeout(()=>process.exit(0),60)"],
      { ...options, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
    );
    runner.stdout.once("data", () => {
      fencedDuringRun = rawRecord(setup, seeded.id);
    });
    return runner;
  });

  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await dispatcher.merge(seeded.id);
  await waitForConditionOverTime(
    () => ["passed", "failed"].includes(rawRecord(setup, seeded.id).postMerge?.state),
    "post-merge verification never settled",
  );
  t.after(() => {
    try {
      process.kill(runner.pid, "SIGKILL");
    } catch {
      // Already reaped by the test itself.
    }
  });

  assert.equal(
    fencedDuringRun.postMerge.pid,
    runner.pid,
    "the post-merge runner was never fenced at spawn",
  );
  if (process.platform === "linux") {
    assert.match(fencedDuringRun.postMerge.pidIdentity, /^linux-proc-start:/);
  }
  const persisted = rawRecord(setup, seeded.id);
  assert.equal(persisted.postMerge.state, "passed");
  assert.equal(persisted.postMerge.pid, undefined, "the observed exit did not clear the fence");
  assert.equal(persisted.postMerge.pidIdentity, undefined);
  assert.equal(persisted.orphanUnresolved, false);
});

test("observer boot never signals, re-fences or concludes anything for a verify or post-merge runner", async (t) => {
  if (process.platform !== "linux") {
    t.skip("verifier PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const verifyRunner = await spawnFixtureVerifier(t);
  const postMergeRunner = await spawnFixtureVerifier(t);
  const commit = "4444444444444444444444444444444444444444";
  await seedIndex(setup, [
    verifyFencedRecord(setup, {
      id: "observer-verify-fenced",
      verifyPid: verifyRunner.root.pid,
      verifyPidIdentity: processStartIdentity(verifyRunner.root.pid),
    }),
    fencedRecord(setup, {
      id: "observer-post-merge-fenced",
      state: "completed",
      endedAt: "2026-07-30T08:05:00.000Z",
      merged: { commit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
      postMerge: {
        state: "running",
        commit,
        mergeCommit: commit,
        pid: postMergeRunner.root.pid,
        pidIdentity: processStartIdentity(postMergeRunner.root.pid),
        steps: [],
        startedAt: "2026-07-30T09:01:00.000Z",
      },
    }),
  ]);
  _setRunFile(async () => "");

  const observer = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    observer: true,
    postMergeShutdownGraceMs: 100,
  });
  // A setImmediate drain is NOT enough here and asserting on one is a false
  // negative: the reap's escalation runs on the wall clock (SIGTERM, then SIGKILL
  // at graceMs - 50, then the re-probe at graceMs), so 100 microtask turns finish
  // long before an unguarded boot could have signalled anything, and the test
  // would pass with the observer gate deleted. Wait several times the whole reap
  // window instead - and then PROVE the window was long enough by letting a real
  // dispatcher do the reap below.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));
  await settleAsyncWork();

  for (const runner of [verifyRunner, postMergeRunner]) {
    assert.equal(runner.root.exitCode, null, "an observer boot signalled a runner");
    assert.equal(runner.root.signalCode, null);
  }
  const verifyFenced = rawRecord(setup, "observer-verify-fenced");
  assert.equal(verifyFenced.verifyPid, verifyRunner.root.pid);
  assert.equal(verifyFenced.verify.state, "running", "an observer concluded the attempt");
  assert.equal(verifyFenced.state, "verifying");
  assert.equal(verifyFenced.orphanUnresolved, undefined);
  const postMergeFenced = rawRecord(setup, "observer-post-merge-fenced");
  assert.equal(postMergeFenced.postMerge.pid, postMergeRunner.root.pid);
  assert.equal(postMergeFenced.postMerge.state, "running", "an observer failed main health closed");
  assert.equal(observer.get("observer-post-merge-fenced").postMerge.state, "running");

  // The control that gives the silence above its meaning: the same state
  // directory, the same fixtures, the same record shapes - only the flag differs -
  // and a real boot reaps both runners and concludes both records. Without this,
  // "nothing happened" could equally mean "nothing was ever going to happen".
  createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 400,
  });
  await withDeadline(
    Promise.all([verifyRunner.exitPromise, postMergeRunner.exitPromise]),
    "a real boot did not reap the runners an observer boot left alone",
  );
  await waitForConditionOverTime(
    () =>
      rawRecord(setup, "observer-verify-fenced").verifyPid === null &&
      rawRecord(setup, "observer-post-merge-fenced").postMerge.state === "failed",
    "a real boot did not conclude the records an observer boot left alone",
  );
});

test("a record with no verifier fencing fields behaves exactly as it did before the fence existed", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const commit = "3333333333333333333333333333333333333333";
  const seeded = await seedDispatch(setup, {
    merged: { commit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
    // The pre-atelier-yqk shape: an interrupted post-merge run with no pid recorded
    // at all, and a record with no verifyPid key.
    postMerge: {
      state: "running",
      commit,
      mergeCommit: commit,
      steps: [],
      startedAt: "2026-07-30T09:01:00.000Z",
    },
  });
  _setRunFile(async () => "");

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 150,
  });
  await waitForConditionOverTime(
    () => rawRecord(setup, seeded.id).postMerge.state === "failed",
    "boot never concluded the fence-less post-merge verification",
  );

  const persisted = rawRecord(setup, seeded.id);
  assert.equal(
    persisted.postMerge.error,
    "server restart interrupted post-merge verification; main health is unknown",
  );
  assert.equal(persisted.orphanUnresolved, false);
  assert.deepEqual(
    persisted.warnings.filter((warning) => warning.startsWith("unresolved orphaned worker:")),
    [],
  );
  assert.equal(persisted.verifyPid, null);
  assert.equal(dispatcher.get(seeded.id).postMerge.state, "failed");
});

test("stopping a verifying dispatch reaps its runner to a verdict instead of flagging an orphan", async (t) => {
  const setup = await fixture(t, { tracker: "committed", verifyCommands: ["node --test"] });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  _setBrResolver(() => "/fixture/br");
  const calls = [];
  _setRunFile(withDispatchChanges(async (file, args) => {
    calls.push({ file, args });
    if (file === "/fixture/br") return "";
    if (args[2] === "worktree" && args[3] === "add") {
      await mkdir(args[4] === "--detach" ? args[5] : args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      await rm(args[4], { recursive: true, force: true });
      return "";
    }
    if (["status", "log", "add", "commit"].includes(args[2])) return "";
    if (args[2] === "rev-parse" && args[3] === "HEAD") {
      return "1111111111111111111111111111111111111111\n";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD^{tree}") return `${FIXTURE_RESULT_TREE}\n`;
    if (args[2] === "rev-parse") return "2222222222222222222222222222222222222222\n";
    if (args[2] === "rev-list") return "0\n";
    return "";
  }));
  let runner;
  const started = deferredValue();
  _setSpawner((file, args, options) => {
    if (file === "claude") return successfulChild();
    // Traps SIGTERM, so only an AWAITED escalation can end it. A fire-and-forget
    // kill would leave the fence up while the claim release ran, which is exactly
    // the regression the fence would otherwise have introduced here.
    runner = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    runner.stdout.once("data", () => started.settle());
    return runner;
  });

  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 400,
  });
  const created = await dispatcher.dispatch({
    project: "fixture",
    ticketId: "fixture-stop",
    prompt: "stop me mid-verification",
  });
  await withDeadline(started.promise, "verification never spawned its runner");
  t.after(() => {
    try {
      process.kill(-runner.pid, "SIGKILL");
    } catch {
      // Already reaped by the stop under test.
    }
  });
  assert.equal(dispatcher.get(created.id).state, "verifying");
  assert.equal(rawRecord(setup, created.id).verifyPid, runner.pid);

  const stopped = await dispatcher.stop(created.id);

  assert.equal(stopped.state, "stopped");
  assert.notEqual(runner.signalCode, null, "the runner survived the stop");
  assert.equal(stopped.orphanUnresolved, false, "an ordinary stop flagged an orphan");
  const persisted = rawRecord(setup, created.id);
  assert.equal(persisted.verifyPid, null);
  assert.equal(persisted.verifyPidIdentity, null);
  assert.deepEqual(
    persisted.warnings.filter((warning) => warning.startsWith("unresolved orphaned worker:")),
    [],
  );
  assert.equal(persisted.verify.state, "failed");
  assert.equal(persisted.verify.detail, "stopped by user");
  const detachedAdd = calls.find(({ args }) => args[2] === "worktree" && args[4] === "--detach");
  const detachedRemove = calls.find(({ args }) => args[2] === "worktree" && args[3] === "remove");
  assert.equal(
    detachedRemove?.args[4],
    detachedAdd?.args[5],
    "stopped verification left its detached worktree registered",
  );
  assert.equal(
    existsSync(detachedAdd.args[5]),
    false,
    "stopped verification left its detached worktree directory",
  );
  assert.equal(claimReleased(calls, "fixture-stop"), true, "the stop did not hand the ticket back");
});

test("fenced reap cancels SIGKILL after an identity swap and still escalates a stable runner", async (t) => {
  if (process.platform !== "linux") {
    t.skip("verifier PID identity fencing uses Linux /proc");
    return;
  }
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const recycled = await spawnFixtureVerifier(t);
  const stable = await spawnFixtureVerifier(t);
  const recycledIdentity = processStartIdentity(recycled.root.pid);
  const stableIdentity = processStartIdentity(stable.root.pid);
  await seedIndex(setup, [
    verifyFencedRecord(setup, {
      id: "verify-recycled-mid-grace",
      verifyPid: recycled.root.pid,
      verifyPidIdentity: recycledIdentity,
    }),
    verifyFencedRecord(setup, {
      id: "verify-stable-mid-grace",
      verifyPid: stable.root.pid,
      verifyPidIdentity: stableIdentity,
    }),
  ]);
  let swapped = false;
  const signals = [];
  _setProcessProbe((pid) => {
    const probed = probeFixtureProcess(pid);
    if (pid === recycled.root.pid && swapped && probed.exists && !probed.zombie) {
      return {
        ...probed,
        identity: "linux-proc-start:00000000-0000-0000-0000-000000000000:999",
      };
    }
    return probed;
  });
  _setFencedProcessSignal((target, signal) => {
    const pid = Math.abs(target);
    signals.push({ pid, signal });
    process.kill(target, signal);
    if (pid === recycled.root.pid && signal === "SIGTERM") {
      setTimeout(() => {
        swapped = true;
      }, 10);
    }
  });
  _setRunFile(async () => "");

  createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 100,
  });

  await withDeadline(stable.exitPromise, "the stable verifier never received the escalation");
  await waitForConditionOverTime(
    () =>
      rawRecord(setup, "verify-recycled-mid-grace").verifyPid === null &&
      rawRecord(setup, "verify-stable-mid-grace").verifyPid === null,
    "boot did not settle both verifier fences",
  );
  assert.deepEqual(
    signals.filter(({ pid }) => pid === recycled.root.pid).map(({ signal }) => signal),
    ["SIGTERM"],
    "a recycled pid received the unblockable escalation",
  );
  assert.deepEqual(
    signals.filter(({ pid }) => pid === stable.root.pid).map(({ signal }) => signal),
    ["SIGTERM", "SIGKILL"],
    "the stable SIGTERM-immune control did not escalate",
  );
  assert.equal(recycled.root.exitCode, null, "the identity-swapped fixture was killed");
});

test("boot-held post-merge fence keeps the project single-flight closed until dismissal", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const runner = await spawnFixtureVerifier(t, { trapSigterm: false });
  const oldCommit = "1111111111111111111111111111111111111111";
  const nextCommit = "2222222222222222222222222222222222222222";
  const [incident, successor] = await seedDispatches(setup, [
    {
      id: "post-merge-boot-fence",
      merged: { commit: oldCommit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
      postMerge: {
        state: "running",
        commit: oldCommit,
        mergeCommit: oldCommit,
        pid: runner.root.pid,
        pidIdentity: null,
        steps: [],
        startedAt: "2026-07-30T09:01:00.000Z",
      },
    },
    {
      id: "post-merge-successor",
      branch: "atelier/post-merge-successor",
    },
  ]);
  let postMergeWorktree;
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${nextCommit}\n`;
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      postMergeWorktree = args[5];
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD" && args[1] === postMergeWorktree) {
      return `${nextCommit}\n`;
    }
    return "";
  });
  const spawns = [];
  _setSpawner((file) => {
    spawns.push(file);
    return verifyChild();
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 100,
  });
  await waitForConditionOverTime(
    () => rawRecord(setup, incident.id).postMerge.state === "failed",
    "boot did not fail the interrupted post-merge incident closed",
  );

  const merged = await dispatcher.merge(successor.id);
  assert.equal(merged.postMerge.state, "queued");
  await settleAsyncWork();
  assert.deepEqual(spawns, [], "a second project verifier spawned beside the retained fence");

  await dispatcher.dismiss(incident.id);
  await waitForConditionOverTime(
    () => spawns.length === 1,
    "dismissing the fenced incident did not release the project barrier",
  );
  await waitForConditionOverTime(
    () => dispatcher.get(successor.id).postMerge.state === "passed",
    "the queued successor verifier did not settle after the fence cleared",
  );
});

test("a passing post-merge verifier does not resolve an incident that still retains its fence", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const oldCommit = "3333333333333333333333333333333333333333";
  const passingCommit = "4444444444444444444444444444444444444444";
  const [incident, passing] = await seedDispatches(setup, [
    {
      id: "post-merge-fenced-incident",
      merged: { commit: oldCommit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
      postMerge: {
        state: "failed",
        commit: oldCommit,
        mergeCommit: oldCommit,
        endedAt: "2026-07-30T09:02:00.000Z",
        evidenceTail: "older failure",
        steps: [],
      },
    },
    {
      id: "post-merge-passing-later",
      branch: "atelier/post-merge-passing-later",
    },
  ]);
  let postMergeWorktree;
  let finishPassing;
  _setRunFile(async (_file, args) => {
    if (args[2] === "rev-parse" && args[3] === "main") return `${passingCommit}\n`;
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      postMergeWorktree = args[5];
      await mkdir(args[5], { recursive: true });
      return "";
    }
    if (args[2] === "rev-parse" && args[3] === "HEAD" && args[1] === postMergeWorktree) {
      return `${passingCommit}\n`;
    }
    return "";
  });
  _setSpawner(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    finishPassing = () => {
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0, null);
    };
    return child;
  });
  const dispatcher = createDispatcher({ registry: setup.registry, stateDir: setup.state });
  await dispatcher.merge(passing.id);
  await waitForCondition(() => Boolean(finishPassing), "the later verifier never started");

  const retained = {
    ...incident,
    postMerge: {
      ...incident.postMerge,
      pid: 2_147_483_640,
      pidIdentity: null,
    },
  };
  await writeFile(
    join(setup.state, "dispatches", "index.jsonl"),
    `${JSON.stringify(retained)}\n`,
    { flag: "a" },
  );
  assert.equal(dispatcher.get(incident.id).postMerge.pid, undefined);
  // get() serves an exposed copy; the retained pid is asserted through the
  // persistence path after mergePersistedEntries has refreshed the inert entry.
  assert.equal(rawRecord(setup, incident.id).postMerge.pid, 2_147_483_640);

  finishPassing();
  await waitForConditionOverTime(
    () => dispatcher.get(passing.id).postMerge.state === "passed",
    "the later verifier did not pass",
  );
  assert.equal(
    rawRecord(setup, incident.id).postMerge.resolvedAt,
    undefined,
    "a passing verifier resolved an incident whose runner is still unconfirmed",
  );
});

test("gc retains a failed post-merge worktree while its runner is unconfirmed, then removes it after proof of death", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const runner = await spawnFixtureVerifier(t, { trapSigterm: false });
  const commit = "5555555555555555555555555555555555555555";
  const worktreePath = join(
    setup.state,
    "post-merge-worktrees",
    "fixture",
    "retained-unconfirmed",
  );
  await mkdir(worktreePath, { recursive: true });
  const [incident] = await seedDispatches(setup, [{
    id: "gc-retained-post-merge",
    merged: { commit, mergedAt: "2026-07-30T09:00:00.000Z", strategy: "ff" },
    postMerge: {
      state: "failed",
      commit,
      mergeCommit: commit,
      pid: runner.root.pid,
      pidIdentity: null,
      worktreePath,
      endedAt: "2026-07-30T09:02:00.000Z",
      steps: [],
    },
  }]);
  _setRunFile(async () => "");
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 100,
    sweepCodexProcessesAtBoot: false,
  });

  const retained = await dispatcher.gc({
    olderThanDays: 0,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  assert.equal(existsSync(worktreePath), true, "gc removed a worktree under a live runner");
  assert.ok(
    retained.warnings.some((warning) =>
      warning.includes(`dispatch ${incident.id}: worktree retained: unconfirmed runner`) &&
      warning.includes(worktreePath)),
    `gc did not report the retained worktree: ${JSON.stringify(retained.warnings)}`,
  );

  process.kill(-runner.root.pid, "SIGKILL");
  await runner.exitPromise;
  const rebooted = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 100,
    sweepCodexProcessesAtBoot: false,
  });
  const collected = await rebooted.gc({
    olderThanDays: 0,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  assert.equal(rawRecord(setup, incident.id).postMerge.pid, undefined);
  assert.equal(existsSync(worktreePath), false, "gc kept the worktree after boot proved death");
  assert.ok(collected.orphans.includes(worktreePath), "gc did not name the removed worktree");
});

test("gc refreshes fenced paths created while git worktree listing is awaited", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  const listStarted = deferredValue();
  const releaseList = deferredValue();
  _setRunFile(async (_file, args) => {
    if (args[2] === "worktree" && args[3] === "list") {
      listStarted.settle();
      await releaseList.promise;
    }
    return "";
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });

  const collectedPromise = dispatcher.gc({
    olderThanDays: 0,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });
  await listStarted.promise;

  const worktreePath = join(
    setup.state,
    "post-merge-worktrees",
    "fixture",
    "created-during-git-list",
  );
  await mkdir(worktreePath, { recursive: true });
  const incident = await seedDispatch(setup, {
    id: "gc-fence-created-during-list",
    merged: {
      commit: "6666666666666666666666666666666666666666",
      mergedAt: "2026-07-30T09:00:00.000Z",
      strategy: "ff",
    },
    postMerge: {
      state: "failed",
      commit: "6666666666666666666666666666666666666666",
      mergeCommit: "6666666666666666666666666666666666666666",
      pid: 2_147_483_640,
      pidIdentity: null,
      worktreePath,
      endedAt: "2026-07-30T09:02:00.000Z",
      steps: [],
    },
  });
  releaseList.settle();

  const collected = await collectedPromise;
  assert.equal(
    existsSync(worktreePath),
    true,
    "gc removed the fenced worktree created during its awaited git listing",
  );
  assert.deepEqual(collected.orphans, []);
  assert.ok(
    collected.warnings.some((warning) =>
      warning.includes(`dispatch ${incident.id}: worktree retained: unconfirmed runner`) &&
      warning.includes(worktreePath)),
    `gc did not report the late retained worktree: ${JSON.stringify(collected.warnings)}`,
  );
});

test("gc preserves an in-flight verification checkout until its run cleans up", async (t) => {
  const setup = await fixture(t, { verifyCommands: ["node --test"] });
  _setProbe(async () => ({ git: { dirtyCount: 0, branch: "main" } }));
  let verificationWorktree;
  const calls = [];
  _setRunFile(withDispatchChanges(async (file, args) => {
    calls.push({ file, args });
    if (["update", "ready", "sync"].includes(args[0])) return "";
    assert.equal(file, "git");
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "-b") {
      await mkdir(args[6], { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "add" && args[4] === "--detach") {
      verificationWorktree = args[5];
      await mkdir(verificationWorktree, { recursive: true });
      return "";
    }
    if (args[2] === "worktree" && args[3] === "list") {
      return `worktree ${setup.primary}\n\nworktree ${verificationWorktree}\n`;
    }
    if (args[2] === "worktree" && args[3] === "remove") {
      await rm(args[4], { recursive: true, force: true });
      return "";
    }
    if (["status", "log"].includes(args[2])) return "";
    if (args[2] === "rev-parse") {
      return `${args[3] === "HEAD^{tree}" ? FIXTURE_RESULT_TREE : FIXTURE_BASE_COMMIT}\n`;
    }
    if (args[2] === "rev-list") return "0\n";
    throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
  }));
  const verifier = heldChild();
  const verifierStarted = deferredValue();
  _setSpawner((command) => {
    if (command === "claude") return successfulChild();
    verifierStarted.settle();
    return verifier;
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    sweepCodexProcessesAtBoot: false,
  });
  const created = await dispatcher.dispatch({ project: "fixture", prompt: "hold verification" });
  t.after(async () => {
    if (dispatcher.get(created.id)?.state === "verifying") {
      verifier.complete();
      await waitForState(dispatcher, created.id, ["completed"]);
    }
  });
  await waitForCondition(
    () => (
      typeof verificationWorktree === "string" &&
      dispatcher.get(created.id)?.verify?.worktreePath === verificationWorktree
    ),
    "verification checkout path was not persisted before the runner started",
  );
  await verifierStarted.promise;

  const liveRecord = rawRecord(setup, created.id);
  assert.equal(liveRecord.verify.state, "running");
  assert.equal(liveRecord.verify.worktreePath, verificationWorktree);
  assert.equal(existsSync(verificationWorktree), true);

  const collected = await dispatcher.gc({
    olderThanDays: 0,
    now: new Date("2026-08-30T12:00:00.000Z"),
  });

  assert.equal(existsSync(verificationWorktree), true, "gc removed the active verify checkout");
  assert.equal(collected.orphans.includes(verificationWorktree), false);
  assert.equal(
    calls.some(({ args }) =>
      args[2] === "worktree" && args[3] === "remove" && args[4] === verificationWorktree),
    false,
    "gc issued a removal for the active verify checkout",
  );

  verifier.complete();
  const completed = await waitForState(dispatcher, created.id, ["completed"]);
  assert.equal(completed.verify.state, "passed");
  assert.equal(completed.verify.worktreePath, undefined);
  assert.equal(rawRecord(setup, created.id).verify.worktreePath, undefined);
  assert.equal(existsSync(verificationWorktree), false, "verification cleanup left its checkout");
});

test("stop preempts a SIGTERM-immune verification re-run and a later re-run is accepted", async (t) => {
  if (process.platform !== "linux") {
    t.skip("verifier process-group escalation uses Linux /proc identity");
    return;
  }
  const setup = await fixture(t, { tracker: "none", verifyCommands: ["node --test"] });
  const record = await seedRerunnable(setup, { id: "rerun-stop-preempts" });
  stubVerificationRuntime();
  const started = deferredValue();
  let runner;
  let spawnCount = 0;
  _setSpawner((_file, _args, options) => {
    spawnCount += 1;
    if (spawnCount > 1) return verifyChild();
    runner = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      { ...options, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    runner.stdout.once("data", () => started.settle());
    return runner;
  });
  const dispatcher = createDispatcher({
    registry: setup.registry,
    stateDir: setup.state,
    postMergeShutdownGraceMs: 200,
  });

  await dispatcher.rerunVerification(record.id);
  await withDeadline(started.promise, "the wedged re-run never started");
  assert.equal(dispatcher.get(record.id).state, "verifying");
  const runnerExit = once(runner, "exit");
  t.after(() => {
    try {
      process.kill(-runner.pid, "SIGKILL");
    } catch {
      // Already reaped by stop().
    }
  });

  const startedStop = Date.now();
  const stopped = await dispatcher.stop(record.id);
  const elapsedMs = Date.now() - startedStop;
  await runnerExit;

  assert.ok(elapsedMs < 1_000, `stop exceeded the escalation budget: ${elapsedMs}ms`);
  assert.equal(stopped.state, "completed");
  assert.equal(stopped.verify.state, "failed");
  assert.equal(stopped.verify.detail, "interrupted by stop");
  assert.equal(stopped.verify.attempts.length, 2);
  assert.equal(stopped.verify.attempts.at(-1).detail, "interrupted by stop");
  assert.equal(stopped.verify.rerun, undefined);
  assert.notEqual(runner.signalCode, null, "the interrupted runner was not proven dead");
  assert.equal(rawRecord(setup, record.id).verifyPid, null);

  const admitted = await dispatcher.rerunVerification(record.id);
  assert.equal(admitted.state, "verifying");
  await waitForConditionOverTime(
    () => dispatcher.get(record.id).verify.state === "passed",
    "the post-stop re-run was not accepted",
  );
});
