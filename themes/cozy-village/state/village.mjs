/**
 * COZY VILLAGE — renderer-free functional world state.
 *
 * Atelier work is represented by one parcel moving through seven permanent
 * stations. Buildings never represent tickets, dispatches, merges, health, or
 * importance. The renderer consumes this semantic model and owns only shape.
 */

import { villagerFor } from "./cast.mjs";
import {
  attemptCount,
  decisionOwed,
  mergeGateReasons,
  roundCount,
  stripFor,
  unknownsOf,
} from "./gates.mjs";

export const PROJECT_DEFAULTS = { name: "atelier", requireReview: true, reviewPolicy: "strict" };

const SKY_KEYS = [
  [0.0, "#24365B", "#415B7D", "#C9D9FA", 0.04, 0.68, 0.34, "#354B6C"],
  [0.2, "#2B4065", "#536C88", "#C9D9FA", 0.06, 0.68, 0.34, "#405B78"],
  [0.26, "#4C6281", "#AE8F96", "#F2BC9A", 0.44, 0.64, 0.34, "#84798B"],
  [0.32, "#7FA2C0", "#E2C3A4", "#FFE0B4", 0.94, 0.74, 0.35, "#D4C3AE"],
  [0.5, "#8CB6D2", "#D8E2E0", "#FFF6E0", 1.12, 0.9, 0.4, "#D9E1DE"],
  [0.68, "#93B6C8", "#E4D2B4", "#FFEBC0", 0.98, 0.8, 0.36, "#DED0B8"],
  [0.78, "#6A7E9E", "#DFA47E", "#FFBE82", 0.5, 0.62, 0.34, "#B99688"],
  [0.85, "#45597B", "#7D708B", "#D4C4E0", 0.12, 0.66, 0.34, "#62647C"],
  [1.0, "#24365B", "#415B7D", "#C9D9FA", 0.04, 0.68, 0.34, "#354B6C"],
];

export function clockState(now = new Date()) {
  const t = (now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600) / 24;
  let left = SKY_KEYS[0];
  let right = SKY_KEYS.at(-1);
  for (let index = 0; index < SKY_KEYS.length - 1; index += 1) {
    if (t >= SKY_KEYS[index][0] && t <= SKY_KEYS[index + 1][0]) {
      left = SKY_KEYS[index];
      right = SKY_KEYS[index + 1];
      break;
    }
  }
  const mix = right[0] === left[0] ? 0 : (t - left[0]) / (right[0] - left[0]);
  const elevation = Math.sin((t - 0.25) * Math.PI * 2);
  const azimuth = (t - 0.25) * Math.PI * 2;
  const nightFloor = clamp01((0.08 - elevation) / 0.46);
  return {
    t,
    hhmm: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`,
    elev: elevation,
    isNight: elevation < 0.02,
    sunDir: [
      Math.cos(azimuth) * 0.78,
      Math.max(0.05, elevation) * 1.1,
      Math.sin(azimuth) * 0.44 + 0.36,
    ],
    moonDir: [
      Math.cos(azimuth + Math.PI) * 0.78,
      Math.max(0.16, -elevation) * 0.92,
      Math.sin(azimuth + Math.PI) * 0.44 + 0.18,
    ],
    moonIntensity: nightFloor * 0.78,
    moonVisibility: nightFloor,
    nightFloor,
    skyTop: mixHex(left[1], right[1], mix),
    skyBottom: mixHex(left[2], right[2], mix),
    sunColor: mixHex(left[3], right[3], mix),
    fogColor: mixHex(left[7], right[7], mix),
    sunIntensity: lerp(left[4], right[4], mix),
    hemiIntensity: lerp(left[5], right[5], mix),
    ambIntensity: lerp(left[6], right[6], mix),
    hearthGlow: clamp01((0.15 - elevation) / 0.3),
    phase:
      elevation > 0.28
        ? "day"
        : elevation > 0.02
          ? "golden hour"
          : elevation > -0.22
            ? "dusk"
            : "night",
  };
}

const SEASONS = [
  { name: "spring", grass: "#8FAE74", grassDeep: "#6E8C57", canopy: "#6B8C58", accent: "#DCC9A2", litter: "#CFE0B4", blossom: "#F0CBD2" },
  { name: "summer", grass: "#84A46F", grassDeep: "#63834F", canopy: "#5A7B4E", accent: "#E0CE9E", litter: "#B9CE9A", blossom: null },
  { name: "autumn", grass: "#9BA46F", grassDeep: "#7C8253", canopy: "#A8763F", accent: "#DDB578", litter: "#C98B48", blossom: null },
  { name: "winter", grass: "#A7B0AC", grassDeep: "#87918D", canopy: "#798A84", accent: "#D8DFDE", litter: "#E6ECEC", blossom: null },
];

export function seasonState(convoy) {
  const completed = Number.isInteger(convoy?.completedConvoys)
    ? convoy.completedConvoys
    : convoy?.state === "completed"
      ? 1
      : 0;
  const season = SEASONS[((completed % SEASONS.length) + SEASONS.length) % SEASONS.length];
  const total = convoy?.ticketIds?.length ?? 0;
  return {
    ...season,
    index: completed,
    convoyId: convoy?.id ?? null,
    convoyLabel: convoy?.label ?? null,
    convoyProgress: total ? `${convoy.cursor ?? 0} of ${total} merged` : null,
    banner: completed > 0,
    source: "convoy — Atelier has no release concept; the year turns when a convoy closes",
  };
}

/**
 * The composition is hand-placed and asymmetric. The paths list is the whole
 * movement topology: R&D has no connecting path because Atelier exposes no
 * artifact-to-dispatch relationship.
 */
export const LAYOUT = Object.freeze({
  width: 39,
  depth: 29,
  notice: [-14.2, 4.5],
  workshop: [-6.2, 2.3],
  assay: [2.0, 4.4],
  cottage: [-1.0, -7.4],
  hall: [11.2, 2.0],
  dock: [12.5, -3.3],
  granary: [10.0, -9.2],
  rnd: [-12.2, -9.0],
});

export const STATION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "notice", name: "Notice", sign: "✉ NOTICE", icon: "✉", at: LAYOUT.notice }),
  Object.freeze({ id: "workshop", name: "Workshop", sign: "⚒ WORK", icon: "⚒", at: LAYOUT.workshop }),
  Object.freeze({ id: "assay", name: "Assay", sign: "⚖ ASSAY", icon: "⚖", at: LAYOUT.assay }),
  Object.freeze({ id: "cottage", name: "Operator", sign: "☕ PORCH", icon: "☕", at: LAYOUT.cottage }),
  Object.freeze({ id: "hall", name: "Town hall", sign: "♜ HALL", icon: "♜", at: LAYOUT.hall }),
  Object.freeze({ id: "granary", name: "Granary", sign: "▤ STORE", icon: "▤", at: LAYOUT.granary }),
  Object.freeze({ id: "rnd", name: "R&D tower", sign: "⚗ R&D", icon: "⚗", at: LAYOUT.rnd }),
]);

export const PATHS = Object.freeze([
  Object.freeze({ id: "notice-workshop", from: "notice", to: "workshop" }),
  Object.freeze({ id: "workshop-assay", from: "workshop", to: "assay" }),
  Object.freeze({ id: "workshop-cottage", from: "workshop", to: "cottage" }),
  Object.freeze({ id: "assay-hall", from: "assay", to: "hall" }),
  Object.freeze({ id: "hall-granary", from: "hall", to: "granary", via: "dock" }),
]);

const TERMINAL_RETAINED = new Set(["failed", "stopped", "prepare_failed", "rejected"]);
const VERIFY_STATES = new Set(["verifying"]);
const REVIEW_STATES = new Set(["reviewing"]);
const FAILED_VERDICTS = new Set(["fail", "failed", "malformed", "error"]);

function gateState(record, name) {
  return record?.gates?.find?.((gate) => gate?.gate === name)?.state ?? null;
}

function reviewVerdict(record) {
  return record?.review?.current?.verdict ?? record?.review?.verdict ?? null;
}

function reviewGatePassed(record) {
  return ["passed", "passed-with-dispositions"].includes(gateState(record, "review"));
}

function reviewFailed(record, project = PROJECT_DEFAULTS) {
  return !reviewGatePassed(record) &&
    FAILED_VERDICTS.has(reviewVerdict(record)) &&
    mergeGateReasons(record, project).some((reason) => reason.startsWith("review "));
}

export function reviewIsStale(record) {
  const reviewed = record?.review?.current?.reviewedHead ?? record?.review?.reviewedHead;
  const mergeEligible = reviewVerdict(record) === "pass" || reviewGatePassed(record);
  return Boolean(mergeEligible && reviewed && record?.branchHead && reviewed !== record.branchHead);
}

export function inspectionBay(record, project = PROJECT_DEFAULTS) {
  if (
    REVIEW_STATES.has(record?.state) ||
    gateState(record, "review") === "pending" ||
    (
      project.requireReview &&
      gateState(record, "verify") === "passed" &&
      !reviewGatePassed(record)
    )
  ) {
    return "review";
  }
  return "verify";
}

/**
 * Current lifecycle geography for a live dispatch. Failure and stale-review
 * returns are explicit: their parcel is back on a workshop bench, marked.
 */
export function stationForRecord(record, project = PROJECT_DEFAULTS) {
  if (!record || record.merged || record.dismissed) return null;
  if (
    record.state === "needs_input" ||
    record.state === "plan_ready" ||
    decisionOwed(record, project)?.kind === "question" ||
    decisionOwed(record, project)?.kind === "plan"
  ) {
    return "cottage";
  }
  if (
    TERMINAL_RETAINED.has(record.state) ||
    gateState(record, "verify") === "failed" ||
    reviewFailed(record, project) ||
    reviewIsStale(record)
  ) {
    return "workshop";
  }
  if (
    VERIFY_STATES.has(record.state) ||
    REVIEW_STATES.has(record.state) ||
    gateState(record, "verify") === "pending" ||
    gateState(record, "review") === "pending"
  ) {
    return "assay";
  }
  const blockers = mergeGateReasons(record, project);
  const owed = decisionOwed(record, project);
  if (owed?.kind === "merge" || (record.state === "completed" && blockers.length === 0)) {
    return "hall";
  }
  if (
    gateState(record, "verify") === "passed" &&
    (!project.requireReview || gateState(record, "review") !== "not-run")
  ) {
    return "assay";
  }
  return "workshop";
}

export function workshopClass(record) {
  if (record?.lane === "codex") return "forge";
  if (record?.lane === "claude") return "craft";
  return "studio";
}

function parcelFor(record, project, activities) {
  const stationId = stationForRecord(record, project);
  const villager = villagerFor(record);
  const failed =
    TERMINAL_RETAINED.has(record.state) ||
    gateState(record, "verify") === "failed" ||
    reviewFailed(record, project) ||
    reviewIsStale(record);
  const owed = decisionOwed(record, project);
  const firstFailure = record.verify?.steps?.find?.((step) => Number(step?.exitCode) !== 0);
  return {
    kind: "parcel",
    id: record.id,
    dispatchId: record.id,
    ticketId: record.ticketId ?? null,
    title: record.title ?? record.promptPreview ?? record.ticketId ?? record.id,
    stationId,
    workshop: workshopClass(record),
    bay: stationId === "assay" ? inspectionBay(record, project) : null,
    villager,
    state: record.state ?? "unknown",
    marked: failed,
    retained: TERMINAL_RETAINED.has(record.state),
    returned: failed && (
      gateState(record, "verify") === "failed" ||
      reviewFailed(record, project) ||
      reviewIsStale(record)
    ),
    staleReview: reviewIsStale(record),
    owed,
    question: owed?.kind === "question" ? record.outcome?.question ?? null : null,
    plan: owed?.kind === "plan" ? record.plan?.text ?? null : null,
    strip: stripFor(record, project),
    blockers: mergeGateReasons(record, project),
    unknowns: unknownsOf(record),
    attempts: attemptCount(record.verify),
    rounds: roundCount(record.review),
    costUSD:
      villager.caps.reportsCost && typeof record.costUSD === "number"
        ? record.costUSD
        : null,
    turns:
      villager.caps.reportsCost && Number.isFinite(record.turns)
        ? record.turns
        : null,
    failure: firstFailure
      ? {
          command: firstFailure.command ?? null,
          exitCode: firstFailure.exitCode ?? null,
          tail: firstFailure.tail ?? null,
        }
      : null,
    activity: activities?.get?.(record.id) ?? null,
    record,
  };
}

const GROWTH_THRESHOLDS = Object.freeze([10, 25, 50, 100]);
const DECORATION_THRESHOLDS = Object.freeze([5, 20, 40, 80, 160]);

export function granaryGrowth(mergeCount) {
  const count = Math.max(0, Number(mergeCount) || 0);
  const reached = GROWTH_THRESHOLDS.filter((threshold) => count >= threshold);
  return {
    level: reached.length,
    threshold: reached.at(-1) ?? 0,
    plaque: reached.length
      ? `${reached.at(-1)} merges — ${reached.length === 1 ? "first wing" : `storey ${reached.length}`}`
      : "Archive beginning — next wing at 10 merges",
    next: GROWTH_THRESHOLDS.find((threshold) => count < threshold) ?? null,
    decorations: Math.min(
      5,
      DECORATION_THRESHOLDS.filter((threshold) => count >= threshold).length,
    ),
  };
}

function warningFor(board, queue) {
  const warnings = [];
  if (board?.degraded) {
    const tracker = board.tracker ?? "none";
    warnings.push(
      tracker !== "none" && tracker !== "unknown"
        ? "readiness degraded (br ready)"
        : `tracker degraded (${tracker})`,
    );
  }
  if (queue?.unavailable) warnings.push("queue unavailable");
  if (queue?.lastError) warnings.push(String(queue.lastError));
  if (queue?.budget?.exceeded) warnings.push("queue budget exceeded");
  if (queue?.unpricedDispatches?.exceeded) warnings.push("unpriced dispatch cap exceeded");
  const parked = Array.isArray(queue?.parkedTickets) ? queue.parkedTickets : [];
  if (parked.length > 0) {
    warnings.push(`${parked.length} parked ${parked.length === 1 ? "ticket" : "tickets"}`);
  }
  return warnings;
}

function mainFailureId(failure, index) {
  return failure?.dispatchId ?? failure?.id ?? failure?.commit ?? `main-failure-${index + 1}`;
}

function postDatesChronicle(record, chronicle) {
  const mergedAt = Date.parse(record?.merged?.mergedAt ?? record?.mergedAt ?? "");
  const generatedAt = Date.parse(chronicle?.generatedAt ?? "");
  return Number.isFinite(mergedAt) &&
    Number.isFinite(generatedAt) &&
    mergedAt > generatedAt;
}

function forceAuditFor(record) {
  const merged = record?.record?.merged ?? record?.merged;
  const forcedBy = merged?.forcedBy ?? record?.forcedBy;
  if (typeof forcedBy !== "string" || !forcedBy) return null;
  return {
    forcedBy,
    reason: merged?.reason ?? record?.reason ?? null,
    dispositionRef: merged?.dispositionRef ?? record?.dispositionRef ?? null,
  };
}

export function buildVillage(input = {}) {
  const project = { ...PROJECT_DEFAULTS, ...(input.project ?? {}) };
  const now = input.now ?? new Date();
  const chronicle = input.chronicle ?? { records: [], summary: {}, stats: {} };
  const boardState = input.board ?? { issues: [], degraded: true, tracker: "none" };
  const queue = input.queue ?? { unavailable: true };
  const mainHealth = input.mainHealth ?? {
    project: project.name,
    state: "unknown",
    checksTotal: 0,
    unresolvedFailures: [],
    running: [],
  };
  const artifactsProjection = input.artifacts ?? {
    project: project.name,
    generatedAt: null,
    artifacts: [],
  };
  const records = Array.isArray(input.dispatches) ? input.dispatches : [];
  const archived = Array.isArray(chronicle.records) ? chronicle.records : [];
  const archivedIds = new Set(archived.map((record) => record?.id));
  const vestibuleRecords = [
    ...(Array.isArray(input.vestibule) ? input.vestibule : []),
    ...records.filter((record) => record?.merged && !record?.dismissed),
  ].filter((record, index, all) =>
    record?.id &&
    !archivedIds.has(record.id) &&
    postDatesChronicle(record, chronicle) &&
    all.findIndex((candidate) => candidate?.id === record.id) === index);
  const liveRecords = records.filter((record) =>
    record &&
    !record.reviewOf &&
    !record.merged &&
    !record.dismissed);
  const parcels = liveRecords.map((record) => parcelFor(record, project, input.activities));
  const at = (stationId) => parcels.filter((parcel) => parcel.stationId === stationId);
  const boardPapers = (
    Array.isArray(boardState.readyIssues) ? boardState.readyIssues : []
  ).map((issue) => ({
    kind: "paper",
    id: issue.id,
    ticketId: issue.id,
    title: issue.title ?? "Untitled ticket",
    priority: issue.priority ?? null,
    issue,
  }));
  const boardWarnings = warningFor(boardState, queue);
  const unresolvedFailures = Array.isArray(mainHealth.unresolvedFailures)
    ? mainHealth.unresolvedFailures
    : [];
  const runningChecks = Array.isArray(mainHealth.running) ? mainHealth.running : [];
  const dockParcels = unresolvedFailures.map((failure, index) => ({
    kind: "dock-parcel",
    id: mainFailureId(failure, index),
    dispatchId: failure?.dispatchId ?? failure?.id ?? null,
    state: "failed",
    marked: true,
    scaffolded: true,
    acknowledged: Boolean(failure?.acknowledgedAt ?? failure?.postMerge?.acknowledgedAt),
    failure,
  }));
  const dockRunning = runningChecks.map((running, index) => ({
    kind: "dock-parcel",
    id: mainFailureId(running, index),
    dispatchId: running?.dispatchId ?? running?.id ?? null,
    state: "running",
    marked: false,
    scaffolded: false,
    acknowledged: false,
    running,
  }));
  const mergeCount = Number(
    chronicle.summary?.merges ??
    chronicle.stats?.merges ??
    archived.length,
  );
  const artifacts = Array.isArray(artifactsProjection.artifacts)
    ? artifactsProjection.artifacts
    : [];
  const artifactCounts = {
    total: artifacts.length,
    specs: artifacts.filter((artifact) => artifact?.kind === "spec").length,
    designs: artifacts.filter((artifact) => artifact?.kind === "design").length,
  };
  const overrideRecords = [...archived, ...vestibuleRecords]
    .filter((record) => forceAuditFor(record))
    .slice(-10)
    .reverse();
  const stationData = {
    notice: {
      papers: boardPapers,
      warning: boardWarnings.length > 0,
      warnings: boardWarnings,
      source: boardState.source ?? null,
      generatedAt: boardState.generatedAt ?? null,
    },
    workshop: {
      parcels: at("workshop"),
      huts: [
        { id: "craft", name: "Craft", parcels: at("workshop").filter((parcel) => parcel.workshop === "craft") },
        { id: "forge", name: "Forge", parcels: at("workshop").filter((parcel) => parcel.workshop === "forge") },
        { id: "studio", name: "Studio", parcels: at("workshop").filter((parcel) => parcel.workshop === "studio") },
      ],
    },
    assay: {
      parcels: at("assay"),
      verify: at("assay").filter((parcel) => parcel.bay === "verify"),
      review: at("assay").filter((parcel) => parcel.bay === "review"),
    },
    cottage: {
      parcels: at("cottage"),
      visitors: at("cottage"),
    },
    hall: {
      parcels: at("hall"),
      mergeQueue: at("hall"),
      overrides: overrideRecords,
      dock: {
        state: mainHealth.state ?? "unknown",
        checksTotal: Number(mainHealth.checksTotal ?? 0),
        failures: dockParcels,
        running: dockRunning,
        bellRinging: dockParcels.some((parcel) => !parcel.acknowledged),
      },
    },
    granary: {
      records: archived,
      generatedAt: chronicle.generatedAt ?? null,
      truncated: Boolean(chronicle.truncated),
      vestibule: vestibuleRecords.map((record) => ({
        kind: "vestibule-parcel",
        id: record.id,
        dispatchId: record.id,
        ticketId: record.ticketId ?? null,
        title: record.title ?? record.promptPreview ?? record.ticketId ?? record.id,
        label: "awaiting archive",
        villager: villagerFor(record),
        record,
      })),
      growth: granaryGrowth(mergeCount),
      banner: seasonState(input.convoy).banner,
    },
    rnd: {
      artifacts,
      generatedAt: artifactsProjection.generatedAt ?? null,
      counts: artifactCounts,
      props: {
        blueprints: Math.min(4, Math.floor(artifactCounts.total / 5)),
        telescope: artifactCounts.total > 0,
        globe: artifactCounts.total >= 15,
      },
    },
  };
  const stations = STATION_DEFINITIONS.map((definition) => ({
    ...definition,
    data: stationData[definition.id],
  }));
  const stats = {
    ...(chronicle.stats ?? {}),
    ...(chronicle.summary ?? {}),
    merges: mergeCount,
    inFlight: parcels.length,
    retainedFailures: parcels.filter((parcel) => parcel.retained).length,
    awaitingArchive: vestibuleRecords.length,
    ready: boardPapers.length,
    artifacts: artifactCounts.total,
  };

  return {
    now,
    project,
    clock: clockState(now),
    season: seasonState(input.convoy),
    layout: LAYOUT,
    paths: PATHS,
    stations,
    stationById: Object.fromEntries(stations.map((station) => [station.id, station])),
    parcels,
    board: stationData.notice,
    workshop: stationData.workshop,
    assay: stationData.assay,
    porch: stationData.cottage,
    hall: stationData.hall,
    granary: stationData.granary,
    rnd: stationData.rnd,
    mainHealth: {
      ...mainHealth,
      owed: stationData.hall.dock.bellRinging,
      unresolved: dockParcels.length,
    },
    decisionsOwed: at("cottage").length + at("hall").length + (
      stationData.hall.dock.bellRinging ? 1 : 0
    ),
    stats,
    quiet: parcels.length === 0,
  };
}

const EVENT_PATCH = {
  status: (record, event) => ({
    ...record,
    state: event.state ?? record.state,
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.detail ? { exitSummary: event.detail } : {}),
  }),
  review: (record, event) => {
    const round = {
      dispatchId: event.reviewDispatchId ?? null,
      round: event.round ?? roundCount(record.review) + 1,
      at: event.at ?? new Date().toISOString(),
      reviewedHead: event.reviewedHead ?? null,
      verdict: event.verdict ?? "pending",
      summary: event.summary ?? "",
      findingCount: event.findingCount ?? null,
      ...(Array.isArray(event.findings) ? { findings: event.findings } : {}),
      ...(event.findingsTruncated === true
        ? {
            findingsTruncated: true,
            findingOverflowCount: event.findingOverflowCount,
            findingOverflowSeverity: event.findingOverflowSeverity,
            findingOverflowSeverityCounts: event.findingOverflowSeverityCounts,
            findingOverflowSeverities: event.findingOverflowSeverities,
            findingOverflowText: event.findingOverflowText,
          }
        : {}),
    };
    const prior = Array.isArray(record.review?.rounds) ? record.review.rounds : [];
    const rounds = prior.some((candidate) => candidate.round === round.round)
      ? prior.map((candidate) => candidate.round === round.round
        ? { ...candidate, ...round }
        : candidate)
      : [...prior, round];
    return {
      ...record,
      review: { ...round, current: round, rounds },
      ...(event.reviewParking ? { reviewParking: event.reviewParking } : {}),
    };
  },
  "review-disposition": (record, event) => ({
    ...record,
    reviewDispositions: event.reviewDispositions ?? record.reviewDispositions ?? [],
  }),
  "verify-rerun": (record, event) =>
    event.phase === "end" && event.verdict
      ? { ...record, verify: { ...(record.verify ?? {}), state: event.verdict } }
      : record,
  "post-merge": (record, event) => ({
    ...record,
    postMerge: {
      ...(record.postMerge ?? {}),
      ...(event.state ? { state: event.state } : {}),
      ...(event.commit ? { commit: event.commit } : {}),
      ...(event.steps ? { steps: event.steps } : {}),
      ...(event.evidenceTail ? { evidenceTail: event.evidenceTail } : {}),
      ...(event.resolvedAt ? { resolvedAt: event.resolvedAt } : {}),
      ...(event.acknowledgedAt ? { acknowledgedAt: event.acknowledgedAt } : {}),
    },
  }),
  usage: (record, event) => ({
    ...record,
    costUSD: event.costUSD ?? record.costUSD,
    turns: event.turns ?? record.turns,
  }),
  exit: (record, event) => ({ ...record, exitSummary: event.summary ?? record.exitSummary }),
  plan: (record, event) => ({
    ...record,
    plan: { state: "ready", text: event.text ?? record.plan?.text ?? "" },
  }),
};

const GATE_BEARING_EVENTS = new Set([
  "status",
  "review",
  "review-disposition",
  "post-merge",
  "verify-rerun",
]);
const ACTIVITY_EVENTS = new Set(["usage", "status", "message"]);

function activityLabel(event) {
  if (event.type === "usage") return "usage observed";
  if (event.type === "message") return "message observed";
  return `status: ${event.state ?? "updated"}`;
}

function movementRoute(from, to) {
  if (from === "assay" && to === "workshop") return ["assay", "workshop"];
  if (from === "assay" && to === "hall") return ["assay", "hall"];
  if (from === "cottage" && to === "workshop") return ["cottage", "workshop"];
  if (from === "workshop" && to === "cottage") return ["workshop", "cottage"];
  if (from === "workshop" && to === "assay") return ["workshop", "assay"];
  return from && to ? [from, to] : [];
}

export class VillageStore {
  constructor(input = {}) {
    this.chronicle = input.chronicle ?? { records: [], summary: {} };
    this.dispatches = (input.dispatches ?? []).map((record) => ({ ...record }));
    this.convoy = input.convoy ?? null;
    this.project = { ...PROJECT_DEFAULTS, ...(input.project ?? {}) };
    this.board = input.board ?? { issues: [], degraded: true, tracker: "none" };
    this.queue = input.queue ?? { unavailable: true };
    this.mainHealth = input.mainHealth ?? {
      project: this.project.name,
      state: "unknown",
      checksTotal: 0,
      unresolvedFailures: [],
      running: [],
    };
    this.artifacts = input.artifacts ?? { project: this.project.name, artifacts: [] };
    this.vestibule = input.vestibule ?? [];
    this.activities = new Map();
    this.clockNow = input.now ?? null;
    this.listeners = new Set();
    this.village = this.rebuild();
  }

  replace(input = {}) {
    if (input.chronicle) this.chronicle = input.chronicle;
    if (input.dispatches) this.dispatches = input.dispatches.map((record) => ({ ...record }));
    if (input.convoy !== undefined) this.convoy = input.convoy;
    if (input.project) this.project = { ...PROJECT_DEFAULTS, ...input.project };
    if (input.board) this.board = input.board;
    if (input.queue) this.queue = input.queue;
    if (input.mainHealth) this.mainHealth = input.mainHealth;
    if (input.artifacts) this.artifacts = input.artifacts;
    const archived = new Set((this.chronicle.records ?? []).map((record) => record?.id));
    this.vestibule = this.vestibule.filter((record) => !archived.has(record?.id));
    return this.rebuild();
  }

  rebuild(now) {
    const at = now ?? this.clockNow ?? new Date();
    this.village = buildVillage({
      chronicle: this.chronicle,
      dispatches: this.dispatches,
      convoy: this.convoy,
      project: this.project,
      board: this.board,
      queue: this.queue,
      mainHealth: this.mainHealth,
      artifacts: this.artifacts,
      vestibule: this.vestibule,
      activities: this.activities,
      now: at,
    });
    return this.village;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(change) {
    for (const listener of this.listeners) listener(this.village, change);
  }

  tickClock(now = new Date()) {
    const stamp = now.getTime();
    for (const [id, activity] of this.activities) {
      if (activity.until <= stamp) this.activities.delete(id);
    }
    this.rebuild(now);
    this.emit({ kind: "clock" });
    return this.village;
  }

  recordById(id) {
    return this.dispatches.find((record) => record.id === id) ?? null;
  }

  applyMainHealthRecord(record) {
    if (!record?.id) return this.village;
    const replaceRecord = (candidate) =>
      mainFailureId(candidate, -1) === record.id ? record : candidate;
    this.mainHealth = {
      ...this.mainHealth,
      unresolvedFailures: (this.mainHealth.unresolvedFailures ?? []).map(replaceRecord),
      running: (this.mainHealth.running ?? []).map(replaceRecord),
    };
    return this.rebuild();
  }

  static withFreshGates(patched, incoming, event) {
    if (Array.isArray(incoming?.gates) && incoming.gates.length) {
      return { ...patched, gates: incoming.gates };
    }
    if (!GATE_BEARING_EVENTS.has(event?.type)) return patched;
    const { gates: _stale, ...withoutGates } = patched;
    return withoutGates;
  }

  applyEvent(event) {
    if (event?.type === "board.snapshot" && event.board) {
      this.board = event.board;
      if (event.queue) this.queue = event.queue;
      this.rebuild();
      const change = {
        kind: "board",
        project: event.project ?? this.project.name,
      };
      this.emit(change);
      return change;
    }
    if (!event?.dispatchId) return null;
    if (event.mainHealth) this.mainHealth = event.mainHealth;
    const index = this.dispatches.findIndex((record) => record.id === event.dispatchId);
    if (index === -1) {
      if (!event.record || event.record.reviewOf || event.record.dismissed) return null;
      this.dispatches = [...this.dispatches, event.record];
      if (event.record.merged && postDatesChronicle(event.record, this.chronicle)) {
        this.vestibule.push(event.record);
      }
      this.rebuild();
      const parcel = this.village.parcels.find((candidate) => candidate.id === event.record.id);
      const change = event.record.merged
        ? {
            kind: "updated",
            dispatchId: event.record.id,
            stationId: null,
          }
        : {
            kind: "arrived",
            dispatchId: event.record.id,
            from: this.village.board.papers.some((paper) => paper.id === event.record.ticketId)
              ? "notice"
              : null,
            to: parcel?.stationId ?? "workshop",
            route: this.village.board.papers.some((paper) => paper.id === event.record.ticketId)
              ? ["notice", "workshop"]
              : [],
            parcel,
          };
      this.emit(change);
      return change;
    }

    const previous = this.dispatches[index];
    const from = stationForRecord(previous, this.project);
    const patch = EVENT_PATCH[event.type];
    const patched = patch ? patch(previous, event) : previous;
    const merged = event.record ? { ...patched, ...event.record } : patched;
    const next = merged === previous
      ? previous
      : VillageStore.withFreshGates(merged, event.record, event);

    if (ACTIVITY_EVENTS.has(event.type)) {
      const observedAt = Number.isFinite(event.observedAt)
        ? event.observedAt
        : Date.now();
      this.activities.set(event.dispatchId, {
        label: activityLabel(event),
        observedAt,
        until: observedAt + 3_200,
      });
    }
    if (next !== previous) {
      this.dispatches = this.dispatches.map((record, candidate) =>
        candidate === index ? next : record);
    }

    if (!previous.merged && next.merged) {
      if (!this.vestibule.some((record) => record.id === next.id)) {
        this.vestibule.push(next);
      }
      this.rebuild();
      const change = {
        kind: "merged",
        dispatchId: event.dispatchId,
        from: from ?? "hall",
        to: "granary",
        route: ["hall", "dock", "granary"],
        vestibule: this.village.granary.vestibule.find((item) => item.id === next.id) ?? null,
      };
      this.emit(change);
      return change;
    }

    this.rebuild();
    const to = stationForRecord(next, this.project);
    const change = from !== to
      ? {
          kind: "moved",
          dispatchId: event.dispatchId,
          from,
          to,
          route: movementRoute(from, to),
          parcel: this.village.parcels.find((candidate) => candidate.id === event.dispatchId) ?? null,
        }
      : {
          kind: ACTIVITY_EVENTS.has(event.type) ? "activity" : "updated",
          dispatchId: event.dispatchId,
          stationId: to,
          activity: this.activities.get(event.dispatchId) ?? null,
        };
    this.emit(change);
    return change;
  }
}

export function recomputeStats(chronicle, liveDispatches = []) {
  const records = chronicle.records ?? [];
  const reported = records.filter((record) =>
    villagerFor(record).caps.reportsCost && typeof record.costUSD === "number");
  const spend = reported.reduce((total, record) => total + record.costUSD, 0);
  return {
    ...(chronicle.summary ?? chronicle.stats ?? {}),
    merges: records.length,
    spendMergedUSD: Number(spend.toFixed(2)),
    costPerMergeUSD: reported.length ? Number((spend / reported.length).toFixed(2)) : null,
    unlandedSpendUSD: Number(
      liveDispatches
        .filter((record) => !record.merged && villagerFor(record).caps.reportsCost)
        .reduce((total, record) => total + (Number(record.costUSD) || 0), 0)
        .toFixed(2),
    ),
  };
}

export function lerp(left, right, amount) {
  return left + (right - left) * amount;
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function mixHex(left, right, amount) {
  const a = parseInt(left.slice(1), 16);
  const b = parseInt(right.slice(1), 16);
  const red = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, amount));
  const green = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, amount));
  const blue = Math.round(lerp(a & 255, b & 255, amount));
  return `#${((1 << 24) | (red << 16) | (green << 8) | blue).toString(16).slice(1)}`;
}

export function seeded(key) {
  let hash = 2166136261;
  for (const character of String(key)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash ^= hash << 13;
    hash ^= hash >>> 17;
    hash ^= hash << 5;
    return ((hash >>> 0) % 1_000_000) / 1_000_000;
  };
}

export const PALETTE = {
  basswood: "#E0C398",
  basswoodDeep: "#B08A54",
  endGrain: "#C9A472",
  beam: "#9A7746",
  beamDark: "#6E5030",
  plaster: "#F2E7D0",
  plasterDim: "#DCCDB0",
  madder: "#B25742",
  madderDeep: "#8E4030",
  ochre: "#D69B4C",
  slate: "#7E8D99",
  slateDeep: "#57646F",
  fog: "#C7CFD5",
  lamp: "#FFC46B",
  lampCore: "#FFF3D6",
  cobble: "#B8AA94",
  cobbleDeep: "#8F8271",
  ink: "#413425",
  chalk: "#F6EFE0",
};
