#!/usr/bin/env node
// Proves that `shared/switchgear-contract-pin.test.mjs` actually GATES the Switchgear
// contract, rather than merely passing.
//
// A green contract suite is worth nothing on its own: the failure mode this campaign
// keeps finding is the assertion that could never fail. So each mutation below breaks
// exactly one contract fact in a COPY of the pinned corpus, restamps `PIN.json`'s
// digests so the tamper-evidence check is not the thing that fires, and requires the
// suite to turn red. A mutation that stays green is a hole in the pin, and this script
// exits non-zero and names it.
//
// It also runs the unmutated copy first: if the baseline is red, every "mutation
// detected" below would be a false positive.
//
// Not part of the gated batch (that batch enumerates `*.test.mjs` under server/, ui/,
// shared/ and test-system/). Run it when re-pinning, or when changing the suite:
//
//   node scripts/switchgear-pin-mutation-check.mjs

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST = "shared/switchgear-contract-pin.test.mjs";
const PIN_REL = "contracts/switchgear/contract-v1-rc1";
const PACK = `${PIN_REL}/adapter-v1-contract-fixtures.v1`;

// Each entry: a name, and a function that mutates the copied tree in place.
const MUTATIONS = [
  ["the alias becomes cross-surface consistent", (t) =>
    edit(t, `${PACK}/ok/result.json`, (o) => { o.provider = "opencode-go"; })],
  ["a v1 record is relabelled schema_version 2", (t) =>
    edit(t, `${PACK}/legacy_v1/result.json`, (o) => { o.schema_version = 2; })],
  ["the changed job reports change.state none", (t) =>
    edit(t, `${PACK}/empty_final_text_with_change/result.json`, (o) => { o.change.state = "none"; })],
  ["a frozen change loses its freeze binding", (t) =>
    edit(t, `${PACK}/awaiting_external_review/result.json`, (o) => { o.freeze = null; })],
  ["gc stops protecting awaiting_external_review", (t) =>
    edit(t, `${PACK}/gc_plan.json`, (o) => {
      o.protected = o.protected.filter((e) => e.state !== "awaiting_external_review");
    })],
  ["gc applies an empty collection", (t) =>
    edit(t, `${PACK}/gc_applied.json`, (o) => {
      o.launch_artifacts_removed = []; o.removed = [];
    })],
  ["the manifest declares a future events version", (t) =>
    edit(t, `${PACK}/MANIFEST.json`, (o) => { o.contract_versions.normalized_events_version = 3; })],
  ["the v1 schema gains session_store_id", (t) =>
    edit(t, `${PIN_REL}/schemas/result-v1.schema.json`, (o) => {
      o.properties.session_store_id = { type: "string" };
    })],
  ["a crashed job loses its harness attribution", (t) =>
    edit(t, `${PACK}/crashed_launch_only/jobs-row.json`, (o) => { delete o.harness; })],
  // The second adversarial review found each of the following green. They are kept as
  // permanent regressions so the holes cannot silently reopen.
  ["the model subtree becomes garbage (a $ref'd shape)", (t) =>
    edit(t, `${PACK}/needs_input/result.json`, (o) => { o.model = { anything: true }; })],
  ["the model subtree gains an unknown key", (t) =>
    edit(t, `${PACK}/ok/result.json`, (o) => { o.model.bogus_key = [1, 2]; })],
  ["a scenario's transcript meaning is scrambled", (t) =>
    edit(t, `${PACK}/ok/events.v2.jsonl`, (lines) =>
      lines.map((l) => (l.event === "finished" ? { ...l, final_text_state: "empty" } : l)))],
  ["awaiting_external_review's transcript reports failed", (t) =>
    edit(t, `${PACK}/awaiting_external_review/events.v2.jsonl`, (lines) =>
      lines.map((l) => (l.event === "finished" ? { ...l, status: "failed" } : l)))],
  ["needs_input claims it saw a terminal event", (t) =>
    edit(t, `${PACK}/needs_input/events.v2.jsonl`, (lines) =>
      lines.map((l) => (l.event === "finished" ? { ...l, sawTerminal: true } : l)))],
  ["harness and pool become meaningless tokens", (t) => {
    for (const s of ["dirty", "needs_input", "provider_error", "legacy_v1"]) {
      edit(t, `${PACK}/${s}/jobs-row.json`, (o) => { o.harness = "X"; o.pool = "Y"; });
    }
  }],
  ["the digest projection stops stamping digest_v", (t) => {
    for (const s of ["ok", "dirty"]) {
      edit(t, `${PACK}/${s}/logs-digest.json`, (o) => {
        delete o.digest_v;
        for (const e of o.events) delete e.digest_v;
      });
    }
  }],
  ["the normalized projection disagrees with the durable file", (t) =>
    edit(t, `${PACK}/ok/logs-normalized.json`, (o) => { o.events = [{ event: "text", content: "x", v: 2 }]; })],
  ["the session binding schema is replaced with garbage", (t) =>
    edit(t, `${PIN_REL}/schemas/session-binding.schema.json`, () => ({ total: "garbage" }))],
  ["a record's status contradicts its four facts", (t) =>
    edit(t, `${PACK}/ok/result.json`, (o) => { o.status = "timeout"; })],
  ["the legacy record's execution outcome is rewritten", (t) =>
    edit(t, `${PACK}/legacy_v1/result.json`, (o) => {
      o.status = "provider_error"; o.execution.outcome = "timeout";
    })],
  ["a record violates a schema bound", (t) =>
    edit(t, `${PACK}/dirty/result.json`, (o) => { o.generation = -99; })],
  ["the pin names a different source repository", (t) =>
    edit(t, `${PIN_REL}/PIN.json`, (o) => { o.source.repository = "attacker/fork"; })],
  ["a vendored surface file is emptied", (t) =>
    edit(t, `${PACK}/dirty/logs-normalized.json`, () => ({ totally: "unrelated" }))],
];

function edit(tree, relPath, mutate) {
  const path = join(tree, relPath);
  if (relPath.endsWith(".jsonl")) {
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const next = mutate(lines) ?? lines;
    writeFileSync(path, next.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return;
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  const next = mutate(value) ?? value;
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
}

// Restamp so the digest check is not what fires. Without this every mutation would be
// "detected" by tamper-evidence alone and the contract assertions would go unexercised --
// the script would prove nothing about what it claims to prove.
function restamp(tree) {
  const root = join(tree, PIN_REL);
  const pin = JSON.parse(readFileSync(join(root, "PIN.json"), "utf8"));
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath ?? e.path, e.name)))
    .filter((p) => p !== "PIN.json" && p !== "README.md")
    .sort();
  pin.vendored.sha256 = Object.fromEntries(
    files.map((p) => [p, createHash("sha256").update(readFileSync(join(root, p))).digest("hex")]),
  );
  pin.vendored.file_count = files.length;
  writeFileSync(join(root, "PIN.json"), JSON.stringify(pin, null, 2) + "\n");
}

function runSuite(tree) {
  return spawnSync(process.execPath, ["--test", TEST], { cwd: tree, encoding: "utf8" }).status === 0;
}

let failures = 0;
const trees = [];
try {
  // Baseline. If this is red, every result below is meaningless.
  const base = mkdtempSync(join(tmpdir(), "sg-pin-base-"));
  trees.push(base);
  cpSync(join(ROOT, "contracts"), join(base, "contracts"), { recursive: true });
  cpSync(join(ROOT, "shared"), join(base, "shared"), { recursive: true });
  if (!runSuite(base)) {
    console.error("BASELINE IS RED — fix the suite before trusting any mutation result.");
    process.exit(2);
  }
  console.log("baseline: green\n");

  for (const [name, mutate] of MUTATIONS) {
    const tree = mkdtempSync(join(tmpdir(), "sg-pin-mut-"));
    trees.push(tree);
    cpSync(join(ROOT, "contracts"), join(tree, "contracts"), { recursive: true });
    cpSync(join(ROOT, "shared"), join(tree, "shared"), { recursive: true });
    mutate(tree);
    restamp(tree);
    const stillGreen = runSuite(tree);
    if (stillGreen) failures += 1;
    console.log(`${stillGreen ? "NOT DETECTED  " : "detected      "} ${name}`);
  }
} finally {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
}

console.log(
  `\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected` +
    (failures ? ` — ${failures} HOLE(S) IN THE PIN` : ""),
);
process.exit(failures === 0 ? 0 : 1);
