import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseIssuesJsonl } from "./tracker.mjs";

const WORST_READY_PRIORITY = 5;
const READY_SNAPSHOT_ATTEMPTS = 3;

function warnReady(warn, message) {
  try {
    warn?.(message);
  } catch {
    // Logging failures must not block an otherwise usable ready snapshot.
  }
}

function readyPriority(value) {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const normalized = typeof value === "string"
    ? value.trim().replace(/^P/i, "")
    : value;
  if (normalized === "") return undefined;
  const priority = Number(normalized);
  return Number.isInteger(priority) && priority >= 0 && priority < WORST_READY_PRIORITY
    ? priority
    : undefined;
}

function readyCreatedAt(value) {
  if (typeof value !== "string" || value.trim() === "") return Infinity;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Infinity : timestamp;
}

function orderedReadyTicketIds(issues, warn) {
  const candidates = issues.flatMap((issue) => {
    if (typeof issue?.id !== "string" || !issue.id) return [];
    const priority = readyPriority(issue.priority);
    if (priority === undefined) {
      warnReady(
        warn,
        `Atelier ready queue: ${issue.id} has missing or invalid priority metadata; treating it as lowest priority`,
      );
    }
    return [{
      id: issue.id,
      priority: priority ?? WORST_READY_PRIORITY,
      createdAt: readyCreatedAt(issue.created_at),
    }];
  });
  candidates.sort((left, right) => {
    const priority = left.priority - right.priority;
    if (priority !== 0) return priority;
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
    return left.id.localeCompare(right.id);
  });
  return new Set(candidates.map((issue) => issue.id));
}

function isReadyTextBoilerplate(line) {
  const trimmed = line.trim();
  return !trimmed ||
    /^📋\s+Ready work\b/i.test(trimmed) ||
    /^✨\s+No ready issues\s+—\s+all remaining work is blocked, deferred, or in progress$/i.test(trimmed) ||
    /^✨\s+All work complete\s+—\s+no issues to work on$/i.test(trimmed);
}

function readyJsonIssues(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid br ready JSON: ${error.message}`);
  }
  const issues = Array.isArray(parsed) ? parsed : parsed?.issues;
  if (!Array.isArray(issues)) {
    throw new Error("Invalid br ready JSON: expected an issue array");
  }
  for (const [index, issue] of issues.entries()) {
    if (
      !issue ||
      typeof issue !== "object" ||
      Array.isArray(issue) ||
      typeof issue.id !== "string" ||
      issue.id.trim() === ""
    ) {
      throw new Error(`Invalid br ready JSON issue at index ${index}`);
    }
  }
  return issues;
}

function parseReadyJsonTicketIds(raw, { warn } = {}) {
  return orderedReadyTicketIds(readyJsonIssues(raw), warn);
}

function parseReadyTextTicketIds(raw, { warn } = {}) {
  let unparseableRows = 0;
  let declaredCount;
  let recognizedEmptyState = false;
  const issues = String(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""))
    .flatMap((line, index) => {
      const count = /^📋\s+Ready work\s+\((\d+)\s+issues?\b/i.exec(line.trim());
      if (count) declaredCount = Number(count[1]);
      if (
        /^✨\s+No ready issues\s+—\s+all remaining work is blocked, deferred, or in progress$/i
          .test(line.trim()) ||
        /^✨\s+All work complete\s+—\s+no issues to work on$/i.test(line.trim())
      ) {
        recognizedEmptyState = true;
      }
      if (isReadyTextBoilerplate(line)) return [];
      const ticket = /([a-zA-Z0-9][a-zA-Z0-9._-]*-[a-zA-Z0-9._-]+):(?=\s|$)/.exec(line);
      const metadata = ticket ? line.slice(0, ticket.index) : line;
      const bracketedPriority = /\[(?:[●○◐]\s*)?(P?\s*\d+(?:\.\d+)?)\]/i.exec(metadata);
      const priorityToken = /\bP\s*\d+(?:\.\d+)?\b/i.exec(metadata);
      const priority = bracketedPriority?.[1] ?? priorityToken?.[0];
      if (!ticket || !priority) {
        unparseableRows += 1;
        warnReady(
          warn,
          `Atelier ready queue: skipped unparseable br ready text line ${index + 1}`,
        );
        return [];
      }
      return [{ id: ticket[1], priority }];
    });
  if (
    issues.length === 0 &&
    (
      unparseableRows > 0 ||
      (declaredCount !== undefined && declaredCount > 0) ||
      (declaredCount === undefined && !recognizedEmptyState)
    )
  ) {
    throw new Error("Invalid br ready text: no parseable issue rows");
  }
  return orderedReadyTicketIds(issues, warn);
}

export function parseReadyTicketIds(raw, options = {}) {
  const trimmed = String(raw).trimStart();
  return trimmed.startsWith("[") || trimmed.startsWith("{")
    ? parseReadyJsonTicketIds(raw, options)
    : parseReadyTextTicketIds(raw, options);
}

function lacksStructuredReady(error) {
  const message = String(error?.message ?? error);
  return /(?:unknown|unrecognized|unsupported)\s+(?:option|flag|argument)[^\n]*--json/i.test(message) ||
    /unexpected argument\s+['"]?--json/i.test(message) ||
    /(?:option|flag)\s+['"]?--json['"]?[^\n]*(?:not supported|not found|unknown)/i.test(message);
}

export async function loadReadyTicketIds(run, br, cwd, options = {}) {
  let raw;
  try {
    raw = await run(br, ["ready", "--json"], { cwd });
  } catch (error) {
    if (!lacksStructuredReady(error)) throw error;
    return parseReadyTextTicketIds(await run(br, ["ready"], { cwd }), options);
  }
  return parseReadyJsonTicketIds(raw, options);
}

function trackerSignature(info) {
  return [
    info.dev ?? "",
    info.ino ?? "",
    info.size,
    info.mtimeMs,
    info.ctimeMs,
  ].join(":");
}

export async function loadFencedReadySnapshot(
  run,
  br,
  cwd,
  {
    warn,
    readTrackerFile = readFile,
    statTrackerFile = stat,
    maxAttempts = READY_SNAPSHOT_ATTEMPTS,
  } = {},
) {
  const source = join(cwd, ".beads", "issues.jsonl");
  const attempts = Number.isInteger(maxAttempts) && maxAttempts > 0
    ? maxAttempts
    : READY_SNAPSHOT_ATTEMPTS;
  let lastIssues = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = trackerSignature(await statTrackerFile(source));
    const raw = await readTrackerFile(source, "utf8");
    const issues = parseIssuesJsonl(raw);
    lastIssues = issues;
    let degraded = false;
    let readyTicketIds = new Set();
    try {
      readyTicketIds = await loadReadyTicketIds(run, br, cwd, { warn });
    } catch {
      degraded = true;
    }
    const after = trackerSignature(await statTrackerFile(source));
    if (before === after) {
      return { issues, readyTicketIds, degraded };
    }
  }

  return {
    issues: lastIssues,
    readyTicketIds: new Set(),
    degraded: true,
  };
}
