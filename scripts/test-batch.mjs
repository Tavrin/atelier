#!/usr/bin/env node
// The campaign test batch, in one place so CI and humans cannot drift apart.
//
// Why this exists rather than `node --test`: a bare run discovers every
// *.test.mjs in the tree and then HANGS. It reaches the *.browser.test.mjs
// suites, which need a Chrome binary, and the themes/ suites. On CI a bare run
// sat at 1h13m against a ~70s batch before being cancelled, so that job had
// never actually gated anything.
//
// Node's test runner has no file-level exclude flag (only --test-name-pattern /
// --test-skip-pattern, which filter test NAMES, not files), so the file set is
// enumerated here.
//
// Exclusions, both deliberate:
//   *.browser.test.mjs - require Chrome; run them with a browser available.
//   themes/            - the decorative theme is frozen by owner decision 6 and
//                        its vendored gate projection has drifted behind
//                        ATT-003/ATT-004's merge-blocker reasons (tracked as
//                        atelier-8ty). Including it would mask real regressions
//                        behind known-red tests.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOTS = ["server", "ui", "shared", "test-system"];

function testFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.endsWith(".test.mjs"))
    .filter((entry) => !entry.name.endsWith(".browser.test.mjs"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

const files = ROOTS.flatMap(testFiles).sort();

// An empty batch must fail loudly. A silently-empty test run reports success and
// is indistinguishable from a passing suite.
if (files.length === 0) {
  console.error("test-batch: no test files matched; refusing to report success");
  process.exit(1);
}

// Node defaults test concurrency to the machine's parallelism. This suite spawns
// real dispatchers, git and provider children per file, so on a 4-core CI runner
// four heavy files at once starve each other and time-sensitive tests fail - a
// different small set every run (boot, convoy, claim, lease). That reads as
// flakiness but is contention, and chasing the tests one at a time never
// converges. ATELIER_TEST_CONCURRENCY caps it; CI sets it, and a 32-core
// workstation leaves it alone.
const concurrency = process.env.ATELIER_TEST_CONCURRENCY;
// Bound every test so a hang becomes a failure rather than a silent stall. This
// batch is the mandatory gate; a gate that hangs does not gate (atelier-uub, and
// the pre-f174e02 job that sat at 1h13m). Generous relative to the whole batch's
// ~70s so it cannot fire on ordinary contention.
const timeoutMs = Number(process.env.ATELIER_TEST_TIMEOUT_MS || 120_000);
const options = [
  `--test-timeout=${timeoutMs}`,
  ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
];

console.log(
  `test-batch: running ${files.length} test files` +
    (concurrency ? ` at concurrency ${concurrency}` : ""),
);
// Node options precede the file list; trailing flags are treated as paths.
const result = spawnSync(
  process.execPath,
  ["--test", ...options, ...process.argv.slice(2), ...files],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
