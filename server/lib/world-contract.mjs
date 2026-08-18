import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  assessReview,
  reviewFindingSet,
  reviewRoundsFor,
} from "../../shared/review-assessment.mjs";

export { reviewRoundsFor };

const CHANGES_PENDING_STATES = new Set([
  "queued",
  "preparing",
  "resuming",
  "running",
  "plan_ready",
  "stopping",
]);

const PENDING_STATES = new Set(["queued", "preparing", "running", "pending", "resuming"]);
const PASSED_STATES = new Set(["pass", "passed"]);
const FAILED_STATES = new Set(["error", "fail", "failed", "malformed"]);
const SKIPPED_STATES = new Set(["skip", "skipped"]);
export const CHRONICLE_LIMIT = 500;
const ARTIFACT_ROOTS = Object.freeze([
  Object.freeze({ kind: "spec", path: join("docs", "specs") }),
  Object.freeze({ kind: "design", path: join("docs", "design") }),
]);

function parkedTicketId(ticket) {
  return typeof ticket === "string" ? ticket : ticket?.ticketId ?? ticket?.id ?? null;
}

/**
 * The one ready-work projection exposed to every dashboard and theme.
 *
 * `readyTicketIds` is the tracker's own `br ready` snapshot. Atelier maps those
 * ids back to the unchanged issue records and removes tickets parked by its
 * dispatcher queue without independently interpreting tracker fields.
 */
export function readyIssuesFor(issues = [], readyTicketIds = [], parkedTickets = []) {
  const records = Array.isArray(issues) ? issues : [];
  const byId = new Map(
    records
      .filter((issue) => typeof issue?.id === "string" && issue.id)
      .map((issue) => [issue.id, issue]),
  );
  const parked = new Set(
    (Array.isArray(parkedTickets) ? parkedTickets : [])
      .map(parkedTicketId)
      .filter(Boolean),
  );

  return [...readyTicketIds]
    .map((ticketId) => byId.get(ticketId))
    .filter((issue) => issue && !parked.has(issue.id));
}

function staysInside(root, target) {
  const segment = relative(root, target);
  return segment === "" || (
    !isAbsolute(segment) &&
    segment !== ".." &&
    !segment.startsWith(`..${sep}`)
  );
}

function artifactTitle(source, filePath) {
  const heading = String(source).match(/^\s{0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/m);
  if (heading?.[1]?.trim()) return heading[1].trim();
  return filePath.split("/").at(-1).replace(/\.md$/i, "");
}

function snapshotArtifactRoot(projectRoot, rootSpec) {
  const root = resolve(projectRoot, rootSpec.path);
  if (!staysInside(projectRoot, root)) {
    throw new Error(`Artifact root escapes project: ${rootSpec.path}`);
  }

  let rootDetails;
  try {
    rootDetails = lstatSync(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (rootDetails.isSymbolicLink()) {
    throw new Error(`Artifact root must not be a symbolic link: ${rootSpec.path}`);
  }
  if (!rootDetails.isDirectory()) return [];

  const canonicalProject = realpathSync(projectRoot);
  const canonicalRoot = realpathSync(root);
  if (!staysInside(canonicalProject, canonicalRoot)) {
    throw new Error(`Artifact root escapes project: ${rootSpec.path}`);
  }

  const artifacts = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = join(directory, entry.name);
      const relativeTarget = relative(root, target);
      if (!staysInside(root, target)) {
        throw new Error(`Artifact path escapes docs root: ${relativeTarget}`);
      }
      const details = lstatSync(target);
      if (entry.isSymbolicLink() || details.isSymbolicLink()) {
        throw new Error(`Artifact path must not use symbolic links: ${relativeTarget}`);
      }
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;

      const canonicalTarget = realpathSync(target);
      if (!staysInside(canonicalRoot, canonicalTarget)) {
        throw new Error(`Artifact path escapes docs root: ${relativeTarget}`);
      }
      const path = relative(projectRoot, target).split(sep).join("/");
      const source = readFileSync(target, "utf8");
      artifacts.push(Object.freeze({
        kind: rootSpec.kind,
        title: artifactTitle(source, path),
        path,
        updatedAt: details.mtime.toISOString(),
      }));
    }
  };
  walk(root);
  return artifacts;
}

/**
 * Boot-snapshot the markdown artifacts a theme may browse. The roots and file
 * set are fixed by the world contract; request data can never select a path.
 * Every path component is lstat'd and canonical containment is checked before
 * a byte is read, so a symlink cannot turn the index into a project-file
 * browser.
 */
export function artifactsForProject(project, {
  generatedAt = new Date().toISOString(),
} = {}) {
  const projectRoot = resolve(project.path);
  const artifacts = ARTIFACT_ROOTS
    .flatMap((rootSpec) => snapshotArtifactRoot(projectRoot, rootSpec))
    .sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    project: project.name,
    generatedAt,
    artifacts: Object.freeze(artifacts),
  });
}

export function snapshotProjectArtifacts(projects, options = {}) {
  return new Map(
    projects.map((project) => [
      project.name,
      artifactsForProject(project, options),
    ]),
  );
}

function gate(gateName, state, detail = undefined) {
  return { gate: gateName, state, ...(detail ?? {}) };
}

function mappedVerdict(value) {
  if (typeof value !== "string") return "unknown";
  if (value === "passed-with-dispositions") return value;
  if (PASSED_STATES.has(value)) return "passed";
  if (FAILED_STATES.has(value)) return "failed";
  if (SKIPPED_STATES.has(value)) return "skipped";
  if (PENDING_STATES.has(value)) return "pending";
  return "unknown";
}

function verifyVerdict(record) {
  const verify = record?.verify;
  if (!verify || typeof verify !== "object") return undefined;
  if (typeof verify.state === "string") return verify.state;
  if (!Array.isArray(verify.attempts) || verify.attempts.length === 0) return null;
  return verify.attempts.at(-1)?.state ?? null;
}

function changesGate(record) {
  const changes = record?.outcome?.changes;
  if (changes === "changed") return "passed";
  if (changes === "empty") return "empty";
  if (changes === "unknown") return "unknown";
  if (changes !== undefined && changes !== null) return "unknown";
  if (record?.state === "completed_empty") return "empty";
  if (record?.readOnly === true || record?.reviewOf) return "skipped";
  if (record?.merged && !record.merged.forcedBy) return "passed";
  const verify = verifyVerdict(record);
  if (verify && verify !== "skipped") return "passed";
  if (CHANGES_PENDING_STATES.has(record?.state)) return "pending";
  if (record?.outcome && typeof record.outcome === "object") return "unknown";
  if (["completed", "completed_empty", "needs_input", "failed"].includes(record?.state)) {
    return "unknown";
  }
  return "not-run";
}

function verifyGate(record) {
  const verdict = verifyVerdict(record);
  if (verdict !== undefined) return verdict === null ? "unknown" : mappedVerdict(verdict);
  if (record?.verifyRequested === false || record?.readOnly === true || record?.reviewOf) {
    return "skipped";
  }
  if (record?.merged && !record.merged.forcedBy) return "skipped";
  return "not-run";
}

function reviewGate(record) {
  return assessReview(record, { requireReview: true }).gateState;
}

function mergeGate(record) {
  if (record?.merged?.forcedBy) return "bypassed";
  if (record?.merged) return "passed";
  if (record?.dismissed) return "skipped";
  if (record?.state === "completed" && !record?.reviewOf && record?.readOnly !== true) {
    return "pending";
  }
  return "not-run";
}

function mainGate(record) {
  if (!record?.merged) return "not-run";
  if (!record?.postMerge) return "not-run";
  const verdict = mappedVerdict(record.postMerge.state);
  if (
    verdict === "passed" &&
    (
      !Array.isArray(record.postMerge.steps) ||
      !record.postMerge.steps.some((step) => Number(step?.exitCode) === 0)
    )
  ) {
    return "not-run";
  }
  return verdict;
}

// The one five-gate projection used by every public record. Each gate reports
// its own observed verdict; a forced merge can therefore show failed verify or
// review gates alongside a bypassed merge gate without rewriting history.
export function gatesFor(record) {
  const mergeAudit = record?.merged &&
    typeof record.merged.forcedBy === "string" &&
    typeof record.merged.reason === "string" &&
    typeof record.merged.dispositionRef === "string"
    ? {
        forcedBy: record.merged.forcedBy,
        reason: record.merged.reason,
        dispositionRef: record.merged.dispositionRef,
        targetSha: record.merged.targetSha,
        tokenId: record.merged.tokenId,
        mintedAt: record.merged.mintedAt,
        consumedAt: record.merged.consumedAt,
      }
    : undefined;
  return [
    gate("changes", changesGate(record)),
    gate("verify", verifyGate(record)),
    gate("review", reviewGate(record)),
    gate("merge", mergeGate(record), mergeAudit),
    gate("main", mainGate(record)),
  ];
}

function branchTitle(record) {
  const explicit = typeof record?.title === "string" ? record.title.trim() : "";
  if (explicit) return explicit;
  const branch = typeof record?.branch === "string" ? record.branch.trim() : "";
  if (!branch) return record?.ticketId || record?.id || "merged work";
  const slug = branch.split("/").filter(Boolean).at(-1) || branch;
  const suffix = record?.id ? `-${record.id}` : "";
  return suffix && slug.endsWith(suffix) ? slug.slice(0, -suffix.length) : slug;
}

function numericCost(record) {
  const value = Number(record?.costUSD);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function chronicleFor(records, project, {
  generatedAt = new Date().toISOString(),
  limit = CHRONICLE_LIMIT,
  diffStatsForRecords,
  historyRecords = [],
} = {}) {
  const projectRecords = (Array.isArray(records) ? records : [])
    .filter((record) => record?.project === project && !record.reviewOf);
  const recordedMerged = projectRecords.filter((record) => record.merged?.mergedAt);
  const recordedCommits = new Set(
    recordedMerged
      .map((record) => String(record.merged?.commit ?? ""))
      .filter(Boolean),
  );
  const recordedIds = new Set(recordedMerged.map((record) => String(record.id)));
  const historicalMerged = (Array.isArray(historyRecords) ? historyRecords : [])
    .filter((record) =>
      record?.project === project &&
      record.merged?.mergedAt &&
      !record.reviewOf &&
      !recordedCommits.has(String(record.merged?.commit ?? "")) &&
      !recordedIds.has(String(record.id)));
  const merged = [...recordedMerged, ...historicalMerged]
    .sort((left, right) =>
      String(left.merged.mergedAt).localeCompare(String(right.merged.mergedAt)) ||
      String(left.id).localeCompare(String(right.id)));
  const bounded = merged.slice(-Math.max(1, limit));
  /* Git-backfilled merges deliberately carry no review history. They are real
     merges, but they are not evidence about review efficiency. Keep both the
     rate and its basis on the merged records whose review rounds Atelier
     actually observed, so history discovery cannot dilute the score. */
  const reviewedMerges = merged.filter((record) => reviewRoundsFor(record).length > 0);
  const firstPassReviews = reviewedMerges.filter((record) =>
    reviewRoundsFor(record).length === 1 &&
    ["passed", "passed-with-dispositions"].includes(reviewGate(record))).length;
  const severityDistribution = () => ({ blocker: 0, major: 0, minor: 0, nit: 0 });
  const finalRoundSeverityDistribution = severityDistribution();
  const finalRoundSeverityDistributionByOutcome = {
    merged: severityDistribution(),
    gated: severityDistribution(),
    parked: severityDistribution(),
    dismissed: severityDistribution(),
  };
  for (const record of projectRecords) {
    const finalRound = reviewRoundsFor(record).at(-1);
    if (!finalRound) continue;
    const outcome = record.merged
      ? "merged"
      : record.dismissed
        ? "dismissed"
        : record.reviewParking?.state === "parked"
          ? "parked"
          : "gated";
    for (const finding of reviewFindingSet(record, finalRound)) {
      if (Object.hasOwn(finalRoundSeverityDistribution, finding?.severity)) {
        finalRoundSeverityDistribution[finding.severity] += 1;
        finalRoundSeverityDistributionByOutcome[outcome][finding.severity] += 1;
      }
    }
  }
  const totalSpend = projectRecords.reduce((total, record) => total + numericCost(record), 0);
  const unlandedSpendUSD = projectRecords
    .filter((record) => !record.merged)
    .reduce((total, record) => total + numericCost(record), 0);
  const diffStats = typeof diffStatsForRecords === "function"
    ? diffStatsForRecords(bounded)
    : new Map();

  return {
    project,
    generatedAt,
    records: bounded.map((record) => ({
      id: record.id,
      ticketId: record.ticketId ?? null,
      title: branchTitle(record),
      mergedAt: record.merged.mergedAt,
      costUSD: record.costUSD ?? null,
      rounds: reviewRoundsFor(record).length,
      postMerge: record.postMerge?.state ?? null,
      diff: diffStats?.get?.(String(record.merged.commit)) ?? null,
      ...(typeof record.merged.forcedBy === "string"
        ? {
            forcedBy: record.merged.forcedBy,
            reason: record.merged.reason ?? null,
            dispositionRef: record.merged.dispositionRef ?? null,
          }
        : {}),
    })),
    summary: {
      merges: merged.length,
      firstPassReviews,
      reviewedMerges: reviewedMerges.length,
      reviewPassRate:
        reviewedMerges.length > 0 ? firstPassReviews / reviewedMerges.length : null,
      finalRoundSeverityDistribution,
      finalRoundSeverityDistributionByOutcome,
      costPerMergeUSD: merged.length > 0 ? totalSpend / merged.length : null,
      unlandedSpendUSD,
    },
    truncated: merged.length > bounded.length,
  };
}

export function snapshotChronicles(records, projects, options = {}) {
  const { diffStatsForProject, historyForProject, ...chronicleOptions } = options;
  return new Map(
    projects.map((project) => [
      project.name,
      chronicleFor(records, project.name, {
        ...chronicleOptions,
        historyRecords:
          typeof historyForProject === "function"
            ? historyForProject(project)
            : [],
        ...(typeof diffStatsForProject === "function"
          ? {
              diffStatsForRecords: (bounded) =>
                diffStatsForProject(project, bounded),
            }
          : {}),
      }),
    ]),
  );
}

export function aggregateChronicles(chronicles, {
  generatedAt,
  limit = CHRONICLE_LIMIT,
} = {}) {
  const projectChronicles = [...(chronicles?.values?.() ?? chronicles ?? [])];
  const records = projectChronicles
    .flatMap((chronicle) => (chronicle.records ?? []).map((record) => ({
      ...record,
      project: chronicle.project,
    })))
    .sort((left, right) =>
      String(left.mergedAt).localeCompare(String(right.mergedAt)) ||
      String(left.project).localeCompare(String(right.project)) ||
      String(left.id).localeCompare(String(right.id)));
  const bounded = records.slice(-Math.max(1, limit));
  return {
    generatedAt: generatedAt ?? projectChronicles[0]?.generatedAt ?? new Date().toISOString(),
    records: bounded,
    truncated:
      records.length > bounded.length ||
      projectChronicles.some((chronicle) => chronicle.truncated === true),
  };
}
