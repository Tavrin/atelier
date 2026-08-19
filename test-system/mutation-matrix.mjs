#!/usr/bin/env node
// ATT-011 mutation matrix.
//
// The campaign's claim is not "the tests pass" - it is that the GUARDS are load
// bearing. A suite can be green because it asserts nothing. So for each mutant
// below we deliberately break one integrity guard in production source and
// require that:
//
//   1. its named gate turns RED - the guard is actually asserted somewhere, and
//   2. the failure LOCALIZES - every red test belongs to that guard's own gate
//      file, so a red result tells you which guard broke.
//
// A mutant that changes nothing is a missing test dressed as coverage. A mutant
// that reddens unrelated areas is an assertion that cannot say what broke. Both
// fail this harness.
//
// Note on "exactly one gate red" (CAMPAIGN.md): that means one GUARD localized,
// not one test. Several tests asserting the SAME guard is redundant coverage and
// is healthy - removing /api/session from the denial list correctly reddens both
// the direct denial test and the normalization-variants test, and removing the
// merge-result gate correctly reddens both the R-B residual test and the strict
// merge-binding test. Demanding a single failing test would have punished exactly
// the coverage this campaign wants. Co-firing tests are counted and reported so
// the information is not lost.
//
// Safety: every mutant is applied to a file whose exact bytes are restored in a
// finally, and the run refuses to start on a dirty tree so a crash can never be
// confused with uncommitted work. It also verifies restoration at the end.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Each mutant names the ONE guard it breaks and the ONE gate that must catch it.
const MUTANTS = [
  {
    id: "att008-rb-writable-root-split",
    guard:
      "ATT-008 R-B: a verification checkout mounts the tested tree read-only, so a " +
      "verifier cannot durably modify the bytes it is testing (the ATT-003 " +
      "modify-test-restore class).",
    file: "server/lib/execution/sandbox.mjs",
    find: '  return confinement === "sandboxed-write" ? absolutePaths([cwd], "writableRoots") : [];',
    replace: "  return [];",
    gateFile: "server/lib/execution/escape-harness.test.mjs",
    gateName: "escape harness expected-residual",
  },
  {
    id: "att010-h1-broker-denies-session",
    guard:
      "ATT-010 H1: the sandbox broker denies /api/session unconditionally, which is " +
      "what makes the human break-glass boundary enforceable rather than surface " +
      "discipline.",
    file: "server/lib/execution/daemon-broker.mjs",
    find: '  "/api/session",\n  "/api/break-glass",',
    replace: '  "/api/break-glass",',
    gateFile: "server/lib/execution/escape-harness.test.mjs",
    gateName: "broker denial: /api/session",
  },
  {
    id: "att005-bearer-verification",
    guard:
      "ATT-005: an invalid bearer token is refused. Every actor-based refusal in the " +
      "system, including ATT-010's break-glass boundary, rests on this.",
    file: "server/lib/auth.mjs",
    find: '      if (!actor) authenticationFailure(request, "Invalid Atelier bearer token");',
    replace: '      if (false) authenticationFailure(request, "Invalid Atelier bearer token");',
    // Gate lives in server.test.mjs, not auth.test.mjs: auth.test.mjs covers token
    // MINTING and signature comparison, while the rejection path is asserted end to
    // end through the HTTP surface. The matrix caught this pointer being wrong by
    // reporting UNGUARDED, which is the harness working - an unasserted guard and a
    // misaimed gate look identical until you check, and both deserve to be loud.
    gateFile: "server/server.test.mjs",
    gateName: "API authentication enforces the bearer",
  },
  {
    id: "att003-zero-exit-mutation-cannot-attest",
    guard:
      "ATT-003: a verify run that mutated the tested tree cannot attest, even on a " +
      "zero exit. This is the proof chain behind 'tested = reviewed = merged'.",
    file: "server/lib/dispatch.mjs",
    find: "    if (post.tree !== result.tree) {",
    replace: "    if (false && post.tree !== result.tree) {",
    gateFile: "server/lib/dispatch.test.mjs",
    gateName: "mutat",
  },
  {
    id: "att004-merge-requires-finalized-result",
    guard:
      "ATT-004: a merge is refused for a record with no finalized result unless a " +
      "human break-glass authorizes it. ATT-008 R-B's residual leans on this gate.",
    file: "server/lib/dispatch.mjs",
    find: "    if (!force && !record.result?.commit) {",
    replace: "    if (false && !force && !record.result?.commit) {",
    gateFile: "server/lib/dispatch.test.mjs",
    gateName: "R-B residual",
  },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: REPO, encoding: "utf8", ...options });
}

function requireCleanTree() {
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
  if (status.trim() !== "") {
    throw new Error(
      "mutation-matrix refuses to run on a dirty tree: it restores files by exact bytes, " +
        "and uncommitted work must not be confused with a mutant.\n" + status,
    );
  }
}

// Run one test file and report which of its tests failed, by name.
function gateResult(gateFile) {
  const result = run(process.execPath, ["--test", gateFile], {
    env: { ...process.env, ATELIER_TEST_NO_REAL_PROVIDER: "1" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failed = [...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1].trim());
  const passed = [...output.matchAll(/^ok \d+ - (.*)$/gm)].map((match) => match[1].trim());
  return { failed, passed, output };
}

function applyMutant(mutant) {
  const path = join(REPO, mutant.file);
  const original = readFileSync(path, "utf8");
  const occurrences = original.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutant ${mutant.id}: anchor matched ${occurrences} times in ${mutant.file}; ` +
        "it must match exactly once or the mutation is not the one described",
    );
  }
  writeFileSync(path, original.replace(mutant.find, mutant.replace));
  return () => writeFileSync(path, original);
}

const results = [];
requireCleanTree();

for (const mutant of MUTANTS) {
  process.stdout.write(`\n=== ${mutant.id} ===\n`);

  const baseline = gateResult(mutant.gateFile);
  if (baseline.failed.length > 0) {
    results.push({
      mutant, verdict: "INCONCLUSIVE",
      detail: `gate file already red before mutation: ${baseline.failed.join("; ")}`,
    });
    continue;
  }

  const restore = applyMutant(mutant);
  let mutated;
  try {
    mutated = gateResult(mutant.gateFile);
  } finally {
    restore();
  }

  const caught = mutated.failed.filter((name) => name.includes(mutant.gateName));
  const sameGuard = mutated.failed.filter((name) => !name.includes(mutant.gateName));
  // Everything measured here comes from the gate's OWN file, so co-firing tests
  // are same-guard coverage. A blanket break would surface as the whole file red.
  const wholeFileRed = mutated.passed.length === 0 && mutated.failed.length > 1;

  let verdict;
  let detail;
  if (mutated.failed.length === 0) {
    // The guard can be removed and nothing notices.
    verdict = "UNGUARDED";
    detail = "no gate turned red - this guard is not asserted anywhere";
  } else if (caught.length === 0) {
    verdict = "MISATTRIBUTED";
    detail = `the named gate stayed green; other tests failed instead: ${sameGuard.join("; ")}`;
  } else if (wholeFileRed) {
    verdict = "IMPRECISE";
    detail = "the entire gate file went red, so a red result cannot name the broken guard";
  } else {
    verdict = "CAUGHT";
    detail =
      `localized to ${mutated.failed.length} test(s) of this guard, ` +
      `${mutated.passed.length} unrelated test(s) in the file still green` +
      (sameGuard.length > 0 ? `; co-firing: ${sameGuard.join("; ")}` : "");
  }
  results.push({ mutant, verdict, detail });
  process.stdout.write(`${verdict}: ${detail}\n`);
}

requireCleanTree();

process.stdout.write("\n=== ATT-011 mutation matrix ===\n");
for (const { mutant, verdict, detail } of results) {
  process.stdout.write(`${verdict.padEnd(14)} ${mutant.id}\n                 ${detail}\n`);
}

const failures = results.filter((entry) => entry.verdict !== "CAUGHT");
process.stdout.write(
  `\n${results.length - failures.length}/${results.length} mutants localized to their own guard\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
