const REVIEW_SEVERITIES = Object.freeze(["blocker", "major", "minor", "nit"]);
const REVIEW_POLICIES = new Set(["strict", "tiered", "advisory"]);
const NEUTRALIZING_DISPOSITIONS = new Set(["refuted", "redirected", "waived"]);
const REVIEW_FINDING_IDENTITY_SUMMARY_LIMIT = 500;
// Markdown's three unordered markers, numeric ordered lists, and the common
// Unicode bullet glyphs all carry the same finding semantics. Primary capture
// and overflow reconstruction deliberately call the one parser below: a
// finding must not acquire a different identity merely because it crossed the
// persisted ten-item structured boundary.
const OPTIONAL_REVIEW_BULLET =
  String.raw`(?:(?:[-*+\u2022\u2023\u25E6\u2043\u2219])[ \t]+|\d{1,3}[.)][ \t]+)?`;
const REQUIRED_REVIEW_BULLET =
  String.raw`(?:(?:[-*+\u2022\u2023\u25E6\u2043\u2219])[ \t]+|\d{1,3}[.)][ \t]+)`;
const STRUCTURED_REVIEW_FINDING = new RegExp(
  String.raw`^[ \t]*${OPTIONAL_REVIEW_BULLET}\[(BLOCKER|MAJOR|MINOR|NIT)\][ \t]*(.+?):(\d+)(?::\d+)?[ \t]*(?:-|\u2013|\u2014|:)[ \t]*(.+?)[ \t]*$`,
  "iu",
);
const OPAQUE_TAGGED_REVIEW_FINDING = new RegExp(
  String.raw`^[ \t]*${OPTIONAL_REVIEW_BULLET}\[(BLOCKER|MAJOR|MINOR|NIT)\](.*?)[ \t]*$`,
  "iu",
);
const STRUCTURED_UNTAGGED_REVIEW_FINDING = new RegExp(
  String.raw`^[ \t]*${OPTIONAL_REVIEW_BULLET}(.+?):(\d+)(?::\d+)?[ \t]*(?:-|\u2013|\u2014|:)[ \t]*(.+?)[ \t]*$`,
  "u",
);
const OPAQUE_UNTAGGED_REVIEW_FINDING = new RegExp(
  String.raw`^[ \t]*${REQUIRED_REVIEW_BULLET}(\S.*?)[ \t]*$`,
  "u",
);

function reviewFindingTextWithoutInlineCode(line) {
  const source = String(line || "");
  let plain = "";
  for (let index = 0; index < source.length;) {
    if (source[index] !== "`") {
      plain += source[index];
      index += 1;
      continue;
    }
    let runEnd = index;
    while (source[runEnd] === "`") runEnd += 1;
    const marker = source.slice(index, runEnd);
    const close = source.indexOf(marker, runEnd);
    if (close === -1) {
      plain += marker;
      index = runEnd;
      continue;
    }
    plain += source.slice(runEnd, close);
    index = close + marker.length;
  }
  return plain;
}

export function parseReviewFindingLine(line, { includeUntagged = false } = {}) {
  const source = reviewFindingTextWithoutInlineCode(line);
  const structured = STRUCTURED_REVIEW_FINDING.exec(source);
  if (structured) {
    return {
      severity: structured[1].toLowerCase(),
      file: structured[2].trim(),
      line: Number(structured[3]),
      summary: structured[4].trim(),
    };
  }
  const tagged = OPAQUE_TAGGED_REVIEW_FINDING.exec(source);
  if (tagged) {
    const summary = String(tagged[2] || "")
      .replace(/^[ \t]*\p{P}+[ \t]*/u, "")
      .trim();
    return {
      severity: tagged[1].toLowerCase(),
      file: null,
      line: null,
      summary: summary || "Tagged finding omitted a parseable file:line.",
    };
  }
  if (!includeUntagged) return null;
  const untagged = STRUCTURED_UNTAGGED_REVIEW_FINDING.exec(source);
  if (untagged) {
    return {
      severity: "major",
      file: untagged[1].trim(),
      line: Number(untagged[2]),
      summary: untagged[3].trim(),
    };
  }
  const opaque = OPAQUE_UNTAGGED_REVIEW_FINDING.exec(source);
  if (!opaque) return null;
  return {
    severity: "major",
    file: null,
    line: null,
    summary: opaque[1].trim(),
  };
}

export function reviewRoundsFor(record) {
  const review = record?.review;
  if (Array.isArray(review)) {
    return review.filter((round) => round && typeof round === "object");
  }
  if (!review || typeof review !== "object") return [];
  if (Array.isArray(review.rounds) && review.rounds.length > 0) {
    return review.rounds.filter((round) => round && typeof round === "object");
  }
  if (review.current && typeof review.current === "object" && !Array.isArray(review.current)) {
    return [review.current];
  }
  const { current: _current, rounds: _rounds, ...flat } = review;
  return Object.keys(flat).length > 0 ? [flat] : [];
}

export function currentReviewFor(record) {
  return reviewRoundsFor(record).at(-1);
}

export function reviewFindingWithRef(round, finding, index) {
  return {
    ...finding,
    ref: typeof finding?.ref === "string" && finding.ref
      ? finding.ref
      : `round-${Number(round?.round ?? 1)}:finding-${index + 1}`,
  };
}

export function normalizedReviewFindingIdentity(finding) {
  const file = String(finding?.file || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .trim();
  const line = Number(finding?.line);
  const lineBand = Number.isInteger(line) && line > 0
    ? `${Math.floor((line - 1) / 10) * 10 + 1}-${Math.floor((line - 1) / 10) * 10 + 10}`
    : "unknown";
  const summary = String(finding?.summary || "")
    .normalize("NFKC")
    .replace(/^[ \t]*(?:FIXED|PARTIAL|UNFIXED)[ \t]*:?[ \t]*/i, "")
    .replace(/[ \t]+\u2014[ \t]+NEW EVIDENCE:[ \t]*.*$/i, "");
  const sentenceBoundary = summary.search(/\.(?=[ \t]+\p{Lu})/u);
  const claim = summary
    .slice(0, Math.min(
      sentenceBoundary === -1 ? summary.length : sentenceBoundary,
      REVIEW_FINDING_IDENTITY_SUMMARY_LIMIT,
    ))
    .toLocaleLowerCase("en-US")
    .replace(/[`'\"\u2018\u2019\u201c\u201d]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${file}\n${lineBand}\n${claim}`;
}

function validCount(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function overflowSeverityList(round) {
  const count = validCount(round?.findingOverflowCount) || (
    round?.findingsTruncated === true && REVIEW_SEVERITIES.includes(round?.findingOverflowSeverity)
      ? 1
      : 0
  );
  if (count === 0) return [];
  const ordered = Array.isArray(round?.findingOverflowSeverities)
    ? round.findingOverflowSeverities
      .filter((severity) => REVIEW_SEVERITIES.includes(severity))
      .slice(0, count)
    : [];
  if (ordered.length === count) return ordered;
  const counts = round?.findingOverflowSeverityCounts;
  const severities = [];
  if (counts && typeof counts === "object" && !Array.isArray(counts)) {
    for (const severity of REVIEW_SEVERITIES) {
      severities.push(...Array(validCount(counts[severity])).fill(severity));
    }
  }
  const fallback = REVIEW_SEVERITIES.includes(round?.findingOverflowSeverity)
    ? round.findingOverflowSeverity
    : "major";
  if (severities.length > count) severities.length = count;
  while (severities.length < count) severities.push(fallback);
  return severities;
}

export function reviewOverflowFindings(round) {
  const severities = overflowSeverityList(round);
  if (severities.length === 0) return [];
  const lines = typeof round?.findingOverflowText === "string"
    ? round.findingOverflowText.split(/\r?\n/)
    : [];
  return severities.map((severity, index) => {
    const fallbackSummary = `Overflow review finding ${index + 1} of ${severities.length}.`;
    const overflowText = lines[index];
    const parsed = parseReviewFindingLine(overflowText, { includeUntagged: true });
    return {
      ref: `round-${Number(round?.round ?? 1)}:overflow-${index + 1}`,
      severity,
      file: parsed?.file ?? null,
      line: parsed?.line ?? null,
      summary: parsed?.summary || fallbackSummary,
      novelty: "new",
      overflow: true,
      ...(overflowText ? { overflowText } : {}),
    };
  });
}

function parsedLegacyReviewFindings(round) {
  if (Array.isArray(round?.findings) || typeof round?.findingsText !== "string") return null;
  const findings = round.findingsText
    .split(/\r?\n/)
    .map((line) => parseReviewFindingLine(line, { includeUntagged: true }))
    .filter(Boolean)
    .map((finding, index) => reviewFindingWithRef(round, {
      ...finding,
      novelty: "new",
    }, index));
  return findings.length > 0 ? findings : null;
}

export function reviewFindingSet(record, round = currentReviewFor(record)) {
  if (!round || typeof round !== "object") return [];
  const structured = Array.isArray(round.findings)
    ? round.findings.map((finding, index) => reviewFindingWithRef(round, finding, index))
    : [];
  // Pre-structured records persisted only findingsText. Upgrade those rounds
  // through the same tolerant grammar regardless of verdict: a legacy PASS
  // beside a persisted finding is not evidence that the finding disappeared.
  const legacy = parsedLegacyReviewFindings(round) ?? [];
  const findings = [...structured, ...legacy, ...reviewOverflowFindings(round)];
  if (round.verdict === "fail" && findings.length === 0) {
    findings.push({
      ref: `round-${Number(round.round ?? 1)}:finding-1`,
      severity: "major",
      file: "(untagged-review)",
      line: 1,
      summary: String(round.summary || "Untagged review failure."),
      novelty: "new",
      synthetic: true,
    });
  }
  return findings;
}

function reviewDispositions(record) {
  return Array.isArray(record?.reviewDispositions) ? record.reviewDispositions : [];
}

export function latestReviewDispositionForRefs(record, findingRefs) {
  const lineage = new Set(findingRefs);
  let latest;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const disposition of reviewDispositions(record)) {
    if (!lineage.has(disposition?.findingRef)) continue;
    const at = Date.parse(disposition.at);
    const comparableAt = Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
    // Equal timestamps retain append-only order as the deterministic tiebreaker.
    if (!latest || comparableAt >= latestAt) {
      latest = disposition;
      latestAt = comparableAt;
    }
  }
  return latest;
}

export function reviewFindingLineageRefs(record, finding, findingRef = finding?.ref) {
  const identity = normalizedReviewFindingIdentity(finding);
  const lineage = new Set(reviewRoundsFor(record).flatMap((round) =>
    reviewFindingSet(record, round)
      .filter((candidate) => normalizedReviewFindingIdentity(candidate) === identity)
      .map((candidate) => candidate.ref)));
  if (typeof findingRef === "string" && findingRef) lineage.add(findingRef);
  if (typeof finding?.dispositionRef === "string") {
    const referenced = reviewDispositions(record)
      .find((disposition) => disposition?.ref === finding.dispositionRef);
    if (typeof referenced?.findingRef === "string") lineage.add(referenced.findingRef);
  }
  return lineage;
}

export function latestReviewLineageDisposition(record, finding, findingRef = finding?.ref) {
  return latestReviewDispositionForRefs(
    record,
    reviewFindingLineageRefs(record, finding, findingRef),
  );
}

export function reviewFindingHasExplicitNewEvidence(finding) {
  return finding?.explicitNewEvidence === true ||
    / \u2014 NEW EVIDENCE: \S/.test(String(finding?.summary || ""));
}

function reviewFindingWithoutDispositionRef(finding) {
  const { dispositionRef: _dispositionRef, ...rest } = finding;
  return rest;
}

export function classifiedReviewFindingSet(record, round = currentReviewFor(record)) {
  const parsedLegacy = parsedLegacyReviewFindings(round);
  if (
    !round ||
    (
      !Array.isArray(round.findings) &&
      !parsedLegacy &&
      !Number.isInteger(round.findingOverflowCount) &&
      round.findingsTruncated !== true
    )
  ) return null;
  const redirectedFindingRefs = new Set(
    reviewDispositions(record)
      .filter((disposition) => disposition?.disposition === "redirected")
      .map((disposition) => disposition?.findingRef)
      .filter((findingRef) => typeof findingRef === "string"),
  );
  const earlier = reviewRoundsFor(record)
    .filter((candidate) => Number(candidate.round) < Number(round.round))
    .flatMap((candidate) => reviewFindingSet(record, candidate));
  return reviewFindingSet(record, round).map((finding) => {
    const identity = normalizedReviewFindingIdentity(finding);
    const matches = earlier.filter((candidate) =>
      normalizedReviewFindingIdentity(candidate) === identity);
    const redirectRootIndex = matches.findIndex((candidate) =>
      redirectedFindingRefs.has(candidate.ref));
    const controllingDisposition = redirectRootIndex === -1
      ? undefined
      : latestReviewDispositionForRefs(
          record,
          matches.slice(redirectRootIndex).map((candidate) => candidate.ref),
        );
    if (controllingDisposition) {
      if (reviewFindingHasExplicitNewEvidence(finding)) {
        return {
          ...reviewFindingWithoutDispositionRef(finding),
          novelty: "new",
          explicitNewEvidence: true,
        };
      }
      if (controllingDisposition.disposition === "accepted") {
        return {
          ...reviewFindingWithoutDispositionRef(finding),
          novelty: "repeated",
        };
      }
      return {
        ...finding,
        novelty: "redirect-disputed",
        dispositionRef: controllingDisposition.ref,
      };
    }
    if (matches.length === 0 && ["new", "repeated", "redirect-disputed"].includes(finding.novelty)) {
      return finding;
    }
    return { ...finding, novelty: matches.length > 0 ? "repeated" : "new" };
  });
}

export function dispositionForReviewFinding(record, finding, findingRef = finding?.ref) {
  const direct = typeof findingRef === "string" && findingRef
    ? latestReviewDispositionForRefs(record, [findingRef])
    : undefined;
  if (reviewFindingHasExplicitNewEvidence(finding)) return direct;
  const lineage = reviewFindingLineageRefs(record, finding, findingRef);
  const hasRedirect = reviewDispositions(record).some((disposition) =>
    lineage.has(disposition?.findingRef) && disposition?.disposition === "redirected");
  return hasRedirect
    ? latestReviewDispositionForRefs(record, lineage)
    : direct;
}

export function neutralizingReviewDisposition(disposition) {
  return Boolean(
    disposition &&
    NEUTRALIZING_DISPOSITIONS.has(disposition.disposition) &&
    typeof disposition.actor === "string" && disposition.actor.trim() &&
    typeof disposition.note === "string" && disposition.note.trim() &&
    (disposition.disposition !== "redirected" || (
      typeof disposition.redirectTicket === "string" && disposition.redirectTicket.trim()
    )),
  );
}

function mappedReviewVerdict(value) {
  if (["pass", "passed"].includes(value)) return "passed";
  if (["error", "fail", "failed", "malformed"].includes(value)) return "failed";
  if (["pending", "running", "queued"].includes(value)) return "pending";
  if (["skip", "skipped"].includes(value)) return "skipped";
  return "unknown";
}

export function assessReview(record, project = {}, { reviewGateState } = {}) {
  const required = project.requireReview !== false;
  const round = currentReviewFor(record);
  if (!round) {
    const gateState = record?.readOnly === true || record?.reviewOf || record?.merged
      ? "skipped"
      : "not-run";
    return {
      required,
      round: null,
      findings: [],
      openFindings: [],
      blockers: [],
      advisories: [],
      gateState,
      eligible: !required,
      reason: required ? "expected pass, got missing" : undefined,
    };
  }

  const findings = classifiedReviewFindingSet(record, round) ?? reviewFindingSet(record, round);
  const legacyDispositionPass = reviewGateState === "passed-with-dispositions" &&
    round.verdict === "fail" &&
    !Array.isArray(round.findings) &&
    reviewOverflowFindings(round).length === 0;
  const blockers = findings.filter((finding) => finding.severity === "blocker");
  const openFindings = findings.filter((finding) =>
    !neutralizingReviewDisposition(dispositionForReviewFinding(record, finding)));
  const allDispositioned = findings.length > 0 && findings.every((finding) =>
    ["major", "minor", "nit"].includes(finding?.severity) &&
    neutralizingReviewDisposition(dispositionForReviewFinding(record, finding)));
  const gateState = legacyDispositionPass
    ? "passed-with-dispositions"
    : blockers.length > 0
    ? "failed"
    : round.verdict === "pass"
      ? openFindings.length > 0 ? "failed" : "passed"
      : round.verdict === "fail" && allDispositioned
        ? "passed-with-dispositions"
        : mappedReviewVerdict(round.verdict);

  if (!required) {
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: [],
      gateState,
      eligible: true,
    };
  }
  if (legacyDispositionPass) {
    return {
      required,
      round,
      findings: [],
      openFindings: [],
      blockers: [],
      advisories: [],
      gateState,
      eligible: true,
    };
  }
  if (
    reviewGateState !== undefined &&
    !["passed", "passed-with-dispositions", "failed", "fail"].includes(reviewGateState)
  ) {
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: [],
      gateState: reviewGateState,
      eligible: false,
      reason: `review gate is ${reviewGateState}`,
    };
  }
  if (!["pass", "fail"].includes(round.verdict)) {
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: [],
      gateState,
      eligible: false,
      reason: `expected pass, got ${round.verdict ?? "missing"}`,
    };
  }
  if (blockers.length > 0) {
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: [],
      gateState,
      eligible: false,
      reason: "BLOCKER findings require an audited force merge",
    };
  }

  const policy = REVIEW_POLICIES.has(project.reviewPolicy) ? project.reviewPolicy : "strict";
  if (policy === "strict" && openFindings.length > 0) {
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: [],
      gateState,
      eligible: false,
      reason: `${openFindings.length} open review finding${openFindings.length === 1 ? "" : "s"}`,
    };
  }
  if (policy === "tiered") {
    const severe = openFindings.filter((finding) =>
      !["minor", "nit"].includes(finding.severity));
    if (severe.length > 0) {
      return {
        required,
        round,
        findings,
        openFindings,
        blockers,
        advisories: [],
        gateState,
        eligible: false,
        reason: `${severe.length} open MAJOR finding${severe.length === 1 ? "" : "s"}`,
      };
    }
    return {
      required,
      round,
      findings,
      openFindings,
      blockers,
      advisories: openFindings,
      gateState,
      eligible: true,
    };
  }
  return {
    required,
    round,
    findings,
    openFindings,
    blockers,
    advisories: [],
    gateState,
    eligible: true,
  };
}
