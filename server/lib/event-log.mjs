// Atelier's structured operational event log (atelier-e5x).
//
// One append-only JSONL line per consequential decision, under XDG state, so
// "why did the queue do X" is one grep instead of registry-mtime forensics.
//
// THREE PROPERTIES THIS MODULE OWES ITS CALLERS, in priority order:
//
// 1. It can never fail a dispatch. `append` is total and does only bounded
//    preparation plus enqueue; the deferred batch flush degrades to warn-once
//    backoff. Callers in lifecycle paths still wrap it (defence in depth), but
//    the guarantee lives HERE so a new call site cannot forget it.
// 2. It never persists a secret. Redaction happens at write time through
//    stream.mjs's shared value redactor (secret-shaped KEYS blanked, credential
//    shapes in strings replaced) - never at read time, where a leak is already
//    on disk.
// 3. Reads never re-read a truncated window. `read` returns the newest N
//    matching events; FOLLOWERS advance a byte cursor (`tail` then `poll`), so
//    every retained appended byte is delivered exactly once across rotation,
//    with an explicit marker when retention made continuity impossible. A
//    follower that re-applied `limit` on each pass would silently drop
//    everything that scrolled past the window between polls - the archived
//    atelier-e5x MAJOR, now covered by regression tests.
//
// Track B seam: `append(kind, payload, { source })` is deliberately NOT
// server-internal. `source` defaults to "server"; authenticated per-dispatch
// hook events will write into this same log with source "dispatch" and no
// change to this module beyond accepting that value. The schema is versioned
// (`v`) for the same reason.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import {
  appendDurable as appendFileDurable,
  fsyncDirectoryBestEffort,
} from "./fs-integrity.mjs";
import { redactValue } from "./stream.mjs";

export const EVENT_LOG_SCHEMA_VERSION = 1;
export const DEFAULT_LOG_LIMIT = 200;
export const MAX_LOG_LIMIT = 1_000;
export const MAX_LOG_KINDS = 16;

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_ROTATIONS = 5;
const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;
const DEFAULT_DEGRADED_BACKOFF_MS = 1_000;
// A single event is a decision record, not a payload channel: bounded so one
// pathological field cannot push a rotation or blow up a read.
const MAX_STRING_LENGTH = 2_000;
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 64;
const TAIL_SCAN_BYTES = 64 * 1024;
const RESERVED_FIELDS = ["v", "ts", "seq", "source", "kind"];
const SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const FILTER_FIELDS = ["kind", "project", "dispatchId", "actor", "source", "ticketId"];
const STRICT_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const DEFAULT_FILE_OPS = Object.freeze({
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
});

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function bounded(value, depth = 0) {
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (depth >= MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((item) => bounded(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, child]) => [key, bounded(child, depth + 1)])
        .filter(([, child]) => child !== undefined),
    );
  }
  // Functions, symbols, bigints and undefined carry no operator value and
  // would either vanish or throw in JSON.stringify. Drop them explicitly.
  return undefined;
}

function parseLine(line) {
  try {
    const event = JSON.parse(line);
    return event && typeof event === "object" && !Array.isArray(event) ? event : undefined;
  } catch {
    // A torn tail from an unclean death is tolerated exactly like the dispatch
    // index tolerates one: the line is skipped, the file stays readable.
    return undefined;
  }
}

function parseLines(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const event = parseLine(line);
    if (event) events.push(event);
  }
  return events;
}

function filterError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Validate and normalize a caller-supplied log query (REST, MCP, CLI all share
 * this so a bad filter is rejected identically everywhere).
 *
 * @param {object} [query] raw filters
 * @returns {object} normalized filters with a bounded `limit`
 */
export function normalizeLogQuery(query = {}) {
  const normalized = {};
  for (const field of FILTER_FIELDS) {
    const value = query[field];
    if (value === undefined || value === null || value === "") continue;
    if (field === "kind") {
      const kinds = String(value).split(",").map((kind) => kind.trim()).filter(Boolean);
      if (kinds.length === 0) continue;
      if (kinds.length > MAX_LOG_KINDS) {
        throw filterError(`kind must contain at most ${MAX_LOG_KINDS} values`);
      }
      normalized.kind = kinds;
      continue;
    }
    normalized[field] = String(value);
  }
  if (query.since !== undefined && query.since !== null && query.since !== "") {
    const rawSince = String(query.since);
    const since = STRICT_ISO_8601.test(rawSince) ? Date.parse(rawSince) : Number.NaN;
    if (!Number.isFinite(since)) throw filterError("since must be an ISO-8601 timestamp");
    normalized.since = since;
  }
  if (query.limit !== undefined && query.limit !== null && query.limit !== "") {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
      throw filterError(`limit must be an integer between 1 and ${MAX_LOG_LIMIT}`);
    }
    normalized.limit = limit;
  } else {
    normalized.limit = DEFAULT_LOG_LIMIT;
  }
  return normalized;
}

/**
 * Match one event against normalized filters.
 *
 * @param {object} event stored event
 * @param {object} [filters] output of {@link normalizeLogQuery}
 * @returns {boolean} true when the event should be returned
 */
export function matchesLogQuery(event, filters = {}) {
  if (filters.kind && !filters.kind.includes(event.kind)) return false;
  for (const field of FILTER_FIELDS) {
    if (field === "kind") continue;
    if (filters[field] !== undefined && event[field] !== filters[field]) return false;
  }
  if (filters.since !== undefined) {
    const at = Date.parse(event.ts || "");
    if (!Number.isFinite(at) || at < filters.since) return false;
  }
  return true;
}

/**
 * Field-level diff for settings/registry change events. Values are compared
 * structurally; the caller's redaction happens later, at write time.
 *
 * @param {object} [before] prior field values
 * @param {object} [after] next field values
 * @param {Iterable<string>} [fields] optional field allowlist
 * @returns {object} `{ field: { from, to } }` for changed fields only
 */
export function fieldDiff(before = {}, after = {}, fields = undefined) {
  const keys = fields ?? new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return Object.fromEntries(
    [...keys].flatMap((key) => {
      const from = before?.[key];
      const to = after?.[key];
      if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return [];
      return [[key, { from: from ?? null, to: to ?? null }]];
    }),
  );
}

/**
 * Open (lazily creating) the structured event log under a Atelier state directory.
 *
 * @param {object} options
 * @param {string} options.stateDir Atelier XDG state directory
 * @param {number} [options.maxBytes] rotation threshold for the active file
 * @param {number} [options.rotations] how many rotated files to retain
 * @param {number} [options.maxScanBytes] maximum bytes one filtered read scans
 * @param {number} [options.degradedBackoffMs] retry delay after a failed batch
 * @param {Function} [options.now] clock seam for degradation tests
 * @param {object} [options.logger] warn sink for degraded persistence
 * @param {object} [options.fileOps] injectable fs surface (tests)
 * @returns {object} frozen writer/reader handle
 */
export function createEventLog({
  stateDir,
  maxBytes = DEFAULT_MAX_BYTES,
  rotations = DEFAULT_ROTATIONS,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  degradedBackoffMs = DEFAULT_DEGRADED_BACKOFF_MS,
  now = Date.now,
  logger = console,
  fileOps = DEFAULT_FILE_OPS,
} = {}) {
  if (typeof stateDir !== "string" || !stateDir) throw new Error("stateDir is required");
  const directory = join(stateDir, "logs");
  const path = join(directory, "events.jsonl");
  const retained = positiveInteger(rotations, DEFAULT_ROTATIONS);
  const sizeLimit = positiveInteger(maxBytes, DEFAULT_MAX_BYTES);
  const scanLimit = positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES);
  const backoffMs = positiveInteger(degradedBackoffMs, DEFAULT_DEGRADED_BACKOFF_MS);
  const listeners = new Set();
  let warned = false;
  let directoryReady = false;
  let pending = [];
  let flushScheduled = false;
  let closed = false;
  let retryAt = 0;
  let droppedEvents = 0;
  let degradedSince;
  let recoverySummaryQueued = false;

  function rotatedPath(index) {
    return join(directory, `events.${index}.jsonl`);
  }

  // Newest first. Rotation shifts the active file to events.1.jsonl, so higher
  // indices are older.
  function readableFiles() {
    const files = [path];
    for (let index = 1; index <= retained; index += 1) files.push(rotatedPath(index));
    return files;
  }

  function warnOnce(message) {
    if (warned) return;
    warned = true;
    try {
      logger?.warn?.(message);
    } catch {
      // A logger that throws must not become the failure it was reporting.
    }
  }

  function statOrUndefined(target) {
    try {
      return fileOps.statSync(target);
    } catch {
      return undefined;
    }
  }

  // Byte-range read so a follower consumes only what was appended since its
  // cursor. Returns the raw buffer; the caller decides where complete lines end.
  function readRange(target, start, end) {
    const length = end - start;
    if (!(length > 0)) return Buffer.alloc(0);
    const fd = fileOps.openSync(target, "r");
    try {
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const bytes = fileOps.readSync(fd, buffer, read, length - read, start + read);
        if (!bytes) break;
        read += bytes;
      }
      return buffer.subarray(0, read);
    } finally {
      try {
        fileOps.closeSync(fd);
      } catch {
        // Closing a readable fd cannot fail in a way that matters here.
      }
    }
  }

  // A file's identity for follow purposes: the sequence number of its FIRST
  // event PLUS a hash of that first line's bytes. Separate writers can mint the
  // same seq, so the sequence alone can alias the cursor's rotated file to a
  // different active file.
  //
  // NOT the inode. Rotation deletes the oldest retained file and creates a new
  // active one, and both tmpfs and ext4 hand the freed inode NUMBER straight
  // back - so an inode check reports "same file" across a rotation and a
  // follower silently stops delivering. (Found exactly that way: a cross-process
  // follow test delivered 0 of 25 events while every in-process test passed.)
  // The full first-line identity is content, so neither an inode nor a duplicate
  // sequence can be recycled underneath a follower.
  function headIdentityIn(target) {
    const stats = statOrUndefined(target);
    if (!stats?.size) return null;
    let buffer;
    try {
      buffer = readRange(target, 0, Math.min(stats.size, TAIL_SCAN_BYTES));
    } catch {
      return null;
    }
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(0x0a, start);
      const end = newline === -1 ? buffer.length : newline;
      const line = buffer.subarray(start, end);
      const event = parseLine(line.toString("utf8"));
      if (Number.isInteger(event?.seq)) {
        return {
          seq: event.seq,
          hash: createHash("sha256").update(line).digest("hex"),
        };
      }
      if (newline === -1) break;
      start = newline + 1;
    }
    return null;
  }

  // One bounded tail read answers both questions a restart has to ask: where the
  // sequence left off, and whether the last line is torn.
  function inspectTail(target) {
    const stats = statOrUndefined(target);
    if (!stats?.size) return { seq: 0, unterminated: false };
    const start = Math.max(0, stats.size - TAIL_SCAN_BYTES);
    let buffer;
    try {
      buffer = readRange(target, start, stats.size);
    } catch {
      return { seq: 0, unterminated: false };
    }
    const unterminated = buffer.length > 0 && buffer.at(-1) !== 0x0a;
    let seqInTail = 0;
    for (const event of parseLines(buffer.toString("utf8")).reverse()) {
      if (Number.isInteger(event.seq)) {
        seqInTail = event.seq;
        break;
      }
    }
    return { seq: seqInTail, unterminated };
  }

  // seq is a monotonic ordering hint that survives restarts: recovered from the
  // newest readable tail rather than reset to 0, so a restart cannot make new
  // events sort before old ones. It is NOT a global identity - a second writer
  // process (`atelier dispatch`, a Track B hook) can mint the same number - which
  // is exactly why followers advance a byte cursor instead of filtering on seq.
  let seq = 0;
  // A torn final line from an unclean death would otherwise have the next append
  // concatenated onto it, corrupting BOTH - so the boundary is repaired on the
  // next write, exactly as the dispatch index repairs its own JSONL boundary.
  let repairBoundary = false;
  try {
    const active = inspectTail(path);
    seq = active.seq || inspectTail(rotatedPath(1)).seq;
    repairBoundary = active.unterminated;
  } catch {
    seq = 0;
  }

  function ensureDirectory() {
    if (directoryReady) return;
    fileOps.mkdirSync(directory, { recursive: true });
    directoryReady = true;
  }

  function rotate(incomingBytes) {
    const stats = statOrUndefined(path);
    const currentBytes = stats?.size ?? 0;
    if (currentBytes === 0 || currentBytes + incomingBytes <= sizeLimit) return;
    fileOps.rmSync(rotatedPath(retained), { force: true });
    for (let index = retained - 1; index >= 1; index -= 1) {
      const from = rotatedPath(index);
      if (fileOps.existsSync(from)) fileOps.renameSync(from, rotatedPath(index + 1));
    }
    fileOps.renameSync(path, rotatedPath(1));
    fsyncDirectoryBestEffort(directory, { fileOps });
  }

  function normalizeSource(value) {
    const source = value === undefined ? "server" : String(value);
    return SOURCE_PATTERN.test(source) ? source : "unknown";
  }

  // Returns the event as it will actually be persisted, so callers and listeners
  // never see a richer object than the log holds.
  function serialize(event) {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) <= MAX_EVENT_BYTES) return { event, line };
    // Never drop the decision itself because one field was oversized.
    const trimmed = {
      v: event.v,
      ts: event.ts,
      seq: event.seq,
      source: event.source,
      kind: event.kind,
      ...(typeof event.project === "string" ? { project: event.project } : {}),
      ...(typeof event.dispatchId === "string" ? { dispatchId: event.dispatchId } : {}),
      truncated: true,
    };
    return { event: trimmed, line: `${JSON.stringify(trimmed)}\n` };
  }

  function notify(events) {
    for (const event of events) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // One consumer cannot break persistence or the other consumers.
        }
      }
    }
  }

  function recoverySummary() {
    return {
      ...serialize({
        v: EVENT_LOG_SCHEMA_VERSION,
        ts: new Date(now()).toISOString(),
        seq: (seq += 1),
        source: "server",
        kind: "log.degraded",
        dropped: droppedEvents,
        since: degradedSince,
      }),
      recoverySummary: true,
    };
  }

  /**
   * Persist the current in-memory batch. Exported on the returned handle as a
   * deterministic test/read seam; production calls normally arrive through the
   * scheduled microtask.
   *
   * @returns {boolean} true when no batch remains or the batch was persisted
   */
  function flush() {
    flushScheduled = false;
    if (pending.length === 0) return true;
    const batch = pending;
    pending = [];
    recoverySummaryQueued = false;
    const line = `${repairBoundary ? "\n" : ""}${batch.map((item) => item.line).join("")}`;
    try {
      ensureDirectory();
      rotate(Buffer.byteLength(line));
      // One filesystem append for the whole microtask batch: lifecycle callers
      // never rotate or write inline.
      fileOps.appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      repairBoundary = false;
      const recovered = batch.some((item) => item.recoverySummary);
      if (recovered) {
        droppedEvents = 0;
        degradedSince = undefined;
        retryAt = 0;
      }
      warned = false;
      notify(batch.map((item) => item.event));
      return true;
    } catch (error) {
      droppedEvents += batch.filter((item) => !item.recoverySummary).length;
      degradedSince ??= new Date(now()).toISOString();
      retryAt = now() + backoffMs;
      warnOnce(
        `Atelier event log write failed (${error?.message ?? error}); continuing without event history`,
      );
      return false;
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      if (!closed) flush();
    });
  }

  /**
   * Append one event. Total function: it never throws and never returns a
   * rejected promise, whatever the caller passes or the filesystem does.
   * Payloads are bounded before redaction copies them, then the serialized event
   * is enqueued for one deferred batch append.
   *
   * @param {string} kind dotted event kind, e.g. "queue.drain"
   * @param {object} [payload] event fields (bounded and redacted here)
   * @param {object} [options] `{ source }`, default "server"
   * @returns {object|undefined} the accepted event, or undefined while degraded
   */
  function append(kind, payload = {}, options = {}) {
    if (closed) return undefined;
    if (retryAt > now()) {
      droppedEvents += 1;
      return undefined;
    }
    try {
      // The order is deliberate: redactValue recursively clones. Bounding first
      // means a 100k candidate list pays for only the 64 entries we can persist.
      const boundedPayload = bounded(payload ?? {});
      const safePayload =
        boundedPayload && typeof boundedPayload === "object" && !Array.isArray(boundedPayload)
          ? redactValue(boundedPayload)
          : {};
      for (const field of RESERVED_FIELDS) delete safePayload[field];
      if (droppedEvents > 0 && !recoverySummaryQueued) {
        pending.push(recoverySummary());
        recoverySummaryQueued = true;
      }
      const serialized = serialize({
        v: EVENT_LOG_SCHEMA_VERSION,
        ts: new Date(now()).toISOString(),
        seq: (seq += 1),
        source: normalizeSource(options.source),
        kind: String(kind),
        ...safePayload,
      });
      pending.push(serialized);
      scheduleFlush();
      return serialized.event;
    } catch (error) {
      warnOnce(
        `Atelier event log could not enqueue an event (${error?.message ?? error}); continuing without event history`,
      );
      return undefined;
    }
  }

  /**
   * Append one security-critical event synchronously and fsync the exact file
   * descriptor that received it. Unlike `append`, this method deliberately
   * throws: callers use it only where execution must fail closed if the audit
   * record cannot be made durable.
   */
  function appendDurable(kind, payload = {}, options = {}) {
    if (closed) throw new Error("Atelier event log is closed");
    if (!flush()) throw new Error("Atelier event log is degraded");
    const boundedPayload = bounded(payload ?? {});
    const safePayload =
      boundedPayload && typeof boundedPayload === "object" && !Array.isArray(boundedPayload)
        ? redactValue(boundedPayload)
        : {};
    // Break-glass token ids are audit correlation handles, not signed bearer
    // tokens. Preserve those exact non-authorizing handles even though the
    // general redactor conservatively treats every token-shaped key as secret.
    if (["dispatch.break-glass", "dispatch.merge"].includes(kind)) {
      for (const field of ["tokenId", "supersededByTokenId"]) {
        if (
          typeof boundedPayload?.[field] === "string" &&
          /^[A-Za-z0-9_-]{43}$/.test(boundedPayload[field])
        ) {
          safePayload[field] = boundedPayload[field];
        }
      }
    }
    for (const field of RESERVED_FIELDS) delete safePayload[field];
    const serialized = serialize({
      v: EVENT_LOG_SCHEMA_VERSION,
      ts: new Date(now()).toISOString(),
      seq: (seq += 1),
      source: normalizeSource(options.source),
      kind: String(kind),
      ...safePayload,
    });
    ensureDirectory();
    rotate(Buffer.byteLength(serialized.line));
    appendFileDurable(path, serialized.line, {
      fileOps: {
        ...fileOps,
        // event-log's established injection seam names this operation for its
        // ordinary path; fs-integrity names the descriptor-level equivalent.
        appendDescriptorSync: fileOps.appendFileSync,
      },
    });
    repairBoundary = false;
    warned = false;
    notify([serialized.event]);
    return serialized.event;
  }

  /**
   * Read the newest matching events with scan metadata. A byte cap bounds sparse
   * filters across retention; `truncated` tells callers the search did not reach
   * the oldest retained byte.
   *
   * @param {object} [query] raw filters (see {@link normalizeLogQuery})
   * @returns {{events: object[], truncated: boolean}} chronological matches
   */
  function readResult(query = {}) {
    const filters = normalizeLogQuery(query);
    flush();
    const collected = [];
    let remainingBytes = scanLimit;
    let truncated = false;
    // Newest file first, stopping as soon as the event or scan bound is
    // satisfied. The newest tail of an oversized file is the useful portion.
    for (const file of readableFiles()) {
      if (collected.length >= filters.limit) break;
      const stats = statOrUndefined(file);
      if (!stats?.size) continue;
      if (remainingBytes <= 0) {
        truncated = true;
        break;
      }
      const bytes = Math.min(stats.size, remainingBytes);
      const start = stats.size - bytes;
      let text;
      try {
        text = readRange(file, start, stats.size).toString("utf8");
      } catch {
        text = "";
      }
      remainingBytes -= bytes;
      if (start > 0) {
        truncated = true;
        const firstNewline = text.indexOf("\n");
        text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
      }
      const matching = parseLines(text).filter((event) => matchesLogQuery(event, filters));
      const room = filters.limit - collected.length;
      collected.unshift(...matching.slice(-room));
    }
    return { events: collected, truncated };
  }

  /**
   * Read only the events for compatibility with existing CLI/dispatcher callers.
   * `readResult` is the metadata-bearing API used by `/api/logs`.
   */
  function read(query = {}) {
    return readResult(query).events;
  }

  function cursorFor(target) {
    const stats = statOrUndefined(target);
    const identity = headIdentityIn(target);
    return {
      headSeq: identity?.seq ?? null,
      headHash: identity?.hash ?? null,
      offset: stats?.size ?? 0,
      seq,
    };
  }

  /**
   * Backfill + cursor for a follower: the newest matching events plus the
   * position to resume from. Capturing the cursor BEFORE parsing means an event
   * appended during the backfill is delivered by the first `poll` instead of
   * being skipped.
   *
   * @param {object} [query] raw filters
   * @returns {{events: object[], cursor: object}} backfill and resume cursor
   */
  function tail(query = {}) {
    flush();
    const cursor = cursorFor(path);
    return { events: read(query), cursor };
  }

  /**
   * Advance a follower. Every byte appended since `cursor` is delivered exactly
   * once, including bytes that landed in a file which has since rotated away.
   *
   * @param {object} cursor cursor from {@link tail} or a previous poll
   * @param {object} [query] raw filters
   * @returns {{events: object[], cursor: object}} new events and next cursor
   */
  function poll(cursor, query = {}) {
    flush();
    const filters = normalizeLogQuery({ ...query, limit: MAX_LOG_LIMIT });
    const events = [];
    let gap = false;
    let position = cursor && Number.isInteger(cursor.offset)
      ? {
        headSeq: Number.isInteger(cursor.headSeq) ? cursor.headSeq : null,
        headHash: typeof cursor.headHash === "string" ? cursor.headHash : null,
        offset: cursor.offset,
        seq: cursor.seq ?? 0,
      }
      : cursorFor(path);
    const consume = (target, from) => {
      const stats = statOrUndefined(target);
      if (!stats?.size || stats.size <= from) return from;
      let buffer;
      try {
        buffer = readRange(target, from, stats.size);
      } catch {
        return from;
      }
      const lastNewline = buffer.lastIndexOf(0x0a);
      // A partial trailing line stays unconsumed: the next poll re-reads it
      // once the writer has finished the line.
      if (lastNewline === -1) return from;
      events.push(...parseLines(buffer.subarray(0, lastNewline + 1).toString("utf8")));
      return from + lastNewline + 1;
    };

    const active = statOrUndefined(path);
    const activeIdentity = active ? headIdentityIn(path) : null;
    const sameIdentity = (left, right) =>
      left?.seq === right?.seq &&
      typeof left?.hash === "string" &&
      left.hash === right?.hash;
    const cursorIdentity = {
      seq: position.headSeq,
      hash: position.headHash,
    };
    // A cursor taken before the log file existed cannot name its file. A
    // contiguous retained sequence establishes the ordinary first append;
    // otherwise the recovery path below emits a gap before retained survivors.
    const unidentifiedCursor =
      position.headSeq === null && position.headHash === null && position.offset === 0;
    if (active && (unidentifiedCursor || !sameIdentity(activeIdentity, cursorIdentity))) {
      // Rotation. The cursor's file is now one of the rotated files: drain ITS
      // tail, then every newer rotation in full, then the new active file. A
      // follower can cross several rotations in one poll (fast writer, slow
      // poll) and must lose nothing that is still retained.
      let cursorIndex = -1;
      for (let index = 1; index <= retained; index += 1) {
        if (!unidentifiedCursor && sameIdentity(headIdentityIn(rotatedPath(index)), cursorIdentity)) {
          cursorIndex = index;
          break;
        }
      }
      if (cursorIndex > 0) {
        const cursorFile = statOrUndefined(rotatedPath(cursorIndex));
        if (cursorFile && cursorFile.size < position.offset) {
          gap = true;
          consume(rotatedPath(cursorIndex), 0);
        } else {
          consume(rotatedPath(cursorIndex), position.offset);
        }
        for (let index = cursorIndex - 1; index >= 1; index -= 1) consume(rotatedPath(index), 0);
      } else {
        // The file this cursor was reading has rotated out of retention: history
        // is genuinely gone. Deliver what IS retained and say so explicitly;
        // sequence de-duplication is unsafe because concurrent writers can mint
        // the same sequence.
        let earliestRetainedSeq = activeIdentity?.seq;
        for (let index = retained; index >= 1; index -= 1) {
          const identity = headIdentityIn(rotatedPath(index));
          if (identity) {
            earliestRetainedSeq = identity.seq;
            break;
          }
        }
        gap = !unidentifiedCursor ||
          (Number.isInteger(earliestRetainedSeq) &&
            earliestRetainedSeq > (position.seq ?? 0) + 1);
        for (let index = retained; index >= 1; index -= 1) consume(rotatedPath(index), 0);
      }
      position = {
        headSeq: activeIdentity?.seq ?? null,
        headHash: activeIdentity?.hash ?? null,
        offset: 0,
        seq: position.seq ?? 0,
      };
    } else if (active && active.size < position.offset) {
      // Truncated or replaced in place: re-read from the start rather than
      // silently skipping the difference, and report that continuity is gone.
      gap = true;
      position = {
        headSeq: activeIdentity?.seq ?? null,
        headHash: activeIdentity?.hash ?? null,
        offset: 0,
        seq: position.seq ?? 0,
      };
    }
    if (active) {
      position = {
        headSeq: activeIdentity?.seq ?? null,
        headHash: activeIdentity?.hash ?? null,
        offset: consume(path, position.offset),
        seq: position.seq ?? 0,
      };
    }
    const delivered = events.filter((event) => matchesLogQuery(event, filters));
    const highest = events.reduce(
      (top, event) => (Number.isInteger(event.seq) && event.seq > top ? event.seq : top),
      position.seq ?? 0,
    );
    return {
      events: [...(gap ? [{ gap: true }] : []), ...delivered],
      cursor: { ...position, seq: highest },
    };
  }

  /**
   * Subscribe to events written by THIS process (used by the SSE-less UI/CLI
   * paths in-process; cross-process followers use {@link poll}).
   *
   * @param {Function} listener called with each written event
   * @returns {Function} unsubscribe
   */
  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function shutdown() {
    if (closed) return;
    flush();
    closed = true;
  }

  return Object.freeze({
    _flush: flush,
    append,
    appendDurable,
    directory,
    onEvent,
    path,
    poll,
    read,
    readResult,
    shutdown,
    tail,
  });
}
