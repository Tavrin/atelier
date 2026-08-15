import assert from "node:assert/strict";
import test from "node:test";

import {
  _setCodexProcessOps,
  captureProcessTree,
  descendantPids,
  isCodexCompanionProcess,
  readProcessTable,
} from "./codex-processes.mjs";

// /proc/<pid>/stat, faithfully enough for the two fields the walk reads: the
// command sits in parentheses and MAY contain spaces and parentheses of its own,
// which is why the parser scans from the last ")" rather than splitting.
function statLine(pid, { command, ppid, pgid, startTime }) {
  const trailing = Array.from({ length: 30 }, (_unused, index) => String(index));
  trailing[0] = "S";
  trailing[1] = String(ppid);
  trailing[2] = String(pgid);
  trailing[19] = String(startTime);
  return `${pid} (${command}) ${trailing.join(" ")}`;
}

function procOps(processes, { platform = "linux" } = {}) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const reads = [];
  return {
    platform,
    existsSync: () => true,
    readdirSync(path) {
      assert.equal(path, "/proc");
      return [...byPid.keys()].map(String).concat(["self", "cpuinfo"]);
    },
    readFileSync(path) {
      const cmdline = /^\/proc\/(\d+)\/cmdline$/.exec(path);
      if (cmdline) {
        const entry = byPid.get(Number(cmdline[1]));
        if (!entry || entry.argv === undefined) {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        }
        return `${entry.argv.join("\0")}\0`;
      }
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (!match) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      const entry = byPid.get(Number(match[1]));
      if (!entry || entry.statUnreadable) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      reads.push(entry.pid);
      // A pid that exits and is reused between two reads reads back a DIFFERENT
      // start time. Any code that probes twice would capture the second one.
      const startTime = entry.rereadStartTime !== undefined && reads.filter((pid) => pid === entry.pid).length > 1
        ? entry.rereadStartTime
        : entry.startTime;
      return statLine(entry.pid, { ...entry, startTime });
    },
    readlinkSync(path) {
      const match = /^\/proc\/(\d+)\/cwd$/.exec(path);
      const entry = match ? byPid.get(Number(match[1])) : undefined;
      if (!entry || entry.cwd === undefined) {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      }
      return entry.cwd;
    },
    kill() {
      throw new Error("this test must never signal anything");
    },
  };
}

test("the process table carries parentage, cwd deletion and a command with awkward characters", (t) => {
  t.after(() => _setCodexProcessOps());
  _setCodexProcessOps(procOps([
    { pid: 10, command: "sh", ppid: 1, pgid: 10, startTime: 100, cwd: "/wt/a" },
    { pid: 11, command: "codex app-server (x)", ppid: 10, pgid: 11, startTime: 101, cwd: "/wt/a (deleted)" },
    { pid: 12, command: "hidden", ppid: 10, pgid: 12, startTime: 102 },
    { pid: 13, command: "gone", ppid: 10, pgid: 13, startTime: 103, cwd: "/wt/a", statUnreadable: true },
  ]));

  const table = readProcessTable();
  assert.deepEqual([...table.keys()].sort((left, right) => left - right), [10, 11, 12]);
  assert.equal(table.get(10).ppid, 1);
  assert.equal(table.get(10).cwdDeleted, false);
  // The command is preserved verbatim for operator-facing reports, and its own
  // parenthesis must not truncate the fields that follow it.
  assert.equal(table.get(11).command, "codex app-server (x)");
  assert.equal(table.get(11).ppid, 10);
  assert.equal(table.get(11).startTime, "101");
  // The kernel's " (deleted)" marker is the corroboration a sweep acts on, so it
  // is reported as a flag and stripped from the path.
  assert.equal(table.get(11).cwd, "/wt/a");
  assert.equal(table.get(11).cwdDeleted, true);
  // An unreadable cwd cannot be tied to a Atelier worktree; the process is still
  // in the table (it may be someone's descendant) but has no cwd to match on.
  assert.equal(table.get(12).cwd, undefined);
});

test("the descendant walk follows parentage across process groups and survives a cyclic snapshot", (t) => {
  t.after(() => _setCodexProcessOps());
  // The real shape: task-worker -> broker -> js wrapper -> native binary -> MCP
  // child, each in its OWN process group. A kill(-rootPid) reaches only the
  // first, which is exactly why the companion's cancel leaks the rest.
  _setCodexProcessOps(procOps([
    { pid: 100, command: "task-worker", ppid: 1, pgid: 100, startTime: 1, cwd: "/wt" },
    { pid: 101, command: "broker", ppid: 100, pgid: 101, startTime: 2, cwd: "/wt" },
    { pid: 102, command: "codex", ppid: 101, pgid: 102, startTime: 3, cwd: "/wt" },
    { pid: 103, command: "codex", ppid: 102, pgid: 103, startTime: 4, cwd: "/wt" },
    { pid: 104, command: "mcp", ppid: 103, pgid: 104, startTime: 5, cwd: "/elsewhere" },
    { pid: 200, command: "stranger", ppid: 1, pgid: 200, startTime: 6, cwd: "/wt" },
    // A snapshot read pid by pid while the system runs can be internally
    // inconsistent; a parent cycle must bound the walk, not hang it.
    { pid: 300, command: "cycle-a", ppid: 301, pgid: 300, startTime: 7, cwd: "/wt" },
    { pid: 301, command: "cycle-b", ppid: 300, pgid: 301, startTime: 8, cwd: "/wt" },
  ]));

  const table = readProcessTable();
  const walked = descendantPids(table, 100);
  assert.deepEqual(
    walked.sort((left, right) => left.pid - right.pid),
    [
      { pid: 100, depth: 0 },
      { pid: 101, depth: 1 },
      { pid: 102, depth: 2 },
      { pid: 103, depth: 3 },
      // Depth 4 and a cwd of its own: a name match or a cwd pass alone would
      // never find it, parentage does.
      { pid: 104, depth: 4 },
    ],
  );
  assert.deepEqual(descendantPids(table, 200), [{ pid: 200, depth: 0 }]);
  assert.deepEqual(descendantPids(table, 300).map((entry) => entry.pid).sort(), [300, 301]);
  assert.deepEqual(descendantPids(table, 999), []);
  assert.deepEqual(descendantPids(table, 0), []);
});

test("a captured tree records one identity per member and never invents one it could not read", (t) => {
  t.after(() => _setCodexProcessOps());
  _setCodexProcessOps(procOps([
    { pid: 100, command: "task-worker", ppid: 1, pgid: 100, startTime: 1, cwd: "/wt" },
    { pid: 101, command: "app-server", ppid: 100, pgid: 101, startTime: 2, cwd: "/wt" },
  ]));

  const captured = captureProcessTree(
    100,
    (startTime) => (startTime === "1" ? `identity-${startTime}` : undefined),
  );
  assert.equal(captured.rootPid, 100);
  assert.deepEqual(captured.processes, [
    { pid: 100, identity: "identity-1", depth: 0, command: "task-worker" },
    // No identity means no corroboration, which means this member can never be
    // reaped - null is recorded honestly rather than filled in.
    { pid: 101, identity: null, depth: 1, command: "app-server" },
  ]);
  assert.equal(captureProcessTree(999, () => "x"), undefined);
  assert.equal(captureProcessTree(undefined, () => "x"), undefined);
});

test("a captured identity comes from the read that discovered the process, never a second probe", (t) => {
  t.after(() => _setCodexProcessOps());
  // The pid exits and is reused between reads: its second stat read reports a
  // different start time. A capture that probed the pid again would record the
  // STRANGER's identity and thereafter treat it as owned - self-derived identity
  // is not ownership (round-2 review, blocker 2).
  _setCodexProcessOps(procOps([
    {
      pid: 100,
      command: "task-worker",
      ppid: 1,
      pgid: 100,
      startTime: 1,
      rereadStartTime: 999,
      cwd: "/wt",
    },
  ]));

  const captured = captureProcessTree(100, (startTime) => `linux-proc-start:boot:${startTime}`);
  assert.deepEqual(captured.processes, [
    { pid: 100, identity: "linux-proc-start:boot:1", depth: 0, command: "task-worker" },
  ]);
});

test("the companion family is recognized by argv, and a bare codex CLI is not part of it", (t) => {
  const vendor = "/home/u/.nvm/versions/node/v22/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
  const cache = "/home/u/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts";
  // Every shape a real companion job runs.
  assert.equal(isCodexCompanionProcess(["node", `${cache}/app-server-broker.mjs`, "serve"]), true);
  assert.equal(
    isCodexCompanionProcess(["node", `${cache}/codex-companion.mjs`, "task-worker", "--cwd", "/wt"]),
    true,
  );
  assert.equal(isCodexCompanionProcess(["node", "/home/u/.nvm/bin/codex", "app-server"]), true);
  assert.equal(isCodexCompanionProcess([vendor, "app-server"]), true);
  assert.equal(isCodexCompanionProcess(["node", "/home/u/.nvm/bin/codex", "mcp-server"]), true);
  // code-mode-host needs no subcommand: the executable name is the whole proof.
  assert.equal(isCodexCompanionProcess([`${vendor}-code-mode-host`]), true);
  assert.equal(isCodexCompanionProcess(["/opt/x/bin/codex-code-mode-host"]), true);

  // Not the family: a human's own interactive CLI, unrelated processes, and a
  // same-named script somewhere with no codex path segment borrowing its authority.
  assert.equal(isCodexCompanionProcess(["node", "/home/u/.nvm/bin/codex"]), false);
  assert.equal(isCodexCompanionProcess(["sh", "-c", "sleep 120"]), false);
  assert.equal(isCodexCompanionProcess(["node", "/tmp/evil/codex-companion.mjs"]), false);
  assert.equal(isCodexCompanionProcess([]), false);
  assert.equal(isCodexCompanionProcess(undefined), false);
});

test("a non-Linux host yields no process facts at all, so every caller degrades to report-only", (t) => {
  t.after(() => _setCodexProcessOps());
  _setCodexProcessOps(procOps(
    [{ pid: 100, command: "task-worker", ppid: 1, pgid: 100, startTime: 1, cwd: "/wt" }],
    { platform: "darwin" },
  ));

  assert.equal(readProcessTable().size, 0);
  assert.equal(captureProcessTree(100, () => "identity"), undefined);
});
