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

console.log(`test-batch: running ${files.length} test files`);
const result = spawnSync(process.execPath, ["--test", ...files, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
