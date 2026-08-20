#!/usr/bin/env node
// Run a command N times and report how often it passed.
//
// A single green run says the suite CAN pass. It says nothing about how often it
// does, and this campaign has now seen several low-rate flakes survive a green
// run each: a transient-state sampler, two immediate-only pollers, a shell race,
// and at least one golden-suite failure that has still not been explained. The
// declaration bundle should carry a measured rate, not a screenshot.
//
// Usage:
//   node scripts/flake-rate.mjs --runs 5 --label serialised [--tolerate] -- <cmd> [args...]
//
// --tolerate marks a DELIBERATELY hostile configuration (e.g. running the suite
// at full concurrency on a small runner). Its failures are measured and reported
// but do not fail the job, because the point is to characterise behaviour under
// contention, not to gate on it. Without --tolerate, any failure fails the job:
// that is the configuration CI actually gates on, and a flake there is a broken
// gate rather than a curiosity.

import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
if (separator === -1) {
  console.error("flake-rate: expected `-- <command>` in the arguments");
  process.exit(2);
}
const flags = argv.slice(0, separator);
const command = argv.slice(separator + 1);
if (command.length === 0) {
  console.error("flake-rate: no command given after --");
  process.exit(2);
}

function flagValue(name, fallback) {
  const index = flags.indexOf(name);
  return index === -1 ? fallback : flags[index + 1];
}
const runs = Number(flagValue("--runs", "3"));
const label = flagValue("--label", "run");
const tolerate = flags.includes("--tolerate");
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`flake-rate: --runs must be a positive integer, got ${JSON.stringify(runs)}`);
  process.exit(2);
}

const attempts = [];
for (let attempt = 1; attempt <= runs; attempt += 1) {
  const started = Date.now();
  const result = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Both reporters, because Node 22 emits TAP and Node 24 emits `spec`. Reading
  // neither would silently report "no failures" for a failing run.
  const failedTests = [
    ...[...output.matchAll(/^not ok \d+ - (.*)$/gm)].map((match) => match[1].trim()),
    ...[...output.matchAll(/^✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)]
      .map((match) => match[1].trim())
      .filter((name) => name && name !== "failing tests:"),
  ];
  const passed = result.status === 0;
  attempts.push({
    attempt,
    passed,
    exitCode: result.status,
    durationMs: Date.now() - started,
    failedTests: [...new Set(failedTests)],
    // Keep WHY, not just THAT. A rate without the assertion behind it cannot be
    // diagnosed - especially for a flake that only reproduces on CI, where the
    // job log is the single opportunity to see it. Failing attempts only, so a
    // clean run stays readable.
    ...(passed ? {} : { outputTail: output.slice(-6000) }),
  });
  process.stdout.write(
    `${label} ${attempt}/${runs}: ${passed ? "pass" : "FAIL"}` +
      (failedTests.length > 0 ? ` (${[...new Set(failedTests)].join("; ")})` : "") +
      "\n",
  );
  if (!passed) {
    process.stdout.write(`--- ${label} attempt ${attempt} output (tail) ---\n${output.slice(-4000)}\n---\n`);
  }
}

const failures = attempts.filter((entry) => !entry.passed);
// Which tests flaked, and how often. A name appearing in some runs but not all is
// the signature worth chasing; one failing every run is a plain regression.
const byTest = {};
for (const entry of attempts) {
  for (const name of entry.failedTests) byTest[name] = (byTest[name] ?? 0) + 1;
}

const report = {
  label,
  runs,
  passed: runs - failures.length,
  failed: failures.length,
  tolerated: tolerate,
  command: command.join(" "),
  flakiestFirst: Object.entries(byTest).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({
    test: name,
    failedInRuns: count,
    ofRuns: runs,
  })),
  attempts,
};

const out = process.env.ATELIER_FLAKE_REPORT_PATH || `flake-rate-${label}.json`;
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

const summary = `${label}: ${report.passed}/${runs} runs passed` +
  (report.flakiestFirst.length > 0
    ? ` | flakiest: ${report.flakiestFirst.slice(0, 3).map((e) => `${e.test} (${e.failedInRuns}/${runs})`).join(", ")}`
    : "");
process.stdout.write(`\n${summary}\n${tolerate ? "(tolerated configuration - measured, not gated)\n" : ""}`);
process.stdout.write(`report written to ${out}\n`);

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${summary}${tolerate ? " _(tolerated)_" : ""}\n`);
}

process.exit(tolerate || failures.length === 0 ? 0 : 1);
