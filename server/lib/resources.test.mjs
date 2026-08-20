import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResourceProjector,
  RESOURCE_CACHE_MS,
  RESOURCE_COST_MODEL,
  RESOURCE_SCAN_CAP,
  WORKTREE_ROOTS,
} from "./resources.mjs";

async function resourceRoot(t, slug) {
  const root = await mkdtemp(join(tmpdir(), `atelier-resources-${slug}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function sizedFile(path, size, byte = "x") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, byte.repeat(size));
}

// /proc/<pid>/stat, with the ppid in the same field used by Linux and the
// production process walker. The command may contain spaces and parentheses.
function statLine(pid, { command = "node", ppid = 1 }) {
  const trailing = Array.from({ length: 30 }, (_unused, index) => String(index));
  trailing[0] = "S";
  trailing[1] = String(ppid);
  return `${pid} (${command}) ${trailing.join(" ")}`;
}

function procOps(processes, { platform = "linux" } = {}) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  return {
    platform,
    existsSync: () => true,
    readdirSync(path) {
      assert.equal(path, "/proc");
      return [...byPid.keys()].map(String).concat(["self", "cpuinfo"]);
    },
    readFileSync(path) {
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (!match) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const entry = byPid.get(Number(match[1]));
      if (!entry || entry.statUnreadable) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return statLine(entry.pid, entry);
    },
    readlinkSync(path) {
      const match = /^\/proc\/(\d+)\/cwd$/.exec(path);
      const entry = match ? byPid.get(Number(match[1])) : undefined;
      if (!entry || entry.cwd === undefined) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return entry.cwd;
    },
  };
}

test("exact fixtures project every Tier-1 and Tier-2 byte total", async (t) => {
  const root = await resourceRoot(t, "exact");
  await sizedFile(join(root, "logs", "events.jsonl"), 3);
  await sizedFile(join(root, "logs", "events.1.jsonl"), 5);
  await sizedFile(join(root, "dispatches", "index.jsonl"), 7);
  await sizedFile(join(root, "dispatches", "alpha.jsonl"), 11);
  await sizedFile(join(root, "dispatches", "beta.jsonl"), 13);
  await sizedFile(join(root, "dispatches", "alpha.codex-prompt.md"), 17);

  const jobId = "a".repeat(24);
  await sizedFile(join(root, "codex-app-server", "jobs", `${jobId}.json`), 19);
  await sizedFile(join(root, "codex-app-server", "jobs", `${jobId}.stream.jsonl`), 23);
  await sizedFile(join(root, "codex-app-server", "jobs", `${jobId}.attach.json`), 29);
  await sizedFile(join(root, "break-glass", "token.json"), 31);
  await sizedFile(join(root, "codex-companion", "jobs", "legacy.json"), 37);
  await sizedFile(join(root, "codex-companion", "logs", "legacy.jsonl"), 41);

  for (const path of [
    join(root, "worktrees", "project", "dispatch"),
    join(root, "worktrees", "project", "dispatch-two"),
    join(root, "verify-worktrees", "project", "verify"),
    join(root, "merge-worktrees", "merge"),
  ]) {
    await mkdir(path, { recursive: true });
  }

  const runner = {};
  const records = [
    {
      record: {
        worktreePath: join(root, "worktrees", "project", "dispatch"),
        verify: { worktreePath: join(root, "verify-worktrees", "project", "verify") },
      },
      child: runner,
    },
    {
      worktreePath: join(root, "worktrees", "project", "dispatch-two"),
      postMerge: { worktreePath: join(root, "post-merge-worktrees", "project", "post") },
      child: runner,
      postMergeChild: {},
    },
    {
      worktreePath: join(root, "worktrees", "project", "historical"),
      merged: { commit: "abc123" },
    },
  ];
  const processes = procOps([
    { pid: 10, ppid: 1, cwd: join(root, "worktrees", "project", "dispatch") },
    { pid: 11, ppid: 10, cwd: "/tmp" },
    { pid: 12, ppid: 1, cwd: "/tmp" },
  ]);
  const projection = createResourceProjector({
    stateDir: root,
    processOps: processes,
    now: () => new Date("2026-08-20T10:00:00.000Z"),
  }).measure({ records });

  assert.equal(projection.logs.eventLog.value, 8);
  assert.equal(projection.logs.dispatchIndex.value, 7);
  assert.equal(projection.logs.transcripts.value, 24);
  assert.equal(projection.logs.prompts.value, 17);
  assert.equal(projection.logs.codexJobs.value, 42, "attachment leases are not job/stream logs");
  assert.equal(projection.logs.breakGlass.value, 31);
  assert.equal(projection.logs.legacyCompanion.value, 78);
  assert.equal(projection.worktrees.recordBackedCount.value, 4);
  assert.equal(projection.worktrees.onDiskCount.value, 4);
  assert.deepEqual(projection.worktrees.byRoot, [
    { root: "worktrees", count: 2, truncated: false },
    { root: "verify-worktrees", count: 1, truncated: false },
    { root: "post-merge-worktrees", count: 0, truncated: false },
    { root: "merge-worktrees", count: 1, truncated: false },
  ]);
  assert.equal(projection.processes.relevantCount.value, 2);
  assert.equal(projection.processes.directRunners.value, 2);
  assert.match(projection.worktrees.recordBackedCount.detail, /record-backed.*orphan/i);
  assert.match(projection.processes.directRunners.detail, /in-memory.*distinct.*\/proc/i);
});

test("worktree counting stops at the advertised per-root read cap", async (t) => {
  const root = await resourceRoot(t, "cap");
  const mergeRoot = join(root, "merge-worktrees");
  await mkdir(mergeRoot, { recursive: true });
  await Promise.all(
    Array.from({ length: RESOURCE_SCAN_CAP + 25 }, (_unused, index) =>
      mkdir(join(mergeRoot, `worktree-${String(index).padStart(3, "0")}`))),
  );

  let mergeReads = 0;
  const fileOps = {
    ...fs,
    opendirSync(path, options) {
      const directory = fs.opendirSync(path, options);
      if (path !== mergeRoot) return directory;
      return {
        readSync() {
          mergeReads += 1;
          return directory.readSync();
        },
        closeSync: () => directory.closeSync(),
      };
    },
  };
  const projection = createResourceProjector({
    stateDir: root,
    fileOps,
    processOps: procOps([]),
  }).measure();

  const merge = projection.worktrees.byRoot.find(({ root: name }) => name === "merge-worktrees");
  assert.deepEqual(merge, { root: "merge-worktrees", count: RESOURCE_SCAN_CAP, truncated: true });
  assert.equal(projection.worktrees.onDiskCount.truncated, true);
  assert.equal(mergeReads, RESOURCE_SCAN_CAP, "the truncation check must not read entry 501");
});

test("Tier-1 refreshes every call while Tier-2 keeps its measurement time until expiry", async (t) => {
  const root = await resourceRoot(t, "freshness");
  const eventPath = join(root, "logs", "events.jsonl");
  const transcriptPath = join(root, "dispatches", "one.jsonl");
  await sizedFile(eventPath, 2);
  await sizedFile(transcriptPath, 3);
  let clock = Date.parse("2026-08-20T10:00:00.000Z");
  const projector = createResourceProjector({
    stateDir: root,
    processOps: procOps([]),
    now: () => new Date(clock),
  });

  const first = projector.measure();
  await sizedFile(eventPath, 5);
  await sizedFile(transcriptPath, 7);
  clock += 1_000;
  const cached = projector.measure();
  assert.equal(cached.logs.eventLog.value, 5);
  assert.notEqual(cached.logs.eventLog.measuredAt, first.logs.eventLog.measuredAt);
  assert.equal(cached.logs.transcripts.value, 3);
  assert.equal(cached.logs.transcripts.measuredAt, first.logs.transcripts.measuredAt);
  assert.equal(cached.logs.transcripts.ageMs, 1_000);

  clock += RESOURCE_CACHE_MS - 1_000;
  const refreshed = projector.measure();
  assert.equal(refreshed.logs.transcripts.value, 7);
  assert.notEqual(refreshed.logs.transcripts.measuredAt, first.logs.transcripts.measuredAt);
  assert.equal(refreshed.logs.transcripts.ageMs, 0);
});

test("recursive worktree and evidence bytes run only on explicit deep requests", async (t) => {
  const root = await resourceRoot(t, "deep");
  const worktree = join(root, "worktrees", "project", "dispatch");
  const merge = join(root, "merge-worktrees", "merge");
  const evidence = join(root, "evidence", "objects", "sha256", "aa");
  await sizedFile(join(worktree, "nested", "a.bin"), 43);
  await sizedFile(join(merge, "b.bin"), 47);
  await sizedFile(join(evidence, "object"), 53);

  const deepPaths = [worktree, join(worktree, "nested"), merge, join(root, "evidence")];
  let deepReads = 0;
  const fileOps = {
    ...fs,
    opendirSync(path, options) {
      if (deepPaths.includes(path) || path.startsWith(`${join(root, "evidence")}/`)) deepReads += 1;
      return fs.opendirSync(path, options);
    },
  };
  const projector = createResourceProjector({ stateDir: root, fileOps, processOps: procOps([]) });
  const routine = projector.measure({ deep: false });
  assert.equal(deepReads, 0);
  assert.equal(routine.worktrees.deepBytes, null);
  assert.equal(routine.evidence.deepBytes, null);

  const explicit = projector.measure({ deep: true });
  assert.ok(deepReads > 0);
  assert.equal(explicit.worktrees.deepBytes.value, 90);
  assert.equal(explicit.evidence.deepBytes.value, 53);
  assert.match(explicit.worktrees.deepBytes.detail, /exact.*no sampled.*extrapolated/i);

  const retained = projector.measure({ deep: false });
  assert.equal(retained.worktrees.deepBytes.value, 90);
  assert.equal(retained.worktrees.deepBytes.measuredAt, explicit.worktrees.deepBytes.measuredAt);
});

test("non-Linux process measurement is unsupported rather than zero", async (t) => {
  const root = await resourceRoot(t, "non-linux");
  const projection = createResourceProjector({
    stateDir: root,
    processOps: procOps([], { platform: "darwin" }),
  }).measure();

  assert.equal(projection.platform.linux, false);
  assert.equal(projection.processes.relevantCount.value, null);
  assert.equal(projection.processes.relevantCount.supported, false);
  assert.equal(projection.processes.relevantCount.detail, "requires /proc");
});

test("missing paths mean zero, while unreadable paths remain explicit unknowns", async (t) => {
  const root = await resourceRoot(t, "unknown");
  const missing = createResourceProjector({ stateDir: root, processOps: procOps([]) }).measure();
  assert.equal(missing.logs.eventLog.value, 0);
  assert.equal(missing.logs.dispatchIndex.value, 0);
  assert.equal(missing.logs.transcripts.value, 0);
  assert.equal(missing.worktrees.onDiskCount.value, 0);
  assert.equal(missing.logs.eventLog.supported, true);

  const logs = join(root, "logs");
  await mkdir(logs);
  const denied = Object.assign(new Error("fixture denied"), { code: "EACCES" });
  const unreadable = createResourceProjector({
    stateDir: root,
    fileOps: {
      ...fs,
      lstatSync(path, options) {
        if (path === join(logs, "events.jsonl")) throw denied;
        return fs.lstatSync(path, options);
      },
    },
    processOps: procOps([]),
  }).measure();
  assert.equal(unreadable.logs.eventLog.value, null);
  assert.equal(unreadable.logs.eventLog.supported, true);
  assert.match(unreadable.logs.eventLog.detail, /fixture denied/);
});

test("the frozen cost model covers every projected measurement exactly once", async (t) => {
  const root = await resourceRoot(t, "cost-model");
  const projection = createResourceProjector({ stateDir: root, processOps: procOps([]) }).measure();
  const projectedKeys = new Set([
    ...Object.keys(projection.logs).map((key) => `logs.${key}`),
    "worktrees.recordBackedCount",
    "worktrees.onDiskCount",
    "worktrees.deepBytes",
    ...Object.keys(projection.processes).map((key) => `processes.${key}`),
    "evidence.deepBytes",
  ]);
  const costKeys = new Set(RESOURCE_COST_MODEL.map(({ key }) => key));

  assert.deepEqual(costKeys, projectedKeys);
  assert.equal(costKeys.size, RESOURCE_COST_MODEL.length);
  assert.equal(Object.isFrozen(RESOURCE_COST_MODEL), true);
  assert.equal(RESOURCE_COST_MODEL.every(Object.isFrozen), true);
  assert.equal(Object.isFrozen(WORKTREE_ROOTS), true);
});
