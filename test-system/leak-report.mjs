#!/usr/bin/env node
// ATT-011 process / worktree leak report.
//
// The golden harness already ASSERTS no leaks per test (daemon pid, fake-agent
// child pids, git worktrees, a ps scan, the disposable worktree root). Those
// assertions are the gate. This is the artifact the P0 declaration bundle owes:
// a whole-run, before/after account of what Atelier left behind, including the
// things per-test assertions structurally cannot see.
//
// Two classes are reported separately and deliberately:
//
//   LEAKS      - things Atelier owns and should have cleaned up. These fail.
//   OBSERVED   - environment-dependent residue that is real but not Atelier's to
//                reap, e.g. rootless podman's `pause` process, which the sandbox
//                backend probe starts on hosts where podman is configured for it.
//                GitHub runners report terminating one; this workstation produces
//                none. Asserting on it would make the gate depend on how the host
//                happens to have podman set up, so it is recorded, not enforced.
//
// Reporting something as OBSERVED is a claim that it is not Atelier's to clean.
// That claim should be re-examined, not inherited.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.ATELIER_LEAK_REPORT_PATH || resolve(REPO, "leak-report.json");

function processes() {
  const out = execFileSync("ps", ["-eo", "pid=,comm=,args="], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).map((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), comm: match[2], args: match[3] } : null;
  }).filter(Boolean);
}

function tempEntries() {
  try {
    return readdirSync(tmpdir()).filter((name) => /^atelier[-.]/i.test(name));
  } catch {
    return [];
  }
}

// A process is Atelier's if its command line points into the repo or into an
// Atelier temp/state directory. Matching on the word "atelier" alone would catch
// this very script and the editor that opened it.
function looksLikeAtelier(entry) {
  const args = entry.args || "";
  if (entry.pid === process.pid) return false;
  return /atelier[-/]dispatch|atelier[-/]state|test-system\/fake-agent|server\/server\.mjs/.test(args);
}

const KNOWN_ENVIRONMENTAL = [
  {
    id: "rootless-podman-pause",
    match: (entry) => entry.comm === "podman" && /\bpause\b/.test(entry.args || ""),
    why:
      "rootless podman keeps a `pause` process alive to hold its user namespace. " +
      "Atelier's podman backend probe starts it on hosts configured that way; " +
      "GitHub runners report terminating one, this workstation produces none. " +
      "Not Atelier's process to reap - but if the podman backend ever gains a " +
      "working wrap(), revisit whether Atelier should be tearing it down.",
  },
];

// Self-test: prove the detector can actually see a leak before trusting it to
// report none. A leak report that always reads "0" is indistinguishable from a
// broken one - the same failure the mutation matrix exists to catch, and which
// this harness's own first CI run exhibited. Plants a synthetic process that
// matches the Atelier pattern, confirms it is classified as a leak, and reaps it.
function selfTest() {
  const before = processes().map((entry) => entry.pid);
  // `exec -a NAME cmd & echo $!` inside `bash -c` does NOT survive bash exiting -
  // the echoed pid is dead on arrival. Spawn bash detached instead and let `exec`
  // replace it in place, so Node's own child.pid IS the renamed process.
  const child = spawn("bash", ["-c", "exec -a atelier-dispatch-leak-report-selftest sleep 10"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const pid = child.pid;
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("leak-report self-test could not plant a process");
  const beforePids = new Set(before);
  let seen = false;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !seen) {
    const survivors = processes().filter((entry) => !beforePids.has(entry.pid));
    seen = survivors.filter(looksLikeAtelier).some((entry) => entry.pid === pid);
    if (!seen) execFileSync("sleep", ["0.1"]);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  if (!seen) {
    throw new Error(
      "leak-report self-test FAILED: a planted Atelier-shaped process was not classified " +
        "as a leak, so a clean report from this run would mean nothing",
    );
  }
  process.stdout.write("leak-report: self-test passed - the detector sees a planted leak\n");
}
selfTest();

const before = { processes: processes(), temp: tempEntries() };

process.stdout.write("leak-report: running the golden suite\n");
const run = spawnSync(process.execPath, ["test-system/run-tests.mjs"], {
  cwd: REPO,
  encoding: "utf8",
  env: { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" },
});
// Trust the EXIT CODE, not the output shape. Parsing for "# fail 0" depends on
// the reporter, and Node 22 emits TAP while Node 24 emits `spec` - so on the
// Node 24 job this read a passing golden suite as FAILED. Same trap the mutation
// matrix hit; the lesson is that a harness should not infer a result it can be
// told directly.
const suiteOutput = `${run.stdout ?? ""}${run.stderr ?? ""}`;
const suitePassed = run.status === 0;

const after = { processes: processes(), temp: tempEntries() };

const beforePids = new Set(before.processes.map((entry) => entry.pid));
const survivors = after.processes.filter((entry) => !beforePids.has(entry.pid));

const environmental = [];
const leaked = [];
for (const entry of survivors) {
  const known = KNOWN_ENVIRONMENTAL.find((candidate) => candidate.match(entry));
  if (known) environmental.push({ ...entry, id: known.id, why: known.why });
  else if (looksLikeAtelier(entry)) leaked.push(entry);
}

const beforeTemp = new Set(before.temp);
const tempLeaked = after.temp.filter((name) => !beforeTemp.has(name));

const report = {
  generatedFor: "ATT-011 process/worktree leak report",
  suite: "test-system/run-tests.mjs",
  suitePassed,
  checked: [
    "processes whose command line points into the repo, an Atelier dispatch/state dir, or the fake agent",
    `temp entries matching /^atelier[-.]/ under ${tmpdir()}`,
  ],
  notChecked: [
    // Saying what a report cannot see is part of the report. A silent omission
    // reads as a clean result.
    "open file descriptors held by surviving processes",
    "git worktrees inside the disposable project - asserted per-test by the golden harness instead",
    "processes that exited during the run but left state behind",
  ],
  leaked,
  environmental,
  tempLeaked,
};
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`\n=== ATT-011 leak report ===\n`);
process.stdout.write(`golden suite: ${suitePassed ? "passed" : "FAILED"}\n`);
process.stdout.write(`atelier processes leaked: ${leaked.length}\n`);
for (const entry of leaked) process.stdout.write(`  LEAK  ${entry.pid} ${entry.comm} ${entry.args.slice(0, 90)}\n`);
process.stdout.write(`temp entries left behind: ${tempLeaked.length}\n`);
for (const name of tempLeaked) process.stdout.write(`  LEAK  ${name}\n`);
process.stdout.write(`environmental residue (recorded, not enforced): ${environmental.length}\n`);
for (const entry of environmental) process.stdout.write(`  OBSERVED  ${entry.id}: pid ${entry.pid}\n`);
process.stdout.write(`report written to ${OUT}\n`);

if (!suitePassed) {
  process.stdout.write("\nthe golden suite did not pass, so this report describes a failed run\n");
  process.exit(1);
}
process.exit(leaked.length === 0 && tempLeaked.length === 0 ? 0 : 1);
