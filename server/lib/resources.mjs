import {
  existsSync,
  lstatSync,
  opendirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import { resolve, join, sep } from "node:path";

import { stateDir as atelierStateDir } from "./paths.mjs";

export const RESOURCE_CACHE_MS = 60_000;
export const RESOURCE_SCAN_CAP = 500;
export const WORKTREE_ROOTS = Object.freeze([
  "worktrees",
  "verify-worktrees",
  "post-merge-worktrees",
  "merge-worktrees",
]);

function cost(key, tier, bound, measuredCost) {
  return Object.freeze({ key, tier, bound, measuredCost });
}

export const RESOURCE_COST_MODEL = Object.freeze([
  cost("logs.eventLog", 1, "active file plus 5 known rotations", "0.129 ms; 475,335 B"),
  cost("logs.dispatchIndex", 1, "one file", "1.278 ms; 7,436,345 B"),
  cost("logs.transcripts", 2, "unbounded dispatch file count", "1.994 ms; 232 files; 89,435,896 B"),
  cost("logs.prompts", 2, "unbounded dispatch file count", "0.959 ms; 62 files; 12,182,872 B"),
  cost("logs.codexJobs", 2, "unbounded job and stream file count", "not separately measured"),
  cost("logs.breakGlass", 2, "unbounded authorization file count", "not separately measured"),
  cost("logs.legacyCompanion", 2, "unbounded legacy-companion tree", "not separately measured"),
  cost("worktrees.recordBackedCount", 1, "cost proportional to total dispatch history", "in-memory; not separately measured"),
  cost("worktrees.onDiskCount", 1, `${RESOURCE_SCAN_CAP} directory entries per root`, "0.241 ms"),
  cost("worktrees.deepBytes", 3, "unbounded recursive worktree content", "2.364 ms for a 30 MiB checkout"),
  cost("processes.relevantCount", 2, "unbounded /proc PID count", "0.694 ms internal"),
  cost("processes.directRunners", 1, "unavailable from record projections", "in-memory child handles are not exposed to record projections"),
  cost("evidence.deepBytes", 3, "unbounded recursive evidence content", "not measured; store absent"),
]);

const NESTED_WORKTREE_ROOTS = new Set([
  "worktrees",
  "verify-worktrees",
  "post-merge-worktrees",
]);

const DEFAULT_FILE_OPS = Object.freeze({ lstatSync, opendirSync });
const DEFAULT_PROCESS_OPS = Object.freeze({
  platform: process.platform,
  existsSync,
  readFileSync,
  readdirSync(path) {
    const directory = opendirSync(path);
    const names = [];
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    return names;
  },
  readlinkSync,
});

function errorDetail(error) {
  return String(error?.message ?? error ?? "unknown error");
}

function measurement({
  value,
  unit,
  measuredAt,
  tier,
  bounded,
  truncated,
  supported = true,
  detail,
}) {
  return {
    value,
    unit,
    measuredAt,
    ageMs: 0,
    tier,
    bounded,
    ...(truncated === undefined ? {} : { truncated }),
    supported,
    ...(detail ? { detail } : {}),
  };
}

function aged(value, generatedAtMs) {
  if (!value) return null;
  const measuredAtMs = Date.parse(value.measuredAt);
  return {
    ...value,
    ageMs: Number.isFinite(measuredAtMs) ? Math.max(0, generatedAtMs - measuredAtMs) : 0,
  };
}

function readDirectory(ops, path, limit = Number.POSITIVE_INFINITY) {
  let details;
  try {
    details = ops.lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return { missing: true, entries: [], truncated: false };
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`${path} is not a directory`);
  }

  const directory = ops.opendirSync(path);
  const entries = [];
  try {
    while (entries.length < limit) {
      const entry = directory.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  return {
    missing: false,
    entries,
    // At the cap, exactness is deliberately not claimed: checking for one more
    // entry would itself exceed the advertised read bound.
    truncated: Number.isFinite(limit) && entries.length === limit,
  };
}

function statFiles(ops, paths, measuredAt, detail) {
  let bytes = 0;
  try {
    for (const path of paths) {
      let file;
      try {
        file = ops.lstatSync(path);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error(`${path} is not a regular file`);
      }
      bytes += file.size;
    }
    return measurement({ value: bytes, unit: "bytes", measuredAt, tier: 1, bounded: true, detail });
  } catch (error) {
    return measurement({
      value: null,
      unit: "bytes",
      measuredAt,
      tier: 1,
      bounded: true,
      detail: errorDetail(error),
    });
  }
}

function sumFiles(ops, root, { recursive = false, include = () => true } = {}) {
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    const read = readDirectory(ops, directory);
    if (read.missing) continue;
    for (const entry of read.entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (recursive) pending.push(path);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink() || !include(entry.name, path)) continue;
      const details = ops.lstatSync(path);
      if (!details.isFile() || details.isSymbolicLink()) {
        throw new Error(`${path} changed while it was being measured`);
      }
      bytes += details.size;
    }
  }
  return bytes;
}

function byteAggregate(ops, root, completedAt, options = {}) {
  try {
    const value = sumFiles(ops, root, options);
    return measurement({
      value,
      unit: "bytes",
      measuredAt: completedAt(),
      tier: 2,
      bounded: false,
    });
  } catch (error) {
    return measurement({
      value: null,
      unit: "bytes",
      measuredAt: completedAt(),
      tier: 2,
      bounded: false,
      detail: errorDetail(error),
    });
  }
}

function countRoot(ops, stateRoot, root) {
  const path = join(stateRoot, root);
  let remaining = RESOURCE_SCAN_CAP;
  let count = 0;
  let truncated = false;
  try {
    const top = readDirectory(ops, path, remaining);
    if (top.missing) return { root, count: 0, truncated: false };
    remaining -= top.entries.length;
    truncated ||= top.truncated;

    if (!NESTED_WORKTREE_ROOTS.has(root)) {
      count = top.entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).length;
      return { root, count, truncated };
    }

    for (const project of top.entries) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      if (remaining === 0) {
        truncated = true;
        break;
      }
      const children = readDirectory(ops, join(path, project.name), remaining);
      if (children.missing) continue;
      remaining -= children.entries.length;
      truncated ||= children.truncated;
      count += children.entries.filter(
        (entry) => entry.isDirectory() || entry.isSymbolicLink(),
      ).length;
      if (remaining === 0) break;
    }
    return { root, count, truncated };
  } catch (error) {
    return { root, count: null, truncated: false, error };
  }
}

function recordValue(candidate) {
  return candidate?.record && typeof candidate.record === "object" ? candidate.record : candidate;
}

function recordBackedWorkspaceCount(records) {
  const paths = new Set();
  for (const candidate of records) {
    const record = recordValue(candidate);
    // The durable dispatch path is intentionally retained after successful
    // cleanup. Merged/dismissed records therefore cannot count it as active.
    const activeDispatchPath = record?.merged || record?.dismissed ? null : record?.worktreePath;
    for (const path of [activeDispatchPath, record?.verify?.worktreePath, record?.postMerge?.worktreePath]) {
      if (typeof path === "string" && path) paths.add(resolve(path));
    }
  }
  return paths.size;
}

function parseProcStat(pid, raw) {
  const commandEnd = raw.lastIndexOf(")");
  const commandStart = raw.indexOf("(");
  if (commandStart < 0 || commandEnd < commandStart) return null;
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  if (!Number.isInteger(ppid) || ppid < 0) return null;
  return { pid, ppid };
}

function insideRoot(path, root) {
  const normalized = resolve(path);
  return normalized === root || normalized.startsWith(`${root}${sep}`);
}

function relevantProcesses(processOps, stateRoot, completedAt) {
  if (processOps.platform !== "linux") {
    return measurement({
      value: null,
      unit: "count",
      measuredAt: completedAt(),
      tier: 2,
      bounded: false,
      supported: false,
      detail: "requires /proc",
    });
  }
  try {
    if (processOps.existsSync && !processOps.existsSync("/proc")) {
      throw new Error("/proc is unavailable");
    }
    const table = new Map();
    for (const name of processOps.readdirSync("/proc")) {
      if (!/^\d+$/.test(String(name))) continue;
      const pid = Number(name);
      let row;
      try {
        row = parseProcStat(
          pid,
          String(processOps.readFileSync(`/proc/${pid}/stat`, "utf8")),
        );
      } catch {
        continue;
      }
      if (!row) continue;
      try {
        const raw = String(processOps.readlinkSync(`/proc/${pid}/cwd`));
        row.cwd = raw.endsWith(" (deleted)") ? raw.slice(0, -" (deleted)".length) : raw;
      } catch {
        // Descendant classification can still make this row relevant.
      }
      table.set(pid, row);
    }

    const roots = WORKTREE_ROOTS.map((root) => join(stateRoot, root));
    const relevant = new Set(
      [...table.values()]
        .filter((row) => row.cwd && roots.some((root) => insideRoot(row.cwd, root)))
        .map((row) => row.pid),
    );
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table.values()) {
        if (!relevant.has(row.pid) && relevant.has(row.ppid)) {
          relevant.add(row.pid);
          changed = true;
        }
      }
    }
    return measurement({
      value: relevant.size,
      unit: "count",
      measuredAt: completedAt(),
      tier: 2,
      bounded: false,
      detail: "processes rooted in an Atelier worktree, including their observed descendants",
    });
  } catch (error) {
    return measurement({
      value: null,
      unit: "count",
      measuredAt: completedAt(),
      tier: 2,
      bounded: false,
      detail: errorDetail(error),
    });
  }
}

function deepBytes(ops, root, measuredAt) {
  try {
    return measurement({
      value: sumFiles(ops, root, { recursive: true }),
      unit: "bytes",
      measuredAt,
      tier: 3,
      bounded: false,
    });
  } catch (error) {
    return measurement({
      value: null,
      unit: "bytes",
      measuredAt,
      tier: 3,
      bounded: false,
      detail: errorDetail(error),
    });
  }
}

function deepWorktreeBytes(ops, stateRoot, measuredAt) {
  let bytes = 0;
  try {
    for (const root of WORKTREE_ROOTS) {
      bytes += sumFiles(ops, join(stateRoot, root), { recursive: true });
    }
    return measurement({
      value: bytes,
      unit: "bytes",
      measuredAt,
      tier: 3,
      bounded: false,
      detail: "exact recursive total; no sampled value is extrapolated",
    });
  } catch (error) {
    return measurement({
      value: null,
      unit: "bytes",
      measuredAt,
      tier: 3,
      bounded: false,
      detail: errorDetail(error),
    });
  }
}

export function createResourceProjector({
  stateDir = atelierStateDir(),
  fileOps,
  processOps,
  now = () => new Date(),
  cacheMs = RESOURCE_CACHE_MS,
} = {}) {
  if (typeof stateDir !== "string" || !stateDir) throw new TypeError("stateDir must be a path");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (!Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new TypeError("cacheMs must be a non-negative number");
  }
  const root = resolve(stateDir);
  const ops = { ...DEFAULT_FILE_OPS, ...(fileOps || {}) };
  const proc = { ...DEFAULT_PROCESS_OPS, ...(processOps || {}) };
  let tierTwoCache;
  let tierThreeCache;

  function instant() {
    const value = now();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("now must return a valid date");
    return date;
  }

  function tierTwo() {
    const dispatches = join(root, "dispatches");
    const completedAt = () => instant().toISOString();
    const logs = {
      transcripts: byteAggregate(ops, dispatches, completedAt, {
        include: (name) => name !== "index.jsonl" && name.endsWith(".jsonl"),
      }),
      prompts: byteAggregate(ops, dispatches, completedAt, {
        include: (name) => name.endsWith(".codex-prompt.md"),
      }),
      codexJobs: byteAggregate(ops, join(root, "codex-app-server", "jobs"), completedAt, {
        include: (name) => /^(?:[a-f0-9]{24})\.(?:json|stream\.jsonl)$/.test(name),
      }),
      breakGlass: byteAggregate(ops, join(root, "break-glass"), completedAt, {
        include: (name) => name.endsWith(".json"),
      }),
      legacyCompanion: byteAggregate(ops, join(root, "codex-companion"), completedAt, {
        recursive: true,
      }),
    };
    const relevantCount = relevantProcesses(proc, root, completedAt);
    return {
      measuredAt: relevantCount.measuredAt,
      logs,
      relevantCount,
    };
  }

  function measure({ records = [], deep = false } = {}) {
    const started = instant();
    const startedAt = started.toISOString();
    const startedAtMs = started.getTime();
    const suppliedRecords = Array.isArray(records) ? records : [];

    const eventPaths = [join(root, "logs", "events.jsonl")];
    for (let index = 1; index <= 5; index += 1) {
      eventPaths.push(join(root, "logs", `events.${index}.jsonl`));
    }
    const eventLog = statFiles(ops, eventPaths, startedAt);
    const dispatchIndex = statFiles(ops, [join(root, "dispatches", "index.jsonl")], startedAt);

    const byRoot = WORKTREE_ROOTS.map((name) => countRoot(ops, root, name));
    const rootFailure = byRoot.find((entry) => entry.error);
    const onDiskCount = measurement({
      value: rootFailure ? null : byRoot.reduce((total, entry) => total + entry.count, 0),
      unit: "count",
      measuredAt: startedAt,
      tier: 1,
      bounded: true,
      truncated: byRoot.some((entry) => entry.truncated),
      ...(rootFailure ? { detail: errorDetail(rootFailure.error) } : {}),
    });
    const publicByRoot = byRoot.map(({ root: name, count, truncated }) => ({
      root: name,
      count,
      truncated,
    }));

    const recordBackedCount = recordBackedWorkspaceCount(suppliedRecords);
    const cachedAge = tierTwoCache ? startedAtMs - Date.parse(tierTwoCache.measuredAt) : Infinity;
    if (!tierTwoCache || cachedAge < 0 || cachedAge >= cacheMs) {
      tierTwoCache = tierTwo();
    }

    if (deep) {
      tierThreeCache = {
        worktrees: deepWorktreeBytes(ops, root, startedAt),
        evidence: deepBytes(ops, join(root, "evidence"), startedAt),
      };
    }

    const generated = instant();
    const generatedAt = generated.toISOString();
    const generatedAtMs = generated.getTime();

    return {
      generatedAt,
      platform: { linux: proc.platform === "linux" },
      logs: {
        eventLog,
        dispatchIndex,
        ...Object.fromEntries(
          Object.entries(tierTwoCache.logs).map(([key, value]) => [key, aged(value, generatedAtMs)]),
        ),
      },
      worktrees: {
        recordBackedCount: measurement({
          value: recordBackedCount,
          unit: "count",
          measuredAt: generatedAt,
          tier: 1,
          bounded: false,
          detail: "record-backed workspace paths only; cost is proportional to total dispatch history and the count is not authoritative for orphaned directories",
        }),
        onDiskCount,
        byRoot: publicByRoot,
        deepBytes: aged(tierThreeCache?.worktrees, generatedAtMs),
      },
      processes: {
        relevantCount: aged(tierTwoCache.relevantCount, generatedAtMs),
        directRunners: measurement({
          value: null,
          unit: "count",
          measuredAt: generatedAt,
          tier: 1,
          bounded: true,
          detail: "in-memory child handles are not exposed to record projections",
        }),
      },
      evidence: { deepBytes: aged(tierThreeCache?.evidence, generatedAtMs) },
      costModel: RESOURCE_COST_MODEL,
    };
  }

  return Object.freeze({ measure });
}
