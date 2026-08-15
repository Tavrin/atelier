import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

import { loadIssues, trackerDirectory } from "./tracker.mjs";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 15_000;
const DEFER_RETRY_BASE_MS = 250;
const DEFER_RETRY_MAX_MS = 5_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

function hasTracker(project) {
  return project.archetype !== "git-only" && project.tracker !== "none";
}

function issuesPath(project) {
  return join(trackerDirectory(project), ".beads", "issues.jsonl");
}

async function fileSignature(path, statFile) {
  try {
    const info = await statFile(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export function createBoardEvents({
  registry,
  watchFile = watch,
  statFile = stat,
  debounceMs = DEBOUNCE_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  timers = globalThis,
  loadProjectIssues = loadIssues,
  now = Date.now,
  deferRetryBaseMs = DEFER_RETRY_BASE_MS,
  deferRetryMaxMs = DEFER_RETRY_MAX_MS,
} = {}) {
  const emitter = new EventEmitter();
  const projects = new Map();
  let closed = false;

  function emitProject(project) {
    emitter.emit("event", { type: "board", project: project.name });
  }

  async function rescheduleDeferredBoundary(state) {
    state.deferRevision = (state.deferRevision ?? 0) + 1;
    const revision = state.deferRevision;
    if (state.deferTimer) timers.clearTimeout(state.deferTimer);
    state.deferTimer = undefined;

    let issues;
    try {
      issues = await loadProjectIssues(state.project);
    } catch {
      if (
        closed ||
        state.stopped ||
        state.deferRevision !== revision ||
        projects.get(state.project.name) !== state
      ) {
        return;
      }
      const attempt = state.deferRetryAttempt ?? 0;
      const delay = Math.min(
        deferRetryMaxMs,
        deferRetryBaseMs * (2 ** Math.min(attempt, 30)),
      );
      state.deferRetryAttempt = attempt + 1;
      state.deferTimer = timers.setTimeout(() => {
        state.deferTimer = undefined;
        void rescheduleDeferredBoundary(state);
      }, delay);
      state.deferTimer.unref?.();
      return;
    }
    if (
      closed ||
      state.stopped ||
      state.deferRevision !== revision ||
      projects.get(state.project.name) !== state
    ) {
      return;
    }
    state.deferRetryAttempt = 0;

    const currentTime = now();
    const priorScan = state.deferScanAt;
    const crossedBoundary = Number.isFinite(priorScan) && issues.some((issue) => {
      if (issue?.status !== "open") return false;
      const candidate = typeof issue?.defer_until === "string"
        ? Date.parse(issue.defer_until)
        : NaN;
      return Number.isFinite(candidate) && candidate > priorScan && candidate <= currentTime;
    });
    state.deferScanAt = currentTime;
    if (crossedBoundary) emitProject(state.project);

    const boundary = issues.reduce((earliest, issue) => {
      if (issue?.status !== "open") return earliest;
      const candidate = typeof issue?.defer_until === "string"
        ? Date.parse(issue.defer_until)
        : NaN;
      return Number.isNaN(candidate) || candidate <= currentTime
        ? earliest
        : Math.min(earliest, candidate);
    }, Infinity);
    if (!Number.isFinite(boundary)) return;

    const remaining = boundary - currentTime;
    state.deferTimer = timers.setTimeout(() => {
      state.deferTimer = undefined;
      if (remaining <= MAX_TIMEOUT_MS) {
        state.deferScanAt = Math.max(state.deferScanAt ?? 0, boundary);
        emitProject(state.project);
      }
      void rescheduleDeferredBoundary(state);
    }, Math.min(remaining, MAX_TIMEOUT_MS));
    state.deferTimer.unref?.();
  }

  function recompute(state) {
    emitProject(state.project);
    void rescheduleDeferredBoundary(state);
  }

  function debounce(state) {
    if (state.debounceTimer) timers.clearTimeout(state.debounceTimer);
    state.debounceTimer = timers.setTimeout(() => {
      state.debounceTimer = undefined;
      recompute(state);
    }, debounceMs);
    state.debounceTimer.unref?.();
  }

  async function poll(state, emitChange) {
    if (state.polling) return;
    state.polling = true;
    try {
      const signature = await fileSignature(state.path, statFile);
      if (emitChange && state.signature !== undefined && signature !== state.signature) {
        debounce(state);
      }
      state.signature = signature;
    } catch {
      // Poll fallback is deliberately silent; the next interval retries.
    } finally {
      state.polling = false;
    }
  }

  function startPoll(state) {
    if (state.pollTimer || closed) return;
    void poll(state, false);
    state.pollTimer = timers.setInterval(() => void poll(state, true), pollIntervalMs);
    state.pollTimer.unref?.();
  }

  function fallBackToPoll(state) {
    state.watcher?.close?.();
    state.watcher = undefined;
    startPoll(state);
  }

  function startProject(project) {
    const state = {
      project,
      path: issuesPath(project),
      stopped: false,
      deferScanAt: now(),
    };
    projects.set(project.name, state);
    void rescheduleDeferredBoundary(state);
    try {
      // Watch the DIRECTORY, not the file: br rewrites issues.jsonl via
      // temp+rename, and a file watch follows the inode - it dies silently
      // after the first atomic replace (caught live: board went quiet
      // until a manual refresh). Directory watches survive renames.
      const directory = dirname(state.path);
      const file = basename(state.path);
      state.watcher = watchFile(directory, (event, filename) => {
        if (!filename || filename === file) debounce(state);
      });
      state.watcher.on?.("error", () => fallBackToPoll(state));
    } catch {
      fallBackToPoll(state);
    }
  }

  function stopProject(state) {
    state.stopped = true;
    state.deferRevision = (state.deferRevision ?? 0) + 1;
    state.watcher?.close?.();
    if (state.debounceTimer) timers.clearTimeout(state.debounceTimer);
    if (state.deferTimer) timers.clearTimeout(state.deferTimer);
    if (state.pollTimer) timers.clearInterval(state.pollTimer);
  }

  function refresh() {
    if (closed) return;
    const wanted = new Map(
      (registry?.projects || [])
        .filter(hasTracker)
        .map((project) => [project.name, project]),
    );
    for (const [name, state] of projects) {
      const project = wanted.get(name);
      if (!project || issuesPath(project) !== state.path) {
        stopProject(state);
        projects.delete(name);
      }
    }
    for (const [name, project] of wanted) {
      const state = projects.get(name);
      if (!state) {
        startProject(project);
      } else {
        state.project = project;
        void rescheduleDeferredBoundary(state);
      }
    }
  }

  function closeAll() {
    closed = true;
    for (const state of projects.values()) stopProject(state);
    projects.clear();
    emitter.removeAllListeners();
  }

  refresh();
  return {
    refresh,
    close: closeAll,
    notify(projectName) {
      const state = projects.get(projectName);
      if (state) recompute(state);
    },
    onEvent(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
  };
}
