#!/usr/bin/env node
/**
 * Fixture generator — the archive is THIS repo's real history.
 *
 * Slice V develops ahead of slice S (the substrate). Rather than invent a
 * demo, this reads the atelier repository's own git log and writes fixtures
 * shaped exactly like the substrate's documented projections:
 *
 *   chronicle.json   ← GET /api/projects/:p/chronicle   (records[] + stats)
 *   dispatches.json  ← GET /api/dispatches               (exposedRecord[])
 *
 * Every merged record's id, ticket, branch slug, commit, timestamp and
 * footprint (insertions/deletions/files) is MEASURED from git. Only the
 * fields git cannot know - cost, review rounds, verify attempts - are
 * synthesised, and they are synthesised deterministically from the commit
 * sha so the demo is stable across runs and nobody can mistake a reroll
 * for a data change.
 *
 * Usage:  node themes/cozy-village/data/fixtures/generate.mjs [repoDir]
 */

import { execFileSync } from "node:child_process";

import { gatesFor } from "../../../../server/lib/world-contract.mjs";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.argv[2] ?? resolve(HERE, "../../../.."));

const git = (...args) =>
  execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/* ── deterministic synthesis ──────────────────────────────────────────────
   A sha-seeded PRNG. The same commit always gets the same cost, so a
   regenerated fixture diffs cleanly and "the numbers moved" always means
   the history moved.                                                       */
function seedFrom(sha) {
  let h = 2166136261;
  for (const ch of sha) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/* Lane/model assignment. Atelier has no persistent agent identity: a villager
   is a lane+model pair, so the fixture assigns one per merge from the sha,
   weighted the way this program actually ran (sonnet did most of the work,
   opus took the architecture, codex reviewed and occasionally built). */
const CAST = [
  { villager: "tobin", lane: "claude", model: "sonnet", weight: 34 },
  { villager: "juniper", lane: "claude", model: "sonnet[1m]", weight: 18 },
  { villager: "wren", lane: "claude", model: "opus", weight: 16 },
  { villager: "marisol", lane: "claude", model: "opus[1m]", weight: 12 },
  { villager: "pell", lane: "claude", model: "haiku", weight: 10 },
  { villager: "alder", lane: "codex", model: "gpt-5.4-codex", weight: 10 },
];
const CAST_TOTAL = CAST.reduce((n, c) => n + c.weight, 0);
function castFor(rand) {
  let roll = rand() * CAST_TOTAL;
  for (const c of CAST) {
    roll -= c.weight;
    if (roll <= 0) return c;
  }
  return CAST[0];
}

/** Branch slug from a merge subject - the "title-ish" field the chronicle serves. */
function titleFrom(subject) {
  return subject
    .replace(/^merge:\s*/, "")
    .replace(/^atelier dispatch [0-9a-f]+\s*\(([^)]+)\)\s*/, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function ticketFrom(subject) {
  const explicit = subject.match(/\((atelier-[a-z0-9]+)[^)]*\)/);
  if (explicit) return explicit[1];
  const inline = subject.match(/\b(atelier-[a-z0-9]{3,4})\b/);
  return inline ? inline[1] : null;
}

/** Dispatch id from the subject when the merge names one, else the sha head. */
function dispatchIdFrom(subject, sha) {
  const named = subject.match(/atelier dispatch ([0-9a-f]{6,})/);
  return named ? named[1] : sha.slice(0, 8);
}

function branchFrom(subject, ticket) {
  const arch = subject.match(/(atelier-arch\/[a-z0-9-]+)/);
  if (arch) return arch[1];
  const slug = titleFrom(subject)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .split("-")
    .slice(0, 5)
    .join("-");
  return `atelier/${slug || ticket || "work"}`;
}

/* ── read the real merges ─────────────────────────────────────────────── */
const RAW = git(
  "log",
  "--format=%H%h%aI%s",
  "--grep=^merge:",
  "-60",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, short, iso, subject] = line.split("");
    return { sha, short, iso, subject };
  });

const records = RAW.map((m) => {
  const stat = git("diff", "--shortstat", `${m.sha}^1`, m.sha).trim();
  const num = (re) => Number((stat.match(re) ?? [, 0])[1]);
  const insertions = num(/(\d+) insertion/);
  const deletions = num(/(\d+) deletion/);
  const files = num(/(\d+) file/);

  const rand = seedFrom(m.sha);
  const cast = castFor(rand);
  const ticketId = ticketFrom(m.subject);
  const churn = insertions + deletions;

  /* Cost tracks churn with real spread. Codex never reports cost
     (reportsCost:false in server/lib/agents/codex.mjs) so its records
     carry null - the village must render "cost not reported", not 0. */
  const costUSD =
    cast.lane === "codex"
      ? null
      : Number((0.55 + (churn / 1000) * (1.8 + rand() * 2.6) + rand() * 0.9).toFixed(2));

  /* Review rounds: most land in one, the big ones took two or three -
     which is what this program's own history shows (see the "round-two"
     and "round-three" fix commits in the log). */
  const rounds = churn > 2500 ? (rand() > 0.45 ? 3 : 2) : churn > 700 ? (rand() > 0.6 ? 2 : 1) : 1;
  const verifyAttempts = churn > 1500 && rand() > 0.62 ? 2 : 1;

  /* postMerge: the one unresolved red is pinned deliberately (see below);
     everything else passed, except the tracker-only merges git shows as
     1-2 line changes, which never triggered a main check at all. */
  /* postMerge.state enum is queued|running|passed|failed|skipped. A project
     with no verify commands gets "skipped" with an empty `steps` - the
     zero-check case that atelier-kg5 forbids reading as a pass. Tracker-only
     merges here are exactly that case. Failures WITH steps carry
     `evidenceTail`; only pre-step failures carry `error`. */
  const postMerge =
    churn <= 20
      ? { state: "skipped", commit: m.short, steps: [], queuedAt: m.iso, startedAt: m.iso, endedAt: m.iso }
      : {
          state: "passed",
          commit: m.short,
          steps: [{ command: "node --test server/**/*.test.mjs", exitCode: 0, durationMs: 41200 + Math.round(rand() * 30000), tail: "# pass 1184" }],
          queuedAt: m.iso,
          startedAt: m.iso,
          endedAt: m.iso,
          testedTree: m.short,
        };

  return {
    id: dispatchIdFrom(m.subject, m.sha),
    project: "atelier",
    ticketId,
    title: titleFrom(m.subject),
    branch: branchFrom(m.subject, ticketId),
    lane: cast.lane,
    model: cast.model,
    villager: cast.villager,
    // A merged record stays `completed`; `merged` being set is what merged means.
    state: "completed",
    startedAt: new Date(new Date(m.iso).getTime() - (900_000 + Math.round(rand() * 9_000_000))).toISOString(),
    endedAt: m.iso,
    // `mergedAt` is nested inside `merged` on a record; the chronicle
    // projection flattens it alongside. Both are emitted, as S will serve them.
    mergedAt: m.iso,
    merged: { commit: m.short, mergedAt: m.iso, strategy: "primary-merge" },
    costUSD,
    // Chronicle counts (the projection's shape). A live record carries arrays.
    verify: { state: "passed", attempts: verifyAttempts },
    review: { verdict: "pass", current: { verdict: "pass", round: rounds }, rounds },
    postMerge,
    outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
    diff: { insertions, deletions, files },
    orphanUnresolved: false,
  };
});

/* ── the one unresolved main-health failure ──────────────────────────────
   The village's memory is append-only INCLUDING its mistakes: one merged
   dock parcel wears a scaffold that will not come off. Pinned to a real
   merge so the demo shows the real rule - only a later passing merge
   commit resolves a post-merge failure; acknowledging only dims the lamp. */
const SCAFFOLD = records.find((r) => r.ticketId === "atelier-za6");
if (SCAFFOLD) {
  SCAFFOLD.postMerge = {
    state: "failed",
    commit: SCAFFOLD.merged.commit,
    // A failure WITH steps carries evidenceTail, never `error` - `error` is
    // written only for pre-step failures (crash, restart, shutdown).
    steps: [{ command: "node --test server/lib/dispatch.test.mjs", exitCode: 1, durationMs: 38400, tail: "not ok 41" }],
    evidenceTail:
      "not ok 41 - reaper leaves a live observer alone\n  # identity mismatch: pid 481203 recycled",
    testedTree: SCAFFOLD.merged.commit,
    queuedAt: SCAFFOLD.mergedAt,
    startedAt: SCAFFOLD.mergedAt,
    endedAt: SCAFFOLD.mergedAt,
    acknowledgedAt: null,
    resolvedAt: null,
  };
}

/* ── summary stats: the scorecard numbers the chronicle serves ─────────── */
const withCost = records.filter((r) => typeof r.costUSD === "number");
const spendMerged = withCost.reduce((n, r) => n + r.costUSD, 0);
const reviewed = records.filter((r) => Number.isInteger(r.review?.rounds) && r.review.rounds > 0);
const firstRound = reviewed.filter((r) => r.review.rounds === 1).length;

const chronicle = {
  project: "atelier",
  generatedAt: new Date().toISOString(),
  provenance: `derived from ${RAW.length} real 'merge:' commits in the atelier repository`,
  records,
  stats: {
    merges: records.length,
    firstPassReviews: firstRound,
    reviewedMerges: reviewed.length,
    reviewPassRate: reviewed.length ? firstRound / reviewed.length : null,
    spendMergedUSD: Number(spendMerged.toFixed(2)),
    costPerMergeUSD: withCost.length ? Number((spendMerged / withCost.length).toFixed(2)) : null,
    /* Unlanded spend is the uncomfortable number: money spent on dispatches
       that never became a merge. Taken from the live fixture below. */
    unlandedSpendUSD: 0,
    costUnreported: records.length - withCost.length,
    insertions: records.reduce((n, r) => n + r.diff.insertions, 0),
    deletions: records.reduce((n, r) => n + r.diff.deletions, 0),
    mainUnresolved: records.filter((r) => r.postMerge?.state === "failed" && !r.postMerge.resolvedAt).length,
  },
};


/**
 * The server's review shape: `reviewState()` returns `{ ...current, current,
 * rounds }` - every field of the latest round is ALSO mirrored at the top
 * level for older consumers. A fixture that omits the mirror would not match
 * what the API actually serves.
 */
function buildReview(rounds) {
  const current = rounds.at(-1);
  return { ...current, current, rounds };
}

/* ── live dispatches: mixed states, real branch names from today ──────────
   Seven in-flight records covering every state the village must draw:
   awaiting-merge, needs_input with a REAL question, verify failed,
   running, review running, fogged/indeterminate, completed-empty.
   Branch names and ticket ids are today's real ones.                       */
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

const live = [
  {
    id: "c7d21a94",
    project: "atelier",
    ticketId: "atelier-8r6",
    title: "needs_input outcome detection - fail-closed classification",
    branch: "atelier-arch/needs-input-residuals",
    branchHead: "c41f9a2e",
    lane: "claude",
    model: "opus",
    villager: "wren",
    state: "completed",
    startedAt: hoursAgo(3.4),
    endedAt: hoursAgo(0.6),
    costUSD: 7.14,
    turns: 38,
    outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
    verify: {
      state: "passed",
      attempt: 1,
      steps: [{ command: "node --test server/**/*.test.mjs", exitCode: 0, durationMs: 44120, tail: "# pass 1184" }],
      attempts: [{ state: "passed", attempt: 1, steps: [] }],
      testedTree: "c41f9a2e",
      mainBranch: "main",
      commitsBehind: 0,
    },
    review: buildReview([
      {
        dispatchId: "1d90b7c4",
        round: 1,
        at: hoursAgo(0.7),
        reviewedHead: "c41f9a2e",
        verdict: "pass",
        findingCount: 0,
        summary:
          "Attacked the classifier on the three shapes I distrusted - a trailing question inside a quoted span, a plan that ends in a question mark, and an empty diff with a question. Fail-closed holds on all three. No new terminal state leaks into the board.",
      },
    ]),
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    exitSummary: "Classifier now fails closed; three shapes covered by tests.",
    diff: { insertions: 214, deletions: 33, files: 6 },
  },
  {
    id: "3f80b6e2",
    project: "atelier",
    ticketId: "atelier-2q6",
    title: "review round history - trajectory parking follow-up",
    branch: "atelier-arch/review-rounds-followup",
    branchHead: "77b1e004",
    lane: "claude",
    model: "sonnet",
    villager: "tobin",
    state: "needs_input",
    startedAt: hoursAgo(1.2),
    costUSD: 1.86,
    turns: 11,
    outcome: {
      kind: "needs_input",
      changes: "empty",
      finalMessage: "retrieved",
      question:
        "Parking a stalled thread drops its rounds from the active view. Should a parked round still count against reviewPassRate in the chronicle stats, or is a parked thread excluded from the denominator entirely? I can argue both and the choice changes the scorecard.",
      detectedAt: hoursAgo(0.2),
    },
    // Nothing to verify - this dispatch is waiting on an answer. The server
    // writes exactly this detail for that case.
    verify: { state: "skipped", detail: "nothing to verify - this dispatch is waiting on an answer", steps: [] },
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    diff: { insertions: 0, deletions: 0, files: 0 },
  },
  {
    id: "a15c9d77",
    project: "atelier",
    ticketId: "atelier-fo5",
    title: "resume-path hygiene - redaction parity across lanes",
    branch: "atelier-arch/redaction-parity",
    branchHead: "5aa20c31",
    lane: "claude",
    model: "sonnet[1m]",
    villager: "juniper",
    state: "verifying",
    startedAt: hoursAgo(0.9),
    costUSD: 2.41,
    turns: 19,
    outcome: { kind: null, changes: "changed", question: null, finalMessage: "retrieved" },
    verify: { state: "running", attempt: 1, steps: [], startedAt: hoursAgo(0.15), attempts: [] },
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    diff: { insertions: 147, deletions: 22, files: 5 },
  },
  {
    id: "6b2e40f1",
    project: "atelier",
    ticketId: "atelier-9dt",
    title: "verify re-run - race-safe capacity on boot repair",
    branch: "atelier-arch/verify-rerun-capacity",
    branchHead: "b0c7d199",
    lane: "claude",
    model: "sonnet",
    villager: "tobin",
    state: "completed",
    startedAt: hoursAgo(5.1),
    endedAt: hoursAgo(1.9),
    costUSD: 3.28,
    turns: 26,
    outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
    verify: {
      state: "failed",
      attempt: 2,
      testedTree: "b0c7d199",
      mainBranch: "main",
      commitsBehind: 3,
      steps: [
        {
          command: "node --test server/lib/dispatch.test.mjs",
          exitCode: 1,
          durationMs: 51900,
          tail: "not ok 118 - re-run reuses a freed capacity slot\n  expected 2 running, got 3",
        },
      ],
      // Append-only history: attempt 1 failed too, on the same step.
      attempts: [
        { state: "failed", attempt: 1, steps: [{ command: "node --test server/lib/dispatch.test.mjs", exitCode: 1, durationMs: 50100, tail: "not ok 118" }] },
        { state: "failed", attempt: 2, steps: [{ command: "node --test server/lib/dispatch.test.mjs", exitCode: 1, durationMs: 51900, tail: "not ok 118" }] },
      ],
    },
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    diff: { insertions: 331, deletions: 47, files: 8 },
  },
  {
    id: "d904ce38",
    project: "atelier",
    ticketId: "atelier-e5x",
    title: "event log - drain tracing follow-up",
    branch: "atelier-arch/event-log-drain",
    branchHead: "d1e88a70",
    lane: "claude",
    model: "opus[1m]",
    villager: "marisol",
    state: "completed",
    startedAt: hoursAgo(4.2),
    endedAt: hoursAgo(0.4),
    costUSD: 9.05,
    turns: 52,
    outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
    verify: {
      state: "passed",
      attempt: 1,
      steps: [{ command: "node --test server/**/*.test.mjs", exitCode: 0, durationMs: 46800, tail: "# pass 1184" }],
      attempts: [{ state: "passed", attempt: 1, steps: [] }],
      testedTree: "d1e88a70",
      mainBranch: "main",
      commitsBehind: 1,
    },
    review: buildReview([
      { dispatchId: "77c04b12", round: 1, at: hoursAgo(2.6), reviewedHead: "9f2b1e77", verdict: "fail", findingCount: 3, summary: "Three blockers: the drain trace loses its cursor across a restart, the spend readout double-counts a re-run, and the log tap is not total." },
      { dispatchId: "0ab3f951", round: 2, at: hoursAgo(0.5), reviewedHead: "d1e88a70", verdict: "fail", findingCount: 2, summary: "Two still open. The cursor survives a restart now, but the spend readout still double-counts a re-run, and the drain trace loses its parent span when the queue parks." },
    ]),
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    diff: { insertions: 688, deletions: 91, files: 12 },
  },
  {
    id: "72af1b05",
    project: "atelier",
    ticketId: "atelier-za6",
    title: "codex reaper - observer-safe gc residuals",
    branch: "atelier-arch/codex-reaper-residuals",
    branchHead: null,
    lane: "codex",
    model: "gpt-5.4-codex",
    villager: "alder",
    state: "running",
    startedAt: hoursAgo(2.7),
    costUSD: null,
    turns: null,
    /* Three named indeterminacies at once. This is the marked parcel: Atelier
       drawing its own blindness, never inferring death from silence. */
    outcome: { kind: null, changes: "unknown", question: null, finalMessage: "unavailable" },
    verify: null,
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: true,
    strandedBrWrites: false,
    diff: null,
  },
  {
    id: "1c46fa9b",
    project: "atelier",
    ticketId: "atelier-vke",
    title: "queue un-park MCP tool - schema drift guard",
    branch: "atelier-arch/queue-unpark-schema",
    branchHead: "0f31ab6d",
    lane: "claude",
    model: "haiku",
    villager: "pell",
    state: "completed",
    startedAt: hoursAgo(1.6),
    endedAt: hoursAgo(1.1),
    costUSD: 0.41,
    turns: 7,
    /* Ran, found nothing to carry forward. NOT a failure - dismiss is the
       right action, and the village must not slander it as a red gate. */
    outcome: { kind: "completed_empty", changes: "empty", question: null, finalMessage: "retrieved" },
    // "nothing to verify - this dispatch produced no changes" is the server's
    // own wording for the empty-diff skip.
    verify: { state: "skipped", detail: "nothing to verify - this dispatch produced no changes", steps: [] },
    review: null,
    merged: null,
    dismissed: null,
    postMerge: null,
    orphanUnresolved: false,
    strandedBrWrites: false,
    exitSummary: "Schema already covered queueFailureLimit; nothing to change.",
    diff: { insertions: 0, deletions: 0, files: 0 },
  },
];

live.push({
  id: "e58d3c60",
  project: "atelier",
  ticketId: "atelier-def",
  title: "settings schema drift guard - MCP parity residuals",
  branch: "atelier-arch/settings-drift-guard",
  branchHead: "3c7710ab",
  lane: "claude",
  model: "sonnet",
  villager: "tobin",
  state: "completed",
  startedAt: hoursAgo(2.2),
  endedAt: hoursAgo(0.3),
  costUSD: 2.02,
  turns: 16,
  outcome: { kind: "completed", changes: "changed", question: null, finalMessage: "retrieved" },
  verify: {
    state: "passed",
    attempt: 1,
    steps: [{ command: "node --test server/**/*.test.mjs", exitCode: 0, durationMs: 43310, tail: "# pass 1184" }],
    attempts: [{ state: "passed", attempt: 1, steps: [] }],
    testedTree: "3c7710ab",
    mainBranch: "main",
    commitsBehind: 0,
  },
  // Verify passed and nobody has looked at it yet: the parcel remains at the
  // workshop until review actually starts.
  review: null,
  merged: null,
  dismissed: null,
  postMerge: null,
  orphanUnresolved: false,
  strandedBrWrites: false,
  exitSummary: "Drift guard covers every settings field the MCP schema exposes.",
  diff: { insertions: 268, deletions: 41, files: 7 },
});

chronicle.stats.unlandedSpendUSD = Number(
  live
    .filter((r) => !r.merged && typeof r.costUSD === "number")
    .reduce((n, r) => n + r.costUSD, 0)
    .toFixed(2),
);

const convoy = {
  id: "cv-71a4",
  project: "atelier",
  label: "theme substrate + flagship world",
  ticketIds: ["atelier-2q6", "atelier-e5x", "atelier-yqk", "atelier-8r6", "atelier-9dt", "atelier-za6", "atelier-def"],
  cursor: 3,
  state: "running",
  completedConvoys: 6,
};

/* Every fixture record carries the SERVER's five-gate projection, so the
   fixture village and the live village are drawn from the same facts.
   Measured parity between this theme's local port and the substrate's
   projection was 67.5% across 750 live gate slots - a fixture built on the
   port would demo a village drawn from different facts than the dashboard.
   This is also what quarantines the port: with `gates` present, `gatesOf`
   reports source "server" and the local derivation is never reached.
   The generator is a dev tool and may import the server contract; the
   theme's runtime never does. */
/* `state/server-gates.mjs` shares review assessment with core directly. Its
   remaining small fixture-side projection is held to the server by the full
   corpus parity test instead of source-copy generation. */

for (const record of live) record.gates = gatesFor(record);
for (const record of chronicle.records) record.gates = gatesFor(record);

writeFileSync(resolve(HERE, "chronicle.json"), `${JSON.stringify(chronicle, null, 2)}\n`);
writeFileSync(
  resolve(HERE, "dispatches.json"),
  `${JSON.stringify({ project: "atelier", dispatches: live, convoy }, null, 2)}\n`,
);

process.stdout.write(
  `wrote chronicle.json (${records.length} real merges, ` +
    `${chronicle.stats.insertions}+/${chronicle.stats.deletions}- measured) ` +
    `and dispatches.json (${live.length} live)\n`,
);
