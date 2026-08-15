// Linux /proc facts about codex companion process trees. FACTS ONLY: this
// module never decides that a process may die - `dispatch.mjs` owns that, and
// it owns it through the one classifier atelier-tzw built (`classifyFencedPid`),
// so the reaper adds no second opinion about what "dead" means.
//
// Why a ppid closure and not a process group. A codex companion job is three
// processes plus per-session MCP children, and they deliberately escape each
// other's process groups:
//
//   node codex-companion.mjs task-worker   <- the pid the companion job store
//                                             reports (`job.pid`), spawned
//                                             detached, its own group leader
//     node app-server-broker.mjs serve     <- own group, keyed by cwd and
//                                             REUSED by a later resume
//       node .../bin/codex app-server      <- js wrapper
//         .../codex app-server             <- native binary
//           codex-code-mode-host, MCP servers ... <- own groups again
//
// The companion's own cancel path calls kill(-job.pid), which is why cancelling
// a job leaves the broker and everything under it resident (observed live:
// 211 app-servers, ~10 GiB PSS). A group kill cannot reach them; a name match
// cannot tell one user's app-server from another's. The parent chain can, so
// that is what this walks - and because a broker reparents to init the moment
// its task-worker exits, the walk has to happen WHILE the job is alive and its
// result has to be persisted (see captureProcessTree's caller).
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";

// The kernel appends this to /proc/<pid>/cwd once the directory is unlinked -
// a removed dispatch worktree is exactly that, and it is the strongest
// corroboration available that a process belongs to work that is over.
const DELETED_CWD_SUFFIX = " (deleted)";

const nativeCodexProcessOps = Object.freeze({
  platform: process.platform,
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  kill(pid, signal) {
    process.kill(pid, signal);
  },
});

let processOps = nativeCodexProcessOps;

// /proc/<pid>/stat, but only the two fields a tree walk needs. The command is
// carried for operator-facing reports, never for a kill decision. Start time is
// returned RAW (clock ticks since boot): turning ticks into the fencing identity
// string is dispatch.mjs's job, so there is exactly one place that spelling
// exists.
function parseStat(pid, raw) {
  const commandEnd = raw.lastIndexOf(")");
  const commandStart = raw.indexOf("(");
  if (commandEnd < 0 || commandStart < 0 || commandEnd < commandStart) return undefined;
  const fields = raw.slice(commandEnd + 1).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isInteger(ppid) || ppid < 0 || !/^\d+$/.test(startTime ?? "")) return undefined;
  return { pid, ppid, command: raw.slice(commandStart + 1, commandEnd), startTime };
}

// One pass over /proc. Non-Linux hosts get an empty table, which is what makes
// every caller degrade to report-only without a platform check of its own
// (spec constraint 5).
export function readProcessTable() {
  if (processOps.platform !== "linux") return new Map();
  let names;
  try {
    names = processOps.readdirSync("/proc");
  } catch {
    return new Map();
  }
  const table = new Map();
  for (const name of names) {
    if (!/^\d+$/.test(String(name))) continue;
    const pid = Number(name);
    let parsed;
    try {
      parsed = parseStat(pid, String(processOps.readFileSync(`/proc/${pid}/stat`, "utf8")));
    } catch {
      // Processes exit while /proc is being scanned; that is not an error.
      continue;
    }
    if (!parsed) continue;
    let cwd;
    let cwdDeleted = false;
    try {
      const raw = String(processOps.readlinkSync(`/proc/${pid}/cwd`));
      cwdDeleted = raw.endsWith(DELETED_CWD_SUFFIX);
      cwd = cwdDeleted ? raw.slice(0, -DELETED_CWD_SUFFIX.length) : raw;
    } catch {
      // A process whose cwd cannot be read can never be tied to a Atelier
      // worktree, so it stays out of scope rather than becoming a guess.
    }
    let argv = [];
    try {
      argv = String(processOps.readFileSync(`/proc/${pid}/cmdline`)).split("\0").filter(Boolean);
    } catch {
      // No argv means no way to recognize the companion family, which means the
      // process can only ever be reported.
    }
    table.set(pid, { ...parsed, cwd, cwdDeleted, argv });
  }
  return table;
}

// Breadth-first parent-chain closure, depth-annotated so callers can signal
// leaves before roots. Self-parenting and cycles (a table snapshot can be
// internally inconsistent - it is read pid by pid while the system runs) are
// bounded by the visited set rather than trusted not to happen.
export function descendantPids(table, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0 || !table.has(rootPid)) return [];
  const children = new Map();
  for (const entry of table.values()) {
    if (entry.pid === entry.ppid) continue;
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry.pid);
  }
  const depths = new Map([[rootPid, 0]]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    for (const child of children.get(pid) ?? []) {
      if (depths.has(child)) continue;
      depths.set(child, depths.get(pid) + 1);
      queue.push(child);
    }
  }
  return [...depths].map(([pid, depth]) => ({ pid, depth }));
}

// The processes a codex companion job is MADE of, recognized by argv. This is
// half of what makes a sweep candidate signalable: a cwd inside a Atelier worktree
// says where a process is standing, not what it is, and a user's shell - or their
// own editor session - can stand there too.
//
// Deliberately argv and not `exe`: two of the four real shapes exec `node`, whose
// exe link says nothing, and the vendored binary is reached through a JS shim.
// Deliberately not the `stat` comm field either - it is truncated to 15 bytes and
// says "codex" for unrelated things.
const COMPANION_SCRIPTS = new Set(["codex-companion.mjs", "app-server-broker.mjs"]);
const COMPANION_EXECUTABLES = new Set(["codex", "codex-code-mode-host"]);
const COMPANION_SUBCOMMANDS = new Set(["app-server", "mcp-server", "task-worker"]);

function executableName(argument) {
  const name = String(argument).split("/").pop() ?? "";
  return name.toLowerCase().replace(/\.exe$/, "");
}

export function isCodexCompanionProcess(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return false;
  for (const [index, argument] of argv.entries()) {
    const name = executableName(argument);
    // The companion's own scripts. A `codex` DIRECTORY segment is required so a
    // same-named script somewhere else cannot borrow the family's authority -
    // tested against the directory only, because the filename itself starts with
    // "codex-" and would otherwise satisfy its own guard.
    if (COMPANION_SCRIPTS.has(name)) {
      const path = String(argument);
      const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      if (/(^|\/)codex(\/|$)/.test(directory)) return true;
    }
    // The codex binary (or its JS shim) in one of the roles a companion job runs
    // it in. The subcommand is required: a bare `codex` is a human's own CLI.
    if (COMPANION_EXECUTABLES.has(name)) {
      if (name === "codex-code-mode-host") return true;
      if (COMPANION_SUBCOMMANDS.has(String(argv[index + 1]))) return true;
    }
  }
  return false;
}

// The persisted shape: every member of a live companion job's tree with the
// start-time identity that proves, later, that the pid was never recycled.
//
// The identity comes from `identityFromStartTime` applied to the start ticks THIS
// table read already carries - never from a second probe of the same pid. A pid
// that exits and is reused between the two reads would otherwise be captured
// under a stranger's identity and thereafter treated as owned, which is the
// self-derived-identity-is-not-ownership trap (round-2 review, blocker 2).
//
// Members whose identity cannot be derived are captured with `identity: null` and
// can therefore never be reaped - "cannot corroborate" is not a licence to kill,
// the same asymmetry the fencing lesson records for death.
export function captureProcessTree(rootPid, identityFromStartTime) {
  const table = readProcessTable();
  const members = descendantPids(table, rootPid);
  if (members.length === 0) return undefined;
  return {
    rootPid,
    capturedAt: new Date().toISOString(),
    processes: members
      .map(({ pid, depth }) => {
        const row = table.get(pid);
        return {
          pid,
          identity: identityFromStartTime(row?.startTime) ?? null,
          depth,
          command: row?.command ?? null,
        };
      })
      .sort((left, right) => left.pid - right.pid),
  };
}

export function signalProcess(pid, signal) {
  processOps.kill(pid, signal);
}

// A PARTIAL override is merged over the native ops, so a test can fail one
// primitive (e.g. make kill(2) return EPERM) without having to reimplement /proc.
export function _setCodexProcessOps(nextOps) {
  processOps = nextOps ? { ...nativeCodexProcessOps, ...nextOps } : nativeCodexProcessOps;
}
