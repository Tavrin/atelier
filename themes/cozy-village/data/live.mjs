/**
 * THE LIVE SOURCE — /api/* and SSE.
 *
 * Themes never call fetch() raw: every request is built by the core's
 * ui/request.mjs so that attribution and JSON handling stay in one place.
 * The theme's mutations are attributed `theme:cozy-village`, so the forensic
 * event log can always tell a village merge from a dashboard merge.
 *
 * The functional village reads the existing board, queue, dispatch,
 * main-health and chronicle projections plus the boot-frozen artifacts index.
 * Missing optional projections degrade visibly; they are never filled with
 * inferred facts.
 */

import {
  rememberProject,
  selectVillageProject,
} from "./project-selection.mjs";
import { abortError, raceAbort, throwIfAborted } from "../abort.mjs";

/**
 * THE CORE REQUEST HELPERS, on the sanctioned theme-library routes.
 *
 * S3 gave themes a STABLE contract for this (docs/THEMES.md, "Theme library
 * imports"): `/theme-lib/request.mjs`, `/theme-lib/actor.mjs` and
 * `/theme-lib/theme-stream.mjs`, captured in the same immutable boot snapshot
 * as the built-in UI. The handbook is explicit that a theme must not import
 * through a repo-relative source path and must not rely on the flat built-in
 * UI routes, which is precisely what the previous pair of fallbacks did.
 *
 * That dual-host dance existed because neither available path was reliable:
 * `../../../ui/request.mjs` 404s under a real server, which serves no `ui/`
 * directory, and the flat `/request.mjs` route is the DASHBOARD's, not a
 * theme contract, so a theme sitting on it was one static-allowlist edit from
 * silently losing live mode. One documented route replaces the guesswork, and
 * a failure to resolve it is now a real failure rather than a fallback into a
 * second unreliable path.
 *
 * Vendoring a copy stays rejected: two copies of the actor rules is how
 * attribution silently drifts.
 */
const THEME_ID = "cozy-village";

const themeCoreLoadSlots = new Map();

function takeThemeCoreLoad(token) {
  const slot = themeCoreLoadSlots.get(token);
  if (!slot) return undefined;
  themeCoreLoadSlots.delete(token);
  slot.signal?.removeEventListener?.("abort", slot.onAbort);
  return slot;
}

function abortThemeCoreLoad(token) {
  const slot = takeThemeCoreLoad(token);
  slot?.reject(abortError("Cozy Village theme library load was aborted"));
}

function rejectThemeCoreLoad(token, error) {
  const slot = takeThemeCoreLoad(token);
  slot?.reject(error);
}

function completeThemeCoreLoad(token, modules) {
  const pending = themeCoreLoadSlots.get(token);
  if (!pending) return;
  if (pending.signal?.aborted) {
    abortThemeCoreLoad(token);
    return;
  }
  const slot = takeThemeCoreLoad(token);
  if (!slot) return;
  const [request, stream] = modules;
  slot.resolve({ ...request, ...stream });
}

function startThemeCoreLoad(token) {
  if (!themeCoreLoadSlots.has(token)) return;
  Promise.all([
    import(/* @vite-ignore */ "/theme-lib/request.mjs"),
    import(/* @vite-ignore */ "/theme-lib/theme-stream.mjs"),
  ]).then(
    (modules) => completeThemeCoreLoad(token, modules),
    (error) => rejectThemeCoreLoad(token, error),
  );
}

function loadThemeCore(signal) {
  if (signal?.aborted) {
    return Promise.reject(abortError("Cozy Village theme library load was aborted"));
  }
  return new Promise((resolve, reject) => {
    const token = Symbol("cozy-village-theme-core-load");
    const onAbort = () => abortThemeCoreLoad(token);
    themeCoreLoadSlots.set(token, { onAbort, reject, resolve, signal });
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    queueMicrotask(() => startThemeCoreLoad(token));
  });
}

/** The four event types the server re-projects `gates` onto (dispatch.mjs). */
const GATE_BEARING = new Set([
  "status",
  "review",
  "review-disposition",
  "post-merge",
  "verify-rerun",
]);

function isVillageDispatch(record) {
  if (record.dismissed) return false;
  if (record.reviewOf) return false; // a review dispatch is not its own undertaking
  return true;
}

export async function createLiveSource(options = {}) {
  const signal = options.signal;
  const {
    createThemeActionClient,
    createThemeStream,
    atelierRequestOptions,
  } = options.core ?? await loadThemeCore(signal);
  throwIfAborted(signal, "Cozy Village live source creation was aborted");
  /* The substrate ships the sanctioned client, so the theme no longer
     hand-rolls the actor header: `createThemeActionClient` stamps
     `theme:cozy-village` on every mutation and refuses any path that is not a
     same-origin /api/ path. */
  const action = createThemeActionClient(THEME_ID);
  const base = options.baseUrl ?? "";
  const search = options.search ?? globalThis.location?.search ?? "";
  const storage = options.storage ?? globalThis.localStorage;
  let activeProjectName = null;
  let selectionEpoch = 0;
  let availableProjects = [];
  let selectionReason = null;
  let chronicleAvailable = true;
  let gatesAvailable = false;
  let chronicleGeneratedAt = null;
  let chronicleTruncated = false;
  let footprintServed = false;
  let artifactsGeneratedAt = null;
  let artifactCount = 0;
  let loaded = false;
  let boardSnapshotGeneration = 0;
  let appliedBoardSnapshotGeneration = 0;
  let fullSnapshotGeneration = 0;
  let appliedFullSnapshotGeneration = 0;
  let latestBoardSnapshot = null;

  async function api(path, requestOptions) {
    const optionsWithSignal = signal && requestOptions?.signal === undefined
      ? { ...requestOptions, signal }
      : requestOptions;
    const mutating = optionsWithSignal?.method && optionsWithSignal.method.toUpperCase() !== "GET";
    const request = mutating
      ? action(path, optionsWithSignal)
      : fetch(`${base}${path}`, atelierRequestOptions(optionsWithSignal));
    const message = "Cozy Village live request was aborted";
    const response = await raceAbort(request, optionsWithSignal?.signal, message);
    throwIfAborted(optionsWithSignal?.signal, message);
    const text = await raceAbort(response.text(), optionsWithSignal?.signal, message);
    throwIfAborted(optionsWithSignal?.signal, message);
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(payload?.error ?? `${response.status} ${response.statusText}`);
      error.status = response.status;
      Object.assign(error, payload ?? {});
      throw error;
    }
    return payload;
  }

  async function loadMainHealth(project) {
    return api(`/api/projects/${encodeURIComponent(project)}/main-health`).catch((error) => {
      throwIfAborted(signal, "Cozy Village live request was aborted");
      return {
        project,
        state: "unknown",
        checksTotal: 0,
        unresolvedFailures: [],
        running: [],
        error: error.message,
      };
    });
  }

  function optionalFailure(error, fallback) {
    throwIfAborted(signal, "Cozy Village live request was aborted");
    return typeof fallback === "function" ? fallback(error) : fallback;
  }

  /** Adapt the server's `summary` name to the store's `stats` name. */
  async function loadChronicle(project) {
    try {
      const payload = await api(`/api/projects/${encodeURIComponent(project)}/chronicle`);
      const records = Array.isArray(payload?.records) ? payload.records : [];
      return {
        ...payload,
        records,
        stats: {
          merges: payload?.summary?.merges ?? records.length,
          firstPassReviews: payload?.summary?.firstPassReviews,
          reviewedMerges: payload?.summary?.reviewedMerges,
          reviewPassRate: payload?.summary?.reviewPassRate ?? null,
          costPerMergeUSD: payload?.summary?.costPerMergeUSD ?? null,
          unlandedSpendUSD: payload?.summary?.unlandedSpendUSD ?? 0,
        },
      };
    } catch (error) {
      throwIfAborted(signal, "Cozy Village live request was aborted");
      // An empty town that says why is honest; a town invented from the
      // dispatch list would not be.
      if (error.status === 404) {
        return { records: [], stats: {}, unavailable: true };
      }
      throw error;
    }
  }

  function observeChronicle(chronicle) {
    chronicleAvailable = chronicle?.unavailable !== true;
    chronicleGeneratedAt = chronicle?.generatedAt ?? null;
    chronicleTruncated = Boolean(chronicle?.truncated);
    footprintServed = (chronicle?.records ?? []).some((record) => record?.diff != null);
  }

  function syncProjectUrl(name) {
    try {
      const url = new URL(globalThis.location.href);
      url.searchParams.set("project", name);
      globalThis.history?.replaceState?.(globalThis.history.state, "", url);
    } catch {
      // A standalone harness may not have a writable History implementation.
    }
  }

  const source = {
    mode: "live",

    async load() {
      const message = "Cozy Village live load was aborted";
      const [projectsPayload, all, convoys] = await raceAbort(
        Promise.all([
          api("/api/projects"),
          api("/api/dispatches"),
          api("/api/convoys").catch((error) => optionalFailure(error, { convoys: [] })),
        ]),
        signal,
        message,
      );
      throwIfAborted(signal, message);
      loaded = true;
      const projects = Array.isArray(projectsPayload?.projects)
        ? projectsPayload.projects
        : [];
      const chroniclePairs = await raceAbort(
        Promise.all(
          projects.map(async (project) => {
            const chronicle = await loadChronicle(project.name);
            throwIfAborted(signal, message);
            return [project.name, chronicle];
          }),
        ),
        signal,
        message,
      );
      throwIfAborted(signal, message);
      const chronicles = new Map(chroniclePairs);
      const active = projects.find((project) => project.name === activeProjectName);
      const selected = active
        ? { project: active, reason: selectionReason ?? "selected" }
        : selectVillageProject({
            projects,
            chronicles,
            search,
            storage,
            contextProject: options.project,
          });
      const project = selected.project ?? { name: options.project ?? "atelier", requireReview: true };
      if (activeProjectName !== project.name) selectionEpoch += 1;
      activeProjectName = project.name;
      selectionReason = selected.reason;
      if (selected.reason === "query") rememberProject(storage, project.name);
      const chronicle = chronicles.get(project.name) ?? {
        records: [],
        stats: {},
        unavailable: true,
      };
      observeChronicle(chronicle);
      availableProjects = projects.map((candidate) => ({
        ...candidate,
        chronicleRecords: chronicles.get(candidate.name)?.records?.length ?? 0,
      }));

      // /api/dispatches serves every project; the village is one project's town.
      const mine = (Array.isArray(all) ? all : (all?.dispatches ?? [])).filter(
        (r) => r.project === project.name,
      );
      gatesAvailable = mine.some((r) => Array.isArray(r.gates));
      const encodedProject = encodeURIComponent(project.name);
      const [board, queue, mainHealth, artifacts] = await raceAbort(Promise.all([
        api(`/api/projects/${encodedProject}/state`).catch((error) => optionalFailure(error, {
          issues: [],
          readyIssues: [],
          source: null,
          tracker: "unknown",
          degraded: true,
          generatedAt: null,
          error: error.message,
        })),
        api(`/api/projects/${encodedProject}/queue`).catch((error) => optionalFailure(error, {
          enabled: false,
          unavailable: true,
          lastError: error.message,
        })),
        loadMainHealth(project.name),
        api(`/api/projects/${encodedProject}/artifacts`).catch((error) => optionalFailure(error, {
          project: project.name,
          generatedAt: null,
          artifacts: [],
          unavailable: true,
          error: error.message,
        })),
      ]), signal, message);
      throwIfAborted(signal, message);
      artifactsGeneratedAt = artifacts?.generatedAt ?? null;
      artifactCount = Array.isArray(artifacts?.artifacts) ? artifacts.artifacts.length : 0;

      const convoyList = convoys?.convoys ?? convoys ?? [];
      const convoy =
        convoyList.find((c) => c.project === project.name && c.state === "running") ??
        convoyList.find((c) => c.project === project.name) ??
        null;

      return {
        project,
        projects: availableProjects,
        chronicle,
        dispatches: mine.filter(isVillageDispatch),
        convoy: convoy
          ? { ...convoy, completedConvoys: convoyList.filter((c) => c.project === project.name && c.state === "completed").length }
          : null,
        board,
        queue,
        mainHealth,
        artifacts,
      };
    },

    async selectProject(name) {
      if (!availableProjects.some((project) => project.name === name)) {
        throw new Error(`Unknown project: ${name}`);
      }
      selectionEpoch += 1;
      activeProjectName = name;
      selectionReason = "selected";
      rememberProject(storage, name);
      syncProjectUrl(name);
      return source.load();
    },

    /**
     * The aggregate stream, filtered to this project's dispatches.
     *
     * Several event types are TRIGGERS rather than complete field carriers -
     * a `verify` event reports one step, not the settled verdict. So on any
     * gate-bearing event the record is re-fetched and attached as
     * `event.record`, and the store treats the server's record as final.
     */
    subscribe(handler) {
      /* One aggregate stream for the whole village. The theme never opens a
         per-dispatch stream: every parcel is already on the aggregate, and a
         pool of them would be a connection leak dressed as detail. */
      let subscribed = true;
      const deliver = (event) => {
        if (subscribed && !signal?.aborted) handler(event);
      };
      const stream = createThemeStream({
        eventSourceFactory: (path) => new EventSource(`${base}${path}`),

        onBoardEvent: async (event) => {
          if (event?.project !== activeProjectName) return;
          const requestedProject = activeProjectName;
          const requestedEpoch = selectionEpoch;
          const generation = ++boardSnapshotGeneration;
          const encodedProject = encodeURIComponent(requestedProject);
          const [board, queue] = await Promise.all([
            api(`/api/projects/${encodedProject}/state`).catch((error) => ({
              issues: [],
              readyIssues: [],
              source: null,
              tracker: "unknown",
              degraded: true,
              generatedAt: null,
              error: error.message,
            })),
            api(`/api/projects/${encodedProject}/queue`).catch((error) => ({
              enabled: false,
              unavailable: true,
              lastError: error.message,
            })),
          ]);
          if (
            !subscribed || signal?.aborted ||
            requestedEpoch !== selectionEpoch ||
            generation < appliedBoardSnapshotGeneration
          ) {
            return;
          }
          appliedBoardSnapshotGeneration = generation;
          latestBoardSnapshot = {
            project: requestedProject,
            epoch: requestedEpoch,
            generation,
            board,
            queue,
          };
          deliver({
            type: "board.snapshot",
            project: requestedProject,
            board,
            queue,
          });
        },

        onAggregateEvent: async (event) => {
          if (!subscribed || signal?.aborted || !event?.dispatchId) return;
          if (GATE_BEARING.has(event.type)) {
            /* Several SSE events are TRIGGERS rather than complete carriers —
               a `verify` event reports one step, not a settled verdict. The
               server attaches `gates` to the four types below, but the
               aggregate stream also replays a buffer of historical events on
               connect, and events persisted before the substrate landed carry
               none at all (verified live: 50 of 50 replayed events had no
               gates). Re-reading the record is what makes this correct against
               a replay buffer as well as a live tail — and it guarantees the
               store never receives a patch whose gate array is older than the
               record it rides on. */
            try {
              const record = await api(`/api/dispatch/${encodeURIComponent(event.dispatchId)}`);
              if (record?.project === activeProjectName) event.record = record;
            } catch {
              // A record we cannot re-read is left to the event's own fields.
            }
          }
          if (
            (event.type === "post-merge" || event.type === "status") &&
            event.record?.project === activeProjectName
          ) {
            event.mainHealth = await loadMainHealth(activeProjectName);
          }
          deliver(event);
        },

        /* On initial stream open and every reconnect, ask for the world again.
           This closes both the snapshot-to-subscribe gap and any disconnected
           interval without inventing event replay. */
        resync: async () => {
          const requestedEpoch = selectionEpoch;
          const requestedProject = activeProjectName;
          const generation = ++fullSnapshotGeneration;
          const boardGenerationAtStart = appliedBoardSnapshotGeneration;
          try {
            const data = await source.load();
            if (
              !subscribed || signal?.aborted ||
              requestedEpoch !== selectionEpoch ||
              generation < appliedFullSnapshotGeneration
            ) {
              return;
            }
            appliedFullSnapshotGeneration = generation;
            const newerBoard = latestBoardSnapshot?.epoch === requestedEpoch &&
              latestBoardSnapshot.project === requestedProject &&
              latestBoardSnapshot.generation > boardGenerationAtStart
              ? latestBoardSnapshot
              : null;
            deliver({
              type: "stream.resync",
              data: newerBoard
                ? { ...data, board: newerBoard.board, queue: newerBoard.queue }
                : data,
            });
          } catch (error) {
            if (
              !subscribed || signal?.aborted ||
              requestedEpoch !== selectionEpoch ||
              generation < appliedFullSnapshotGeneration
            ) {
              return;
            }
            throw error;
          }
        },

        onError: (error) => deliver({
          type: "stream.degraded",
          ...(error?.message ? { error: error.message } : {}),
        }),
      });

      return () => {
        if (!subscribed) return;
        subscribed = false;
        stream.close();
      };
    },

    merge: (id) => api(`/api/dispatch/${encodeURIComponent(id)}/merge`, { method: "POST", body: {} }),
    dismiss: (id) => api(`/api/dispatch/${encodeURIComponent(id)}/dismiss`, { method: "POST", body: {} }),
    reply: (id, text) => api(`/api/dispatch/${encodeURIComponent(id)}/reply`, { method: "POST", body: { text } }),
    ackMainHealth: (id) =>
      api(`/api/dispatch/${encodeURIComponent(id)}/ack-main-health`, { method: "POST", body: {} }),

    dashboardHref: (id) => `${base}/#dispatch/${encodeURIComponent(id)}`,

    describe() {
      /* Same rule as the fixture source: before load() this has measured
         nothing, and "chronicle unavailable" is a FINDING, not a default. It
         may not be reported before the request has been made. */
      if (!loaded) {
        return { mode: "live", label: "Live Atelier data", detail: "not loaded yet" };
      }
      const age = chronicleGeneratedAt
        ? `chronicle frozen at ${new Date(chronicleGeneratedAt).toLocaleTimeString()}`
        : "chronicle unavailable — the town is empty until the substrate lands";
      return {
        mode: "live",
        label: "Live Atelier data",
        detail: [
          chronicleAvailable ? age : age,
          activeProjectName
            ? `${activeProjectName} selected (${selectionReason ?? "live"})`
            : null,
          chronicleTruncated ? "truncated to the most recent merges" : null,
          gatesAvailable ? "gates from the server" : "gates derived in the theme (server projection absent)",
          footprintServed ? "archive includes measured diffs" : "archive diff measurements unavailable",
          artifactsGeneratedAt
            ? `${artifactCount} artifacts frozen at ${new Date(artifactsGeneratedAt).toLocaleTimeString()}`
            : "artifact index unavailable",
        ].filter(Boolean).join(" · "),
      };
    },
  };

  return source;
}
