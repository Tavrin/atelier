import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  _clearProbeCache,
  probeProject,
  probeProjectPath,
  trackerMode,
} from "./lib/capabilities.mjs";
import { agents } from "./lib/agents/index.mjs";
import { createRequestAuth } from "./lib/auth.mjs";
import { createBoardEvents } from "./lib/board-events.mjs";
import {
  LONG_GIT_TIMEOUT_MS,
  resolveBrExecutable,
  runFile,
  spawnTracked,
} from "./lib/exec.mjs";
import {
  gitChildEnv,
  sanitizeChildEnv,
} from "./lib/execution/environment-policy.mjs";
import {
  HttpError,
  jsonResponse,
  optionalString,
  parsePriority,
  readJsonBody,
  requiredString,
  textResponse,
} from "./lib/http.mjs";
import { createEventLog, fieldDiff } from "./lib/event-log.mjs";
import { configDir, stateDir } from "./lib/paths.mjs";
import {
  addProject,
  projectOwnDispatchProfile,
  RegistryError,
  removeProject,
  resolveProjectDefaultAgent,
  updateProject,
  validateProject,
  validateProjectAddition,
} from "./lib/registry.mjs";
import {
  claimIssue,
  closeIssue,
  commentIssue,
  createIssue,
  initializeTrackerDirectory,
  promoteIssue,
  trackerDirectory,
} from "./lib/tracker.mjs";
import { moveProjectTracker } from "./lib/tracker-move.mjs";
import { snapshotThemeBundles } from "./lib/themes.mjs";
import { createBootStamp } from "./lib/version.mjs";
import { loadFencedReadySnapshot } from "./lib/ready.mjs";
import {
  aggregateChronicles,
  CHRONICLE_LIMIT,
  chronicleFor,
  readyIssuesFor,
  snapshotProjectArtifacts,
  snapshotChronicles,
} from "./lib/world-contract.mjs";

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");
const SHARED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "shared");
const THEMES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "themes");
const STATIC_ALLOWLIST = new Map([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { fileName: "app.js", contentType: "text/javascript; charset=utf-8" }],
  [
    "/agent-selection.mjs",
    { fileName: "agent-selection.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/log-view.mjs",
    { fileName: "log-view.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/main-health.mjs",
    { fileName: "main-health.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/board-stream.mjs",
    { fileName: "board-stream.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/ready-projection.mjs",
    { fileName: "ready-projection.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/notifications.mjs",
    { fileName: "notifications.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/reply-availability.mjs",
    { fileName: "reply-availability.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/shared/review-assessment.mjs",
    {
      fileName: "review-assessment.mjs",
      sourcePath: join(SHARED_DIR, "review-assessment.mjs"),
      contentType: "text/javascript; charset=utf-8",
    },
  ],
  ["/request.mjs", { fileName: "request.mjs", contentType: "text/javascript; charset=utf-8" }],
  [
    "/actor.mjs",
    { fileName: "actor.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  ["/components.mjs", { fileName: "components.mjs", contentType: "text/javascript; charset=utf-8" }],
  [
    "/theme-host.mjs",
    { fileName: "theme-host.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/theme-stream.mjs",
    { fileName: "theme-stream.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/theme-lib/request.mjs",
    { fileName: "request.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/theme-lib/actor.mjs",
    { fileName: "actor.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  [
    "/theme-lib/theme-stream.mjs",
    { fileName: "theme-stream.mjs", contentType: "text/javascript; charset=utf-8" },
  ],
  ["/atelier.css", { fileName: "atelier.css", contentType: "text/css; charset=utf-8" }],
  [
    "/manifest.webmanifest",
    { fileName: "manifest.webmanifest", contentType: "application/manifest+json; charset=utf-8" },
  ],
  ["/icon.svg", { fileName: "icon.svg", contentType: "image/svg+xml; charset=utf-8" }],
]);
const ISSUE_TYPES = new Set(["task", "bug", "chore"]);
const TRACKER_LOCATIONS = new Set(["external", "in-repo"]);
const ACTIVE_DISPATCH_STATES = new Set([
  "queued",
  "preparing",
  "resuming",
  "running",
  "plan_ready",
  "verifying",
  "stopping",
]);
const TERMINAL_DISPATCH_STATES = new Set([
  "completed",
  "completed_empty",
  "needs_input",
  "failed",
  "stopped",
  "prepare_failed",
  "rejected",
]);
const AGGREGATE_EVENT_TYPES = new Set([
  "status",
  "usage",
  "exit",
  "reply",
  "plan",
  "review",
  "review-disposition",
  "post-merge",
]);
const PATCH_LIMIT = 1024 * 1024;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 1_500;
const EVENT_STREAM_GLOBAL_LIMIT = 64;
const EVENT_STREAM_PER_CREDENTIAL_LIMIT = 8;
const MCP_RESTRICTED_SETTINGS = new Set([
  "requireReview",
  "reviewPolicy",
  "budgetUSDPerDay",
  "unpricedDispatchCapPerDay",
]);
const serverResources = new WeakMap();

function projectByName(registry, name) {
  const project = registry.projects.find((candidate) => candidate.name === name);
  if (!project) throw new HttpError(404, `Unknown project: ${name}`);
  return project;
}

function parkedTicketIds(dispatcher, projectName) {
  try {
    return dispatcher.getQueue(projectName).parkedTickets
      .map((ticket) => ticket?.ticketId)
      .filter(Boolean)
      .sort();
  } catch {
    return null;
  }
}

function projectPayload(project, defaults) {
  return {
    ...project,
    ownDispatchProfile: { ...projectOwnDispatchProfile(project) },
    resolvedDefaultAgent: resolveProjectDefaultAgent(project, defaults),
  };
}

async function projectStatus(project) {
  const capabilities = await probeProject(project);
  const detectedTracker = await trackerMode(project, capabilities);
  return { capabilities, detectedTracker };
}

async function trackedProject(project) {
  const status = await projectStatus(project);
  if (status.detectedTracker === "none") {
    throw new HttpError(409, `Project ${project.name} has no tracker`);
  }
  return status;
}

export async function trackProject(project) {
  const capabilities = await probeProject(project);
  const detectedTracker = await trackerMode(project, capabilities);
  if (project.archetype === "git-only") {
    throw new HttpError(409, `Project ${project.name} is git-only; tracker is disabled`);
  }
  if (detectedTracker === "none") {
    throw new HttpError(
      409,
      `Project ${project.name} has no tracker; Atelier will not write into the project tree`,
    );
  }
  return {
    ...project,
    capabilities,
    declaredTracker: project.tracker,
    detectedTracker,
  };
}

function parseNumstat(raw) {
  const files = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...pathParts] = line.split("\t");
      return {
        path: pathParts.join("\t"),
        insertions: added === "-" ? 0 : Number(added),
        deletions: removed === "-" ? 0 : Number(removed),
      };
    });
  return {
    files,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function writeSse(response, event, id = event.seq) {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function parseAggregateResume(value) {
  if (typeof value !== "string") return undefined;
  const match = /^([^:\s]+):(\d+)$/.exec(value);
  if (!match) return undefined;
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq)) return undefined;
  return { dispatchId: match[1], seq };
}

function trackEventStream(response, eventStreamState, credentialKey) {
  if (eventStreamState.responses.size >= eventStreamState.globalLimit) {
    throw new HttpError(429, "Atelier event-stream connection limit reached");
  }
  const credentialCount = eventStreamState.byCredential.get(credentialKey) ?? 0;
  if (credentialCount >= eventStreamState.perCredentialLimit) {
    throw new HttpError(429, "Atelier event-stream credential limit reached");
  }
  eventStreamState.responses.add(response);
  eventStreamState.byCredential.set(credentialKey, credentialCount + 1);
  response.once("close", () => {
    eventStreamState.responses.delete(response);
    const remaining = (eventStreamState.byCredential.get(credentialKey) ?? 1) - 1;
    if (remaining > 0) eventStreamState.byCredential.set(credentialKey, remaining);
    else eventStreamState.byCredential.delete(credentialKey);
  });
}

function openEventStream(request, response, dispatcher, eventStreamState, credentialKey, dispatchId) {
  trackEventStream(response, eventStreamState, credentialKey);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  if (dispatchId) {
    const since = Number.parseInt(request.headers["last-event-id"] || "0", 10) || 0;
    for (const event of dispatcher.getEvents(dispatchId, since) || []) writeSse(response, event);
  } else {
    const resumeHeader = request.headers["last-event-id"];
    if (resumeHeader === undefined) {
      const records = dispatcher.list();
      for (const record of records) {
        if (TERMINAL_DISPATCH_STATES.has(record.state)) continue;
        for (const event of dispatcher.getEvents(record.id, 0) || []) {
          if (AGGREGATE_EVENT_TYPES.has(event.type)) {
            writeSse(response, event, `${event.dispatchId}:${event.seq}`);
          }
        }
      }

      // Active history is operationally relevant and remains uncapped. Terminal
      // history is ordered by dispatch start (oldest first) and capped globally
      // to its newest 50 aggregate-eligible events because there is no global seq.
      const terminalEvents = [];
      for (const record of [...records].reverse()) {
        if (!TERMINAL_DISPATCH_STATES.has(record.state)) continue;
        for (const event of dispatcher.getEvents(record.id, 0) || []) {
          if (AGGREGATE_EVENT_TYPES.has(event.type)) terminalEvents.push(event);
        }
      }
      for (const event of terminalEvents.slice(-50)) {
        writeSse(response, event, `${event.dispatchId}:${event.seq}`);
      }
    } else {
      const resume = parseAggregateResume(resumeHeader);
      for (const record of dispatcher.list()) {
        // Aggregate resume is per dispatch, not a global ordering: only the
        // named dispatch skips through its saved seq; every other one replays fully.
        const since = resume?.dispatchId === record.id ? resume.seq : 0;
        for (const event of dispatcher.getEvents(record.id, since) || []) {
          if (AGGREGATE_EVENT_TYPES.has(event.type)) {
            writeSse(response, event, `${event.dispatchId}:${event.seq}`);
          }
        }
      }
    }
  }
  response.write(": heartbeat\n\n");

  const removeListener = dispatcher.onEvent((event) => {
    if (dispatchId && event.dispatchId !== dispatchId) return;
    if (!dispatchId && !AGGREGATE_EVENT_TYPES.has(event.type)) return;
    writeSse(response, event, dispatchId ? event.seq : `${event.dispatchId}:${event.seq}`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  response.once("close", () => {
    clearInterval(heartbeat);
    removeListener();
  });
}

function openBoardEventStream(response, boardEvents, bootStamp, eventStreamState, credentialKey) {
  trackEventStream(response, eventStreamState, credentialKey);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  writeSse(response, {
    type: "hello",
    version: bootStamp.version,
    bootedAt: bootStamp.bootedAt,
  });
  response.write(": heartbeat\n\n");

  const removeListener = boardEvents.onEvent((event) => writeSse(response, event));
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref();
  response.once("close", () => {
    clearInterval(heartbeat);
    removeListener();
  });
}

function snapshotStaticAssets(uiDir) {
  const bodies = new Map();
  return new Map(
    [...STATIC_ALLOWLIST].map(([route, { fileName, sourcePath, contentType }]) => {
      const path = sourcePath ?? join(uiDir, fileName);
      if (!bodies.has(path)) bodies.set(path, readFileSync(path));
      return [route, { body: bodies.get(path), contentType }];
    }),
  );
}

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const CHRONICLE_GIT_BUFFER = 8 * 1024 * 1024;
const CHRONICLE_FIELD_SEPARATOR = "\x1f";

function parseChronicleNumstat(raw) {
  const stats = new Map();
  for (const section of String(raw).split("\x1e").slice(1)) {
    const [commitLine, ...lines] = section.split(/\r?\n/);
    const commit = commitLine.trim();
    if (!GIT_OBJECT_ID.test(commit)) continue;
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of lines) {
      if (!line) continue;
      const [added, removed, ...pathParts] = line.split("\t");
      if (pathParts.length === 0) continue;
      files += 1;
      if (added !== "-") insertions += Number(added) || 0;
      if (removed !== "-") deletions += Number(removed) || 0;
    }
    stats.set(commit, { files, insertions, deletions });
  }
  return stats;
}

function chronicleDiffStats(project, records, gitRunner) {
  const commits = [...new Set(
    records
      .map((record) => String(record?.merged?.commit ?? ""))
      .filter((commit) => GIT_OBJECT_ID.test(commit)),
  )];
  if (commits.length === 0) return new Map();
  try {
    const output = gitRunner(
      "git",
      [
        "-C",
        project.path,
        "log",
        "--no-walk",
        "-m",
        "--first-parent",
        "--root",
        "--numstat",
        "--format=%x1e%H",
        "--ignore-missing",
        ...commits,
      ],
      {
        encoding: "utf8",
        env: gitChildEnv(),
        timeout: LONG_GIT_TIMEOUT_MS,
        maxBuffer: CHRONICLE_GIT_BUFFER,
        windowsHide: true,
      },
    );
    return parseChronicleNumstat(output);
  } catch {
    return new Map();
  }
}

function historyTitle(subject) {
  const withoutPrefix = String(subject).replace(/^merge:\s*/, "");
  const withoutDispatch = withoutPrefix.replace(
    /^atelier dispatch [0-9a-f]{6,}\s*(?:\([^)]+\))?\s*/i,
    "",
  );
  return withoutDispatch.trim() || withoutPrefix.trim() || "merged work";
}

function ticketFromHistorySubject(project, subject) {
  const escaped = String(project.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(subject).match(new RegExp(`\\b${escaped}-[a-z0-9]+\\b`, "i"))?.[0] ?? null;
}

function parseChronicleMergeHistory(project, raw) {
  const records = [];
  for (const section of String(raw).split("\x1e").slice(1)) {
    const line = section.split(/\r?\n/, 1)[0];
    const [commit, mergedAt, ...subjectParts] = line.split(CHRONICLE_FIELD_SEPARATOR);
    const subject = subjectParts.join(CHRONICLE_FIELD_SEPARATOR).trim();
    if (!GIT_OBJECT_ID.test(commit?.trim()) || !mergedAt || !subject) continue;
    const normalizedCommit = commit.trim();
    const dispatchId = subject.match(/\batelier dispatch ([0-9a-f]{6,})\b/i)?.[1];
    records.push({
      id: dispatchId ?? normalizedCommit.slice(0, 8),
      project: project.name,
      ticketId: ticketFromHistorySubject(project, subject),
      title: historyTitle(subject),
      costUSD: null,
      merged: {
        commit: normalizedCommit,
        mergedAt,
        strategy: "git-history",
      },
      postMerge: null,
    });
  }
  return records;
}

/**
 * The village is an accreted history, including Atelier merges older than the
 * retained dispatcher record set. Atelier itself writes lower-case `merge:`
 * subjects, so that prefix is the bounded, project-agnostic provenance rule:
 * it backfills the durable Git ledger without turning every incidental branch
 * reconciliation into a claimed Atelier undertaking.
 */
function chronicleMergeHistory(project, gitRunner) {
  try {
    const output = gitRunner(
      "git",
      [
        "-C",
        project.path,
        "log",
        "--merges",
        "--grep=^merge:",
        `--max-count=${CHRONICLE_LIMIT}`,
        `--format=%x1e%H%x1f%aI%x1f%s`,
      ],
      {
        encoding: "utf8",
        env: gitChildEnv(),
        timeout: LONG_GIT_TIMEOUT_MS,
        maxBuffer: CHRONICLE_GIT_BUFFER,
        windowsHide: true,
      },
    );
    return parseChronicleMergeHistory(project, output);
  } catch {
    return [];
  }
}

function dispatchHttpError(error) {
  let converted;
  if (Number.isInteger(error.status)) converted = new HttpError(error.status, error.message);
  else if (/Concurrent dispatch cap/.test(error.message)) converted = new HttpError(409, error.message);
  else if (/Unknown project/.test(error.message)) converted = new HttpError(404, error.message);
  else converted = new HttpError(400, error.message);
  if (error.budgetExceeded === true) {
    converted.budgetExceeded = true;
    converted.spentUSD = error.spentUSD;
    converted.budgetUSD = error.budgetUSD;
  }
  if (error.dispatchCountExceeded === true) {
    converted.dispatchCountExceeded = true;
    converted.dispatchesToday = error.dispatchesToday;
    converted.dispatchCap = error.dispatchCap;
  }
  return converted;
}

function registryHttpError(error) {
  if (Number.isInteger(error.status)) return new HttpError(error.status, error.message);
  if (error instanceof RegistryError) {
    const status = /already exists/.test(error.message) ? 409 : 400;
    return new HttpError(status, error.message);
  }
  return error;
}

function requireGitOperations(project, operation) {
  if (project.archetype === "tracker-only") {
    throw new HttpError(409, `${operation} unavailable: tracker-only project`);
  }
  return project;
}

function pathIsInside(candidate, parent) {
  const segment = relative(parent, candidate);
  return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
}

async function existingCanonicalDirectory(requested, label = "path") {
  if (!isAbsolute(requested)) throw new HttpError(400, `${label} must be an absolute path`);
  let details;
  try {
    details = await stat(requested);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, `Path does not exist: ${requested}`);
    if (["EACCES", "EPERM"].includes(error.code)) {
      throw new HttpError(403, `Path is not readable: ${requested}`);
    }
    throw error;
  }
  if (!details.isDirectory()) throw new HttpError(400, `Path is not a directory: ${requested}`);
  return realpath(requested);
}

async function directoryBrowseRoots(registry, homeDirectory) {
  const candidates = [homeDirectory, ...registry.projects.map((project) => dirname(project.path))];
  const roots = [];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const canonical = await existingCanonicalDirectory(candidate);
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // A stale registered project must not make the browser endpoint fail.
    }
  }
  return roots;
}

function matchingBrowseRoot(candidate, roots) {
  return roots
    .filter((root) => pathIsInside(candidate, root))
    .sort((left, right) => left.length - right.length)[0];
}

function directoryBreadcrumbs(directory, root) {
  const crumbs = [{ name: root, path: root }];
  const segment = relative(root, directory);
  if (!segment) return crumbs;
  let cursor = root;
  for (const name of segment.split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, name);
    crumbs.push({ name, path: cursor });
  }
  return crumbs;
}

async function markerExists(directory, name) {
  try {
    // A marker symlink is enough for a badge; never follow it beyond the
    // already-contained directory during this deliberately shallow probe.
    await lstat(join(directory, name));
    return true;
  } catch {
    return false;
  }
}

async function browseDirectories(registry, homeDirectory, requestedPath) {
  const roots = await directoryBrowseRoots(registry, homeDirectory);
  if (roots.length === 0) throw new HttpError(500, "No readable directory browser roots");
  const requested = requestedPath || homeDirectory;
  const directory = await existingCanonicalDirectory(requested);
  const root = matchingBrowseRoot(directory, roots);
  if (!root) throw new HttpError(403, "Path is outside the allowed directory browser roots");

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      throw new HttpError(403, `Path is not readable: ${directory}`);
    }
    throw error;
  }
  const directories = (
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return undefined;
        const candidate = join(directory, entry.name);
        let canonical;
        try {
          canonical = await existingCanonicalDirectory(candidate);
        } catch {
          return undefined;
        }
        // Resolve every child before returning it. Symlinks that escape the
        // configured roots are invisible rather than becoming traversal links.
        if (!matchingBrowseRoot(canonical, roots)) return undefined;
        const [git, beads] = await Promise.all([
          markerExists(canonical, ".git"),
          markerExists(canonical, ".beads"),
        ]);
        return { name: entry.name, path: canonical, git, beads };
      }),
    )
  )
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));

  const parentCandidate = dirname(directory);
  const parent =
    parentCandidate !== directory && matchingBrowseRoot(parentCandidate, roots)
      ? parentCandidate
      : null;
  return {
    path: directory,
    parent,
    roots,
    breadcrumbs: directoryBreadcrumbs(directory, root),
    directories,
  };
}

async function validatedProbePath(body, atelierStateDir) {
  const requested = requiredString(body, "path");
  if (!isAbsolute(requested)) throw new HttpError(400, "path must be an absolute path");
  let details;
  try {
    details = await stat(requested);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, `Path does not exist: ${requested}`);
    throw error;
  }
  if (!details.isDirectory()) throw new HttpError(400, `Path is not a directory: ${requested}`);

  const resolvedPath = await realpath(requested);
  let resolvedStateDir = resolve(atelierStateDir);
  try {
    resolvedStateDir = await realpath(atelierStateDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    pathIsInside(resolve(requested), resolve(atelierStateDir)) ||
    pathIsInside(resolvedPath, resolvedStateDir)
  ) {
    throw new HttpError(400, "Project path must not be inside the Atelier state directory");
  }
  return resolvedPath;
}

async function openPathInEditor(registry, targetPath, spawner, missingMessage) {
  const editorCommand = registry.defaults?.editorCommand;
  if (!editorCommand) throw new HttpError(409, "No editorCommand is configured");
  if (!targetPath) throw new HttpError(409, missingMessage);
  let details;
  try {
    details = await stat(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") throw new HttpError(404, missingMessage);
    throw error;
  }
  if (!details.isDirectory()) throw new HttpError(409, `${missingMessage}: target is not a directory`);
  const child = spawner(editorCommand, [targetPath], {
    cwd: targetPath,
    env: sanitizeChildEnv(process.env, { class: "editor" }),
    stdio: "ignore",
  });
  // Editor launch is intentionally fire-and-forget. Attach the error listener
  // so a missing local executable cannot become an unhandled process error.
  child.once?.("error", () => {});
  child.unref?.();
}

function requirePathlessEditorBody(body) {
  if (Object.keys(body).length > 0) {
    throw new HttpError(400, "Open-in-editor requests do not accept a client path or options");
  }
}

export function createServer({
  registry,
  dispatcher,
  registryPath = join(configDir(), "projects.json"),
  atelierStateDir = stateDir(),
  browserHomeDir = homedir(),
  spawner = spawnTracked,
  commandRunner = runFile,
  chronicleGitRunner = execFileSync,
  brExecutable = resolveBrExecutable(),
  boardEvents: providedBoardEvents,
  // Structured event log (atelier-e5x). Defaults to the one under this server's
  // state directory so a server built without an explicit log still records.
  eventLog: providedEventLog,
  bootStamp = createBootStamp(),
  uiDir = UI_DIR,
  themesDir = THEMES_DIR,
  // Conservative on purpose (atelier-za6): the sweep only ever reaps processes it
  // can corroborate, so running it often buys nothing and each run is a full
  // /proc scan. Terminal transitions, dismissal and merge do the timely work.
  codexSweepIntervalMs = 600_000,
  eventStreamGlobalLimit = EVENT_STREAM_GLOBAL_LIMIT,
  eventStreamPerCredentialLimit = EVENT_STREAM_PER_CREDENTIAL_LIMIT,
}) {
  // Keep the HTML, modules, and styles from one boot together. A merge may
  // update the checkout while this process is running; request-time reads can
  // otherwise pair a new app.js with this process's older route allowlist.
  const staticAssets = snapshotStaticAssets(uiDir);
  const themeSnapshot = snapshotThemeBundles(themesDir);
  const chronicles = snapshotChronicles(dispatcher.list(), registry.projects, {
    generatedAt: bootStamp.bootedAt,
    historyForProject: (project) =>
      chronicleMergeHistory(project, chronicleGitRunner),
    diffStatsForProject: (project, records) =>
      chronicleDiffStats(project, records, chronicleGitRunner),
  });
  const aggregateChronicle = aggregateChronicles(chronicles, {
    generatedAt: bootStamp.bootedAt,
  });
  const artifactSnapshots = snapshotProjectArtifacts(registry.projects, {
    generatedAt: bootStamp.bootedAt,
  });
  const boardEvents = providedBoardEvents ?? createBoardEvents({ registry });
  const eventLog = providedEventLog ?? createEventLog({ stateDir: atelierStateDir });
  const requestAuth = createRequestAuth({ directory: atelierStateDir });
  const requestAuthContexts = new WeakMap();
  const requestActor = (request) => requestAuthContexts.get(request)?.actor ?? "api";
  const dispatchActionContext = (request, fields = {}) => ({
    ...fields,
    actor: requestActor(request),
  });
  // Total, like the dispatcher's tap: an observability write can never fail a
  // request. event-log.mjs's append already guarantees this; the wrapper keeps
  // the guarantee true for a stub log injected by a test.
  const logEvent = (kind, payload) => {
    try {
      return eventLog?.append?.(kind, payload);
    } catch {
      return undefined;
    }
  };
  const eventStreams = new Set();
  const eventStreamState = {
    responses: eventStreams,
    byCredential: new Map(),
    globalLimit: eventStreamGlobalLimit,
    perCredentialLimit: eventStreamPerCredentialLimit,
  };
  const sockets = new Set();
  const movingTrackerProjects = new Set();
  const requireStableTracker = (project) => {
    if (movingTrackerProjects.has(project.name)) {
      throw new HttpError(409, `Project ${project.name} tracker is moving`);
    }
    return project;
  };
  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const path = url.pathname;
      const address = server.address();
      const authContext = requestAuth.guard(request, {
        path,
        port: typeof address === "object" && address ? address.port : 0,
      });
      requestAuthContexts.set(request, authContext);
      if (authContext.requestClass === "session-bootstrap") {
        // Local authentication blocks cross-origin and remote callers, not a
        // process already running as the same OS user; that boundary is OS policy.
        const session = requestAuth.mintSession();
        response.setHeader("Set-Cookie", session.cookie);
        jsonResponse(response, 200, { csrfToken: session.csrfToken });
        return;
      }
      const postBody = ["POST", "PATCH"].includes(request.method)
        ? await readJsonBody(request)
        : undefined;
      if (authContext.actor === "mcp" && postBody?.force === true) {
        throw new HttpError(
          409,
          "MCP operator overrides are forbidden; use the human break-glass policy",
        );
      }
      if (authContext.actor === "mcp" && postBody?.acceptExecutionProfile === true) {
        throw new HttpError(
          409,
          "MCP operator overrides are forbidden; use atelier reply --accept-execution-profile or the web UI accept checkbox",
        );
      }

      const staticAsset = request.method === "GET" ? staticAssets.get(path) : undefined;
      if (staticAsset) {
        textResponse(response, 200, staticAsset.body, staticAsset.contentType);
        return;
      }
      const themeAsset = request.method === "GET" ? themeSnapshot.assets.get(path) : undefined;
      if (themeAsset) {
        textResponse(response, 200, themeAsset.body, themeAsset.contentType);
        return;
      }

      if (request.method === "GET" && path === "/api/themes") {
        jsonResponse(response, 200, {
          themes: themeSnapshot.themes,
          // First-party bundles execute as same-page modules in this MVP.
          // Tier isolation/grants are deliberately deferred by the slice spec.
          isolation: "same-page-first-party",
        });
        return;
      }

      if (request.method === "GET" && path === "/api/projects") {
        const projects = await Promise.all(
          registry.projects.map(async (project) => {
            const { capabilities, detectedTracker } = await projectStatus(project);
            return {
              ...projectPayload(project, registry.defaults),
              capabilities,
              declaredTracker: project.tracker,
              detectedTracker,
            };
          }),
        );
        jsonResponse(response, 200, {
          projects,
          groups: registry.groups,
          editorConfigured: Boolean(registry.defaults?.editorCommand),
        });
        return;
      }

      if (request.method === "GET" && path === "/api/logs") {
        // Bounded by construction: normalizeLogQuery rejects a limit above
        // MAX_LOG_LIMIT and defaults to 200, so no filter combination can ask
        // this route for the whole retention window.
        try {
          const query = {
            kind: url.searchParams.get("kind"),
            project: url.searchParams.get("project"),
            dispatchId: url.searchParams.get("dispatchId"),
            ticketId: url.searchParams.get("ticketId"),
            actor: url.searchParams.get("actor"),
            source: url.searchParams.get("source"),
            since: url.searchParams.get("since"),
            limit: url.searchParams.get("limit"),
          };
          const result = typeof eventLog.readResult === "function"
            ? eventLog.readResult(query)
            : { events: eventLog.read(query), truncated: false };
          jsonResponse(response, 200, {
            events: result.events,
            ...(result.truncated === true ? { truncated: true } : {}),
          });
        } catch (error) {
          throw new HttpError(error.status === 400 ? 400 : 500, error.message);
        }
        return;
      }

      if (request.method === "GET" && path === "/api/fs/dirs") {
        jsonResponse(
          response,
          200,
          await browseDirectories(registry, browserHomeDir, url.searchParams.get("path")),
        );
        return;
      }

      if (request.method === "GET" && path === "/api/agents") {
        jsonResponse(
          response,
          200,
          [...agents.values()].map((agent) => ({
            id: agent.id,
            displayName: agent.displayName,
            capabilities: agent.capabilities,
            options: agent.options(),
          })),
        );
        return;
      }

      if (request.method === "POST" && path === "/api/doctor/gc") {
        const rejected = Object.keys(postBody).filter(
          (key) => !["olderThanDays", "dryRun"].includes(key),
        );
        if (rejected.length > 0) {
          throw new HttpError(400, `Unknown doctor GC fields: ${rejected.join(", ")}`);
        }
        try {
          jsonResponse(response, 200, await dispatcher.gc(dispatchActionContext(request, {
            ...(postBody.olderThanDays !== undefined
              ? { olderThanDays: postBody.olderThanDays }
              : {}),
            ...(postBody.dryRun !== undefined ? { dryRun: postBody.dryRun } : {}),
          })));
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }

      if (request.method === "POST" && path === "/api/projects/probe") {
        const projectPath = await validatedProbePath(postBody, atelierStateDir);
        try {
          const probe = await probeProjectPath(projectPath);
          jsonResponse(response, 200, {
            ...probe,
            resolvedDefaultAgent: resolveProjectDefaultAgent({}, registry.defaults),
          });
        } catch (error) {
          throw registryHttpError(error);
        }
        return;
      }

      if (request.method === "POST" && path === "/api/projects") {
        try {
          const registration = { ...postBody };
          const trackerLocation = optionalString(registration, "trackerLocation");
          delete registration.trackerLocation;
          let initializeTracker = false;
          if (trackerLocation !== undefined) {
            if (!TRACKER_LOCATIONS.has(trackerLocation)) {
              throw new HttpError(400, "trackerLocation must be external or in-repo");
            }
            if (registration.archetype !== "full") {
              throw new HttpError(400, "trackerLocation is only available for full projects");
            }
            registration.tracker = trackerLocation === "external" ? "personal" : "committed";
            delete registration.trackerPath;
            if (trackerLocation === "external") {
              // Containment/shape must pass BEFORE the directory is
              // created (never create state for a rejected entry) - but
              // the validator also requires the directory to exist, so
              // tolerate exactly that one problem on the first pass,
              // create, then validate for real.
              registration.trackerPath = join(atelierStateDir, "trackers", registration.name);
              try {
                validateProjectAddition(registry, registration);
              } catch (error) {
                const problems = error.problems || [String(error.message)];
                const onlyMissingDir = problems.every((problem) =>
                  problem.includes("trackerPath must be an existing directory"),
                );
                if (!onlyMissingDir) throw error;
              }
              await mkdir(registration.trackerPath, { recursive: true });
              validateProjectAddition(registry, registration);
            }
            initializeTracker = true;
          }
          if (registration.archetype === "tracker-only") {
            registration.tracker = "personal";
            registration.mainBranch ??= null;
            if (!registration.path) {
              await mkdir(atelierStateDir, { recursive: true });
              const placeholder = { ...registration, path: atelierStateDir };
              const problems = validateProject(placeholder);
              if (problems.length > 0) throw new RegistryError(problems);
              registration.path = join(atelierStateDir, "trackers", registration.name);
              await mkdir(registration.path, { recursive: true });
            }
          }
          validateProjectAddition(registry, registration);
          if (registration.archetype === "tracker-only" || initializeTracker) {
            await initializeTrackerDirectory(registration);
            _clearProbeCache();
          }
          const created = await addProject(registry, registration, registryPath);
          boardEvents.refresh?.();
          logEvent("registry.change", {
            actor: requestActor(request),
            action: "add",
            project: created.name,
            changes: fieldDiff({}, created),
          });
          jsonResponse(response, 201, projectPayload(created, registry.defaults));
        } catch (error) {
          throw registryHttpError(error);
        }
        return;
      }

      const projectRegistration = path.match(/^\/api\/projects\/([^/]+)$/);
      if (request.method === "PATCH" && projectRegistration) {
        const name = decodeURIComponent(projectRegistration[1]);
        projectByName(registry, name);
        const mutableFields = new Set([
          "notes",
          "verifyCommands",
          "warn",
          "dispatchProfile",
          "defaultAgent",
          "autoCommitTracker",
          "autoCloseOnMerge",
          "requireReview",
          "reviewPolicy",
          "maxFixRounds",
          "budgetUSDPerDay",
          "queueFailureLimit",
          "unpricedDispatchCapPerDay",
        ]);
        const rejected = Object.keys(postBody).filter((key) => !mutableFields.has(key));
        if (rejected.length > 0) {
          throw new HttpError(400, `Immutable or unknown project fields: ${rejected.join(", ")}`);
        }
        if (Object.keys(postBody).length === 0) {
          throw new HttpError(400, "At least one mutable project field is required");
        }
        const restricted = Object.keys(postBody).filter((key) =>
          MCP_RESTRICTED_SETTINGS.has(key)
        );
        if (requestActor(request) === "mcp" && restricted.length > 0) {
          throw new HttpError(
            403,
            `MCP cannot change gate-critical settings (${restricted.join(", ")}); use human/UI authority`,
          );
        }
        const before = { ...projectByName(registry, name) };
        const parkedBefore = Object.hasOwn(postBody, "queueFailureLimit")
          ? parkedTicketIds(dispatcher, name)
          : null;
        try {
          const updated = await updateProject(registry, name, postBody, registryPath);
          boardEvents.refresh?.();
          if (parkedBefore !== null) {
            const parkedAfter = parkedTicketIds(dispatcher, name);
            if (
              parkedAfter !== null &&
              JSON.stringify(parkedBefore) !== JSON.stringify(parkedAfter)
            ) {
              boardEvents.notify?.(name);
            }
          }
          logEvent("registry.change", {
            actor: requestActor(request),
            action: "update",
            project: updated.name,
            // Field-level, and only the fields the request could touch. Values
            // are redacted at write time, so a secret-shaped setting never lands
            // in the log even though the diff carries before/after.
            changes: fieldDiff(before, updated, Object.keys(postBody)),
          });
          jsonResponse(response, 200, projectPayload(updated, registry.defaults));
        } catch (error) {
          throw registryHttpError(error);
        }
        return;
      }
      if (request.method === "DELETE" && projectRegistration) {
        const name = decodeURIComponent(projectRegistration[1]);
        projectByName(registry, name);
        const active = dispatcher
          .list()
          .some(
            (record) => record.project === name && ACTIVE_DISPATCH_STATES.has(record.state),
          );
        if (active) {
          throw new HttpError(409, `Project ${name} has active dispatches`);
        }
        try {
          const removed = await removeProject(registry, name, registryPath);
          boardEvents.refresh?.();
          logEvent("registry.change", {
            actor: requestActor(request),
            action: "remove",
            project: name,
            changes: fieldDiff(removed, {}),
          });
          jsonResponse(response, 200, removed);
        } catch (error) {
          throw registryHttpError(error);
        }
        return;
      }

      const projectTrackerMove = path.match(/^\/api\/projects\/([^/]+)\/move-tracker$/);
      if (request.method === "POST" && projectTrackerMove) {
        const rejected = Object.keys(postBody).filter((key) => key !== "to");
        if (rejected.length > 0) {
          throw new HttpError(400, `Unknown move-tracker fields: ${rejected.join(", ")}`);
        }
        const name = decodeURIComponent(projectTrackerMove[1]);
        projectByName(registry, name);
        const active = dispatcher
          .list()
          .some((record) => record.project === name && ACTIVE_DISPATCH_STATES.has(record.state));
        if (active) throw new HttpError(409, `Project ${name} has active dispatches`);
        if (dispatcher.isQueueDrainRunning?.(name)) {
          throw new HttpError(409, `Project ${name} has a running queue drain`);
        }
        if (movingTrackerProjects.has(name)) {
          throw new HttpError(409, `Project ${name} tracker is already moving`);
        }
        movingTrackerProjects.add(name);
        dispatcher.setTrackerMoving?.(name, true);
        try {
          const result = await moveProjectTracker({
            registry,
            name,
            to: requiredString(postBody, "to"),
            stateDir: atelierStateDir,
            registryPath,
            run: commandRunner,
            brExecutable,
          });
          _clearProbeCache();
          logEvent("registry.change", {
            actor: requestActor(request),
            action: "move-tracker",
            project: name,
            changes: { trackerLocation: { from: result.from ?? null, to: result.to ?? null } },
          });
          jsonResponse(response, 200, result);
        } catch (error) {
          _clearProbeCache();
          throw registryHttpError(error);
        } finally {
          dispatcher.setTrackerMoving?.(name, false);
          movingTrackerProjects.delete(name);
          boardEvents.refresh?.();
        }
        return;
      }

      const projectEditor = path.match(/^\/api\/projects\/([^/]+)\/open-editor$/);
      if (request.method === "POST" && projectEditor) {
        requirePathlessEditorBody(postBody);
        const project = projectByName(registry, decodeURIComponent(projectEditor[1]));
        await openPathInEditor(
          registry,
          project.path,
          spawner,
          `Project path does not exist: ${project.name}`,
        );
        jsonResponse(response, 202, { opened: true });
        return;
      }

      const projectQueue = path.match(/^\/api\/projects\/([^/]+)\/queue$/);
      if (projectQueue) {
        const name = decodeURIComponent(projectQueue[1]);
        try {
          requireGitOperations(projectByName(registry, name), "Queue");
          if (request.method === "GET") {
            jsonResponse(response, 200, dispatcher.getQueue(name));
            return;
          }
          if (request.method === "POST") {
            const actor = requestActor(request);
            const queue = Object.hasOwn(postBody, "resumeTicketId")
              ? dispatcher.resumeQueueTicket(name, postBody.resumeTicketId, { actor })
              : dispatcher.setQueue(name, postBody, { actor });
            boardEvents.notify?.(name);
            jsonResponse(response, 200, queue);
            return;
          }
        } catch (error) {
          throw dispatchHttpError(error);
        }
      }

      const projectConvoy = path.match(/^\/api\/projects\/([^/]+)\/convoy$/);
      if (request.method === "POST" && projectConvoy) {
        const name = decodeURIComponent(projectConvoy[1]);
        requireGitOperations(projectByName(registry, name), "Convoy");
        try {
          jsonResponse(response, 201, await dispatcher.createConvoy(name, {
            ticketIds: postBody.ticketIds,
          }));
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }

      const projectState = path.match(/^\/api\/projects\/([^/]+)\/state$/);
      if (request.method === "GET" && projectState) {
        const project = requireStableTracker(
          projectByName(registry, decodeURIComponent(projectState[1])),
        );
        const { detectedTracker } = await projectStatus(project);
        const trackerDegraded = detectedTracker === "none";
        let issues = [];
        let readyTicketIds = new Set();
        let readinessDegraded = false;
        if (!trackerDegraded) {
          const snapshot = await loadFencedReadySnapshot(
            commandRunner,
            brExecutable,
            trackerDirectory(project),
          );
          issues = snapshot.issues;
          readyTicketIds = snapshot.readyTicketIds;
          readinessDegraded = snapshot.degraded;
        }
        const parkedTickets = project.archetype === "tracker-only"
          ? []
          : dispatcher.getQueue(project.name).parkedTickets;
        jsonResponse(response, 200, {
          issues,
          readyIssues: readyIssuesFor(issues, readyTicketIds, parkedTickets),
          source: join(trackerDirectory(project), ".beads", "issues.jsonl"),
          tracker: detectedTracker,
          degraded: trackerDegraded || readinessDegraded,
          generatedAt: new Date().toISOString(),
        });
        return;
      }

      const projectChronicle = path.match(/^\/api\/projects\/([^/]+)\/chronicle$/);
      const projectArtifacts = path.match(/^\/api\/projects\/([^/]+)\/artifacts$/);
      if (request.method === "GET" && path === "/api/chronicle") {
        jsonResponse(response, 200, aggregateChronicle);
        return;
      }
      if (request.method === "GET" && projectChronicle) {
        const name = decodeURIComponent(projectChronicle[1]);
        projectByName(registry, name);
        jsonResponse(
          response,
          200,
          chronicles.get(name) ?? chronicleFor([], name, { generatedAt: bootStamp.bootedAt }),
        );
        return;
      }
      if (request.method === "GET" && projectArtifacts) {
        const name = decodeURIComponent(projectArtifacts[1]);
        const project = projectByName(registry, name);
        jsonResponse(
          response,
          200,
          artifactSnapshots.get(name) ?? {
            project: project.name,
            generatedAt: bootStamp.bootedAt,
            artifacts: [],
          },
        );
        return;
      }

      const projectMainHealth = path.match(/^\/api\/projects\/([^/]+)\/main-health$/);
      if (request.method === "GET" && projectMainHealth) {
        try {
          jsonResponse(
            response,
            200,
            dispatcher.getMainHealth(decodeURIComponent(projectMainHealth[1])),
          );
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }

      const projectAction = path.match(
        /^\/api\/projects\/([^/]+)\/(create|promote|comment|claim|close)$/,
      );
      if (request.method === "POST" && projectAction) {
        const body = postBody;
        const project = requireStableTracker(
          projectByName(registry, decodeURIComponent(projectAction[1])),
        );
        await trackedProject(project);
        const action = projectAction[2];
        if (action === "create") {
          const type = optionalString(body, "type") ?? "task";
          if (!ISSUE_TYPES.has(type)) {
            throw new HttpError(400, "type must be task, bug, or chore");
          }
          const id = await createIssue(project, {
            title: requiredString(body, "title"),
            desc: requiredString(body, "desc"),
            ac: optionalString(body, "ac"),
            type,
            priority: parsePriority(body.priority),
          });
          jsonResponse(response, 201, { id });
          return;
        }
        const id = requiredString(body, "id");
        if (action === "promote") await promoteIssue(project, id);
        if (action === "close") {
          await closeIssue(project, id, optionalString(body, "reason"));
        }
        if (action === "comment") {
          await commentIssue(project, id, requiredString(body, "text"));
        }
        if (action === "claim") {
          const result = await claimIssue(project, id, requiredString(body, "actor"));
          jsonResponse(response, 200, result);
          return;
        }
        jsonResponse(response, 200, { id });
        return;
      }

      if (request.method === "POST" && path === "/api/track") {
        const body = postBody;
        const project = requireStableTracker(
          projectByName(registry, requiredString(body, "project")),
        );
        if (project.archetype === "git-only") {
          throw new HttpError(409, `Project ${project.name} is git-only; tracker is disabled`);
        }
        jsonResponse(response, 200, await trackProject(project));
        return;
      }

      if (request.method === "GET" && path === "/api/dispatches") {
        jsonResponse(response, 200, dispatcher.list());
        return;
      }
      if (request.method === "POST" && path === "/api/dispatches/drain-lease") {
        try {
          jsonResponse(response, 200, dispatcher.acquireDrainLease(
            postBody.ttlMs !== undefined ? { ttlMs: postBody.ttlMs } : {},
          ));
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }
      if (request.method === "POST" && path === "/api/dispatches/drain-lease/release") {
        const token = requiredString(postBody, "token");
        jsonResponse(response, 200, { released: dispatcher.releaseDrainLease(token) });
        return;
      }
      if (request.method === "GET" && path === "/api/convoys") {
        jsonResponse(response, 200, dispatcher.listConvoys());
        return;
      }
      if (request.method === "GET" && path === "/api/rollup") {
        jsonResponse(response, 200, dispatcher.rollup());
        return;
      }
      if (request.method === "POST" && path === "/api/dispatch") {
        const body = postBody;
        requireGitOperations(
          projectByName(registry, requiredString(body, "project")),
          body.verify === false ? "Dispatch" : "Dispatch and verify",
        );
        try {
          jsonResponse(
            response,
            202,
            await dispatcher.dispatch(body, dispatchActionContext(request)),
          );
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }

      if (request.method === "GET" && path === "/api/dispatches/events") {
        openEventStream(
          request,
          response,
          dispatcher,
          eventStreamState,
          authContext.credentialKey,
        );
        return;
      }
      if (request.method === "GET" && path === "/api/board/events") {
        openBoardEventStream(
          response,
          boardEvents,
          bootStamp,
          eventStreamState,
          authContext.credentialKey,
        );
        return;
      }

      const convoyRoute = path.match(/^\/api\/convoys\/([^/]+)\/(resume|cancel)$/);
      if (request.method === "POST" && convoyRoute) {
        const id = decodeURIComponent(convoyRoute[1]);
        try {
          const convoy = convoyRoute[2] === "resume"
            ? await dispatcher.resumeConvoy(id)
            : dispatcher.cancelConvoy(id);
          jsonResponse(response, 200, convoy);
        } catch (error) {
          throw dispatchHttpError(error);
        }
        return;
      }

      const dispatchRoute = path.match(
        /^\/api\/dispatch\/([^/]+)(?:\/(stop|diff|events|merge|review|review-disposition|verify|dismiss|reply|plan|open-editor|ack-main-health))?$/,
      );
      if (dispatchRoute) {
        const id = decodeURIComponent(dispatchRoute[1]);
        const action = dispatchRoute[2];
        const record = dispatcher.get(id);
        if (!record) throw new HttpError(404, `Unknown dispatch: ${id}`);
        if (request.method === "GET" && !action) {
          jsonResponse(response, 200, record);
          return;
        }
        if (request.method === "POST" && action === "stop") {
          try {
            jsonResponse(response, 200, await dispatcher.stop(id, dispatchActionContext(request)));
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "open-editor") {
          requirePathlessEditorBody(postBody);
          await openPathInEditor(
            registry,
            record.worktreePath,
            spawner,
            `Dispatch worktree does not exist: ${id}`,
          );
          jsonResponse(response, 202, { opened: true });
          return;
        }
        if (request.method === "POST" && action === "reply") {
          const text = requiredString(postBody, "text");
          if (Buffer.byteLength(text) > 32 * 1024) {
            throw new HttpError(400, "text must be at most 32KB");
          }
          try {
            jsonResponse(response, 200, await dispatcher.reply(id, dispatchActionContext(request, {
              text,
              ...(postBody.force !== undefined ? { force: postBody.force } : {}),
              ...(postBody.acceptExecutionProfile !== undefined
                ? { acceptExecutionProfile: postBody.acceptExecutionProfile }
                : {}),
            })));
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "plan") {
          try {
            jsonResponse(response, 200, await dispatcher.plan(id, dispatchActionContext(request, {
              action: requiredString(postBody, "action"),
              text: optionalString(postBody, "text"),
              ...(postBody.force !== undefined ? { force: postBody.force } : {}),
              ...(postBody.acceptExecutionProfile !== undefined
                ? { acceptExecutionProfile: postBody.acceptExecutionProfile }
                : {}),
            })));
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "merge") {
          const project = registry.projects.find((candidate) => candidate.name === record.project);
          if (!project) throw new HttpError(404, `Project removed: ${record.project}`);
          requireGitOperations(project, "Merge");
          try {
            jsonResponse(
              response,
              200,
              await dispatcher.merge(
                id,
                dispatchActionContext(request, {
                  force: postBody.force,
                  ...(postBody.forcedBy !== undefined ? { forcedBy: postBody.forcedBy } : {}),
                  ...(postBody.reason !== undefined ? { reason: postBody.reason } : {}),
                  ...(postBody.dispositionRef !== undefined
                    ? { dispositionRef: postBody.dispositionRef }
                    : {}),
                }),
              ),
            );
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "review-disposition") {
          try {
            jsonResponse(response, 200, await dispatcher.reviewDisposition(id, {
              findingRef: requiredString(postBody, "findingRef"),
              disposition: requiredString(postBody, "disposition"),
              ...(postBody.redirectTicket !== undefined
                ? { redirectTicket: postBody.redirectTicket }
                : {}),
              note: requiredString(postBody, "note"),
              actor: requestActor(request),
            }));
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "review") {
          const project = registry.projects.find((candidate) => candidate.name === record.project);
          if (!project) throw new HttpError(404, `Project removed: ${record.project}`);
          requireGitOperations(project, "Review");
          try {
            jsonResponse(response, 202, await dispatcher.review(id, dispatchActionContext(request, {
              ...(postBody.force !== undefined ? { force: postBody.force } : {}),
            })));
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "verify") {
          const rejected = Object.keys(postBody)
            .filter((key) => key !== "acceptExecutionProfile");
          if (rejected.length > 0) {
            throw new HttpError(400, `Unknown verification fields: ${rejected.join(", ")}`);
          }
          const project = registry.projects.find((candidate) => candidate.name === record.project);
          if (!project) throw new HttpError(404, `Project removed: ${record.project}`);
          requireGitOperations(project, "Verification re-run");
          try {
            // 202, like every other route that starts work and streams it: the
            // response reports the attempt as admitted, not as finished.
            jsonResponse(
              response,
              202,
              await dispatcher.rerunVerification(id, dispatchActionContext(request, {
                ...(postBody.acceptExecutionProfile !== undefined
                  ? { acceptExecutionProfile: postBody.acceptExecutionProfile }
                  : {}),
              })),
            );
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "dismiss") {
          try {
            jsonResponse(
              response,
              200,
              await dispatcher.dismiss(id, dispatchActionContext(request)),
            );
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "POST" && action === "ack-main-health") {
          const rejected = Object.keys(postBody);
          if (rejected.length > 0) {
            throw new HttpError(400, `Unknown acknowledgement fields: ${rejected.join(", ")}`);
          }
          try {
            jsonResponse(
              response,
              200,
              dispatcher.acknowledgePostMergeFailure(id, dispatchActionContext(request)),
            );
          } catch (error) {
            throw dispatchHttpError(error);
          }
          return;
        }
        if (request.method === "GET" && action === "events") {
          openEventStream(
            request,
            response,
            dispatcher,
            eventStreamState,
            authContext.credentialKey,
            id,
          );
          return;
        }
        if (request.method === "GET" && action === "diff") {
          if (!record.worktreePath) throw new HttpError(409, "Dispatch worktree is not ready");
          if (!existsSync(record.worktreePath)) {
            // Merged dispatches clean their worktree - the merge commit in
            // the primary is the permanent, honest source for this diff.
            if (record.merged?.commit) {
              const project = registry.projects.find(
                (candidate) => candidate.name === record.project,
              );
              if (!project) throw new HttpError(404, "Project no longer registered");
              const commit = String(record.merged.commit);
              const shown = parseNumstat(
                await runFile(
                  "git",
                  ["-C", project.path, "show", "--numstat", "--format=", commit],
                  { timeout: LONG_GIT_TIMEOUT_MS },
                ),
              );
              shown.source = "merge-commit";
              if (url.searchParams.get("patch") === "1") {
                const patch = await runFile(
                  "git",
                  ["-C", project.path, "show", "--format=", commit],
                  { timeout: LONG_GIT_TIMEOUT_MS },
                );
                shown.patch = Buffer.from(patch).subarray(0, PATCH_LIMIT).toString("utf8");
              }
              jsonResponse(response, 200, shown);
              return;
            }
            throw new HttpError(409, "Worktree cleaned up - diff no longer available");
          }
          const result = parseNumstat(
            await runFile("git", ["-C", record.worktreePath, "diff", "--numstat"]),
          );
          if (url.searchParams.get("patch") === "1") {
            const patch = await runFile("git", ["-C", record.worktreePath, "diff"]);
            result.patch = Buffer.from(patch).subarray(0, PATCH_LIMIT).toString("utf8");
          }
          jsonResponse(response, 200, result);
          return;
        }
      }

      if (path.startsWith("/api/")) {
        jsonResponse(response, 404, { error: "Not found" });
      } else {
        textResponse(response, 404, "Not found", "text/plain; charset=utf-8");
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!response.headersSent) {
        jsonResponse(response, status, {
          error: error.message,
          ...(error.budgetExceeded === true
            ? {
                budgetExceeded: true,
                spentUSD: error.spentUSD,
                budgetUSD: error.budgetUSD,
              }
            : {}),
          ...(error.dispatchCountExceeded === true
            ? {
                dispatchCountExceeded: true,
                dispatchesToday: error.dispatchesToday,
                dispatchCap: error.dispatchCap,
              }
            : {}),
        });
      } else {
        response.end();
      }
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  if (typeof dispatcher.drainQueuesOnce === "function") {
    const queueTimer = setInterval(() => void dispatcher.drainQueuesOnce(), 60_000);
    queueTimer.unref();
    server.once("close", () => clearInterval(queueTimer));
  }
  if (typeof dispatcher.sweepCodexProcesses === "function") {
    // Deliberately no sweep here at boot: the dispatcher runs its own once its
    // boot recovery settles, and starting one per createServer() call turns a
    // test run - or two servers on one host - into a /proc scan storm.
    const codexSweepTimer = setInterval(() => {
      void dispatcher.sweepCodexProcesses().catch((error) => {
        console.error(`Atelier codex process sweep failed: ${error.message}`);
      });
    }, codexSweepIntervalMs);
    codexSweepTimer.unref();
    server.once("close", () => clearInterval(codexSweepTimer));
  }
  let resourcesClosed = false;
  const closeResources = () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    for (const response of eventStreams) response.end();
    eventStreams.clear();
    eventStreamState.byCredential.clear();
    boardEvents.close?.();
  };
  serverResources.set(server, {
    close: closeResources,
    shutdownDispatcher({ graceMs }) {
      return dispatcher.shutdown?.({ graceMs });
    },
    flushEventLog() {
      eventLog._flush?.();
    },
    forceClose() {
      for (const socket of sockets) socket.destroy();
    },
  });
  server.once("close", closeResources);
  return server;
}

export async function shutdownServer(
  server,
  { timeoutMs = GRACEFUL_SHUTDOWN_TIMEOUT_MS } = {},
) {
  const resources = serverResources.get(server);
  const dispatcherShutdown = Promise.resolve().then(() =>
    resources?.shutdownDispatcher({ graceMs: timeoutMs }));
  if (!server.listening) {
    resources?.close();
    await dispatcherShutdown;
    resources?.flushEventLog();
    return;
  }

  const serverShutdown = new Promise((resolvePromise, rejectPromise) => {
    let forceTimer;
    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) rejectPromise(error);
      else resolvePromise();
    });
    resources?.close();
    server.closeIdleConnections?.();
    forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resources?.forceClose();
    }, timeoutMs);
    forceTimer.unref?.();
  });
  await Promise.all([serverShutdown, dispatcherShutdown]);
  resources?.flushEventLog();
}

export function listenLoopback(server, port = Number(process.env.PORT || 5170)) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise(server.address());
    });
  });
}
