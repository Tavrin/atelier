import {
  element,
  button,
  badge,
  stateChip,
  makeActivatable,
  boardColumn,
} from "./components.mjs";
import {
  composerAgentId,
  dispatchLanePayload,
  onboardingAgentId,
  settingsAgentId,
  withOnboardingDefaultAgent,
} from "./agent-selection.mjs";
import { logEventRow, logQueryString, logResultLabel } from "./log-view.mjs";
import { renderProjectMainHealth } from "./main-health.mjs";
import { createBoardStreamGate } from "./board-stream.mjs";
import {
  acceptBoardGeneration,
  boardProjection,
  convoyEligibility,
  convoyPickerProjection,
  nextBoardGeneration,
  nonReadyIssueLabel,
  parkedTicketsFrom,
  readyIssuesFrom,
  replaceReadyConsumers,
  ticketCreationState,
} from "./ready-projection.mjs";
import {
  applyReviewDispositionEvent,
  applyReviewEvent,
  dismissAvailability,
  executionProfileMismatchDetail,
  currentReview,
  mergeGateReasons,
  planAvailability,
  replyAvailability,
  reviewRounds,
  lastActivityAt,
  reviewIsStale,
  verificationEmptyMessage,
  verifyRerunAvailability,
} from "./reply-availability.mjs";
import { createDesktopNotifier } from "./notifications.mjs";
import { atelierRequestOptions, setAtelierCsrfToken } from "./request.mjs";
import { trustProfileSummary } from "./trust-profile.mjs";
import {
  shouldReturnToDashboard,
  teardownTheme,
  trackThemeCanvases,
} from "./theme-host.mjs";

const ACTIVE_STATES = new Set([
  "queued",
  "preparing",
  "resuming",
  "running",
  "plan_ready",
  "verifying",
  "stopping",
]);
const TERMINAL_STATES = new Set([
  "completed",
  "completed_empty",
  "needs_input",
  "failed",
  "stopped",
  "prepare_failed",
  "rejected",
]);

const app = document.querySelector("#app");
const sidebar = document.querySelector("#sidebar-nav");
const toastRoot = document.querySelector("#toast-root");
const modal = document.querySelector("#modal-root");
const modalContent = document.querySelector("#modal-content");
const loadingTemplate = document.querySelector("#loading-template");
const notificationToggle = document.querySelector("#notification-toggle");
const notificationLabel = document.querySelector("#notification-label");
const appearanceSelect = document.querySelector("#appearance-toggle");
const worldThemeSelect = document.querySelector("#world-theme-toggle");
const themeHost = document.querySelector("#theme-host");
const themeHostSwitcher = document.querySelector("#theme-host-switcher");
const activeThemeName = document.querySelector("#active-theme-name");
const themeDashboardReturn = document.querySelector("#theme-dashboard-return");
const themeCommandTrigger = document.querySelector("#theme-command-trigger");
const themeMount = document.querySelector("#theme-mount");
const sidebarMenuToggle = document.querySelector("#sidebar-menu-toggle");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const styleguideLink = document.querySelector("#styleguide-link");
let notificationsEnabled = false;
let notificationDeniedToastShown = false;
let activeThemeLifecycle;
let pendingThemeActivation;
let themeActivationToken = 0;
let themeTeardownTail = Promise.resolve();
let themeActivationBlocked = false;
const themeGenerationSlots = new Map();
const themePromiseRaceSlots = new Map();

const THEMES = ["auto", "light", "dark", "cyberpunk"];
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;
const SHORTCUTS = [
  { keys: ["g", "d"], action: "Open all dispatches" },
  { keys: ["g", "s"], action: "Open the styleguide" },
  { keys: ["1–9"], action: "Open the matching sidebar project" },
  { keys: ["/"], action: "Focus the board filter" },
  { keys: ["n"], action: "Open New dispatch" },
  { keys: ["?"], action: "Toggle this shortcuts overlay" },
  { keys: ["Escape"], action: "Close the open overlay or modal" },
];
const TRANSCRIPT_CARD_LEGEND = [
  { card: "Assistant message", meaning: "Natural-language output from the agent." },
  { card: "Bash command", meaning: "A shell command the agent started." },
  { card: "Tool result", meaning: "Output or an exit status returned by a tool." },
  { card: "File changes", meaning: "The agent is applying or has completed file edits." },
  { card: "Your reply", meaning: "Input you sent to the running or resumed dispatch." },
  { card: "Raw log", meaning: "An unrecognized adapter line preserved without attribution." },
  { card: "Verification", meaning: "The harness running the project's verify commands after the agent finishes - its verdict gates the merge." },
];
const SHORTCUT_SEQUENCE_MS = 800;
let pendingShortcutKey = "";
let pendingShortcutTimer;

const state = {
  projects: [],
  groups: [],
  dispatches: [],
  agents: null,
  agentsPromise: null,
  editorConfigured: false,
  boardCounts: new Map(),
  boardPayloads: new Map(),
  boardRequestGenerations: new Map(),
  boardAppliedGenerations: new Map(),
  boardEventHandler: null,
  route: { kind: "dispatches" },
  viewToken: 0,
  cleanups: [],
  trackerMoveNotes: new Map(),
  themes: [],
};

const sseManager = {
  source: null,
  lastEventIds: new Map(),

  close() {
    if (this.source) this.source.close();
    this.source = null;
  },

  open(key, path, eventTypes, handlers = {}) {
    this.close();
    const source = new EventSource(path);
    this.source = source;
    source.addEventListener("open", () => handlers.open?.());
    source.addEventListener("error", () => handlers.error?.());
    for (const type of eventTypes) {
      source.addEventListener(type, (message) => {
        if (message.lastEventId) this.lastEventIds.set(key, message.lastEventId);
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        handlers.event?.(event, message);
      });
    }
    // Native EventSource automatically sends Last-Event-ID when this connection reconnects.
    return source;
  },
};

const boardSseManager = {
  source: null,
  gate: null,
  bootStamp: null,
  updateToastShown: false,

  open() {
    if (this.source) return;
    const source = new EventSource("/api/board/events");
    this.source = source;
    const streamGate = createBoardStreamGate({
      // Interim reconnect repair only. B-1 owns cursored board replay.
      resync: resyncBoardPayloads,
      apply: (event) => void refreshBoardEvent(event),
      keys: () => state.projects
        .filter((project) => archetypeLabel(project) !== "git-only")
        .map((project) => project.name),
      keyFor: (event) => event.project,
    });
    this.gate = streamGate;
    source.addEventListener("open", () => {
      void streamGate.open().catch(() => {});
    });
    source.addEventListener("error", () => streamGate.error());
    source.addEventListener("hello", (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (
        event?.type !== "hello" ||
        typeof event.version !== "string" ||
        typeof event.bootedAt !== "string"
      ) return;
      const bootStamp = { version: event.version, bootedAt: event.bootedAt };
      if (!this.bootStamp) {
        this.bootStamp = bootStamp;
        return;
      }
      const serverChanged =
        bootStamp.version !== this.bootStamp.version ||
        bootStamp.bootedAt !== this.bootStamp.bootedAt;
      if (!serverChanged || this.updateToastShown) return;
      this.updateToastShown = true;
      showUpdateToast();
    });
    source.addEventListener("board", (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        return;
      }
      if (event?.type !== "board" || typeof event.project !== "string") return;
      streamGate.event(event);
    });
  },

  close() {
    this.source?.close();
    this.source = null;
    this.gate?.close();
    this.gate = null;
  },
};

function storageGet(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The UI still works when storage is unavailable.
  }
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_ESCAPE, "");
}

function themeLabelFor(theme) {
  return theme[0].toUpperCase() + theme.slice(1);
}

function populateThemeSelect(select) {
  select.replaceChildren();
  for (const theme of THEMES) {
    const option = document.createElement("option");
    option.value = theme;
    option.textContent = themeLabelFor(theme);
    select.append(option);
  }
}

function applyTheme(theme = storageGet("atelier-theme", "auto")) {
  const selected = THEMES.includes(theme) ? theme : "auto";
  document.documentElement.dataset.theme = selected;
  appearanceSelect.value = selected;
  appearanceSelect.setAttribute("aria-label", `Appearance: ${selected}`);
}

function setTheme(theme) {
  const next = THEMES.includes(theme) ? theme : "auto";
  storageSet("atelier-theme", next);
  applyTheme(next);
}

function populateWorldThemeSelect(select) {
  select.replaceChildren();
  const dashboard = document.createElement("option");
  dashboard.value = "dashboard";
  dashboard.textContent = "Dashboard (built-in)";
  select.append(dashboard);
  for (const theme of state.themes) {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.name;
    select.append(option);
  }
}

function syncWorldThemeSelects(value) {
  worldThemeSelect.value = value;
  themeHostSwitcher.value = value;
}

function setWorldThemeInventory(payload) {
  state.themes = Array.isArray(payload?.themes) ? payload.themes : [];
  populateWorldThemeSelect(worldThemeSelect);
  populateWorldThemeSelect(themeHostSwitcher);
}

function themeActivationAbortError() {
  const error = new Error("Theme activation was superseded");
  error.name = "AbortError";
  return error;
}

function requireThemeGeneration(token) {
  const lifecycle = themeGenerationSlots.get(token);
  if (
    !lifecycle ||
    lifecycle.controller.signal.aborted ||
    token !== themeActivationToken
  ) {
    throw themeActivationAbortError();
  }
  return lifecycle;
}

function takeThemePromiseRace(token) {
  const slot = themePromiseRaceSlots.get(token);
  if (!slot) return undefined;
  themePromiseRaceSlots.delete(token);
  slot.signal.removeEventListener("abort", slot.onAbort);
  return slot;
}

function abortThemePromiseRace(token) {
  const slot = takeThemePromiseRace(token);
  slot?.reject(themeActivationAbortError());
}

function settleThemePromiseRace(token, outcome, value) {
  const pending = themePromiseRaceSlots.get(token);
  if (!pending) return;
  if (
    pending.generation !== themeActivationToken ||
    !themeGenerationSlots.has(pending.generation) ||
    pending.signal.aborted
  ) {
    abortThemePromiseRace(token);
    return;
  }
  const slot = takeThemePromiseRace(token);
  slot?.[outcome](value);
}

/**
 * Detach activation from a provider-owned promise on generation abort. The
 * callbacks left on the original promise retain only an opaque race token; a
 * late settlement re-resolves the generation slot before observing its value.
 */
function raceThemeGeneration(promise, token) {
  const signal = requireThemeGeneration(token).controller.signal;
  return new Promise((resolve, reject) => {
    const raceToken = Symbol("theme-generation-race");
    const onAbort = () => abortThemePromiseRace(raceToken);
    themePromiseRaceSlots.set(raceToken, {
      generation: token,
      onAbort,
      reject,
      resolve,
      signal,
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    Promise.resolve(promise).then(
      (value) => settleThemePromiseRace(raceToken, "resolve", value),
      (error) => settleThemePromiseRace(raceToken, "reject", error),
    );
  });
}

async function leaveActiveTheme() {
  const lifecycle = activeThemeLifecycle;
  if (!lifecycle) return true;
  if (activeThemeLifecycle === lifecycle) activeThemeLifecycle = undefined;
  const { error } = await queueThemeTeardown(lifecycle);
  return error === undefined;
}

function queueThemeTeardown(lifecycle) {
  if (!lifecycle) return themeTeardownTail;
  lifecycle.controller?.abort();
  themeGenerationSlots.delete(lifecycle.generation);
  if (lifecycle.queuedTeardown) return lifecycle.queuedTeardown;
  const teardown = themeTeardownTail
    .then(() => teardownThemeLifecycle(lifecycle))
    .catch((error) => {
      const failure = themeTeardownFailure("host.teardown", error);
      return {
        error: themeTeardownError([failure]),
        failures: [failure],
        contextLosses: { unconfirmedCount: 0 },
      };
    })
    .then((result) => {
      if (result.error && !lifecycle.teardownFailureContained) {
        lifecycle.teardownFailureContained = true;
        containThemeTeardownFailure(result.error);
      }
      return result;
    });
  const tail = teardown.then(() => undefined, () => undefined);
  themeTeardownTail = tail;
  lifecycle.queuedTeardown = teardown;
  void tail.then(() => {
    if (themeTeardownTail === tail) themeTeardownTail = Promise.resolve();
    lifecycle.cleanup = undefined;
    lifecycle.dispose = undefined;
    lifecycle.canvasTracker = undefined;
    lifecycle.controller = undefined;
    lifecycle.mountPromise = undefined;
    lifecycle.root = undefined;
    lifecycle.teardownPromise = undefined;
    lifecycle.queuedTeardown = undefined;
  });
  return teardown;
}

function themeTeardownFailure(step, caught) {
  return {
    step,
    error: caught instanceof Error ? caught : new Error(String(caught)),
  };
}

function themeTeardownError(failures) {
  const error = new AggregateError(
    failures.map((failure) => failure.error),
    `Theme cleanup failed: ${failures
      .map((failure) => `${failure.step}: ${failure.error.message}`)
      .join("; ")}`,
  );
  error.name = "ThemeTeardownError";
  error.failures = failures;
  return error;
}

function appendThemeTeardownFailure(result, step, caught) {
  const failures = [...(result.failures ?? [])];
  if (failures.length === 0 && result.error) {
    failures.push(themeTeardownFailure("host.theme", result.error));
  }
  failures.push(themeTeardownFailure(step, caught));
  return { ...result, failures, error: themeTeardownError(failures) };
}

async function teardownThemeLifecycle(lifecycle) {
  if (!lifecycle) return Promise.resolve({ error: undefined });
  if (!lifecycle.teardownPromise) {
    lifecycle.controller?.abort();
    themeGenerationSlots.delete(lifecycle.generation);
    const root = lifecycle.root;
    lifecycle.teardownPromise = teardownTheme({
      root,
      cleanup: lifecycle.cleanup,
      dispose: lifecycle.dispose,
      canvasTracker: lifecycle.canvasTracker,
    }).then((result) => {
      try {
        root.remove();
        return result;
      } catch (error) {
        return appendThemeTeardownFailure(result, "theme-root.remove", error);
      }
    });
  }
  return lifecycle.teardownPromise;
}

function supersedePendingThemeActivation() {
  const pending = pendingThemeActivation;
  pendingThemeActivation = undefined;
  pending?.root.remove();
}

function clearPendingThemeActivation(token) {
  if (pendingThemeActivation?.token === token) pendingThemeActivation = undefined;
}

function fallBackToDashboard() {
  document.body.classList.remove("theme-active");
  themeHost.hidden = true;
  syncWorldThemeSelects("dashboard");
  storageSet("atelier-world-theme", "dashboard");
}

function containThemeTeardownFailure(error) {
  themeActivationBlocked = true;
  fallBackToDashboard();
  showToast(`Theme cleanup failed: ${error.message}`);
}

function activateWorldTheme(requested, { remember = true } = {}) {
  const token = ++themeActivationToken;
  supersedePendingThemeActivation();
  const lifecycle = activeThemeLifecycle;
  if (activeThemeLifecycle === lifecycle) activeThemeLifecycle = undefined;
  const teardown = lifecycle ? queueThemeTeardown(lifecycle) : themeTeardownTail;
  return teardown.then(() => activateWorldThemeSerial(
    requested,
    { remember, token },
  ));
}

function createThemeGeneration(theme, token) {
  const generationRoot = element("div", "theme-generation");
  generationRoot.dataset.themeGeneration = String(token);
  generationRoot.append(element("div", "loading-state", `Opening ${theme.name}…`));
  themeMount.append(generationRoot);
  pendingThemeActivation = { token, root: generationRoot };
  const lifecycle = {
    generation: token,
    root: generationRoot,
    dispose: undefined,
    canvasTracker: trackThemeCanvases(generationRoot),
    controller: new AbortController(),
    mountSettled: false,
  };
  themeGenerationSlots.set(token, lifecycle);
  activeThemeLifecycle = lifecycle;
}

function markThemeMountSettled(token) {
  const lifecycle = themeGenerationSlots.get(token);
  if (!lifecycle || lifecycle.controller.signal.aborted || token !== themeActivationToken) return;
  lifecycle.mountSettled = true;
}

function startThemeMount(token, entryModule, themeName) {
  const lifecycle = requireThemeGeneration(token);
  const mount = entryModule.mount ?? entryModule.default;
  if (typeof mount !== "function") {
    throw new Error(`${themeName} entry must export mount(root) or a default mount function`);
  }
  if (entryModule.dispose !== undefined && typeof entryModule.dispose !== "function") {
    throw new Error(`${themeName} dispose export must be a function`);
  }
  lifecycle.dispose = typeof entryModule.dispose === "function"
    ? () => entryModule.dispose(token)
    : undefined;
  lifecycle.root.replaceChildren();
  clearPendingThemeActivation(token);

  const mountWork = Promise.resolve().then(() => {
    const current = requireThemeGeneration(token);
    return mount(current.root, {
      generation: token,
      signal: current.controller.signal,
    });
  });
  const mountPromise = raceThemeGeneration(mountWork, token);
  lifecycle.mountPromise = mountPromise;
  void mountPromise.then(
    () => markThemeMountSettled(token),
    () => markThemeMountSettled(token),
  );
  return mountPromise;
}

async function activateWorldThemeSerial(requested, { remember, token }) {
  const theme = state.themes.find((candidate) => candidate.id === requested);
  const selected = theme ? theme.id : "dashboard";
  if (themeActivationBlocked) {
    fallBackToDashboard();
    return;
  }
  if (token !== themeActivationToken) return;
  syncWorldThemeSelects(selected);

  if (!theme) {
    document.body.classList.remove("theme-active");
    themeHost.hidden = true;
    if (remember) storageSet("atelier-world-theme", "dashboard");
    return;
  }

  activeThemeName.textContent = theme.name;
  themeHost.hidden = false;
  document.body.classList.add("theme-active");
  createThemeGeneration(theme, token);
  try {
    const entryModule = await raceThemeGeneration(import(theme.entryUrl), token);
    const mountPromise = startThemeMount(token, entryModule, theme.name);
    const cleanup = await mountPromise;
    const lifecycle = requireThemeGeneration(token);
    lifecycle.cleanup = cleanup;
    if (remember) storageSet("atelier-world-theme", selected);
  } catch (error) {
    if (token !== themeActivationToken || !themeGenerationSlots.has(token)) return;
    const lifecycle = requireThemeGeneration(token);
    if (activeThemeLifecycle === lifecycle) activeThemeLifecycle = undefined;
    await queueThemeTeardown(lifecycle);
    fallBackToDashboard();
    showToast(`Could not open ${theme.name}: ${error.message}`);
  }
}

function setSidebarOpen(open) {
  const expanded = Boolean(open);
  document.body.classList.toggle("sidebar-open", expanded);
  sidebarMenuToggle.setAttribute("aria-expanded", String(expanded));
  sidebarMenuToggle.setAttribute(
    "aria-label",
    expanded ? "Close navigation" : "Open navigation",
  );
}

function notificationPermission() {
  if (!("Notification" in window)) return "unavailable";
  try {
    return window.Notification.permission;
  } catch {
    return "unavailable";
  }
}

function renderNotificationToggle() {
  const permission = notificationPermission();
  const unavailable = permission === "unavailable";
  const denied = permission === "denied";
  notificationToggle.disabled = unavailable || denied;
  notificationToggle.classList.toggle("enabled", notificationsEnabled);
  notificationToggle.setAttribute("aria-checked", String(notificationsEnabled));
  notificationToggle.setAttribute(
    "aria-label",
    notificationsEnabled ? "Disable desktop notifications" : "Enable desktop notifications",
  );
  notificationToggle.title = unavailable
    ? "Desktop notifications are unavailable in this browser"
    : denied
      ? "Desktop notifications are blocked by the browser"
      : "Notify when a dispatch finishes or merged main fails verification";
  notificationLabel.textContent = unavailable
    ? "Unavailable"
    : denied
      ? "Blocked"
      : notificationsEnabled
        ? "On"
        : "Off";
}

function setNotificationsEnabled(enabled) {
  notificationsEnabled = Boolean(enabled);
  storageSet("atelier-notify", notificationsEnabled ? "on" : "off");
  renderNotificationToggle();
}

function handleNotificationDenied() {
  setNotificationsEnabled(false);
  if (notificationDeniedToastShown) return;
  notificationDeniedToastShown = true;
  showToast("Desktop notifications were denied");
}

async function toggleNotifications() {
  if (notificationsEnabled) {
    setNotificationsEnabled(false);
    return;
  }
  if (notificationPermission() === "unavailable") {
    renderNotificationToggle();
    return;
  }
  let permission;
  try {
    permission = await window.Notification.requestPermission();
  } catch {
    showToast("Desktop notifications are unavailable");
    setNotificationsEnabled(false);
    return;
  }
  if (permission === "granted") setNotificationsEnabled(true);
  else if (permission === "denied") handleNotificationDenied();
  else setNotificationsEnabled(false);
}

function initializeNotifications() {
  const permission = notificationPermission();
  notificationsEnabled = storageGet("atelier-notify", "off") === "on" && permission === "granted";
  if (permission === "denied") {
    handleNotificationDenied();
    return;
  }
  renderNotificationToggle();
}

const {
  markHistoricalDispatches,
  notifyTerminalDispatch,
  notifyPostMergeFailure,
} = createDesktopNotifier({
  getNotificationApi: () => window.Notification,
  getPermission: notificationPermission,
  isEnabled: () => notificationsEnabled,
  fetchRecord: (id) => api(`/api/dispatch/${encoded(id)}`),
});

function savedComposerDefaults() {
  try {
    return JSON.parse(storageGet("atelier-composer-defaults", "{}"));
  } catch {
    return {};
  }
}

function showToast(message, kind = "error") {
  const toast = element("div", `toast ${kind}`, message || "Unexpected error");
  toastRoot.append(toast);
  window.setTimeout(() => toast.remove(), 5_000);
}

function showUpdateToast() {
  const toast = element("div", "toast toast-update");
  const message = element(
    "span",
    "toast-update-message",
    "Atelier was updated - refresh to load the new interface",
  );
  const refresh = button("Refresh", "button compact");
  refresh.addEventListener("click", () => location.reload());
  toast.append(message, refresh);
  toastRoot.append(toast);
}

async function api(path, options = {}) {
  const request = atelierRequestOptions(options);
  const response = await fetch(path, request);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed with ${response.status}`);
    error.status = response.status;
    if (payload && typeof payload === "object") Object.assign(error, payload);
    throw error;
  }
  return payload;
}

function encoded(value) {
  return encodeURIComponent(value);
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatMoney(value) {
  const amount = Number(value || 0);
  return amount === 0 ? "$0.00" : `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;
}

function elapsedBetween(startedAt, endedAt = undefined) {
  const start = Date.parse(startedAt || "");
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - start) / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
  }
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${remainder}s`;
}

function formatDuration(durationMs) {
  const milliseconds = Number(durationMs);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function projectByName(name) {
  return state.projects.find((project) => project.name === name);
}

function groupByName(name) {
  return state.groups.find((group) => group.name === name);
}

function trackerLabel(project) {
  return project.detectedTracker || project.tracker || "none";
}

function archetypeLabel(project) {
  return project.archetype || (trackerLabel(project) === "none" ? "git-only" : "full");
}

function hasExternalTracker(project) {
  return (
    archetypeLabel(project) === "full" &&
    Boolean(project.trackerPath) &&
    project.trackerPath !== project.path
  );
}

function archetypeBadge(project, { expanded = false } = {}) {
  const archetype = archetypeLabel(project);
  const label = archetype === "tracker-only"
    ? expanded ? "tracker-only project" : archetype
    : hasExternalTracker(project) ? "FULL·EXT" : archetype;
  const chip = badge(label, `archetype-badge archetype-${archetype}`);
  if (hasExternalTracker(project)) chip.title = `External tracker: ${project.trackerPath}`;
  return chip;
}

function parseRoute(hash = location.hash) {
  const raw = hash.replace(/^#/, "") || "/dispatches";
  const parts = raw.split("/").filter(Boolean);
  try {
    if (parts[0] === "project" && parts[1]) {
      return { kind: "project", name: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === "dispatch" && parts[1]) {
      return { kind: "dispatch", id: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === "group" && parts[1]) {
      return { kind: "group", name: decodeURIComponent(parts[1]) };
    }
    if (parts[0] === "styleguide") return { kind: "styleguide" };
    if (parts[0] === "logs") return { kind: "logs" };
    if (parts[0] === "dispatches") return { kind: "dispatches" };
  } catch {
    return { kind: "not-found" };
  }
  return { kind: "not-found" };
}

function routeHref(route) {
  if (route.kind === "project") return `#/project/${encoded(route.name)}`;
  if (route.kind === "dispatch") return `#/dispatch/${encoded(route.id)}`;
  if (route.kind === "group") return `#/group/${encoded(route.name)}`;
  if (route.kind === "styleguide") return "#/styleguide";
  if (route.kind === "logs") return "#/logs";
  return "#/dispatches";
}

function sameRoute(left, right) {
  return left.kind === right.kind && left.name === right.name && left.id === right.id;
}

function navigate(route) {
  const href = routeHref(route);
  if (location.hash === href.slice(1)) {
    void renderRoute();
  } else {
    location.hash = href.slice(1);
  }
}

function cleanupView() {
  sseManager.close();
  for (const cleanup of state.cleanups.splice(0)) cleanup();
}

function registerCleanup(cleanup) {
  state.cleanups.push(cleanup);
}

function beginView() {
  cleanupView();
  state.viewToken += 1;
  app.classList.remove("project-view", "dispatch-view", "dispatches-view", "styleguide-view");
  window.scrollTo({ top: 0, left: 0 });
  app.replaceChildren(loadingTemplate.content.cloneNode(true));
  return state.viewToken;
}

function viewIsCurrent(token) {
  return token === state.viewToken;
}

function navSection(title) {
  const section = element("section", "nav-section");
  section.append(element("h2", "nav-heading", title));
  const list = element("ul", "nav-list");
  section.append(list);
  return { section, list };
}

function navLink(route, name, metaBuilder, countBuilder) {
  const item = element("li");
  const link = element("a", "nav-link");
  link.href = routeHref(route);
  link.addEventListener("click", () => setSidebarOpen(false));
  if (sameRoute(state.route, route)) link.classList.add("active");
  const primary = element("span", "nav-primary");
  primary.append(element("span", "nav-name", name));
  const meta = element("span", "nav-meta");
  metaBuilder?.(meta);
  primary.append(meta);
  const counts = element("span", "nav-counts");
  countBuilder?.(counts);
  link.append(primary, counts);
  item.append(link);
  return item;
}

function renderSidebar() {
  const fragment = document.createDocumentFragment();
  const overview = navSection("Overview");
  overview.list.append(
    navLink(
      { kind: "dispatches" },
      "All dispatches",
      (meta) => meta.append(element("span", "", `${state.dispatches.length} total`)),
      (counts) => {
        const live = state.dispatches.filter((record) => ACTIVE_STATES.has(record.state)).length;
        if (live > 0) counts.append(liveCount(live));
      },
    ),
  );
  overview.list.append(
    navLink(
      { kind: "logs" },
      "Event log",
      (meta) => meta.append(element("span", "", "queue, dispatch, settings")),
    ),
  );
  fragment.append(overview.section);

  const projects = navSection("Projects");
  const addProject = button(
    state.projects.length === 0 ? "Add your first project" : "+ Add project",
    `button add-project-button${state.projects.length === 0 ? " empty" : ""}`,
  );
  addProject.addEventListener("click", () => {
    setSidebarOpen(false);
    openAddProjectModal();
  });
  projects.section.append(addProject);
  for (const project of state.projects) {
    projects.list.append(
      navLink(
        { kind: "project", name: project.name },
        project.name,
        (meta) => {
          meta.append(archetypeBadge(project));
        },
        (counts) => {
          const dirty =
            archetypeLabel(project) === "tracker-only"
              ? 0
              : Number(project.capabilities?.git?.dirtyCount || 0);
          const live = state.dispatches.filter(
            (record) => record.project === project.name && ACTIVE_STATES.has(record.state),
          ).length;
          if (dirty > 0) {
            const chip = element("span", "dirty-chip", `±${dirty}`);
            chip.title = `${dirty} uncommitted change${dirty === 1 ? "" : "s"} in the primary checkout`;
            counts.append(chip);
          }
          const boardCount = state.boardCounts.get(project.name);
          if (Number.isInteger(boardCount)) {
            const chip = element("span", "board-count-chip", String(boardCount));
            chip.title = `${boardCount} active board ticket${boardCount === 1 ? "" : "s"}`;
            counts.append(chip);
          }
          if (live > 0) counts.append(liveCount(live));
        },
      ),
    );
  }
  fragment.append(projects.section);

  if (state.groups.length > 0) {
    const groups = navSection("Groups");
    for (const group of state.groups) {
      groups.list.append(
        navLink(
          { kind: "group", name: group.name },
          group.name,
          (meta) => meta.append(element("span", "", `${group.projects.length} projects`)),
        ),
      );
    }
    fragment.append(groups.section);
  }

  sidebar.replaceChildren(fragment);
  styleguideLink.classList.toggle("active", state.route.kind === "styleguide");
}

function liveCount(count) {
  const chip = element("span", "live-chip");
  chip.title = `${count} live dispatch${count === 1 ? "" : "es"}`;
  chip.append(element("span", "running-pulse"), document.createTextNode(String(count)));
  return chip;
}

async function loadShell() {
  const [projectsPayload, dispatches] = await Promise.all([
    api("/api/projects"),
    api("/api/dispatches"),
  ]);
  state.projects = projectsPayload.projects || [];
  state.groups = projectsPayload.groups || [];
  state.editorConfigured = Boolean(projectsPayload.editorConfigured);
  state.dispatches = Array.isArray(dispatches) ? dispatches : [];
  await Promise.all(
    state.projects
      .filter((project) => archetypeLabel(project) !== "git-only")
      .map((project) => refreshBoardPayload(project.name, { render: false })),
  );
  markHistoricalDispatches(state.dispatches);
  renderSidebar();
}

function activeBoardTickets(issues) {
  return issues.filter((issue) => issue.status !== "closed").length;
}

async function refreshBoardPayload(
  projectName,
  { render = true, required = false, includeQueue = false } = {},
) {
  const project = projectByName(projectName);
  if (!project || archetypeLabel(project) === "git-only") return undefined;
  const generation = nextBoardGeneration(state.boardRequestGenerations, projectName);
  try {
    const [boardPayload, queue] = await Promise.all([
      api(`/api/projects/${encoded(projectName)}/state`),
      includeQueue && archetypeLabel(project) === "full"
        ? api(`/api/projects/${encoded(projectName)}/queue`).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const payload = queue
      ? { ...boardPayload, parkedTickets: queue.parkedTickets ?? [] }
      : boardPayload;
    if (
      !acceptBoardGeneration(
        state.boardAppliedGenerations,
        projectName,
        generation,
      )
    ) {
      return undefined;
    }
    state.boardPayloads.set(projectName, payload);
    state.boardCounts.set(projectName, activeBoardTickets(payload.issues || []));
    if (render) renderSidebar();
    return payload;
  } catch (error) {
    if (generation < (state.boardAppliedGenerations.get(projectName) ?? 0)) {
      return undefined;
    }
    if (required) throw error;
    return undefined;
  }
}

async function refreshBoardEvent(event) {
  const payload = await refreshBoardPayload(event.project, { includeQueue: true });
  if (!payload) return;
  state.boardEventHandler?.(event, payload);
}

async function resyncBoardPayloads(projectName) {
  const projects = state.projects.filter((project) =>
    archetypeLabel(project) !== "git-only" &&
    (projectName === undefined || project.name === projectName));
  const refreshed = await Promise.allSettled(
    projects.map(async (project) => ({
        project: project.name,
        payload: await refreshBoardPayload(project.name, {
          render: false,
          includeQueue: true,
          required: true,
        }),
      })),
  );
  renderSidebar();
  for (const result of refreshed) {
    if (result.status === "rejected") continue;
    const { project, payload } = result.value;
    if (!payload) continue;
    state.boardEventHandler?.({ type: "board", project, resync: true }, payload);
  }
  const failure = refreshed.find(({ status }) => status === "rejected");
  if (failure) throw failure.reason;
}

async function refreshDispatches() {
  const records = await api("/api/dispatches");
  state.dispatches = Array.isArray(records) ? records : [];
  renderSidebar();
  return state.dispatches;
}

async function loadAgents() {
  if (state.agents) return state.agents;
  state.agentsPromise ||= api("/api/agents").then((agentList) => {
    state.agents = Array.isArray(agentList) ? agentList : [];
    return state.agents;
  });
  try {
    return await state.agentsPromise;
  } catch (error) {
    state.agentsPromise = null;
    throw error;
  }
}

function viewHeader({ eyebrow, title, description, chip, actions = [] }) {
  const header = element("header", "view-header");
  const copy = element("div");
  copy.append(element("p", "eyebrow", eyebrow));
  const titleRow = element("div", "view-title-row");
  titleRow.append(element("h1", "view-title", title));
  if (chip) titleRow.append(chip);
  copy.append(titleRow);
  if (description) copy.append(element("p", "view-description", description));
  header.append(copy);
  if (actions.length > 0) {
    const toolbar = element("div", "toolbar");
    toolbar.append(...actions);
    header.append(toolbar);
  }
  return header;
}

function openEditorButton(path) {
  const open = button("Open in editor");
  open.addEventListener("click", async () => {
    open.disabled = true;
    open.textContent = "Opening…";
    try {
      await api(path, { method: "POST", body: {} });
      showToast("Opened in editor", "success");
    } catch (error) {
      showToast(error.message);
    } finally {
      open.disabled = false;
      open.textContent = "Open in editor";
    }
  });
  return open;
}

function banner(text, kind = "warning") {
  return element("div", `${kind}-banner`, text);
}

function projectFacts(project, queue = undefined) {
  const facts = element("div", "project-facts");
  const git = project.capabilities?.git || {};
  facts.append(
    element("span", "", `Branch: ${git.branch || "unknown"}`),
    element("span", "", `Dirty: ${Number(git.dirtyCount || 0)}`),
    element("span", "", `Worktrees: ${Number(git.worktrees || 0)}`),
    element("span", "", git.hasRemote ? "Remote configured" : "No remote"),
  );
  // Spend against the daily budget belongs in the ALWAYS-VISIBLE header, not
  // only in the queue card two tabs away: a budget-blocked queue has to be
  // visible at a glance (atelier-e5x constraint 4).
  if (queue?.budget) {
    facts.append(
      element(
        "span",
        queue.budget.exceeded ? "queue-spend-blocked" : "",
        `Spend today: ${formatMoney(queue.budget.spentUSD)} of ${formatMoney(queue.budget.budgetUSD)}${queue.budget.exceeded ? " - budget reached" : ""}`,
      ),
    );
  }
  if (queue?.unpricedDispatches?.exceeded) {
    facts.append(
      element(
        "span",
        "queue-spend-blocked",
        `Unpriced dispatch cap reached: ${Number(queue.unpricedDispatches.dispatchesToday)} of ${Number(queue.unpricedDispatches.dispatchCap)}`,
      ),
    );
  }
  return facts;
}

function composerWarnings(project) {
  const warnings = element("div", "banner-stack composer-banners");
  const dirty = Number(project.capabilities?.git?.dirtyCount || 0);
  if (dirty > 0) {
    warnings.append(
      banner(
        `Primary checkout has ${dirty} uncommitted change${dirty === 1 ? "" : "s"}. The dispatch worktree will not include them.`,
      ),
    );
  }
  if (project.warn) warnings.append(banner(`Forbidden for this project: ${project.warn}`));
  return warnings;
}

function renderQueueCard(project, initialQueue) {
  let queue = initialQueue;
  let pending = false;
  const card = element("section", "queue-card");
  const heading = element("div", "queue-heading");
  const copy = element("div");
  copy.append(
    element("h2", "", "Ready-queue autonomy"),
    element("p", "", "Dispatch the next ready ticket whenever this project is idle."),
  );
  const status = element("div", "queue-status");
  const toggle = button("", "queue-toggle");
  toggle.setAttribute("role", "switch");
  toggle.append(element("span", "queue-toggle-knob"), element("span", "queue-toggle-label"));
  heading.append(copy, toggle);
  card.append(heading, status);

  function renderQueueState() {
    const unavailable = Boolean(queue.unavailable);
    const failures = Number(queue.consecutiveFailures || 0);
    const parkedTickets = Array.isArray(queue.parkedTickets) ? queue.parkedTickets : [];
    card.classList.toggle("muted", unavailable);
    toggle.hidden = unavailable;
    toggle.disabled = pending;
    toggle.classList.toggle("enabled", Boolean(queue.enabled));
    toggle.setAttribute("aria-checked", String(Boolean(queue.enabled)));
    toggle.setAttribute(
      "aria-label",
      `${queue.enabled ? "Disable" : "Enable"} ready-queue autonomy for ${project.name}`,
    );
    toggle.querySelector(".queue-toggle-label").textContent = pending
      ? "Saving…"
      : queue.enabled
        ? "On"
        : "Off";
    status.replaceChildren();
    if (unavailable) {
      status.append(
        badge("no tracker", "tracker-none"),
        element("span", "", "Ready-queue autonomy requires a project tracker."),
      );
      return;
    }
    status.append(element("span", "", `Consecutive failures: ${failures}`));
    status.append(
      element("span", "", `Ticket retry limit: ${Number(queue.failureLimit || 2)}`),
    );
    // Spend readout (atelier-e5x): a budget-blocked queue used to be visible only
    // as a lastError string AFTER a drain had already been refused.
    const spend = element("div", "queue-spend");
    if (queue.budget) {
      const line = element(
        "span",
        queue.budget.exceeded ? "queue-spend-blocked" : "",
        `Spend today: ${formatMoney(queue.budget.spentUSD)} of ${formatMoney(queue.budget.budgetUSD)}${queue.budget.exceeded ? " - budget reached" : ""}`,
      );
      spend.append(line);
    }
    if (queue.unpricedDispatches) {
      spend.append(
        element(
          "span",
          queue.unpricedDispatches.exceeded ? "queue-spend-blocked" : "",
          `Unpriced dispatches today: ${Number(queue.unpricedDispatches.dispatchesToday)} of ${Number(queue.unpricedDispatches.dispatchCap)}${queue.unpricedDispatches.exceeded ? " - cap reached" : ""}`,
        ),
      );
    }
    if (spend.childElementCount > 0) status.append(spend);
    if (queue.lastError) {
      status.append(element("p", "queue-error", `Last error: ${queue.lastError}`));
    }
    if (!queue.enabled && failures >= 3) {
      status.append(
        element(
          "p",
          "queue-warning",
          "auto-disabled after repeated failures - re-enable to reset",
        ),
      );
    }
    if (parkedTickets.length > 0) {
      const parkedList = element("div", "queue-parked-list");
      parkedList.append(
        element(
          "p",
          "queue-warning",
          `${parkedTickets.length} parked ticket${parkedTickets.length === 1 ? "" : "s"}`,
        ),
      );
      for (const parked of parkedTickets) {
        const row = element("div", "queue-parked-ticket");
        const details = element("div");
        const failureDate = parked.lastFailureAt ? new Date(parked.lastFailureAt) : null;
        const failedAt = failureDate && Number.isFinite(failureDate.getTime())
          ? failureDate.toLocaleString()
          : "";
        details.append(
          element("strong", "", parked.ticketId),
          element(
            "span",
            "",
            [
              `${Number(parked.attempts || 0)} attempts`,
              parked.lastFailureKind || "failed",
              failedAt,
            ].filter(Boolean).join(" · "),
          ),
          element("span", "", parked.parkReason || "Repeated runtime failure"),
        );
        const resume = button("Resume", "button compact");
        resume.disabled = pending;
        resume.addEventListener("click", async () => {
          pending = true;
          renderQueueState();
          try {
            queue = await api(`/api/projects/${encoded(project.name)}/queue`, {
              method: "POST",
              body: { resumeTicketId: parked.ticketId },
            });
          } catch (error) {
            showToast(error.message);
          } finally {
            pending = false;
            renderQueueState();
          }
        });
        row.append(details, resume);
        parkedList.append(row);
      }
      status.append(parkedList);
    }
  }

  toggle.addEventListener("click", async () => {
    pending = true;
    renderQueueState();
    try {
      queue = await api(`/api/projects/${encoded(project.name)}/queue`, {
        method: "POST",
        body: { enabled: !queue.enabled },
      });
    } catch (error) {
      showToast(error.message);
    } finally {
      pending = false;
      renderQueueState();
    }
  });

  renderQueueState();
  return card;
}

function option(value, label, selectedValue) {
  const node = element("option", "", label);
  node.value = value;
  node.selected = value === selectedValue;
  return node;
}

function field(label, control, className = "field", hint = "") {
  const wrapper = element("label", className);
  wrapper.append(element("span", "", label), control);
  if (hint) wrapper.append(element("small", "field-hint", hint));
  return wrapper;
}

function issuePrompt(issue) {
  const sections = [`Work ticket ${issue.id}: ${issue.title || "Untitled ticket"}`];
  if (issue.description) sections.push(issue.description);
  if (issue.acceptance_criteria) {
    sections.push(`Acceptance criteria:\n${issue.acceptance_criteria}`);
  }
  return sections.join("\n\n");
}

function syncComposerGuidance(composer, ticketId) {
  const hasTicket = Boolean(ticketId);
  const promptHint = composer.querySelector(".composer-prompt-hint");
  const ticketHint = composer.querySelector(".composer-ticket-hint");
  if (promptHint) {
    promptHint.textContent = hasTicket
      ? "Prompt comes from the ticket description and acceptance criteria."
      : "For one-offs and experiments. Real work deserves a ticket: tracked, claimed, closed on merge, and kept in history.";
  }
  if (ticketHint) {
    ticketHint.textContent = hasTicket
      ? "Prompt comes from this ticket's description; the dispatch keeps its lifecycle and history."
      : "No ticket lifecycle; use free prompts for throwaways and experiments.";
  }
}

function renderComposer(project, agentList, initialIssue = undefined, forceOpen = false) {
  const defaults = savedComposerDefaults();
  const details = element("details", "dispatch-composer");
  details.id = "dispatch-composer";
  details.open = forceOpen || trackerLabel(project) === "none";
  details.append(element("summary", "", initialIssue ? `Dispatch ${initialIssue.id}` : "New dispatch"));
  const warnings = composerWarnings(project);
  if (warnings.childElementCount > 0) details.append(warnings);

  const form = element("form", "composer-form");
  const prompt = document.createElement("textarea");
  prompt.name = "prompt";
  prompt.required = true;
  prompt.placeholder = "Describe the work to perform in an isolated worktree…";
  prompt.value = initialIssue ? issuePrompt(initialIssue) : "";

  const ticket = document.createElement("input");
  ticket.name = "ticketId";
  ticket.readOnly = true;
  ticket.placeholder = "No ticket";
  ticket.value = initialIssue?.id || "";

  const model = document.createElement("select");
  model.name = "model";
  const effort = document.createElement("select");
  effort.name = "effort";
  const planFirst = checkboxSetting(
    "Plan first (review before execution)",
    false,
    { hint: "Pause after a read-only Claude planning run so you can approve or revise it." },
  );
  planFirst.wrapper.classList.add("composer-plan-first");

  const lane = document.createElement("select");
  lane.name = "lane";
  const selectedLane = composerAgentId(project, agentList);
  lane.append(
    ...agentList.map((agent) => option(agent.id, agent.displayName, selectedLane)),
  );
  const modelField = field("Model", model);
  const effortField = field("Effort", effort);
  const resolvedModel = element("p", "composer-resolved-model");
  resolvedModel.hidden = true;
  const selectionsByAgent = new Map();
  let renderedAgentId;
  let laneTouched = false;
  const syncOptionsToAgent = () => {
    if (renderedAgentId) {
      selectionsByAgent.set(renderedAgentId, { model: model.value, effort: effort.value });
    }
    const agent = agentList.find((candidate) => candidate.id === lane.value);
    if (!agent) return;
    const remembered = selectionsByAgent.get(agent.id) || defaults;
    const models = Array.isArray(agent.options?.models) ? agent.options.models : [];
    const efforts = Array.isArray(agent.options?.efforts) ? agent.options.efforts : [];
    const modelChoices = [...models, { value: "inherit", label: "Inherit project default" }];
    const effortChoices = [{ value: "default", label: "Default" }, ...efforts];
    const selectedModel = modelChoices.some(({ value }) => value === remembered.model)
      ? remembered.model
      : models[0]?.value || "inherit";
    const selectedEffort = effortChoices.some(({ value }) => value === remembered.effort)
      ? remembered.effort
      : "default";
    model.replaceChildren(
      ...modelChoices.map(({ value, label }) => option(value, label, selectedModel)),
    );
    effort.replaceChildren(
      ...effortChoices.map(({ value, label }) => option(value, label, selectedEffort)),
    );
    model.disabled = models.length === 0;
    effort.disabled = efforts.length === 0;
    modelField.hidden = models.length === 0;
    effortField.hidden = efforts.length === 0;
    const externallyConfigured = models.length === 0 && efforts.length === 0;
    resolvedModel.hidden = !externallyConfigured;
    resolvedModel.textContent = externallyConfigured
      ? `Model: ${agent.options?.resolvedModel || "codex-default"} — configured in ~/.codex/config.toml`
      : "";
    model.title = model.disabled ? `Model for ${agent.displayName} is configured outside Atelier` : "";
    effort.title = effort.disabled
      ? `Reasoning effort for ${agent.displayName} is configured outside Atelier`
      : "";
    renderedAgentId = agent.id;
  };
  const syncPlanFirst = () => {
    const agent = agentList.find((candidate) => candidate.id === lane.value);
    const available = agent?.id === "claude" && agent.capabilities?.canResume === true;
    planFirst.control.disabled = !available;
    if (!available) planFirst.control.checked = false;
    planFirst.wrapper.title = available
      ? ""
      : "Plan first requires the resumable Claude lane.";
  };
  lane.addEventListener("change", () => {
    laneTouched = true;
    syncOptionsToAgent();
    syncPlanFirst();
  });
  syncOptionsToAgent();
  syncPlanFirst();

  const maxTurns = document.createElement("input");
  maxTurns.name = "maxTurns";
  maxTurns.type = "number";
  maxTurns.min = "1";
  maxTurns.step = "1";
  maxTurns.required = true;
  maxTurns.value = String(defaults.maxTurns || project.dispatchProfile?.maxTurns || 50);

  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const submit = button("Dispatch", "button primary");
  submit.type = "submit";
  const footer = element("div", "form-footer");
  footer.append(status, submit);

  const promptField = field("Prompt", prompt, "field wide", " ");
  promptField.querySelector(".field-hint")?.classList.add("composer-prompt-hint");
  const ticketField = field("Ticket", ticket, "field", " ");
  ticketField.querySelector(".field-hint")?.classList.add("composer-ticket-hint");

  form.append(
    promptField,
    ticketField,
    field("Agent", lane),
    modelField,
    effortField,
    resolvedModel,
    field("Max turns", maxTurns),
    planFirst.wrapper,
    footer,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "Creating isolated worktree…";
    const values = new FormData(form);
    const body = {
      project: project.name,
      prompt: String(values.get("prompt") || "").trim(),
      maxTurns: Number(values.get("maxTurns")),
    };
    Object.assign(body, dispatchLanePayload(laneTouched, lane.value));
    const ticketId = String(values.get("ticketId") || "").trim();
    if (ticketId) body.ticketId = ticketId;
    if (planFirst.control.checked) body.planFirst = true;
    if (!model.disabled && model.value !== "inherit") body.model = model.value;
    if (!effort.disabled && effort.value !== "default") {
      body.effort = effort.value;
    }
    storageSet(
      "atelier-composer-defaults",
      JSON.stringify({
        model: model.value,
        effort: effort.value,
        maxTurns: Number(values.get("maxTurns")),
      }),
    );
    try {
      const result = await api("/api/dispatch", { method: "POST", body });
      await refreshDispatches();
      navigate({ kind: "dispatch", id: result.id });
    } catch (error) {
      if (isDispatchLimitError(error)) {
        status.textContent = error.message;
        openBudgetConfirmation(error, async () => {
          const result = await api("/api/dispatch", {
            method: "POST",
            body: { ...body, force: true },
          });
          await refreshDispatches();
          navigate({ kind: "dispatch", id: result.id });
        });
      } else {
        status.textContent = error.message;
        showToast(error.message);
      }
      submit.disabled = false;
    }
  });
  details.append(form);
  syncComposerGuidance(details, ticket.value);
  return details;
}

function configureComposer(issue) {
  closeModal();
  const composer = document.querySelector("#dispatch-composer");
  if (!composer) return;
  composer.open = true;
  const prompt = composer.querySelector("textarea[name='prompt']");
  const ticket = composer.querySelector("input[name='ticketId']");
  const summary = composer.querySelector("summary");
  prompt.value = issuePrompt(issue);
  ticket.value = issue.id;
  summary.textContent = `Dispatch ${issue.id}`;
  syncComposerGuidance(composer, issue.id);
  composer.scrollIntoView({ behavior: "smooth", block: "start" });
  prompt.focus({ preventScroll: true });
}

function dependencyId(dependency) {
  if (typeof dependency === "string") return dependency;
  return dependency?.depends_on_id || dependency?.id || dependency?.issue_id || "unknown";
}

function dependencyStatus(dependency, issues) {
  const linked = issues.get(dependencyId(dependency));
  return linked?.status || dependency?.status || "unknown";
}

function isTriage(issue) {
  return /triage/i.test(issue.description || "");
}

function closedTime(issue) {
  const value = Date.parse(issue.closed_at || issue.updated_at || "");
  return Number.isNaN(value) ? 0 : value;
}

function comparePriorityThenUpdated(left, right) {
  const priority = Number(left.priority ?? 4) - Number(right.priority ?? 4);
  if (priority !== 0) return priority;
  return closedTime(right) - closedTime(left);
}

function issueMap(issues) {
  return new Map(issues.map((issue) => [issue.id, issue]));
}

function actionButton(label, handler, className = "button compact") {
  const node = button(label, className);
  node.addEventListener("click", async (event) => {
    event.stopPropagation();
    await handler(event);
  });
  return node;
}

function cardFor(project, issue, issues, repoName = undefined, readinessLabel = undefined) {
  const priority = Number(issue.priority ?? 4);
  const card = makeActivatable(
    element("article", `issue-card priority-p${priority}`),
    () => openIssueModal(project, issue, issues),
  );
  card.setAttribute("aria-label", `Open ${issue.id}: ${issue.title}`);
  card.dataset.search = `${issue.id || ""} ${issue.title || ""}`.toLocaleLowerCase();

  const meta = element("div", "card-meta");
  meta.append(
    element("span", "card-id", issue.id),
    badge(issue.issue_type || "task"),
    badge(`P${priority}`, `priority-chip p${priority}`),
  );
  if (repoName) meta.append(badge(repoName, "repo-chip"));
  if (isTriage(issue) && issue.status === "open") meta.append(badge("Triage", "triage"));
  if (readinessLabel) meta.append(badge(readinessLabel, "readiness-label"));
  if (issue.assignee) meta.append(element("span", "card-assignee", `@${issue.assignee}`));
  if (archetypeLabel(project) !== "tracker-only") {
    const dispatch = actionButton("↗", async () => configureComposer(issue), "card-dispatch");
    dispatch.setAttribute("aria-label", `Dispatch ${issue.id}`);
    dispatch.title = `Dispatch ${issue.id}`;
    meta.append(dispatch);
  }
  card.append(meta, element("div", "card-title", issue.title || "Untitled ticket"));
  return card;
}

function renderBoard(
  project,
  issues,
  repoName = undefined,
  {
    filterText = "",
    readyIssues = [],
    readyDegraded = false,
    parkedTickets = [],
  } = {},
) {
  const byId = issueMap(issues);
  const projectedReady = (Array.isArray(readyIssues) ? readyIssues : [])
    .map((issue) => byId.get(issue?.id))
    .filter(Boolean);
  const readyIds = new Set(projectedReady.map(({ id }) => id));
  const columns = [
    {
      kind: "ready",
      title: "Ready",
      issues: projectedReady,
    },
    {
      kind: "not-ready",
      title: "Not Ready",
      issues: issues
        .filter((issue) => issue.status === "open" && !readyIds.has(issue.id))
        .sort(comparePriorityThenUpdated),
    },
    {
      kind: "progress",
      title: "In Progress",
      issues: issues
        .filter((issue) => issue.status === "in_progress")
        .sort(comparePriorityThenUpdated),
    },
    {
      kind: "closed",
      title: "Recently Closed",
      issues: issues
        .filter((issue) => issue.status === "closed")
        .sort((left, right) => closedTime(right) - closedTime(left)),
    },
  ];

  const region = element("section", "board-region");
  const toolbar = element("div", "board-filter");
  const filter = document.createElement("input");
  filter.type = "search";
  filter.placeholder = "Filter by ticket or title";
  filter.setAttribute("aria-label", "Filter board tickets");
  filter.value = filterText;
  const matchCount = element("span", "board-match-count");
  matchCount.setAttribute("aria-live", "polite");
  const clear = button("Clear", "button compact board-filter-clear");
  clear.hidden = true;
  toolbar.append(filter, matchCount, clear);

  const board = element("div", "board");
  const renderedColumns = [];
  let closedExpanded = false;
  let filterTimer;
  const totalIssues = columns.reduce((total, column) => total + column.issues.length, 0);

  for (const columnData of columns) {
    const { column, body: list, count } = boardColumn(
      columnData.kind,
      columnData.title,
      columnData.issues.length,
    );
    if (columnData.kind === "ready" && readyDegraded) {
      const indicator = badge(readyDegraded.label, "ready-degraded");
      indicator.title = readyDegraded.detail;
      column.querySelector(".column-header")?.append(indicator);
    }
    const empty = element("div", "empty-state", "No tickets here");
    const cards = [];
    list.append(empty);
    for (const issue of columnData.issues) {
      const readinessLabel = columnData.kind === "not-ready"
        ? nonReadyIssueLabel(issue, { issues: byId, parkedTickets })
        : undefined;
      const card = cardFor(project, issue, byId, repoName, readinessLabel);
      cards.push(card);
      list.append(card);
    }
    const showAll = button(
      `Show all (${columnData.issues.length})`,
      "button compact show-all-closed",
    );
    showAll.hidden = columnData.kind !== "closed" || columnData.issues.length <= 15;
    showAll.addEventListener("click", () => {
      closedExpanded = true;
      applyFilter();
    });
    list.append(showAll);
    board.append(column);
    renderedColumns.push({ ...columnData, cards, count, empty, showAll });
  }

  function applyFilter() {
    const query = filter.value.trim().toLocaleLowerCase();
    let matches = 0;
    for (const column of renderedColumns) {
      let visible = 0;
      for (const [index, card] of column.cards.entries()) {
        const matchesQuery = !query || card.dataset.search.includes(query);
        const collapsed =
          column.kind === "closed" && !closedExpanded && !query && index >= 15;
        card.hidden = !matchesQuery || collapsed;
        if (matchesQuery) matches += 1;
        if (!card.hidden) visible += 1;
      }
      column.count.textContent = String(query ? visible : column.issues.length);
      column.empty.hidden = visible > 0;
      column.showAll.hidden =
        column.kind !== "closed" ||
        closedExpanded ||
        Boolean(query) ||
        column.issues.length <= 15;
    }
    clear.hidden = !query;
    matchCount.textContent = query
      ? `${matches} of ${totalIssues} tickets`
      : `${totalIssues} ticket${totalIssues === 1 ? "" : "s"}`;
  }

  filter.addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilter, 150);
  });
  clear.addEventListener("click", () => {
    window.clearTimeout(filterTimer);
    filter.value = "";
    applyFilter();
    filter.focus();
  });
  region._atelierCleanup = () => window.clearTimeout(filterTimer);
  registerCleanup(region._atelierCleanup);
  applyFilter();
  region.append(toolbar, board);
  return region;
}

function captureBoardView(region) {
  return {
    filterText: region.querySelector('[aria-label="Filter board tickets"]')?.value || "",
    boardScrollLeft: region.querySelector(".board")?.scrollLeft || 0,
    columns: new Map(
      [...region.querySelectorAll(".column")].map((column) => [
        column.dataset.kind,
        column.querySelector(".card-list")?.scrollTop || 0,
      ]),
    ),
  };
}

function restoreBoardView(region, saved) {
  const board = region.querySelector(".board");
  if (board) board.scrollLeft = saved.boardScrollLeft;
  for (const column of region.querySelectorAll(".column")) {
    const body = column.querySelector(".card-list");
    if (body) body.scrollTop = saved.columns.get(column.dataset.kind) || 0;
  }
}

function closeModal() {
  if (modal.open) modal.close();
  delete modal.dataset.kind;
}

function modalFrame(kicker, title, kind = "") {
  modalContent.replaceChildren();
  if (kind) modal.dataset.kind = kind;
  else delete modal.dataset.kind;
  const header = element("header", "modal-header");
  const copy = element("div");
  copy.append(element("div", "card-id", kicker), element("h2", "", title));
  copy.querySelector("h2").id = "modal-title";
  const close = button("×", "icon-button");
  close.setAttribute("aria-label", "Close");
  close.addEventListener("click", closeModal);
  header.append(copy, close);
  const body = element("div", "modal-body");
  modalContent.append(header, body);
  if (!modal.open) modal.showModal();
  return body;
}

function transcriptLegendTable() {
  const table = element("table", "shortcut-table transcript-legend-table");
  const head = element("thead");
  const heading = element("tr");
  heading.append(element("th", "", "Card"), element("th", "", "Meaning"));
  head.append(heading);
  const rows = element("tbody");
  for (const item of TRANSCRIPT_CARD_LEGEND) {
    const row = element("tr");
    row.append(
      element("td", "transcript-legend-card", item.card),
      element("td", "", item.meaning),
    );
    rows.append(row);
  }
  table.append(head, rows);
  return table;
}

function openTranscriptLegend() {
  const body = modalFrame("Transcript", "Card legend", "transcript-legend");
  body.append(
    element(
      "p",
      "confirm-copy",
      "Atelier keeps recognized activity compact and preserves uncertain adapter output as raw logs.",
    ),
    transcriptLegendTable(),
  );
}

function toggleTranscriptLegend() {
  if (modal.open && modal.dataset.kind === "transcript-legend") {
    closeModal();
    return;
  }
  openTranscriptLegend();
}

function openShortcutsOverlay({
  title = "Keyboard shortcuts",
  kind = "shortcuts",
} = {}) {
  const body = modalFrame("Atelier", title, kind);
  body.append(
    element(
      "p",
      "confirm-copy",
      "Navigate and start work without leaving the keyboard. Shortcuts are paused while a form control is focused.",
    ),
  );
  const table = element("table", "shortcut-table");
  const head = element("thead");
  const heading = element("tr");
  heading.append(element("th", "", "Keys"), element("th", "", "Action"));
  head.append(heading);
  const rows = element("tbody");
  for (const shortcut of SHORTCUTS) {
    const row = element("tr");
    const keys = element("td", "shortcut-keys");
    shortcut.keys.forEach((key, index) => {
      if (index > 0) keys.append(document.createTextNode(" then "));
      keys.append(element("kbd", "", key));
    });
    row.append(keys, element("td", "", shortcut.action));
    rows.append(row);
  }
  table.append(head, rows);
  const legend = element("section", "transcript-legend-section");
  legend.append(
    element("h3", "", "Transcript cards"),
    element("p", "confirm-copy", "The transcript uses these cards for agent activity."),
    transcriptLegendTable(),
  );
  body.append(table, legend);
}

function openCommandPalette() {
  openShortcutsOverlay({
    title: "Command palette",
    kind: "command-palette",
  });
}

function toggleShortcutsOverlay() {
  if (modal.open && modal.dataset.kind === "shortcuts") {
    closeModal();
    return;
  }
  openShortcutsOverlay();
}

function clearPendingShortcut() {
  window.clearTimeout(pendingShortcutTimer);
  pendingShortcutTimer = undefined;
  pendingShortcutKey = "";
}

function startShortcutSequence(key) {
  clearPendingShortcut();
  pendingShortcutKey = key;
  pendingShortcutTimer = window.setTimeout(clearPendingShortcut, SHORTCUT_SEQUENCE_MS);
}

function shortcutTargetIsEditable(target) {
  return (
    target instanceof Element &&
    (target.matches("input, textarea, select") || target.closest("[contenteditable='true']"))
  );
}

function focusBoardFilter() {
  if (state.route.kind !== "project") return false;
  const filter = document.querySelector(
    "#project-board-panel:not([hidden]) [aria-label='Filter board tickets']",
  );
  if (!filter) return false;
  filter.focus();
  return true;
}

function openNewDispatchFromShortcut() {
  if (state.route.kind !== "project") return false;
  const composer = document.querySelector("#dispatch-composer");
  if (!composer) return false;
  composer.open = true;
  composer.scrollIntoView({ behavior: "smooth", block: "start" });
  composer.querySelector("textarea[name='prompt']")?.focus({ preventScroll: true });
  return true;
}

function handleGlobalShortcut(event) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const shiftedQuestionMark = event.shiftKey && event.key === "?";
  if (
    shortcutTargetIsEditable(event.target) ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    (event.shiftKey && !shiftedQuestionMark)
  ) {
    clearPendingShortcut();
    return;
  }

  if (key === "Escape") {
    clearPendingShortcut();
    return;
  }
  if (pendingShortcutKey === "g") {
    clearPendingShortcut();
    if (key === "d") {
      event.preventDefault();
      navigate({ kind: "dispatches" });
      return;
    }
    if (key === "s") {
      event.preventDefault();
      navigate({ kind: "styleguide" });
      return;
    }
  }
  if (key === "g") {
    event.preventDefault();
    startShortcutSequence("g");
    return;
  }
  clearPendingShortcut();

  if (/^[1-9]$/.test(key)) {
    const project = state.projects[Number(key) - 1];
    if (!project) return;
    event.preventDefault();
    navigate({ kind: "project", name: project.name });
    return;
  }
  if (key === "/" && focusBoardFilter()) {
    event.preventDefault();
    return;
  }
  if (key === "n" && openNewDispatchFromShortcut()) {
    event.preventDefault();
    return;
  }
  if (key === "?") {
    event.preventDefault();
    toggleShortcutsOverlay();
  }
}

function openBudgetConfirmation(error, onConfirm) {
  const countLimited = error.dispatchCountExceeded === true;
  const body = modalFrame(
    countLimited ? "Daily unpriced dispatch cap" : "Daily cost budget",
    "Dispatch anyway?",
  );
  body.append(
    element(
      "p",
      "confirm-copy",
      countLimited
        ? `This project has started ${error.dispatchesToday} of its ${error.dispatchCap} daily dispatches on lanes without reported cost.`
        : `This project has spent ${formatMoney(error.spentUSD)} of its ${formatMoney(error.budgetUSD)} daily budget.`,
    ),
  );
  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const cancel = button("Cancel");
  cancel.addEventListener("click", closeModal);
  const confirm = button("Dispatch anyway", "button danger");
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    cancel.disabled = true;
    status.textContent = countLimited
      ? "Overriding the daily unpriced dispatch cap…"
      : "Overriding the daily budget…";
    try {
      await onConfirm();
      closeModal();
    } catch (retryError) {
      status.textContent = retryError.message;
      showToast(retryError.message);
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });
  const actions = element("div", "modal-actions");
  actions.append(status, cancel, confirm);
  body.append(actions);
}

function isDispatchLimitError(error) {
  return error.budgetExceeded === true || error.dispatchCountExceeded === true;
}

function openMoveTrackerConfirmation(project) {
  const to = hasExternalTracker(project) ? "in-repo" : "external";
  const targetLabel = to === "in-repo" ? "inside the repository" : "Atelier-managed state";
  const body = modalFrame("Tracker migration", `Move tracker ${targetLabel}?`);
  body.append(
    element(
      "p",
      "confirm-copy",
      to === "in-repo"
        ? `Atelier will move the entire .beads directory from ${project.trackerPath} into ${project.path}.`
        : `Atelier will move the entire ${project.path}/.beads directory into its state directory for ${project.name}.`,
    ),
  );
  const plan = element("ol", "tracker-move-plan");
  plan.append(
    element("li", "", "Move the directory by rename, or copy and verify it across filesystems."),
    element(
      "li",
      "",
      to === "in-repo"
        ? "Atomically remove trackerPath from the registry."
        : "Atomically set trackerPath to the Atelier-managed directory.",
    ),
    element("li", "", "Run br ready at the new location; any failure rolls back the move and registry."),
  );
  body.append(plan);
  body.append(
    element(
      "p",
      "warning-banner tracker-move-warning",
      to === "in-repo"
        ? "Atelier will not git-add or commit .beads in your repository. That is your commit."
        : "Atelier will not commit the removal of .beads from your repository. That is your commit.",
    ),
  );
  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const cancel = button("Cancel");
  cancel.addEventListener("click", closeModal);
  const confirm = button("Move tracker", "button primary");
  confirm.addEventListener("click", async () => {
    cancel.disabled = true;
    confirm.disabled = true;
    confirm.textContent = "Moving…";
    status.textContent = "Moving tracker and running br ready…";
    try {
      const result = await api(`/api/projects/${encoded(project.name)}/move-tracker`, {
        method: "POST",
        body: { to },
      });
      state.trackerMoveNotes.set(project.name, result.nextSteps);
      closeModal();
      showToast(result.nextSteps, "success");
      await loadShell();
      await renderRoute();
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message);
      cancel.disabled = false;
      confirm.disabled = false;
      confirm.textContent = "Move tracker";
    }
  });
  const actions = element("div", "modal-actions");
  actions.append(status, cancel, confirm);
  body.append(actions);
}

function openAddProjectModal() {
  const body = modalFrame("Project onboarding", "Add project");
  body.append(
    element(
      "p",
      "confirm-copy",
      "Choose a project folder. Atelier will probe it without running verification commands.",
    ),
  );
  const path = document.createElement("input");
  path.name = "path";
  path.required = true;
  path.placeholder = "/absolute/path/to/project";
  const form = element("form", "add-project-form");
  const browser = element("section", "directory-browser");
  browser.setAttribute("aria-label", "Project folder browser");
  const browserHeader = element("div", "directory-browser-header");
  const browserTitle = element("strong", "", "Folders");
  const browserStatus = element("span", "directory-browser-status");
  browserStatus.setAttribute("aria-live", "polite");
  browserHeader.append(browserTitle, browserStatus);
  const browserToolbar = element("div", "directory-browser-toolbar");
  const up = button("↑ Up", "button directory-up");
  const breadcrumbs = element("nav", "directory-breadcrumbs");
  breadcrumbs.setAttribute("aria-label", "Current folder");
  browserToolbar.append(up, breadcrumbs);
  const directoryList = element("ul", "directory-list");
  browser.append(browserHeader, browserToolbar, directoryList);

  let parentPath = null;
  let browseRequest = 0;
  function renderDirectoryListing(listing) {
    parentPath = listing.parent;
    up.disabled = !parentPath;
    breadcrumbs.replaceChildren();
    for (const [index, crumb] of listing.breadcrumbs.entries()) {
      if (index > 0) breadcrumbs.append(element("span", "directory-separator", "/"));
      const crumbButton = button(crumb.name, "directory-crumb");
      if (crumb.path === listing.path) {
        crumbButton.disabled = true;
        crumbButton.setAttribute("aria-current", "location");
      } else {
        crumbButton.addEventListener("click", () => void loadDirectory(crumb.path));
      }
      breadcrumbs.append(crumbButton);
    }

    directoryList.replaceChildren();
    if (listing.directories.length === 0) {
      directoryList.append(element("li", "directory-empty", "No subfolders"));
      return;
    }
    for (const directory of listing.directories) {
      const item = element("li", "directory-entry");
      const open = button("", "directory-entry-button");
      open.setAttribute("aria-label", `Open ${directory.name}`);
      open.append(element("span", "directory-name", directory.name));
      const badges = element("span", "directory-entry-badges");
      if (directory.git) badges.append(badge("git repo", "directory-git"));
      if (directory.beads) badges.append(badge(".beads", "directory-beads"));
      open.append(badges, element("span", "directory-open-icon", "›"));
      open.addEventListener("click", () => void loadDirectory(directory.path));
      item.append(open);
      directoryList.append(item);
    }
  }

  async function loadDirectory(requestedPath) {
    const request = ++browseRequest;
    browser.classList.add("loading");
    browserStatus.textContent = "Loading folders…";
    try {
      const query = requestedPath ? `?path=${encoded(requestedPath)}` : "";
      const listing = await api(`/api/fs/dirs${query}`);
      if (request !== browseRequest) return;
      path.value = listing.path;
      renderDirectoryListing(listing);
      browserStatus.textContent = `${listing.directories.length} subfolder${listing.directories.length === 1 ? "" : "s"}`;
    } catch (error) {
      if (request !== browseRequest) return;
      browserStatus.textContent = `${error.message} Enter a path manually below.`;
    } finally {
      if (request === browseRequest) browser.classList.remove("loading");
    }
  }

  up.addEventListener("click", () => {
    if (parentPath) void loadDirectory(parentPath);
  });
  const manualPath = element("div", "directory-manual-path");
  const browseEntered = button("Browse path", "button");
  browseEntered.addEventListener("click", () => {
    const requestedPath = path.value.trim();
    if (requestedPath) void loadDirectory(requestedPath);
  });
  manualPath.append(
    field(
      "Project path (manual entry)",
      path,
      "field directory-manual-field",
      "Absolute paths remain available as an escape hatch.",
    ),
    browseEntered,
  );
  const status = element("span", "form-status");
  const next = button("Continue", "button primary");
  next.type = "submit";
  const actions = element("div", "form-footer");
  actions.append(status, next);
  form.append(browser, manualPath, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    next.disabled = true;
    status.textContent = "Probing project…";
    try {
      const [probe, agentList] = await Promise.all([
        api("/api/projects/probe", {
          method: "POST",
          body: { path: path.value.trim() },
        }),
        loadAgents(),
      ]);
      renderAddProjectConfirmation(body, probe, agentList);
    } catch (error) {
      status.textContent = error.message;
      next.disabled = false;
    }
  });
  body.append(form);
  void loadDirectory();
}

function radioChoice(name, value, title, selected, description = "") {
  const wrapper = element("label", "radio-choice");
  const control = document.createElement("input");
  control.type = "radio";
  control.name = name;
  control.value = value;
  control.checked = value === selected;
  const copy = element("div", "radio-choice-copy");
  copy.append(element("strong", "", title));
  if (description) copy.append(element("small", "", description));
  wrapper.append(control, copy);
  return wrapper;
}

function renderAddProjectConfirmation(body, probe, agentList) {
  body.replaceChildren();
  const facts = element("section", "probe-facts");
  facts.append(
    element("h3", "", "Probe facts"),
    element("span", "", `Branch: ${probe.git.branch || "none"}`),
    element("span", "", `Remote HEAD: ${probe.git.remoteHead || "unknown"}`),
    element("span", "", `Dirty: ${Number(probe.git.dirtyCount || 0)}`),
    element("span", "", `Remote: ${probe.git.remote || "none"}`),
    element("span", "", `Tracker: ${probe.tracker.detected || "none"}`),
  );

  const form = element("form", "add-project-confirm-form");
  const name = document.createElement("input");
  name.name = "name";
  name.required = true;
  name.pattern = "[a-z0-9][a-z0-9._-]*";
  name.value = probe.inferred.name || "";

  const archetypes = element("fieldset", "field wide archetype-field");
  archetypes.append(element("legend", "", "Archetype"));
  const archetypeChoices = element("div", "radio-choices");
  for (const [value, title, description] of [
    ["full", "Full", "Git repository with a ticket board and dispatches."],
    ["git-only", "Git only", "Git repository for dispatches, without a ticket board."],
    ["tracker-only", "Tracker only", "Ticket board without a Git repository or dispatches."],
  ]) {
    archetypeChoices.append(
      radioChoice(
        "archetype",
        value,
        title,
        probe.inferred.archetype || "git-only",
        description,
      ),
    );
  }
  archetypes.append(archetypeChoices);

  const customBranchValue = "__custom__";
  const branches = Array.isArray(probe.git.branches) ? probe.git.branches : [];
  const inferredMainBranch = probe.inferred.mainBranch || "";
  const mainBranch = document.createElement("select");
  mainBranch.name = "mainBranch";
  mainBranch.append(
    ...branches.map((branch) => option(branch, branch, inferredMainBranch)),
    option(customBranchValue, "Other / unborn branch…", customBranchValue),
  );
  mainBranch.value = branches.includes(inferredMainBranch)
    ? inferredMainBranch
    : customBranchValue;
  const customMainBranch = document.createElement("input");
  customMainBranch.name = "customMainBranch";
  customMainBranch.placeholder = "Branch name or clean base ref";
  customMainBranch.value = branches.includes(inferredMainBranch) ? "" : inferredMainBranch;
  const mainBranchField = field(
    "Main branch",
    mainBranch,
    "field main-branch-field",
    "Choose a detected local branch, or use the escape hatch for an unborn branch or another clean base ref.",
  );
  mainBranchField.insertBefore(customMainBranch, mainBranchField.querySelector(".field-hint"));
  const syncCustomMainBranch = () => {
    const custom = mainBranch.value === customBranchValue;
    customMainBranch.hidden = !custom;
    customMainBranch.required = custom && !mainBranch.disabled;
  };
  mainBranch.addEventListener("change", syncCustomMainBranch);
  syncCustomMainBranch();

  const verifyCommands = document.createElement("textarea");
  verifyCommands.name = "verifyCommands";
  verifyCommands.placeholder = "One command per line";
  verifyCommands.value = (probe.inferred.verifyCommands || []).join("\n");

  const warn = document.createElement("textarea");
  warn.name = "warn";
  warn.placeholder = "Commands or actions agents must avoid";
  warn.value = probe.inferred.warn || "";

  const trackerLocationField = element("fieldset", "field wide tracker-location-field");
  trackerLocationField.append(element("legend", "", "Where does the tracker live?"));
  const trackerLocationChoices = element("div", "tracker-location-choices");
  trackerLocationChoices.append(
    radioChoice(
      "trackerLocation",
      "external",
      "Atelier-managed (default)",
      "external",
      "Nothing is added to the repository; the tracker stays on this machine.",
    ),
    radioChoice(
      "trackerLocation",
      "in-repo",
      "Inside the repository (committed)",
      "external",
      "Syncs with teammates through Git and remains visible in the repository.",
    ),
  );
  trackerLocationField.append(trackerLocationChoices);

  const inferredProfile = { ...(probe.inferred.dispatchProfile || {}) };
  const selectedDefaultAgent = onboardingAgentId(probe.inferred, agentList);
  const inheritedAgentId = agentList.some(
    (candidate) => candidate.id === probe.resolvedDefaultAgent,
  )
    ? probe.resolvedDefaultAgent
    : agentList.find((candidate) => candidate.id === "claude")?.id ||
      agentList[0]?.id ||
      "claude";
  const inheritedAgentName =
    agentList.find((candidate) => candidate.id === inheritedAgentId)?.displayName ||
    inheritedAgentId;
  const defaultAgent = document.createElement("select");
  defaultAgent.name = "defaultAgent";
  defaultAgent.append(
    option("", `Inherit Atelier default (${inheritedAgentName})`, selectedDefaultAgent),
    ...agentList.map((candidate) =>
      option(candidate.id, candidate.displayName, selectedDefaultAgent)),
  );
  const model = document.createElement("select");
  model.name = "model";
  const effort = document.createElement("select");
  effort.name = "effort";
  const selectionsByAgent = new Map([
    [
      selectedDefaultAgent || inheritedAgentId,
      {
        model: inferredProfile.model || inferredProfile.defaultModel || "",
        effort: inferredProfile.effort || "",
      },
    ],
  ]);
  let renderedAgentId;
  const syncAdvancedAgentOptions = () => {
    if (renderedAgentId) {
      selectionsByAgent.set(renderedAgentId, { model: model.value, effort: effort.value });
    }
    const effectiveAgentId = defaultAgent.value || inheritedAgentId;
    const selectedAgent = agentList.find((candidate) => candidate.id === effectiveAgentId);
    const models = Array.isArray(selectedAgent?.options?.models)
      ? selectedAgent.options.models
      : [];
    const efforts = Array.isArray(selectedAgent?.options?.efforts)
      ? selectedAgent.options.efforts
      : [];
    const remembered = selectionsByAgent.get(effectiveAgentId) || {};
    const selectedModel = models.some(({ value }) => value === remembered.model)
      ? remembered.model
      : "";
    const selectedEffort = efforts.some(({ value }) => value === remembered.effort)
      ? remembered.effort
      : "";
    model.replaceChildren(
      option("", "Inherit default", selectedModel),
      ...models.map(({ value, label }) => option(value, label, selectedModel)),
    );
    effort.replaceChildren(
      option("", "Inherit default", selectedEffort),
      ...efforts.map(({ value, label }) => option(value, label, selectedEffort)),
    );
    model.disabled = models.length === 0;
    effort.disabled = efforts.length === 0;
    const externalHint = `Configured outside Atelier for ${selectedAgent?.displayName || effectiveAgentId}.`;
    model.title = model.disabled ? externalHint : "";
    effort.title = effort.disabled ? externalHint : "";
    renderedAgentId = effectiveAgentId;
  };
  defaultAgent.addEventListener("change", syncAdvancedAgentOptions);
  syncAdvancedAgentOptions();

  const maxTurns = document.createElement("input");
  maxTurns.name = "maxTurns";
  maxTurns.type = "number";
  maxTurns.min = "1";
  maxTurns.step = "1";
  maxTurns.placeholder = "Inherit default (50)";
  maxTurns.value = inferredProfile.maxTurns ? String(inferredProfile.maxTurns) : "";
  const dailyBudget = document.createElement("input");
  dailyBudget.name = "budgetUSDPerDay";
  dailyBudget.type = "number";
  dailyBudget.min = "0.01";
  dailyBudget.step = "0.01";
  dailyBudget.placeholder = "No daily limit";
  dailyBudget.value = probe.inferred.budgetUSDPerDay
    ? String(probe.inferred.budgetUSDPerDay)
    : "";
  const requireReview = checkboxSetting(
    "Require passing spec review before merge",
    Boolean(probe.inferred.requireReview),
    { hint: "Adds a read-only spec-audit gate after verification." },
  );
  const reviewPolicy = document.createElement("select");
  reviewPolicy.name = "reviewPolicy";
  const inferredReviewPolicy = probe.inferred.reviewPolicy || "strict";
  reviewPolicy.replaceChildren(
    option("strict", "Strict — any open finding gates", inferredReviewPolicy),
    option("tiered", "Tiered — blocker/major gate", inferredReviewPolicy),
    option("advisory", "Advisory — report only", inferredReviewPolicy),
  );
  const autoCommit = checkboxSetting(
    "Auto-commit tracker changes",
    Boolean(probe.inferred.autoCommitTracker),
    { hint: "Applied when the selected tracker directory is inside a Git checkout." },
  );
  const autoClose = checkboxSetting(
    "Auto-close tickets on merge",
    Boolean(probe.inferred.autoCloseOnMerge),
    { hint: "Close a ticket after its dispatch is merged." },
  );
  const onboardingAutomation = element("div", "onboarding-automation field wide");
  onboardingAutomation.append(
    element("span", "section-label", "Merge safety and tracker automation"),
    requireReview.wrapper,
    field("Review finding policy", reviewPolicy, "field", "BLOCKER always requires force."),
    autoCommit.wrapper,
    autoClose.wrapper,
  );
  const advanced = element("details", "onboarding-advanced wide");
  advanced.append(element("summary", "", "Advanced"));
  const advancedGrid = element("div", "onboarding-advanced-grid");
  advancedGrid.append(
    field("Default agent", defaultAgent),
    field("Model", model, "field", "Options come from the selected agent adapter."),
    field("Effort", effort, "field", "Options come from the selected agent adapter."),
    field("Max turns", maxTurns, "field", "Leave blank to inherit the Atelier default."),
    field(
      "Daily budget (USD)",
      dailyBudget,
      "field",
      "Leave blank to disable the daily cost ceiling.",
    ),
    onboardingAutomation,
  );
  advanced.append(advancedGrid);

  const selectedArchetype = () =>
    form.querySelector("input[name='archetype']:checked")?.value || "git-only";
  const selectedTrackerLocation = () =>
    form.querySelector("input[name='trackerLocation']:checked")?.value || "external";
  const selectedTracker = () => {
    const archetype = selectedArchetype();
    if (archetype === "git-only") return "none";
    if (archetype === "tracker-only") return "personal";
    return selectedTrackerLocation() === "external" ? "personal" : "committed";
  };
  const syncTrackerLocation = () => {
    const archetype = selectedArchetype();
    const trackerAvailable = Boolean(probe.git.isRepo) && archetype === "full";
    trackerLocationField.hidden = !trackerAvailable;
    for (const control of trackerLocationField.querySelectorAll("input")) {
      control.disabled = !trackerAvailable;
    }
    const branchAvailable = Boolean(probe.git.isRepo) && archetype !== "tracker-only";
    mainBranchField.hidden = !branchAvailable;
    mainBranch.disabled = !branchAvailable;
    customMainBranch.disabled = !branchAvailable;
    syncCustomMainBranch();
    const reviewAvailable = branchAvailable;
    requireReview.control.disabled = !reviewAvailable;
    requireReview.wrapper.classList.toggle("disabled", !reviewAvailable);
    reviewPolicy.disabled = !reviewAvailable;
    const trackerAutomationAvailable = trackerAvailable;
    for (const setting of [autoCommit, autoClose]) {
      setting.control.disabled = !trackerAutomationAvailable;
      setting.wrapper.classList.toggle("disabled", !trackerAutomationAvailable);
    }
  };
  archetypes.addEventListener("change", syncTrackerLocation);

  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const back = button("Back");
  back.addEventListener("click", openAddProjectModal);
  const submit = button("Add project", "button primary");
  submit.type = "submit";
  const duplicateHint = element("small", "field-hint field-warning");
  duplicateHint.hidden = true;
  const nameField = field("Name", name);
  nameField.append(duplicateHint);
  const syncDuplicateWarning = () => {
    const duplicate = state.projects.some((project) => project.name === name.value.trim());
    duplicateHint.hidden = !duplicate;
    duplicateHint.textContent = duplicate
      ? `A project named ${name.value.trim()} is already registered.`
      : "";
    submit.disabled = duplicate;
    submit.title = duplicate ? "Choose a unique project name." : "";
  };
  name.addEventListener("input", syncDuplicateWarning);
  const actions = element("div", "form-footer wide");
  actions.append(status, back, submit);
  form.append(
    facts,
    nameField,
    archetypes,
    trackerLocationField,
    mainBranchField,
    field(
      "Verification commands",
      verifyCommands,
      "field wide",
      (probe.inferred.verifyCommands || []).length === 0
        ? "no build files recognized - add commands manually"
        : "",
    ),
    field("Agent warning", warn, "field wide"),
    advanced,
    actions,
  );
  syncTrackerLocation();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    back.disabled = true;
    status.textContent = "Adding project…";
    const dispatchProfile = { ...inferredProfile };
    delete dispatchProfile.lane;
    delete dispatchProfile.agent;
    delete dispatchProfile.model;
    delete dispatchProfile.defaultModel;
    delete dispatchProfile.effort;
    delete dispatchProfile.maxTurns;
    if (!model.disabled && model.value) dispatchProfile.model = model.value;
    if (!effort.disabled && effort.value) dispatchProfile.effort = effort.value;
    if (maxTurns.value) dispatchProfile.maxTurns = Number(maxTurns.value);
    let project = {
      ...probe.inferred,
      name: name.value.trim(),
      path: probe.path,
      archetype: selectedArchetype(),
      mainBranch: selectedArchetype() === "tracker-only"
        ? null
        : mainBranch.value === customBranchValue
          ? customMainBranch.value.trim() || null
          : mainBranch.value || null,
      tracker: selectedTracker(),
      verifyCommands: verifyCommands.value
        .split(/\r?\n/)
        .map((command) => command.trim())
        .filter(Boolean),
      warn: warn.value.trim(),
      containerized: Boolean(probe.inferred.containerized),
      verifyMode: probe.inferred.verifyMode || "worktree",
      dispatchProfile,
      requireReview: !requireReview.control.disabled && requireReview.control.checked,
      reviewPolicy: reviewPolicy.value,
    };
    project = withOnboardingDefaultAgent(project, defaultAgent.value);
    if (dailyBudget.value) project.budgetUSDPerDay = Number(dailyBudget.value);
    else delete project.budgetUSDPerDay;
    if (probe.git.isRepo && project.archetype === "full") {
      project.trackerLocation = selectedTrackerLocation();
      project.autoCommitTracker = autoCommit.control.checked;
      project.autoCloseOnMerge = autoClose.control.checked;
    } else {
      delete project.autoCommitTracker;
      delete project.autoCloseOnMerge;
    }
    try {
      const created = await api("/api/projects", { method: "POST", body: project });
      closeModal();
      await loadShell();
      navigate({ kind: "project", name: created.name });
      showToast(`Added ${created.name}`, "success");
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
      back.disabled = false;
    }
  });
  body.append(form);
  syncTrackerLocation();
  syncDuplicateWarning();
  name.focus();
}

function detailSection(label, text) {
  const section = element("section");
  section.append(
    element("div", "section-label", label),
    element("p", "detail-copy", text || `No ${label.toLowerCase()}.`),
  );
  return section;
}

function commentText(comment) {
  if (typeof comment === "string") return comment;
  return comment?.text || comment?.body || comment?.content || "";
}

function openBakeoffConfirmation(project, issue) {
  const body = modalFrame(issue.id, "Run bake-off?");
  body.append(
    element(
      "p",
      "confirm-copy",
      "This runs the ticket twice - two agents, two worktrees, roughly double tokens.",
    ),
  );
  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const cancel = button("Cancel");
  cancel.addEventListener("click", closeModal);
  const run = button("Run bake-off", "button primary");
  run.addEventListener("click", async () => {
    run.disabled = true;
    cancel.disabled = true;
    status.textContent = "Creating two isolated worktrees…";
    try {
      const result = await api("/api/dispatch", {
        method: "POST",
        body: {
          project: project.name,
          ticketId: issue.id,
          lanes: ["claude", "codex"],
        },
      });
      await refreshDispatches();
      closeModal();
      navigate({ kind: "dispatch", id: result.ids?.[0] || result.id });
    } catch (error) {
      if (isDispatchLimitError(error)) {
        openBudgetConfirmation(error, async () => {
          const result = await api("/api/dispatch", {
            method: "POST",
            body: {
              project: project.name,
              ticketId: issue.id,
              lanes: ["claude", "codex"],
              force: true,
            },
          });
          await refreshDispatches();
          navigate({ kind: "dispatch", id: result.ids?.[0] || result.id });
        });
      } else {
        status.textContent = error.message;
        showToast(error.message);
        run.disabled = false;
        cancel.disabled = false;
      }
    }
  });
  const actions = element("div", "modal-actions");
  actions.append(status, cancel, run);
  body.append(actions);
}

function openIssueModal(project, issue, issues) {
  const body = modalFrame(issue.id, issue.title || "Untitled ticket");
  const ticketDispatches = state.dispatches
    .filter((record) => record.project === project.name && record.ticketId === issue.id)
    .sort((left, right) => Date.parse(right.startedAt || "") - Date.parse(left.startedAt || ""));
  const activeDispatch = ticketDispatches.find((record) => ACTIVE_STATES.has(record.state));
  const foreignClaim = Boolean(issue.assignee) && ticketDispatches.length === 0;
  const actions = element("div", "modal-actions");
  actions.append(
    badge(issue.issue_type || "task"),
    badge(`P${issue.priority ?? 4}`, `priority-chip p${issue.priority ?? 4}`),
    badge(issue.status || "unknown"),
  );
  if (issue.assignee) {
    actions.append(element("span", "card-meta", `Assigned to @${issue.assignee}`));
  }

  const actor = document.createElement("input");
  actor.value = storageGet("atelier-actor");
  actor.placeholder = "Actor name";
  actor.setAttribute("aria-label", "Actor name");
  actor.style.width = "min(180px, 100%)";
  const claim = button("Claim", "button compact");
  claim.addEventListener("click", async () => {
    const value = actor.value.trim();
    if (!value) {
      actor.focus();
      return;
    }
    storageSet("atelier-actor", value);
    claim.disabled = true;
    await mutateIssue(project, "claim", { id: issue.id, actor: value }, claim);
  });
  actions.append(actor, claim);
  if (isTriage(issue) && issue.status === "open") {
    const promote = button("Promote", "button compact");
    promote.addEventListener("click", async () => {
      promote.disabled = true;
      await mutateIssue(project, "promote", { id: issue.id }, promote);
    });
    actions.append(promote);
  }
  const commentAction = button("Comment", "button compact");
  if (archetypeLabel(project) !== "tracker-only") {
    const dispatch = button("Dispatch", "button primary compact");
    dispatch.addEventListener("click", () => configureComposer(issue));
    let dispatchReason = "";
    if (activeDispatch) {
      dispatchReason = `Ticket is being worked by dispatch ${activeDispatch.id}.`;
    } else if (foreignClaim) {
      dispatchReason = `Ticket is assigned to @${issue.assignee} with no Atelier dispatch.`;
    }
    if (dispatchReason) {
      dispatch.disabled = true;
      dispatch.title = dispatchReason;
    }
    const bakeoff = button("Bake-off…", "button compact secondary-action");
    bakeoff.addEventListener("click", () => openBakeoffConfirmation(project, issue));
    if (dispatchReason) {
      bakeoff.disabled = true;
      bakeoff.title = dispatchReason;
    }
    actions.append(dispatch, bakeoff);
    if (foreignClaim) {
      const dispatchAnyway = button("Dispatch anyway", "button compact secondary-action");
      dispatchAnyway.addEventListener("click", () => configureComposer(issue));
      actions.append(dispatchAnyway);
    }
  }
  actions.append(commentAction);
  if (issue.status !== "closed") {
    const close = button("Close", "button danger compact");
    close.addEventListener("click", () => {
      const unmergedDispatch = ticketDispatches.find(
        (record) => !record.merged && !record.dismissed,
      );
      openTicketCloseConfirmation(issue, unmergedDispatch, async () => {
        close.disabled = true;
        await mutateIssue(project, "close", { id: issue.id }, close);
      });
    });
    actions.append(close);
  }
  body.append(actions);
  if (activeDispatch || foreignClaim) {
    body.append(
      element(
        "p",
        "dispatch-gate-hint",
        activeDispatch
          ? `Dispatch unavailable: being worked by dispatch ${activeDispatch.id}.`
          : `Dispatch unavailable: assigned to @${issue.assignee} outside Atelier. Use “Dispatch anyway” only after checking the existing claim.`,
      ),
    );
  }
  if (ticketDispatches.length > 0) {
    const dispatchLinks = element("section", "ticket-dispatch-links");
    dispatchLinks.append(element("div", "section-label", "Dispatch history"));
    const list = element("div", "ticket-dispatch-list");
    for (const record of ticketDispatches) {
      const row = element("div", "ticket-dispatch-link-row");
      const link = element("a", "table-link", `View dispatch ${record.id} →`);
      link.href = routeHref({ kind: "dispatch", id: record.id });
      link.addEventListener("click", closeModal);
      row.append(link, stateChip(record.state));
      list.append(row);
    }
    dispatchLinks.append(list);
    body.append(dispatchLinks);
  }
  body.append(
    detailSection("Description", issue.description),
    detailSection("Acceptance criteria", issue.acceptance_criteria),
  );

  const dependencies = element("section");
  dependencies.append(element("div", "section-label", "Dependencies"));
  const dependencyList = element("div", "dependency-list");
  const dependencyItems = issue.dependencies || [];
  if (dependencyItems.length === 0) {
    dependencyList.append(element("div", "empty-state", "No dependencies"));
  } else {
    for (const dependency of dependencyItems) {
      const id = dependencyId(dependency);
      const linked = issues.get(id);
      const status = dependencyStatus(dependency, issues);
      const label = linked?.title ? `${id} - ${linked.title}` : id;
      dependencyList.append(element("div", "dependency", `${label} [${status}]`));
    }
  }
  dependencies.append(dependencyList);
  body.append(dependencies);

  const commentsSection = element("section");
  commentsSection.append(element("div", "section-label", "Comments"));
  const commentsList = element("div", "comments-list");
  const comments = [...(issue.comments || [])].sort((left, right) => {
    const leftTime = Date.parse(left?.created_at || "") || 0;
    const rightTime = Date.parse(right?.created_at || "") || 0;
    return leftTime - rightTime;
  });
  if (comments.length === 0) {
    commentsList.append(element("div", "empty-state", "No comments yet"));
  } else {
    for (const comment of comments) {
      const wrapper = element("article", "comment");
      if (typeof comment === "object") {
        const author = comment.author || comment.created_by || "unknown";
        const date = comment.created_at ? new Date(comment.created_at).toLocaleString() : "";
        wrapper.append(element("div", "comment-meta", `${author}${date ? ` - ${date}` : ""}`));
      }
      const text = commentText(comment);
      wrapper.append(element(/^\s*HANDOFF\b/i.test(text) ? "pre" : "p", "", text));
      commentsList.append(wrapper);
    }
  }
  commentsSection.append(commentsList);
  body.append(commentsSection);

  const commentForm = element("form", "comment-form");
  const comment = document.createElement("textarea");
  comment.name = "text";
  comment.required = true;
  commentAction.addEventListener("click", () => {
    comment.scrollIntoView({ behavior: "smooth", block: "center" });
    comment.focus({ preventScroll: true });
  });
  const commentStatus = element("span", "form-status");
  const submit = button("Post comment", "button primary");
  submit.type = "submit";
  const footer = element("div", "form-footer");
  footer.append(commentStatus, submit);
  commentForm.append(field("Add comment", comment), footer);
  commentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    commentStatus.textContent = "Posting…";
    try {
      await api(`/api/projects/${encoded(project.name)}/comment`, {
        method: "POST",
        body: { id: issue.id, text: comment.value },
      });
      closeModal();
      await renderRoute();
      showToast("Comment posted", "success");
    } catch (error) {
      commentStatus.textContent = error.message;
      submit.disabled = false;
    }
  });
  body.append(commentForm);
}

function openTicketCloseConfirmation(issue, unmergedDispatch, onConfirm) {
  const body = modalFrame("Close ticket", `Close ${issue.id}?`);
  body.append(
    element("p", "confirm-copy", "This marks the tracker ticket as closed."),
  );
  if (unmergedDispatch) {
    body.append(
      banner(
        `Warning: dispatch ${unmergedDispatch.id} has not been merged or dismissed. Closing the ticket will not preserve or merge its work.`,
      ),
    );
  }
  const actions = element("div", "modal-actions");
  const cancel = button("Cancel");
  const confirm = button("Close ticket", "button danger");
  cancel.addEventListener("click", closeModal);
  confirm.addEventListener("click", () => {
    closeModal();
    void onConfirm();
  });
  actions.append(cancel, confirm);
  body.append(actions);
}

async function mutateIssue(project, action, payload, control = undefined) {
  try {
    await api(`/api/projects/${encoded(project.name)}/${action}`, {
      method: "POST",
      body: payload,
    });
    closeModal();
    await renderRoute();
    const messages = {
      claim: "Ticket claimed",
      close: "Ticket closed",
      promote: "Ticket promoted",
    };
    showToast(messages[action] || "Ticket updated", "success");
  } catch (error) {
    showToast(error.message);
    if (control) control.disabled = false;
  }
}

function renderCreatePanel(project) {
  const details = element("details", "create-panel");
  details.append(element("summary", "", "Create ticket"));
  const form = element("form", "create-form");
  const title = document.createElement("input");
  title.name = "title";
  title.required = true;
  const type = document.createElement("select");
  type.name = "type";
  type.append(option("task", "Task", "task"), option("bug", "Bug"), option("chore", "Chore"));
  const priority = document.createElement("select");
  priority.name = "priority";
  for (let value = 0; value <= 4; value += 1) {
    priority.append(option(String(value), `P${value}`, "2"));
  }
  const description = document.createElement("textarea");
  description.name = "desc";
  description.required = true;
  const acceptance = document.createElement("textarea");
  acceptance.name = "ac";
  const status = element("span", "form-status");
  const submit = button("Create ticket", "button primary");
  submit.type = "submit";
  const footer = element("div", "form-footer");
  footer.append(status, submit);
  form.append(
    field("Title", title),
    field("Type", type),
    field("Priority", priority),
    field("Description", description, "field wide"),
    field("Acceptance criteria", acceptance, "field wide"),
    footer,
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "Creating…";
    const values = new FormData(form);
    const body = {
      title: values.get("title"),
      desc: values.get("desc"),
      type: values.get("type"),
      priority: values.get("priority"),
    };
    const ac = String(values.get("ac") || "").trim();
    if (ac) body.ac = ac;
    try {
      const result = await api(`/api/projects/${encoded(project.name)}/create`, {
        method: "POST",
        body,
      });
      showToast(`Created ${result.id}`, "success");
      await renderRoute();
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
  details.append(form);
  return details;
}

function renderTicketCreationControl(project, payload) {
  const creation = ticketCreationState(payload);
  if (creation.available) return renderCreatePanel(project);
  const unavailable = element("section", "git-state-card tracker-unavailable-card");
  unavailable.append(
    element("h2", "", creation.label),
    element("p", "", creation.detail),
  );
  return unavailable;
}

function checkboxSetting(label, checked, { disabled = false, hint = "" } = {}) {
  const wrapper = element("label", "checkbox-setting");
  const control = document.createElement("input");
  control.type = "checkbox";
  control.checked = checked;
  control.disabled = disabled;
  const copy = element("span", "checkbox-setting-copy");
  copy.append(element("strong", "", label));
  if (hint) copy.append(element("small", "field-hint", hint));
  wrapper.append(control, copy);
  if (disabled) wrapper.title = hint;
  return { wrapper, control };
}

function renderProjectSettings(project, agentList, initialQueue) {
  const stack = element("div", "project-settings-stack");
  const form = element("form", "project-settings-form panel");
  form.append(element("h2", "", "Project settings"));

  const name = document.createElement("input");
  name.value = project.name;
  name.readOnly = true;
  const path = document.createElement("input");
  path.value = project.path;
  path.readOnly = true;
  const trackerLocation = document.createElement("input");
  trackerLocation.value = trackerLabel(project) === "none"
    ? "No tracker configured"
    : project.trackerPath || project.path;
  trackerLocation.readOnly = true;
  const moveTracker = button("Move tracker");
  const trackerMoveAvailable =
    archetypeLabel(project) === "full" && trackerLabel(project) !== "none";
  moveTracker.disabled = !trackerMoveAvailable;
  moveTracker.dataset.to = hasExternalTracker(project) ? "in-repo" : "external";
  moveTracker.title = trackerMoveAvailable
    ? hasExternalTracker(project)
      ? "Move this tracker inside the repository"
      : "Move this tracker into Atelier-managed state"
    : "Move tracker is available for full projects with a tracker.";
  moveTracker.addEventListener("click", () => openMoveTrackerConfirmation(project));
  const trackerLocationSetting = element("section", "tracker-location-setting");
  const trackerLocationRow = element("div", "tracker-location-row");
  trackerLocationRow.append(trackerLocation, moveTracker);
  trackerLocationSetting.append(
    element("span", "section-label", "Tracker location"),
    trackerLocationRow,
    element(
      "small",
      "field-hint",
      hasExternalTracker(project)
        ? "Atelier-managed: nothing added to the repo; this machine only."
        : trackerLabel(project) === "none"
          ? "This project has no tracker."
          : "Inside the repository: syncs via git and is visible in the repo.",
    ),
  );
  const trackerMoveNote = state.trackerMoveNotes.get(project.name);
  if (trackerMoveNote) {
    const note = element("p", "tracker-move-next-steps", trackerMoveNote);
    note.setAttribute("role", "status");
    trackerLocationSetting.append(note);
  }
  const archetype = document.createElement("input");
  archetype.value = archetypeLabel(project);
  archetype.readOnly = true;

  const notes = document.createElement("textarea");
  notes.value = project.notes || "";
  notes.placeholder = "Human context shown in the project header";
  const verifyCommands = document.createElement("textarea");
  verifyCommands.value = (project.verifyCommands || []).join("\n");
  verifyCommands.placeholder = "One command per line";
  const warn = document.createElement("textarea");
  warn.value = project.warn || "";
  warn.placeholder = "Commands or actions agents must avoid";

  const profile = { ...(project.dispatchProfile || {}) };
  const selectedAgentId = settingsAgentId(project, agentList);
  const agent = document.createElement("select");
  agent.append(
    ...agentList.map((candidate) =>
      option(candidate.id, candidate.displayName, selectedAgentId)),
  );

  const model = document.createElement("select");
  const currentModel = profile.model || profile.defaultModel || "";
  const effort = document.createElement("select");
  const modelHint = "Options come from the selected agent adapter.";
  const effortHint = "Options come from the selected agent adapter.";
  const syncSettingsAgentOptions = () => {
    const selectedAgent = agentList.find((candidate) => candidate.id === agent.value);
    const models = Array.isArray(selectedAgent?.options?.models)
      ? selectedAgent.options.models
      : [];
    const efforts = Array.isArray(selectedAgent?.options?.efforts)
      ? selectedAgent.options.efforts
      : [];
    const selectedModel = models.some(({ value }) => value === currentModel)
      ? currentModel
      : "";
    const selectedEffort = efforts.some(({ value }) => value === profile.effort)
      ? profile.effort
      : "";
    model.replaceChildren(
      option("", "Inherit default", selectedModel),
      ...models.map(({ value, label }) => option(value, label, selectedModel)),
    );
    effort.replaceChildren(
      option("", "Inherit default", selectedEffort),
      ...efforts.map(({ value, label }) => option(value, label, selectedEffort)),
    );
    model.disabled = models.length === 0;
    effort.disabled = efforts.length === 0;
    model.title = model.disabled
      ? `Model for ${selectedAgent?.displayName || agent.value} is configured outside Atelier.`
      : "";
    effort.title = effort.disabled
      ? `Reasoning effort for ${selectedAgent?.displayName || agent.value} is configured outside Atelier.`
      : "";
  };
  agent.addEventListener("change", syncSettingsAgentOptions);
  syncSettingsAgentOptions();

  const maxTurns = document.createElement("input");
  maxTurns.type = "number";
  maxTurns.min = "1";
  maxTurns.step = "1";
  maxTurns.placeholder = "Inherit default";
  maxTurns.value = profile.maxTurns ? String(profile.maxTurns) : "";

  const confinement = document.createElement("select");
  const selectedConfinement = project.trustProfile?.confinement || "trusted-local";
  confinement.replaceChildren(
    option("trusted-local", "Trusted local — no isolation", selectedConfinement),
    option("sandboxed-write", "Sandboxed — worktree writable", selectedConfinement),
    option("sandboxed-review-readonly", "Sandboxed — read-only", selectedConfinement),
    option("advisory", "Advisory — non-enforcing", selectedConfinement),
  );
  const credential = document.createElement("select");
  const selectedCredential = project.trustProfile?.credential || "none";
  credential.replaceChildren(
    option("none", "None", selectedCredential),
    option("brokered", "Brokered", selectedCredential),
    option("in-sandbox", "In sandbox", selectedCredential),
  );
  const sandboxBackend = document.createElement("select");
  const selectedSandboxBackend = project.sandboxBackend || "bwrap";
  sandboxBackend.replaceChildren(
    option("bwrap", "Bubblewrap", selectedSandboxBackend),
    option("podman", "Podman (wrap unavailable)", selectedSandboxBackend),
  );

  const dailyBudget = document.createElement("input");
  dailyBudget.type = "number";
  dailyBudget.min = "0.01";
  dailyBudget.step = "0.01";
  dailyBudget.placeholder = "No daily limit";
  dailyBudget.value = project.budgetUSDPerDay
    ? String(project.budgetUSDPerDay)
    : "";

  const queueFailureLimit = document.createElement("input");
  queueFailureLimit.type = "number";
  queueFailureLimit.min = "1";
  queueFailureLimit.step = "1";
  queueFailureLimit.placeholder = "Inherit default (2)";
  queueFailureLimit.value = project.queueFailureLimit
    ? String(project.queueFailureLimit)
    : "";
  const maxFixRounds = document.createElement("input");
  maxFixRounds.type = "number";
  maxFixRounds.min = "1";
  maxFixRounds.step = "1";
  maxFixRounds.value = String(project.maxFixRounds || 4);
  let maxFixRoundsEdited = false;
  maxFixRounds.addEventListener("input", () => {
    maxFixRoundsEdited = true;
  });

  const unpricedDispatchCap = document.createElement("input");
  unpricedDispatchCap.type = "number";
  unpricedDispatchCap.min = "1";
  unpricedDispatchCap.step = "1";
  unpricedDispatchCap.placeholder = "No daily limit";
  unpricedDispatchCap.value = project.unpricedDispatchCapPerDay
    ? String(project.unpricedDispatchCapPerDay)
    : "";

  const automationAvailable =
    trackerLabel(project) !== "none" && Boolean(project.capabilities?.git?.isRepo);
  const automationHint = automationAvailable
    ? "Applied when the configured tracker directory is inside a Git checkout."
    : "Tracker automation requires a tracker in a Git checkout.";
  const autoCommit = checkboxSetting("Auto-commit tracker changes", Boolean(project.autoCommitTracker), {
    disabled: !automationAvailable,
    hint: automationHint,
  });
  const autoClose = checkboxSetting("Auto-close tickets on merge", Boolean(project.autoCloseOnMerge), {
    disabled: !automationAvailable,
    hint: automationAvailable
      ? "Close a ticket after its dispatch is merged."
      : automationHint,
  });
  const requireReview = checkboxSetting(
    "Require passing spec review before merge",
    Boolean(project.requireReview),
    { hint: "Adds a read-only spec-audit gate after verification." },
  );
  const legacyCodexCompanion = checkboxSetting(
    "Use deprecated Codex companion adapter",
    Boolean(project.legacyCodexCompanion),
    { hint: "Compatibility only. New Codex dispatches use the supported app-server adapter." },
  );
  const reviewPolicy = document.createElement("select");
  reviewPolicy.name = "reviewPolicy";
  const selectedReviewPolicy = project.reviewPolicy || "strict";
  reviewPolicy.replaceChildren(
    option("strict", "Strict — any open finding gates", selectedReviewPolicy),
    option("tiered", "Tiered — blocker/major gate", selectedReviewPolicy),
    option("advisory", "Advisory — report only", selectedReviewPolicy),
  );

  const automation = element("div", "settings-automation field wide");
  automation.append(
    element("span", "section-label", "Merge safety and tracker automation"),
    requireReview.wrapper,
    field("Review finding policy", reviewPolicy, "field", "BLOCKER always requires force."),
    autoCommit.wrapper,
    autoClose.wrapper,
  );
  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  const save = button("Save settings", "button primary");
  save.type = "submit";
  const footer = element("div", "form-footer");
  footer.append(status, save);

  form.append(
    field("Name", name),
    field("Path", path, "field wide"),
    trackerLocationSetting,
    field("Archetype", archetype),
    field("Notes", notes, "field wide"),
    field("Verification commands", verifyCommands, "field wide", "One command per line."),
    field("Agent warning", warn, "field wide"),
    field("Agent", agent, "field", "Used when a dispatch does not select an agent explicitly."),
    field("Model", model, "field", modelHint),
    field("Effort", effort, "field", effortHint),
    field("Max turns", maxTurns, "field", "Leave blank to inherit the Atelier default."),
    field(
      "Execution confinement",
      confinement,
      "field",
      "Trusted-local and advisory do not provide an isolation boundary.",
    ),
    field("Credential containment", credential),
    field("Sandbox backend", sandboxBackend),
    field(
      "Daily budget (USD)",
      dailyBudget,
      "field",
      "Leave blank to disable the daily cost ceiling.",
    ),
    field(
      "Queue failure limit",
      queueFailureLimit,
      "field",
      "Park a queue ticket after this many failed attempts; blank inherits 2.",
    ),
    field(
      "Maximum review fix rounds",
      maxFixRounds,
      "field",
      "Hard backstop for one review thread; defaults to 4.",
    ),
    field(
      "Unpriced dispatch cap/day",
      unpricedDispatchCap,
      "field",
      "Caps new dispatches on lanes that do not report trustworthy cost data.",
    ),
    legacyCodexCompanion.wrapper,
    automation,
    footer,
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    save.textContent = "Saving…";
    status.textContent = "Writing registry atomically…";
    const dispatchProfile = { ...profile };
    delete dispatchProfile.lane;
    delete dispatchProfile.agent;
    if (!model.disabled) {
      delete dispatchProfile.defaultModel;
      if (model.value) dispatchProfile.model = model.value;
      else delete dispatchProfile.model;
    }
    if (!effort.disabled) {
      if (effort.value) dispatchProfile.effort = effort.value;
      else delete dispatchProfile.effort;
    }
    if (maxTurns.value) dispatchProfile.maxTurns = Number(maxTurns.value);
    else delete dispatchProfile.maxTurns;
    const body = {
      notes: notes.value.trim(),
      verifyCommands: verifyCommands.value
        .split(/\r?\n/)
        .map((command) => command.trim())
        .filter(Boolean),
      warn: warn.value.trim(),
      defaultAgent: agent.value,
      dispatchProfile,
      budgetUSDPerDay: dailyBudget.value ? Number(dailyBudget.value) : null,
      queueFailureLimit: queueFailureLimit.value ? Number(queueFailureLimit.value) : null,
      unpricedDispatchCapPerDay: unpricedDispatchCap.value
        ? Number(unpricedDispatchCap.value)
        : null,
      requireReview: requireReview.control.checked,
      reviewPolicy: reviewPolicy.value,
      legacyCodexCompanion: legacyCodexCompanion.control.checked,
      trustProfile: {
        confinement: confinement.value,
        credential: credential.value,
      },
      sandboxBackend: sandboxBackend.value,
    };
    if (maxFixRoundsEdited) body.maxFixRounds = Number(maxFixRounds.value);
    if (automationAvailable) {
      body.autoCommitTracker = autoCommit.control.checked;
      body.autoCloseOnMerge = autoClose.control.checked;
    }
    try {
      const updated = await api(`/api/projects/${encoded(project.name)}`, {
        method: "PATCH",
        body,
      });
      if (!Object.hasOwn(updated, "budgetUSDPerDay")) delete project.budgetUSDPerDay;
      if (!Object.hasOwn(updated, "queueFailureLimit")) delete project.queueFailureLimit;
      if (!Object.hasOwn(updated, "unpricedDispatchCapPerDay")) {
        delete project.unpricedDispatchCapPerDay;
      }
      Object.assign(project, updated);
      status.textContent = "Saved.";
      showToast(`Saved ${project.name} settings`, "success");
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message);
    } finally {
      save.disabled = false;
      save.textContent = "Save settings";
    }
  });

  stack.append(form);
  if (initialQueue) stack.append(renderQueueCard(project, initialQueue));
  return stack;
}

function openConvoyModal(project, readyIssues) {
  const body = modalFrame("Sequential batch", `Start convoy in ${project.name}`, "convoy");
  body.append(
    element(
      "p",
      "confirm-copy",
      "Select 2-20 ready tickets and arrange their exact dispatch order. Each ticket starts only after the previous dispatch is merged.",
    ),
  );
  const list = element("div", "convoy-ticket-picker");
  const rowsById = new Map();
  for (const issue of readyIssues) {
    const row = element("div", "convoy-ticket-option");
    row.dataset.ticketId = issue.id;
    const selection = document.createElement("input");
    selection.type = "checkbox";
    selection.setAttribute("aria-label", `Select ${issue.id}`);
    const copy = element("span", "convoy-ticket-copy");
    copy.append(
      element("strong", "", issue.id),
      element("span", "", issue.title || "Untitled ticket"),
    );
    const readiness = element("span", "convoy-ticket-readiness");
    readiness.hidden = true;
    copy.append(readiness);
    const up = button("↑", "icon-button compact");
    up.setAttribute("aria-label", `Move ${issue.id} earlier`);
    const down = button("↓", "icon-button compact");
    down.setAttribute("aria-label", `Move ${issue.id} later`);
    up.addEventListener("click", () => {
      const previous = row.previousElementSibling;
      if (previous) list.insertBefore(row, previous);
    });
    down.addEventListener("click", () => {
      const next = row.nextElementSibling;
      if (next) list.insertBefore(next, row);
    });
    row.append(selection, copy, up, down);
    list.append(row);
    rowsById.set(issue.id, { row, selection, up, down, readiness });
  }
  body.append(list);
  const status = element("span", "form-status");
  status.setAttribute("aria-live", "polite");
  let submitting = false;
  const cancel = button("Cancel");
  cancel.addEventListener("click", closeModal);
  const start = button("Start convoy", "button primary");
  const selectedIds = () => [...list.children]
    .filter((row) => {
      const selection = row.querySelector("input");
      return selection.checked && !selection.disabled;
    })
    .map((row) => row.dataset.ticketId);
  const sync = () => {
    const count = selectedIds().length;
    start.disabled = submitting || count < 2 || count > 20;
    status.textContent = `${count} selected`;
  };
  const refreshEligibility = (nextReadyIssues) => {
    if (
      !modal.open ||
      modal.dataset.kind !== "convoy" ||
      !modalContent.contains(body)
    ) {
      return false;
    }
    for (const { ticketId, ready } of convoyPickerProjection(
      [...rowsById.keys()],
      nextReadyIssues,
    )) {
      const controls = rowsById.get(ticketId);
      controls.row.classList.toggle("unavailable", !ready);
      controls.row.setAttribute("aria-disabled", String(!ready));
      controls.selection.disabled = !ready;
      if (!ready) controls.selection.checked = false;
      controls.up.disabled = !ready;
      controls.down.disabled = !ready;
      controls.readiness.hidden = ready;
      controls.readiness.textContent = ready ? "" : "No longer ready";
    }
    sync();
    return true;
  };
  list.addEventListener("change", sync);
  start.addEventListener("click", async () => {
    const ticketIds = selectedIds();
    if (ticketIds.length < 2) return;
    submitting = true;
    sync();
    cancel.disabled = true;
    status.textContent = "Starting first convoy member…";
    try {
      await api(`/api/projects/${encoded(project.name)}/convoy`, {
        method: "POST",
        body: { ticketIds },
      });
      closeModal();
      showToast("Convoy started", "success");
      await renderRoute();
    } catch (error) {
      status.textContent = error.message;
      showToast(error.message);
      submitting = false;
      cancel.disabled = false;
      sync();
    }
  });
  const actions = element("div", "modal-actions");
  actions.append(status, cancel, start);
  body.append(actions);
  refreshEligibility(readyIssues);
  return refreshEligibility;
}

function renderConvoyProgress(container, convoys, onChange) {
  container.replaceChildren();
  for (const convoy of convoys) {
    const strip = element("article", `convoy-strip convoy-${convoy.state}`);
    const total = convoy.ticketIds.length;
    const position = convoy.state === "completed"
      ? total
      : Math.min(total, convoy.cursor + 1);
    const identity = element("div", "convoy-identity");
    identity.append(
      badge("convoy", "convoy"),
      element("strong", "", `${position}/${total}`),
      element("span", "", convoy.ticketIds[convoy.cursor] || "Complete"),
    );
    const status = element("div", "convoy-progress-status");
    status.append(stateChip(convoy.state));
    if (convoy.currentDispatchId) {
      const link = element("a", "table-link", `Dispatch ${convoy.currentDispatchId} →`);
      link.href = routeHref({ kind: "dispatch", id: convoy.currentDispatchId });
      status.append(link);
    }
    if (convoy.reason) status.append(element("span", "convoy-reason", convoy.reason));
    const actions = element("div", "convoy-actions");
    if (convoy.state === "paused") {
      const resume = button("Resume", "button compact");
      resume.addEventListener("click", async () => {
        resume.disabled = true;
        try {
          await api(`/api/convoys/${encoded(convoy.id)}/resume`, {
            method: "POST",
            body: {},
          });
          await onChange();
        } catch (error) {
          showToast(error.message);
          resume.disabled = false;
        }
      });
      actions.append(resume);
    }
    if (["running", "paused"].includes(convoy.state)) {
      const cancel = button("Cancel", "button compact");
      cancel.addEventListener("click", async () => {
        cancel.disabled = true;
        try {
          await api(`/api/convoys/${encoded(convoy.id)}/cancel`, {
            method: "POST",
            body: {},
          });
          await onChange();
        } catch (error) {
          showToast(error.message);
          cancel.disabled = false;
        }
      });
      actions.append(cancel);
    }
    strip.append(identity, status, actions);
    container.append(strip);
  }
}

async function renderProject(route, token) {
  const project = projectByName(route.name);
  if (!project) {
    renderNotFound(`Unknown project: ${route.name}`);
    return;
  }
  storageSet("atelier-last-project", project.name);
  const archetype = archetypeLabel(project);
  const [refreshedPayload, queue, agentList, initialConvoys] = await Promise.all([
    refreshBoardPayload(project.name, { render: false, required: true }),
    archetype === "full"
      ? api(`/api/projects/${encoded(project.name)}/queue`)
      : Promise.resolve(undefined),
    loadAgents(),
    api("/api/convoys"),
    refreshDispatches(),
  ]);
  if (!viewIsCurrent(token)) return;
  const payload = refreshedPayload ?? state.boardPayloads.get(project.name);
  if (!payload) return;
  app.classList.add("project-view");

  const tracker = payload.tracker || trackerLabel(project);
  let parkedTickets = Array.isArray(queue?.parkedTickets) ? queue.parkedTickets : [];
  const chip = archetypeBadge(project, { expanded: true });
  const refresh = button("Refresh");
  refresh.addEventListener("click", () => void renderRoute());
  const headerActions = [];
  if (state.editorConfigured) {
    headerActions.push(openEditorButton(`/api/projects/${encoded(project.name)}/open-editor`));
  }
  headerActions.push(refresh);
  const fragment = document.createDocumentFragment();
  fragment.append(
    viewHeader({
      eyebrow: "Project",
      title: project.name,
      description: project.notes || project.path,
      chip,
      actions: headerActions,
    }),
  );
  if (archetype !== "tracker-only") fragment.append(projectFacts(project, queue));

  const banners = element("div", "banner-stack");
  const mainHealthBanner = element("div", "main-health-banner-slot");
  if (project.warn) banners.append(banner(`Project warning: ${project.warn}`));
  const dirty = Number(project.capabilities?.git?.dirtyCount || 0);
  if (dirty > 0) {
    banners.append(
      banner(
        `${dirty} uncommitted primary change${dirty === 1 ? " is" : "s are"} invisible to new dispatch worktrees.`,
      ),
    );
  }
  banners.append(mainHealthBanner);
  const syncMainHealthBanner = () => {
    renderProjectMainHealth(mainHealthBanner, project, state.dispatches, {
      dispatchHref: (id) => routeHref({ kind: "dispatch", id }),
      async acknowledge(record) {
        try {
          const updated = await api(`/api/dispatch/${encoded(record.id)}/ack-main-health`, {
            method: "POST",
            body: {},
          });
          const index = state.dispatches.findIndex((candidate) => candidate.id === record.id);
          if (index >= 0) state.dispatches[index] = updated;
          syncMainHealthBanner();
          showToast(`Acknowledged main failure from ${record.id}`, "success");
        } catch (error) {
          showToast(error.message);
          throw error;
        }
      },
    });
    banners.hidden = banners.childElementCount === 1 && !mainHealthBanner.firstElementChild;
  };
  syncMainHealthBanner();
  fragment.append(banners);

  const boardPanel = element("section", "tab-panel project-tab-panel board-tab-panel");
  boardPanel.id = "project-board-panel";
  const controls = element("section", "project-controls");
  let boardRegion;
  if (archetype === "tracker-only") {
    const projection = boardProjection(payload);
    controls.append(renderTicketCreationControl(project, payload));
    boardRegion = renderBoard(project, projection.issues, undefined, {
      readyIssues: projection.readyIssues,
      readyDegraded: projection.readyDegraded,
      parkedTickets,
    });
    boardPanel.append(controls, boardRegion);
  } else if (archetype === "git-only") {
    const gitCard = element("section", "git-state-card");
    gitCard.append(
      element("h2", "", "Git-only project"),
      element("p", "", "No tracker configured. Board panels are unavailable."),
      projectFacts(project),
    );
    controls.append(renderComposer(project, agentList, undefined, true));
    boardPanel.append(controls, gitCard);
  } else {
    const projection = boardProjection(payload);
    controls.append(
      renderComposer(project, agentList),
      renderTicketCreationControl(project, payload),
    );
    boardRegion = renderBoard(project, projection.issues, undefined, {
      readyIssues: projection.readyIssues,
      readyDegraded: projection.readyDegraded,
      parkedTickets,
    });
    boardPanel.append(controls, boardRegion);
  }

  let readyForConvoy = readyIssuesFrom(payload);
  let startConvoy;
  let refreshOpenConvoyEligibility;
  const syncConvoyEligibility = () => {
    if (!startConvoy) return;
    const eligibility = convoyEligibility(readyForConvoy, {
      full: archetype === "full",
    });
    startConvoy.disabled = eligibility.disabled;
    startConvoy.title = eligibility.title;
  };
  const replaceBoard = (nextPayload) => {
    if (!boardRegion || !nextPayload) return;
    parkedTickets = parkedTicketsFrom(nextPayload, parkedTickets);
    replaceReadyConsumers(nextPayload, {
      replaceBoard(nextBoardPayload, nextReadyIssues) {
        const saved = captureBoardView(boardRegion);
        const projection = boardProjection(nextBoardPayload);
        const replacement = renderBoard(project, projection.issues, undefined, {
          filterText: saved.filterText,
          readyIssues: nextReadyIssues,
          readyDegraded: projection.readyDegraded,
          parkedTickets,
        });
        boardRegion._atelierCleanup?.();
        boardRegion.replaceWith(replacement);
        boardRegion = replacement;
        restoreBoardView(boardRegion, saved);
      },
      replaceConvoyEligibility(nextReadyIssues) {
        readyForConvoy = nextReadyIssues;
        syncConvoyEligibility();
        if (
          refreshOpenConvoyEligibility &&
          !refreshOpenConvoyEligibility(nextReadyIssues)
        ) {
          refreshOpenConvoyEligibility = undefined;
        }
      },
    });
  };

  const dispatchesPanel = element(
    "section",
    "tab-panel project-tab-panel project-dispatches-panel",
  );
  dispatchesPanel.id = "project-dispatches-panel";
  dispatchesPanel.hidden = true;
  const dispatchesHeader = element("div", "project-tab-heading");
  dispatchesHeader.append(
    element("div", "section-label", "Project dispatches"),
  );
  const connection = element("span", "connection-state", "Connecting live updates…");
  startConvoy = button("Start convoy", "button compact");
  syncConvoyEligibility();
  startConvoy.addEventListener("click", () => {
    refreshOpenConvoyEligibility = openConvoyModal(project, readyForConvoy);
  });
  dispatchesHeader.append(startConvoy, connection);
  let projectConvoys = (initialConvoys || []).filter(
    (convoy) => convoy.project === project.name,
  );
  const convoyContainer = element("section", "convoy-progress-list");
  const refreshConvoys = async () => {
    projectConvoys = (await api("/api/convoys")).filter(
      (convoy) => convoy.project === project.name,
    );
    renderConvoyProgress(convoyContainer, projectConvoys, refreshConvoys);
  };
  renderConvoyProgress(convoyContainer, projectConvoys, refreshConvoys);
  const dispatchesContainer = element("section");
  dispatchesPanel.append(dispatchesHeader, convoyContainer, dispatchesContainer);
  const projectDispatches = () =>
    state.dispatches.filter((record) => record.project === project.name);
  renderDispatchRows(dispatchesContainer, projectDispatches());

  const settingsPanel = element(
    "section",
    "tab-panel project-tab-panel project-settings-panel",
  );
  settingsPanel.id = "project-settings-panel";
  settingsPanel.hidden = true;
  settingsPanel.append(renderProjectSettings(project, agentList, queue));

  const tabs = element("div", "tabs project-tabs");
  const tabList = element("nav", "tab-list");
  tabList.setAttribute("aria-label", "Project sections");
  tabList.setAttribute("role", "tablist");
  const panels = new Map([
    ["board", boardPanel],
    ["dispatches", dispatchesPanel],
    ["settings", settingsPanel],
  ]);
  const tabButtons = new Map();
  for (const [name, label] of [
    ["board", "Board"],
    ["dispatches", "Dispatches"],
    ["settings", "Settings"],
  ]) {
    const tab = button(label, `tab${name === "board" ? " active" : ""}`);
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(name === "board"));
    tab.setAttribute("aria-controls", panels.get(name).id);
    tab.addEventListener("click", () => {
      for (const [candidate, panel] of panels) {
        const active = candidate === name;
        panel.hidden = !active;
        tabButtons.get(candidate).classList.toggle("active", active);
        tabButtons.get(candidate).setAttribute("aria-selected", String(active));
      }
      if (name === "board") {
        void refreshBoardPayload(project.name).then((nextPayload) => replaceBoard(nextPayload));
      }
      if (name === "dispatches") refreshElapsedCells(dispatchesContainer);
    });
    tabButtons.set(name, tab);
    tabList.append(tab);
  }
  tabs.append(tabList, element("span", "timestamp", `Updated ${formatDate(payload.generatedAt)}`));
  fragment.append(tabs, boardPanel, dispatchesPanel, settingsPanel);
  app.replaceChildren(fragment);
  app.focus({ preventScroll: true });

  const elapsedTimer = window.setInterval(
    () => refreshElapsedCells(dispatchesContainer),
    1_000,
  );
  registerCleanup(() => window.clearInterval(elapsedTimer));
  const boardEventHandler = (event, nextPayload) => {
    if (event.project !== project.name) return;
    replaceBoard(nextPayload);
  };
  state.boardEventHandler = boardEventHandler;
  registerCleanup(() => {
    if (state.boardEventHandler === boardEventHandler) state.boardEventHandler = null;
  });
  sseManager.open(
    `project:${project.name}`,
    "/api/dispatches/events",
    ["status", "usage", "exit", "review", "review-disposition", "post-merge"],
    {
      open() {
        connection.replaceChildren(element("span", "running-pulse"), document.createTextNode("Live"));
      },
      error() {
        connection.textContent = "Reconnecting…";
      },
      async event(event) {
        if (!viewIsCurrent(token)) return;
        const eventRecord = state.dispatches.find((record) => record.id === event.dispatchId);
        void notifyTerminalDispatch(event, eventRecord);
        void notifyPostMergeFailure(event, eventRecord);
        if (!mergeDispatchEvent(event) || (event.type === "status" && event.detail?.startsWith("merged "))) {
          await refreshDispatches().catch(() => {});
        }
        syncMainHealthBanner();
        renderSidebar();
        renderDispatchRows(dispatchesContainer, projectDispatches());
        if (event.type === "status") await refreshConvoys().catch(() => {});
      },
    },
  );
}

function dispatchTableCell(label, text, className = "") {
  const cell = element("td", className, text);
  cell.dataset.label = label;
  return cell;
}

function dispatchPromptLabel(record) {
  if (record.ticketId) return { text: record.ticketId, muted: false };
  return { text: dispatchPromptPreview(record), muted: true };
}

function dispatchPromptPreview(record) {
  if (record.promptPreview) return String(record.promptPreview).slice(0, 80);
  const branch = String(record.branch || "").replace(/^atelier\//, "");
  const suffix = `-${String(record.id || "")}`;
  const slug = branch.endsWith(suffix) ? branch.slice(0, -suffix.length) : branch;
  return (slug ? slug.replaceAll("-", " ") : "Prompt unavailable").slice(0, 80);
}

function refreshElapsedCells(container) {
  for (const cell of container.querySelectorAll("[data-started-at]")) {
    cell.textContent = elapsedBetween(cell.dataset.startedAt, cell.dataset.endedAt || undefined);
  }
}

function renderDispatchRows(
  container,
  records,
  emptyMessage = "No dispatches yet - open a project and press New dispatch.",
) {
  container.replaceChildren();
  if (records.length === 0) {
    container.append(
      element(
        "div",
        "empty-state dispatches-empty",
        emptyMessage,
      ),
    );
    return;
  }
  const wrap = element("div", "table-wrap");
  const table = element("table", "data-table dispatch-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const label of [
    "Project",
    "Ticket",
    "State",
    "Model",
    "Agent",
    "Started",
    "Elapsed",
    "Turns",
    "Cost",
    "",
  ]) {
    headRow.append(element("th", "", label));
  }
  head.append(headRow);
  const body = element("tbody");
  const groupedRecords = [];
  const groupedBakeoffs = new Set();
  for (const record of records) {
    if (record.batchKind !== "bakeoff" || !record.batchId) {
      groupedRecords.push(record);
      continue;
    }
    if (groupedBakeoffs.has(record.batchId)) continue;
    groupedBakeoffs.add(record.batchId);
    groupedRecords.push(
      ...records.filter(
        (candidate) =>
          candidate.batchKind === "bakeoff" && candidate.batchId === record.batchId,
      ),
    );
  }
  for (const [recordIndex, record] of groupedRecords.entries()) {
    const bakeoff = record.batchKind === "bakeoff" && Boolean(record.batchId);
    const previous = groupedRecords[recordIndex - 1];
    const next = groupedRecords[recordIndex + 1];
    const row = element(
      "tr",
      bakeoff
        ? `bakeoff-row${previous?.batchId === record.batchId ? "" : " bakeoff-group-start"}${next?.batchId === record.batchId ? "" : " bakeoff-group-end"}`
        : "",
    );
    row.tabIndex = 0;
    row.setAttribute("role", "link");
    row.setAttribute("aria-label", `Open dispatch ${record.id}`);
    const projectCell = dispatchTableCell("Project", "", "dispatch-project-cell");
    const link = element("a", "table-link", record.project || "Unknown project");
    link.href = routeHref({ kind: "dispatch", id: record.id });
    projectCell.append(link);
    if (record.projectRemoved) projectCell.append(badge("project removed", "project-removed"));
    const ticket = dispatchPromptLabel(record);
    const ticketCell = dispatchTableCell(
      "Ticket",
      ticket.text,
      `dispatch-ticket-cell${ticket.muted ? " muted" : ""}`,
    );
    const stateCell = dispatchTableCell("State", "", "dispatch-state-cell");
    stateCell.append(stateChip(record.state));
    if (record.batchKind === "convoy") {
      stateCell.append(badge(`convoy ${record.batchSeq}`, "convoy"));
    }
    if (bakeoff) {
      stateCell.append(
        badge(`bake-off ${String(record.batchId).replace(/^bakeoff-/, "").slice(0, 8)}`, "bakeoff"),
      );
    }
    if (record.merged) {
      stateCell.append(badge(
        record.merged.forcedBy ? "force-merged" : "merged",
        record.merged.forcedBy ? "force-merged" : "merged",
      ));
    }
    if (record.dismissed) stateCell.append(badge("dismissed", "dismissed"));
    if (record.reviewOf) stateCell.append(badge("read-only review", "review-audit"));
    const current = currentReview(record.review);
    if (current?.verdict) {
      const stale = reviewIsStale(record.review, record.branchHead);
      stateCell.append(badge(
        stale ? "review stale - re-review required" : `review ${current.verdict}`,
        stale ? "review-stale review-error" : `review-${current.verdict}`,
      ));
    }
    const model = `${record.model || "—"}${record.effort ? ` · ${record.effort}` : ""}`;
    // lastActivityAt, not record.endedAt: a re-verified dispatch has newer work
    // than its agent run's end (atelier-9dt).
    const activityEndedAt = lastActivityAt(record);
    const elapsedCell = dispatchTableCell(
      "Elapsed",
      elapsedBetween(record.startedAt, activityEndedAt),
      "dispatch-elapsed-cell",
    );
    elapsedCell.dataset.startedAt = record.startedAt || "";
    if (activityEndedAt) elapsedCell.dataset.endedAt = activityEndedAt;
    row.append(
      projectCell,
      ticketCell,
      stateCell,
      dispatchTableCell("Model", model, "dispatch-model-cell"),
      dispatchTableCell("Agent", record.lane || "—", "dispatch-lane-cell"),
      dispatchTableCell("Started", formatDate(record.startedAt), "dispatch-started-cell"),
      elapsedCell,
      dispatchTableCell("Turns", String(record.turns || 0), "dispatch-turns-cell"),
      dispatchTableCell("Cost", formatMoney(record.costUSD), "dispatch-cost-cell"),
      dispatchTableCell("", "›", "dispatch-chevron-cell"),
    );
    row.addEventListener("click", (event) => {
      if (event.target.closest("a, button")) return;
      navigate({ kind: "dispatch", id: record.id });
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigate({ kind: "dispatch", id: record.id });
    });
    body.append(row);
  }
  table.append(head, body);
  wrap.append(table);
  container.append(wrap);
}

function mergeDispatchEvent(event) {
  let record = state.dispatches.find((candidate) => candidate.id === event.dispatchId);
  if (!record) return false;
  if (Array.isArray(event.gates)) record.gates = event.gates;
  if (event.type === "status") {
    record.state = event.state || record.state;
    if (event.model) record.model = event.model;
  }
  if (event.type === "usage") {
    record.turns = event.turns;
    record.costUSD = event.costUSD;
  }
  if (event.type === "exit") record.exitSummary = event.summary || record.exitSummary;
  if (event.type === "review") {
    applyReviewEvent(record, event);
    if (event.branchHead) record.branchHead = event.branchHead;
  }
  if (event.type === "review-disposition") {
    applyReviewDispositionEvent(record, event);
  }
  if (event.type === "post-merge") {
    applyPostMergeEvent(record, event);
  }
  return true;
}

function applyPostMergeEvent(record, event) {
  record.postMerge = {
    ...(record.postMerge || {}),
    state: event.state || record.postMerge?.state,
    commit: event.commit || record.postMerge?.commit,
    mergeCommit: event.mergeCommit || record.postMerge?.mergeCommit,
    queuedAt: event.queuedAt || record.postMerge?.queuedAt,
    startedAt: event.startedAt || record.postMerge?.startedAt,
    endedAt: event.endedAt || record.postMerge?.endedAt || null,
    steps: event.steps || record.postMerge?.steps || [],
    testedTree: event.testedTree || record.postMerge?.testedTree,
    evidenceTail: event.evidenceTail || record.postMerge?.evidenceTail || "",
    acknowledgedAt: event.acknowledgedAt || record.postMerge?.acknowledgedAt || null,
    resolvedAt: event.resolvedAt || record.postMerge?.resolvedAt || null,
    resolvedBy: event.resolvedBy || record.postMerge?.resolvedBy || null,
  };
}

function renderRollup(rollup, { filtered = false } = {}) {
  const strip = element("section", "rollup-strip");
  const totals = element("div", "rollup-totals");
  if (filtered) {
    const filteredBadge = badge("filtered view", "filtered-view-badge");
    filteredBadge.title = "Rollup totals reflect only the dispatches matching the active filters.";
    totals.append(filteredBadge);
  }
  const totalRows = [
    ["Runs", Number(rollup.totals?.runs || 0).toLocaleString()],
    ["Turns", Number(rollup.totals?.turns || 0).toLocaleString()],
    ["Cost", formatMoney(rollup.totals?.costUSD)],
  ];
  for (const [label, value] of totalRows) {
    const metric = element("div", "rollup-metric");
    metric.append(element("span", "", label), element("strong", "", value));
    totals.append(metric);
  }

  const projects = element("div", "rollup-projects");
  if ((rollup.projects || []).length === 0) {
    projects.append(element("div", "empty-state", "No rollup data yet"));
  } else {
    const table = element("table", "rollup-table");
    const head = element("thead");
    const heading = element("tr");
    for (const label of ["Project", "Runs", "Completed / failed", "Merged / force-merged", "Cost"]) {
      heading.append(element("th", "", label));
    }
    head.append(heading);
    const body = element("tbody");
    for (const project of rollup.projects) {
      const row = element("tr");
      const projectCell = element("td", "", project.project || "Unknown");
      if (project.projectRemoved) {
        projectCell.append(badge("project removed", "project-removed"));
      }
      row.append(
        projectCell,
        element("td", "", String(project.runs || 0)),
        element("td", "", `${project.completed || 0} / ${project.failed || 0}`),
        element("td", "", `${project.merged || 0} / ${project.forcedMerged || 0}`),
        element("td", "", formatMoney(project.costUSD)),
      );
      body.append(row);
    }
    table.append(head, body);
    projects.append(table);
  }

  const series = element("div", "rollup-series");
  series.append(element("span", "rollup-series-label", "7 day cost"));
  const bars = element("div", "rollup-bars");
  const days = rollup.days || [];
  const maximum = Math.max(0, ...days.map((day) => Number(day.costUSD) || 0));
  for (const day of days) {
    const cost = Number(day.costUSD) || 0;
    const bar = element("div", "rollup-bar");
    bar.style.height = `${maximum > 0 ? Math.max(3, Math.round((cost / maximum) * 36)) : 3}px`;
    bar.title = `${day.day} ${formatMoney(cost)}`;
    bar.setAttribute("aria-label", bar.title);
    bars.append(bar);
  }
  if (days.length === 0) bars.append(element("span", "timestamp", "No recent runs"));
  series.append(bars);
  strip.append(totals, projects, series);
  return strip;
}

function rollupForDispatches(records) {
  const projects = new Map();
  const days = new Map();
  const totals = { runs: 0, merged: 0, forcedMerged: 0, turns: 0, costUSD: 0 };
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const afterToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  for (const record of records) {
    const row = projects.get(record.project) || {
      project: record.project,
      ...(record.projectRemoved ? { projectRemoved: true } : {}),
      runs: 0,
      completed: 0,
      failed: 0,
      merged: 0,
      forcedMerged: 0,
      turns: 0,
      costUSD: 0,
    };
    if (record.projectRemoved) row.projectRemoved = true;
    const turns = Number(record.turns) || 0;
    const costUSD = Number(record.costUSD) || 0;
    row.runs += 1;
    row.completed += record.state === "completed" ? 1 : 0;
    row.failed += ["failed", "prepare_failed", "rejected"].includes(record.state) ? 1 : 0;
    const forcedMerged = Boolean(record.merged?.forcedBy);
    row.merged += record.merged && !forcedMerged ? 1 : 0;
    row.forcedMerged += forcedMerged ? 1 : 0;
    row.turns += turns;
    row.costUSD += costUSD;
    projects.set(record.project, row);
    totals.runs += 1;
    totals.merged += record.merged && !forcedMerged ? 1 : 0;
    totals.forcedMerged += forcedMerged ? 1 : 0;
    totals.turns += turns;
    totals.costUSD += costUSD;

    const started = new Date(record.startedAt);
    if (Number.isNaN(started.getTime()) || started < firstDay || started >= afterToday) continue;
    const day = [
      started.getFullYear(),
      String(started.getMonth() + 1).padStart(2, "0"),
      String(started.getDate()).padStart(2, "0"),
    ].join("-");
    const dayRow = days.get(day) || { day, runs: 0, costUSD: 0 };
    dayRow.runs += 1;
    dayRow.costUSD += costUSD;
    days.set(day, dayRow);
  }
  return {
    projects: [...projects.values()].sort((left, right) =>
      left.project.localeCompare(right.project),
    ),
    days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)),
    totals,
  };
}

function savedDispatchFilters() {
  try {
    const saved = JSON.parse(storageGet("atelier-dispatch-filters", "{}"));
    return {
      project: typeof saved.project === "string" ? saved.project : "",
      state: ["all", "active", "terminal", "merged", "dismissed"].includes(saved.state)
        ? saved.state
        : "all",
      agent: typeof saved.agent === "string" ? saved.agent : "",
      search: typeof saved.search === "string" ? saved.search : "",
    };
  } catch {
    return { project: "", state: "all", agent: "", search: "" };
  }
}

function dispatchMatchesStateGroup(record, group) {
  if (group === "active") return ACTIVE_STATES.has(record.state);
  if (group === "merged") return Boolean(record.merged);
  if (group === "dismissed") return Boolean(record.dismissed);
  if (group === "terminal") {
    return TERMINAL_STATES.has(record.state) && !record.merged && !record.dismissed;
  }
  return true;
}

function styleguideDispatchFilters() {
  const bar = element("form", "dispatch-filter-bar");
  const project = element("select");
  project.append(option("", "All projects", ""), option("atelier", "atelier (12)"));
  const stateGroup = element("select");
  stateGroup.append(option("all", "All states", "all"), option("active", "Active (3)"));
  const agent = element("select");
  agent.append(option("", "All agents", ""), option("claude", "Claude Code (9)"));
  const search = element("input");
  search.type = "search";
  search.placeholder = "Search ticket or prompt";
  const count = element("span", "dispatch-filter-count", "12 of 18 dispatches");
  const clear = button("Clear all", "button compact");
  bar.append(project, stateGroup, agent, search, count, clear);
  bar.addEventListener("submit", (event) => event.preventDefault());
  return bar;
}

async function renderAllDispatches(_route, token) {
  const [records, initialRollup] = await Promise.all([refreshDispatches(), api("/api/rollup")]);
  if (!viewIsCurrent(token)) return;
  app.classList.add("dispatches-view");
  let unfilteredRollup = initialRollup;
  const connection = element("span", "connection-state", "Connecting live updates…");
  const filters = savedDispatchFilters();
  const filterBar = element("form", "dispatch-filter-bar");
  filterBar.setAttribute("aria-label", "Filter dispatches");
  const projectFilter = element("select");
  projectFilter.setAttribute("aria-label", "Filter by project");
  const stateFilter = element("select");
  stateFilter.setAttribute("aria-label", "Filter by state group");
  const agentFilter = element("select");
  agentFilter.setAttribute("aria-label", "Filter by agent");
  const searchFilter = element("input");
  searchFilter.type = "search";
  searchFilter.placeholder = "Search ticket or prompt";
  searchFilter.setAttribute("aria-label", "Search ticket or prompt preview");
  searchFilter.value = filters.search;
  const count = element("span", "dispatch-filter-count");
  count.setAttribute("aria-live", "polite");
  const clear = button("Clear all", "button compact");
  filterBar.append(projectFilter, stateFilter, agentFilter, searchFilter, count, clear);
  const rollupHost = element("div");
  const container = element("section");
  const fragment = document.createDocumentFragment();
  fragment.append(
    viewHeader({
      eyebrow: "Cross-project runtime",
      title: "All dispatches",
      description: "Every Claude and Codex lane in one live view.",
      actions: [connection],
    }),
    filterBar,
    rollupHost,
    container,
  );
  app.replaceChildren(fragment);

  function populateFilterChoices() {
    const projectCounts = new Map();
    const agentCounts = new Map();
    for (const record of state.dispatches) {
      projectCounts.set(record.project, (projectCounts.get(record.project) || 0) + 1);
      agentCounts.set(record.lane, (agentCounts.get(record.lane) || 0) + 1);
    }
    const projects = new Set([...state.projects.map((project) => project.name), ...projectCounts.keys()]);
    projectFilter.replaceChildren(
      option("", "All projects", filters.project),
      ...[...projects]
        .sort((left, right) => left.localeCompare(right))
        .map((name) => option(name, `${name} (${projectCounts.get(name) || 0})`, filters.project)),
    );
    const agents = new Set([...(state.agents || []).map((agent) => agent.id), ...agentCounts.keys()]);
    agentFilter.replaceChildren(
      option("", "All agents", filters.agent),
      ...[...agents]
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .map((name) => option(name, `${name} (${agentCounts.get(name) || 0})`, filters.agent)),
    );
    const stateCounts = Object.fromEntries(
      ["active", "terminal", "merged", "dismissed"].map((group) => [
        group,
        state.dispatches.filter((record) => dispatchMatchesStateGroup(record, group)).length,
      ]),
    );
    stateFilter.replaceChildren(
      option("all", "All states", filters.state),
      option("active", `Active (${stateCounts.active})`, filters.state),
      option("terminal", `Terminal (${stateCounts.terminal})`, filters.state),
      option("merged", `Merged (${stateCounts.merged})`, filters.state),
      option("dismissed", `Dismissed (${stateCounts.dismissed})`, filters.state),
    );
  }

  function applyDispatchFilters() {
    filters.project = projectFilter.value;
    filters.state = stateFilter.value;
    filters.agent = agentFilter.value;
    filters.search = searchFilter.value;
    storageSet("atelier-dispatch-filters", JSON.stringify(filters));
    const query = filters.search.trim().toLowerCase();
    const filtered = state.dispatches.filter((record) => {
      if (filters.project && record.project !== filters.project) return false;
      if (filters.agent && record.lane !== filters.agent) return false;
      if (!dispatchMatchesStateGroup(record, filters.state)) return false;
      if (!query) return true;
      const searchable = `${record.ticketId || ""} ${dispatchPromptPreview(record)}`.toLowerCase();
      return searchable.includes(query);
    });
    const active = Boolean(
      filters.project || filters.agent || filters.search.trim() || filters.state !== "all",
    );
    count.textContent = `${filtered.length} of ${state.dispatches.length} dispatches`;
    rollupHost.replaceChildren(
      renderRollup(active ? rollupForDispatches(filtered) : unfilteredRollup, { filtered: active }),
    );
    renderDispatchRows(
      container,
      filtered,
      active ? "No dispatches match the current filters." : undefined,
    );
  }

  populateFilterChoices();
  applyDispatchFilters();
  for (const control of [projectFilter, stateFilter, agentFilter]) {
    control.addEventListener("change", applyDispatchFilters);
  }
  searchFilter.addEventListener("input", applyDispatchFilters);
  filterBar.addEventListener("submit", (event) => event.preventDefault());
  clear.addEventListener("click", () => {
    filters.project = "";
    filters.state = "all";
    filters.agent = "";
    filters.search = "";
    projectFilter.value = "";
    stateFilter.value = "all";
    agentFilter.value = "";
    searchFilter.value = "";
    applyDispatchFilters();
  });
  const elapsedTimer = window.setInterval(() => refreshElapsedCells(container), 1_000);
  registerCleanup(() => window.clearInterval(elapsedTimer));

  sseManager.open(
    "dispatches",
    "/api/dispatches/events",
    ["status", "usage", "exit", "review", "review-disposition", "post-merge"],
    {
      open() {
        connection.replaceChildren(element("span", "running-pulse"), document.createTextNode("Live"));
      },
      error() {
        connection.textContent = "Reconnecting…";
      },
      async event(event) {
        if (!viewIsCurrent(token)) return;
        const eventRecord = state.dispatches.find((record) => record.id === event.dispatchId);
        void notifyTerminalDispatch(event, eventRecord);
        void notifyPostMergeFailure(event, eventRecord);
        if (!mergeDispatchEvent(event) || (event.type === "status" && event.detail?.startsWith("merged "))) {
          await refreshDispatches().catch(() => {});
        }
        unfilteredRollup = rollupForDispatches(state.dispatches);
        populateFilterChoices();
        renderSidebar();
        applyDispatchFilters();
      },
    },
  );
}

function updateUsageFooter(footer, record, usage = {}) {
  footer.hidden = false;
  footer.replaceChildren(
    element("span", "", `Turns ${usage.turns ?? record.turns ?? 0}`),
    element("span", "", `Cost ${formatMoney(usage.costUSD ?? record.costUSD)}`),
    element("span", "", `Input tokens ${Number(usage.inputTokens || 0).toLocaleString()}`),
    element("span", "", `Output tokens ${Number(usage.outputTokens || 0).toLocaleString()}`),
  );
}

function expandableToolValue(value) {
  const text = stripAnsi(value);
  if (text.length <= 120) return element("span", "tool-field-value", text);
  const details = element("details", "tool-value-expand");
  details.append(
    element("summary", "", `${text.slice(0, 120)}…`),
    element("pre", "", text),
  );
  return details;
}

function renderToolUse(event) {
  const wrapper = element("article", "transcript-event tool-use");
  const label = element("div", "tool-label");
  label.append(element("div", "tool-name", stripAnsi(event.name || "tool")));
  if (event.caption) label.append(element("div", "tool-caption", stripAnsi(event.caption)));
  if (event.truncated === true) {
    label.append(element("span", "tool-truncated", "Truncated payload"));
  }
  wrapper.append(label);
  const content = element("div", "tool-content");
  const raw = stripAnsi(event.inputPreview || "");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    content.append(element("pre", "tool-json-fallback", raw));
    wrapper.append(content);
    return wrapper;
  }

  if (input && typeof input === "object" && !Array.isArray(input) && "command" in input) {
    if (input.description !== undefined) {
      content.append(element("p", "tool-description", stripAnsi(input.description)));
    }
    content.append(element("pre", "tool-command", stripAnsi(input.command)));
    wrapper.append(content);
    return wrapper;
  }

  const fields = element("div", "tool-fields");
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, value] of Object.entries(input)) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) continue;
      const row = element("div", "tool-field");
      row.append(element("span", "tool-field-key", `${stripAnsi(key)}:`));
      row.append(expandableToolValue(value === null ? "null" : value));
      fields.append(row);
    }
  }
  if (fields.childElementCount === 0) {
    fields.append(element("span", "tool-description", "Structured arguments"));
  }
  content.append(fields);
  wrapper.append(content);
  return wrapper;
}

function appendTranscriptEvent(container, event) {
  container.querySelector(".empty-state")?.remove();
  if (event.type === "reply") {
    const wrapper = element("article", "transcript-event reply-event");
    wrapper.append(
      element("span", "reply-event-label", "You"),
      element("p", "", stripAnsi(event.text || "")),
    );
    container.append(wrapper);
    return;
  }
  if (event.type === "message" && event.kind === "text") {
    const wrapper = element("article", "transcript-event message-text");
    wrapper.append(element("p", "", stripAnsi(event.text || "")));
    container.append(wrapper);
    return;
  }
  if (event.type === "message" && event.kind === "raw") {
    const wrapper = element("pre", "transcript-event line-raw");
    wrapper.textContent = stripAnsi(event.text || "");
    container.append(wrapper);
    return;
  }
  if (event.type === "message" && event.kind === "tool_use") {
    container.append(renderToolUse(event));
    return;
  }
  if (event.type === "message" && event.kind === "tool_result") {
    const failed = event.exitCode !== undefined && Number(event.exitCode) !== 0;
    const succeeded = event.exitCode !== undefined && Number(event.exitCode) === 0;
    const wrapper = element(
      "details",
      `transcript-event tool-result${failed ? " failed-result" : succeeded ? " success-result" : ""}`,
    );
    const summary = element("summary");
    const resultLabel = failed
      ? "Command failed"
      : event.exitCode === undefined ? "Tool result" : "Command completed";
    summary.append(element("span", "tool-result-label", resultLabel));
    if (event.caption) {
      summary.append(element("span", "tool-result-caption", stripAnsi(event.caption)));
    }
    if (event.exitCode !== undefined) {
      summary.append(
        element("span", `exit-badge${failed ? " danger" : " success"}`, `exit ${event.exitCode}`),
      );
    }
    wrapper.append(
      summary,
      element("pre", "", stripAnsi(event.preview || "")),
    );
    container.append(wrapper);
    return;
  }
  if (event.type === "message" && event.kind === "files") {
    const wrapper = element("article", "transcript-event files-event");
    wrapper.append(
      element("span", "files-event-label", "File changes"),
      element("span", "files-event-detail", stripAnsi(event.text || "File activity")),
    );
    container.append(wrapper);
  }
}

function inferredStatusHistory(record) {
  const history = new Set(["queued"]);
  const current = record.state;
  if (current !== "queued" && current !== "rejected") history.add("preparing");
  if (!["queued", "preparing", "prepare_failed", "rejected"].includes(current)) {
    history.add("running");
  }
  if (current === "plan_ready" || record.plan?.state === "approved") {
    history.add("plan_ready");
  }
  if (current === "verifying" || (record.verify && record.verify.state !== "skipped")) {
    history.add("verifying");
  }
  if (TERMINAL_STATES.has(current)) history.add(current);
  return history;
}

function renderStatusTimeline(timeline, history, current, detail = "", hasPlanPhase = false) {
  timeline.replaceChildren();
  const terminal = TERMINAL_STATES.has(current) || current === "stopping" ? current : "terminal";
  // The plan step only exists for plan-first dispatches - showing a hollow
  // slot on every run read as "why is there a plan after running?".
  const planned = hasPlanPhase || current === "plan_ready";
  const steps = planned
    ? ["queued", "preparing", "running", "plan_ready", "verifying", terminal]
    : ["queued", "preparing", "running", "verifying", terminal];
  const currentStep = current === "resuming"
    ? "running"
    : TERMINAL_STATES.has(current) || current === "stopping"
      ? terminal
      : current;
  for (const step of steps) {
    const item = element("div", "timeline-step");
    const reached = step === "terminal" ? false : history.has(step);
    item.classList.toggle("reached", reached);
    item.classList.toggle("current", step === currentStep);
    item.classList.toggle("paused", step === "plan_ready" && step === currentStep);
    item.append(
      element("span", "timeline-dot"),
      element(
        "span",
        "timeline-label",
        step === "running" && current === "resuming" ? "resuming" : step.replaceAll("_", " "),
      ),
    );
    if (step === terminal && terminal !== "terminal" && detail) {
      // The full exit summary has its own card below - the timeline shows
      // a clamped one-liner so it never eats the transcript's real estate.
      const clean = stripAnsi(detail).replace(/\s+/g, " ").trim();
      const clamped = clean.length > 120 ? `${clean.slice(0, 120)}…` : clean;
      const detailNode = element("span", "timeline-detail", clamped);
      if (clamped !== clean) detailNode.title = clean;
      item.append(detailNode);
    }
    timeline.append(item);
  }
}

function styleguideReplyComposer(label, hint, disabled = false) {
  const form = element("form", "reply-composer styleguide-reply-composer");
  const textarea = element("textarea");
  textarea.value = "Review the verification failure and continue.";
  textarea.disabled = disabled;
  const controls = element("div", "reply-composer-controls");
  const status = element("span", "reply-composer-hint", hint);
  const send = button(label, "button primary");
  send.disabled = disabled;
  if (disabled) {
    form.title = hint;
    textarea.title = hint;
    send.title = hint;
  }
  controls.append(status, send);
  form.append(textarea, controls);
  form.addEventListener("submit", (event) => event.preventDefault());
  return form;
}

function dispatchValueChip(label, initialValue) {
  const wrapper = element("span", "dispatch-value-chip");
  const name = element("span", "dispatch-value-label", label);
  const value = element("code", "", initialValue || "pending");
  const copy = button("⧉", "copy-button");
  copy.setAttribute("aria-label", `Copy ${label.toLowerCase()}`);
  copy.title = `Copy ${label.toLowerCase()}`;
  copy.disabled = !initialValue;
  let currentValue = initialValue || "";
  copy.addEventListener("click", async () => {
    if (!currentValue || !navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(currentValue);
      showToast(`${label} copied`, "success");
    } catch {
      // Clipboard can be unavailable outside a secure browser context.
    }
  });
  wrapper.append(name, value, copy);
  return {
    wrapper,
    update(nextValue) {
      currentValue = nextValue || "";
      value.textContent = currentValue || "pending";
      copy.disabled = !currentValue;
    },
  };
}

function renderDispatchSummary(container, record) {
  container.replaceChildren();
  if (!TERMINAL_STATES.has(record.state) && !(record.warnings || []).length) return;
  const card = element(
    "section",
    `summary-card${record.strandedBrWrites || (record.warnings || []).length ? " warning" : ""}`,
  );
  card.append(
    element("h2", "", TERMINAL_STATES.has(record.state) ? "Exit summary" : "Dispatch warnings"),
  );
  if (record.exitSummary) {
    card.append(element("p", "detail-copy", stripAnsi(record.exitSummary)));
  }
  if (record.strandedBrWrites) {
    card.append(banner("Harvest needed: this worktree contains stranded tracker writes."));
  }
  if ((record.warnings || []).length > 0) {
    const list = element("ul", "warning-list");
    for (const warning of record.warnings) list.append(element("li", "", warning));
    card.append(list);
  }
  container.append(card);
}

const VERIFY_BADGE_STATES = new Set(["passed", "failed", "running", "skipped"]);

function verificationVerdict(target, verify, dispatchState) {
  const verdict = verify?.state || (dispatchState === "verifying" ? "running" : "");
  const branch = verify?.mainBranch || "main";
  const testedTree = String(verify?.testedTree || "").slice(0, 7);
  const behind = Number(verify?.commitsBehind);
  const context = testedTree && Number.isSafeInteger(behind)
    ? `tree ${testedTree} · ${behind === 0 ? `current with ${branch}` : `${behind} behind ${branch}`}`
    : "";
  target.className = `badge verification-verdict${verdict ? ` verify-${verdict}` : ""}`;
  target.textContent = verdict
    ? `verify ${verdict}${verdict === "passed" && context ? ` · ${context}` : ""}`
    : "verify pending";
  target.title = testedTree && Number.isSafeInteger(behind)
    ? `Verified exact worktree HEAD ${testedTree}; ${behind} commit${behind === 1 ? "" : "s"} behind ${branch}@${String(verify.mainTip || "").slice(0, 7)}`
    : "";
  target.hidden = !verdict;
}

function verificationContextText(verify) {
  const details = [];
  // Only stated once there is more than one attempt: on the overwhelmingly
  // common single-attempt record "Attempt 1" is noise.
  const attempt = Number(verify?.attempt);
  if (Number.isSafeInteger(attempt) && attempt > 1) details.push(`Attempt ${attempt}.`);
  const branch = verify?.mainBranch || "main";
  const testedTree = String(verify?.testedTree || "");
  const mainTip = String(verify?.mainTip || "");
  const behind = Number(verify?.commitsBehind);
  if (testedTree && mainTip && Number.isSafeInteger(behind)) {
    details.push(`Verified exact worktree HEAD ${testedTree.slice(0, 12)}; it was ${behind} commit${behind === 1 ? "" : "s"} behind ${branch}@${mainTip.slice(0, 12)}.`);
  }
  return details.join(" ");
}

// Prior attempts stay readable next to the current verdict - a fail-then-pass
// flip is the evidence that the suite is flaky, and hiding it would turn signal
// back into noise.
function verificationAttemptRows(verify) {
  const attempts = Array.isArray(verify?.attempts) ? verify.attempts : [];
  if (attempts.length < 2) return [];
  return attempts.map((attempt, index) => {
    const row = element("div", "verification-attempt");
    const number = Number.isSafeInteger(Number(attempt?.attempt))
      ? Number(attempt.attempt)
      : index + 1;
    const stepCount = Array.isArray(attempt?.steps) ? attempt.steps.length : 0;
    const state = String(attempt?.state || "unknown");
    row.append(
      element("span", "", `Attempt ${number} · ${stepCount} step${stepCount === 1 ? "" : "s"}`),
      badge(state, `verify-${VERIFY_BADGE_STATES.has(state) ? state : "skipped"}`),
    );
    return row;
  });
}

function reviewVerdict(target, review, branchHead, reviewGateState = undefined) {
  const rounds = reviewRounds(review);
  const current = currentReview(review);
  const verdict = current?.verdict || "";
  const dispositionPassed = reviewGateState === "passed-with-dispositions";
  const stale = reviewIsStale(review, branchHead, reviewGateState);
  target.className = `badge review-verdict${stale ? " review-stale review-error" : dispositionPassed ? " review-pass" : verdict ? ` review-${verdict}` : ""}`;
  target.textContent = stale
    ? "review stale - re-review required"
    : dispositionPassed
      ? `review passed with dispositions${rounds.length > 1 ? ` · round ${rounds.length}` : ""}`
    : verdict
      ? `review ${verdict}${rounds.length > 1 ? ` · round ${rounds.length}` : ""}`
      : "review pending";
  target.hidden = !verdict && !dispositionPassed;
  target.title = stale
    ? `review stale - re-review required${current?.summary ? `: ${current.summary}` : ""}`
    : current?.summary || "";
}

function renderReviewHistory(container, review, parking, merged = undefined, reviewGateState = undefined) {
  const rounds = reviewRounds(review);
  container.replaceChildren();
  const forceAudit = merged?.forcedBy
    ? `${merged.forcedBy}: ${merged.reason} (${merged.dispositionRef})`
    : null;
  container.hidden = rounds.length === 0 && !parking && !forceAudit;
  if (container.hidden) return;
  const header = element("header", "review-history-header");
  const trajectory = rounds
    .map((round, index) => index === rounds.length - 1 && reviewGateState === "passed-with-dispositions"
      ? "PASSED WITH DISPOSITIONS"
      : String(round.verdict || "pending").toUpperCase())
    .join(" → ");
  header.append(
    element("h2", "", "Review trajectory"),
    badge(
      `${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
      "review-round-count",
    ),
  );
  if (trajectory) header.append(element("div", "review-trajectory", trajectory));
  const list = element("div", "review-rounds");
  for (const round of rounds) {
    const row = element("article", "review-round");
    const identity = element("header", "review-round-header");
    const count = Number.isInteger(round.findingCount)
      ? `${round.findingCount} finding${round.findingCount === 1 ? "" : "s"}`
      : "finding count unavailable";
    identity.append(
      element("strong", "", `Round ${round.round}`),
      badge(round.verdict || "pending", `review-${round.verdict || "pending"}`),
      element("span", "review-round-meta", `${count}${round.at ? ` · ${formatDate(round.at)}` : ""}`),
    );
    row.append(identity);
    if (round.summary) row.append(element("p", "review-round-summary", round.summary));
    list.append(row);
  }
  container.append(header, list);
  if (parking) {
    container.append(
      banner(
        `Parked after round ${parking.round}: ${parking.reason}. Start a fresh dispatch; salvage remains on the recorded branch.`,
        "warning",
      ),
    );
  }
  if (forceAudit) {
    container.append(
      banner(`Force merged by ${forceAudit}.`, "warning"),
    );
  }
}

function verificationStepView(index, step, outputNodes) {
  const view = element("article", "verification-step");
  const row = element("div", "verification-step-row");
  const identity = element("div", "verification-step-identity");
  identity.append(
    element("span", "verification-step-number", `Step ${index + 1}`),
    element("code", "verification-command", stripAnsi(step.command || "Waiting for command")),
  );
  const result = element("div", "verification-step-result");
  if (step.phase !== "end" && step.exitCode === undefined) {
    const pending = element("span", "verification-pending");
    const spinner = element("span", "verification-spinner");
    spinner.setAttribute("aria-hidden", "true");
    pending.append(spinner, document.createTextNode("running"));
    result.append(pending);
  } else {
    const exitCode = Number(step.exitCode);
    result.append(
      badge(
        Number.isFinite(exitCode) ? `exit ${exitCode}` : "exit —",
        Number.isFinite(exitCode) && exitCode === 0 ? "verify-passed" : "verify-failed",
      ),
    );
  }
  result.append(element("span", "verification-duration", formatDuration(step.durationMs)));
  row.append(identity, result);

  const outputWrap = element("details", "verification-output-wrap");
  outputWrap.open = step.phase !== "end" || Number(step.exitCode) !== 0;
  outputWrap.append(element("summary", "", "Output"));
  const output = element("pre", "verification-output");
  if (step.output) output.append(document.createTextNode(stripAnsi(step.output)));
  outputWrap.append(output);
  outputNodes.set(index, output);
  view.append(row, outputWrap);
  return view;
}

function renderMergedStatus(container, record) {
  container.replaceChildren();
  if (!record.merged) return;
  const card = element("section", "summary-card merged-card");
  const heading = element("div", "merged-heading");
  const forced = Boolean(record.merged.forcedBy);
  heading.append(
    element("h2", "", forced ? "Force merged" : "Merged"),
    badge(forced ? "force-merged" : "merged", forced ? "force-merged" : "merged"),
  );
  const facts = element("div", "merged-facts");
  facts.append(
    element("code", "merged-commit", record.merged.commit || "unknown commit"),
    element("span", "", `Strategy: ${record.merged.strategy || "unknown"}`),
    element("span", "", `Merged: ${formatDate(record.merged.mergedAt)}`),
  );
  card.append(heading, facts);
  if (record.postMerge) {
    const health = element("section", `post-merge-health post-merge-${record.postMerge.state}`);
    const healthHeading = element("div", "merged-heading");
    healthHeading.append(
      element("h3", "", "Post-merge main health"),
      badge(record.postMerge.state, `verify-${record.postMerge.state}`),
    );
    health.append(healthHeading);
    if (record.postMerge.testedTree) {
      health.append(
        element("p", "verification-context", `Tested exact merge tree ${record.postMerge.testedTree}.`),
      );
    }
    if (record.postMerge.error) {
      health.append(element("pre", "verification-output", stripAnsi(record.postMerge.error)));
    }
    const outputs = new Map();
    for (const [index, step] of (record.postMerge.steps || []).entries()) {
      health.append(verificationStepView(index, { ...step, phase: "end", output: step.tail }, outputs));
    }
    card.append(health);
  }
  container.append(card);
}

function openForceMergeConfirmation(record, reasons, onConfirm) {
  const body = modalFrame("Override merge gates", `Force merge ${record.id}?`);
  body.append(
    element(
      "p",
      "detail-copy",
      "This bypasses the following safety gates and merges the dispatch into the primary branch:",
    ),
  );
  const list = element("ul", "warning-list force-merge-gates");
  for (const reason of reasons) list.append(element("li", "", reason));
  body.append(list);
  const targetSha = String(record.branchHead || record.result?.commit || "");
  const target = element(
    "p",
    "detail-copy force-merge-target",
    `Authorizing exact target ${targetSha ? targetSha.slice(0, 12) : "unavailable"}.`,
  );
  target.title = targetSha;
  body.append(target);
  const forcedBy = document.createElement("input");
  forcedBy.type = "text";
  forcedBy.required = true;
  forcedBy.maxLength = 80;
  forcedBy.autocomplete = "name";
  const reason = document.createElement("textarea");
  reason.required = true;
  reason.maxLength = 1_000;
  reason.rows = 3;
  const dispositionRef = document.createElement("input");
  dispositionRef.type = "text";
  dispositionRef.required = true;
  dispositionRef.maxLength = 200;
  body.append(
    field("Forced by", forcedBy, "field", "Human identity recorded on the merge."),
    field("Reason", reason, "field", "Why the open finding is being overridden."),
    field(
      "Disposition reference",
      dispositionRef,
      "field",
      "Disposition, tracker comment, or other adjudication reference.",
    ),
  );
  const actions = element("div", "modal-actions");
  const failure = element("p", "form-error");
  failure.hidden = true;
  const cancel = button("Cancel");
  const confirm = button("Force merge", "button danger");
  const updateConfirm = () => {
    confirm.disabled = !targetSha || !forcedBy.value.trim() || !reason.value.trim() ||
      !dispositionRef.value.trim();
  };
  for (const control of [forcedBy, reason, dispositionRef]) {
    control.addEventListener("input", updateConfirm);
  }
  updateConfirm();
  cancel.addEventListener("click", closeModal);
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    failure.hidden = true;
    try {
      await onConfirm({
        targetSha,
        forcedBy: forcedBy.value.trim(),
        reason: reason.value.trim(),
        dispositionRef: dispositionRef.value.trim(),
      });
      closeModal();
    } catch (error) {
      failure.textContent = error.message;
      failure.hidden = false;
      updateConfirm();
    }
  });
  actions.append(cancel, confirm);
  body.append(failure, actions);
}

function openDismissConfirmation(record, onConfirm) {
  const body = modalFrame("Dispatch cleanup", `Dismiss ${record.id}?`);
  body.append(
    element(
      "p",
      "confirm-copy",
      "Atelier will remove this dispatch worktree and local branch, release its ticket claim, and keep the history record.",
    ),
  );
  const actions = element("div", "modal-actions");
  const cancel = button("Cancel");
  const confirm = button("Dismiss", "button danger");
  cancel.addEventListener("click", closeModal);
  confirm.addEventListener("click", () => {
    closeModal();
    void onConfirm();
  });
  actions.append(cancel, confirm);
  body.append(actions);
}

function diffPathFromHeader(line) {
  const boundary = line.lastIndexOf(" b/");
  if (boundary === -1) return "Unknown file";
  return line.slice(boundary + 3).replace(/^"|"$/g, "");
}

function parseUnifiedDiff(result) {
  const patch = String(result.patch || "");
  const files = Array.isArray(result.files) ? result.files : [];
  const sections = [];
  let current;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      current = {
        path: files[sections.length]?.path || diffPathFromHeader(line),
        lines: [],
      };
      sections.push(current);
    }
    if (current) current.lines.push(line);
  }
  for (let index = sections.length; index < files.length; index += 1) {
    sections.push({ path: files[index].path, lines: [] });
  }
  if (sections.length === 0) {
    return files.map((file) => ({ path: file.path, lines: [] }));
  }
  return sections.map((section, index) => {
    const file = files[index] || {};
    const additions = section.lines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++"),
    ).length;
    const deletions = section.lines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---"),
    ).length;
    return {
      ...section,
      insertions: Number.isFinite(Number(file.insertions)) ? Number(file.insertions) : additions,
      deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : deletions,
    };
  });
}

function renderDiffPaneV2(container, result, onComment) {
  container.replaceChildren();
  const sections = parseUnifiedDiff(result);
  container.append(
    element(
      "p",
      "numstat-summary",
      `${sections.length} file${sections.length === 1 ? "" : "s"} · +${result.insertions || 0} / −${result.deletions || 0}`,
    ),
  );
  if (sections.length === 0) {
    container.append(element("div", "empty-state", "No uncommitted worktree changes"));
    return;
  }

  const fileList = element("nav", "diff-file-list");
  fileList.setAttribute("aria-label", "Changed files");
  const renderedSections = [];
  const collapsedByDefault = sections.length > 20;
  for (const [index, section] of sections.entries()) {
    const id = `diff-file-${index}`;
    const jump = element(
      "a",
      "diff-file-jump",
      `${section.path} (+${section.insertions}/−${section.deletions})`,
    );
    jump.href = `#${id}`;
    jump.addEventListener("click", (event) => {
      event.preventDefault();
      renderedSections[index].scrollIntoView({ behavior: "smooth", block: "start" });
    });
    fileList.append(jump);

    const fileSection = element("section", "diff-file-section");
    fileSection.id = id;
    const header = element("header", "diff-file-header");
    const identity = element("div", "diff-file-identity");
    identity.append(
      element("code", "diff-file-path", section.path),
      element("span", "diff-file-stats", `+${section.insertions} / −${section.deletions}`),
    );
    const actions = element("div", "diff-file-actions");
    const comment = button("Comment", "button compact diff-comment");
    comment.setAttribute("aria-label", `Comment on ${section.path}`);
    comment.addEventListener("click", () => onComment(section.path));
    const toggle = button(collapsedByDefault ? "Expand" : "Collapse", "button compact");
    toggle.setAttribute("aria-expanded", String(!collapsedByDefault));
    actions.append(comment, toggle);
    header.append(identity, actions);
    const content = element("div", "diff-file-content");
    content.hidden = collapsedByDefault;
    if (section.lines.length > 0) {
      const patchView = element("pre", "diff-file-patch");
      patchView.textContent = section.lines.join("\n");
      content.append(patchView);
    } else {
      content.append(element("div", "empty-state", "No textual patch content"));
    }
    toggle.addEventListener("click", () => {
      content.hidden = !content.hidden;
      toggle.textContent = content.hidden ? "Expand" : "Collapse";
      toggle.setAttribute("aria-expanded", String(!content.hidden));
    });
    fileSection.append(header, content);
    renderedSections.push(fileSection);
  }
  container.append(fileList, ...renderedSections);
}

async function renderDispatch(route, token) {
  const [initialRecord, agentList] = await Promise.all([
    api(`/api/dispatch/${encoded(route.id)}`),
    loadAgents(),
    refreshDispatches(),
  ]);
  let record = initialRecord;
  if (!viewIsCurrent(token)) return;
  const agent = agentList.find((candidate) => candidate.id === record.lane);
  app.classList.add("dispatch-view");
  const chip = stateChip(record.state);
  const headerBadges = element("span", "header-badges");
  const verdict = badge("verify pending", "verification-verdict");
  const reviewBadge = badge("review pending", "review-verdict");
  const reviewAuditBadge = badge("read-only review", "review-audit");
  const mergedBadge = badge(
    record.merged?.forcedBy ? "force-merged" : "merged",
    record.merged?.forcedBy ? "force-merged" : "merged",
  );
  const dismissedBadge = badge("dismissed", "dismissed");
  const projectRemovedBadge = badge("project removed", "project-removed");
  const convoyBadge = badge(`convoy ${record.batchSeq || ""}`.trim(), "convoy");
  const bakeoffBadge = badge("bake-off", "bakeoff");
  verificationVerdict(verdict, record.verify, record.state);
  reviewVerdict(
    reviewBadge,
    record.review,
    record.branchHead,
    record.gates?.find((gate) => gate.gate === "review")?.state,
  );
  reviewAuditBadge.hidden = !record.reviewOf;
  mergedBadge.hidden = !record.merged;
  dismissedBadge.hidden = !record.dismissed;
  projectRemovedBadge.hidden = !record.projectRemoved;
  convoyBadge.hidden = record.batchKind !== "convoy";
  bakeoffBadge.hidden = record.batchKind !== "bakeoff";
  headerBadges.append(
    chip,
    verdict,
    reviewBadge,
    reviewAuditBadge,
    mergedBadge,
    dismissedBadge,
    projectRemovedBadge,
    convoyBadge,
    bakeoffBadge,
  );
  const elapsed = element(
    "span",
    "timestamp elapsed-live",
    elapsedBetween(record.startedAt, lastActivityAt(record)),
  );
  const backLink = element("a", "dispatch-back");
  backLink.href = `#/project/${encoded(record.project)}`;
  backLink.textContent = `← ${record.project}`;
  backLink.title = "Back to project (browser Back also works)";
  const copyJson = button("Copy JSON", "button compact");
  copyJson.title = "Copy this dispatch's full record as JSON - paste it to an AI or a bug report";
  copyJson.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(record, null, 2));
      showToast("Dispatch JSON copied", "success");
    } catch {
      showToast("Clipboard unavailable");
    }
  });
  const approveMerge = button("Approve & merge", "button primary");
  const forceMerge = button("Force merge", "button danger");
  const startReview = button("Run spec review", "button");
  const dismiss = button("Dismiss", "button danger");
  const stop = button("Stop", "button danger");
  stop.hidden = !["resuming", "running", "verifying"].includes(record.state);
  const openEditor = state.editorConfigured
    ? openEditorButton(`/api/dispatch/${encoded(route.id)}/open-editor`)
    : undefined;
  if (openEditor) openEditor.hidden = !record.worktreePath;
  const connection = element("span", "connection-state", "Connecting…");
  const header = viewHeader({
    eyebrow: `Dispatch ${record.id}`,
    title: record.project,
    description: `${record.ticketId || "Prompt dispatch"} · ${record.model}${record.effort ? ` · ${record.effort}` : ""} · ${record.lane}`,
    chip: headerBadges,
    actions: [elapsed, copyJson, ...(openEditor ? [openEditor] : []), startReview, approveMerge, forceMerge, dismiss, stop],
  });
  header.firstElementChild.prepend(backLink);
  const branchChip = dispatchValueChip("Branch", record.branch);
  const worktreeChip = dispatchValueChip("Worktree", record.worktreePath);
  const trustChip = dispatchValueChip("Execution", trustProfileSummary(record));
  const dispatchContext = element("div", "dispatch-context");
  dispatchContext.append(branchChip.wrapper, worktreeChip.wrapper, trustChip.wrapper);
  header.firstElementChild.append(dispatchContext);
  const bakeoffLinks = element("div", "bakeoff-links");
  const bakeoffSiblings = () => state.dispatches.filter(
    (candidate) =>
      candidate.id !== record.id &&
      candidate.batchKind === "bakeoff" &&
      candidate.batchId === record.batchId,
  );
  for (const sibling of bakeoffSiblings()) {
    const link = element("a", "table-link", `bake-off sibling: ${sibling.id} →`);
    link.href = routeHref({ kind: "dispatch", id: sibling.id });
    bakeoffLinks.append(link);
  }
  bakeoffLinks.hidden = bakeoffLinks.childElementCount === 0;
  header.firstElementChild.append(bakeoffLinks);
  const siblingMergeWarning = banner("", "warning");
  siblingMergeWarning.classList.add("bakeoff-merge-warning");
  siblingMergeWarning.hidden = true;

  const pane = element("section", "dispatch-pane");
  const paneToolbar = element("div", "dispatch-toolbar");
  const tabs = element("div", "tab-list");
  const transcriptTab = button("Transcript", "tab active");
  const diffTab = button("Diff", "tab");
  transcriptTab.setAttribute("aria-selected", "true");
  diffTab.setAttribute("aria-selected", "false");
  tabs.append(transcriptTab, diffTab);
  const transcriptLegendToggle = button("?", "icon-button transcript-legend-toggle");
  transcriptLegendToggle.setAttribute("aria-label", "Open transcript card legend");
  transcriptLegendToggle.title = "Transcript card legend";
  transcriptLegendToggle.addEventListener("click", toggleTranscriptLegend);
  const toolbarStatus = element("div", "dispatch-toolbar-status");
  toolbarStatus.append(connection, transcriptLegendToggle);
  paneToolbar.append(tabs, toolbarStatus);

  const timeline = element("section", "status-timeline");
  timeline.setAttribute("aria-label", "Dispatch status timeline");
  timeline.setAttribute("aria-live", "polite");
  const statusHistory = inferredStatusHistory(record);
  let terminalDetail = record.merged
    ? `merged ${String(record.merged.commit || "").slice(0, 7)}`
    : TERMINAL_STATES.has(record.state)
      ? record.exitSummary || ""
      : "";
  renderStatusTimeline(timeline, statusHistory, record.state, terminalDetail, Boolean(record.plan));

  const transcriptPanel = element("section");
  const transcript = element("div", "transcript");
  const events = element("div", "transcript-events");
  events.append(element("div", "empty-state", "Waiting for transcript events…"));
  const follow = button("Resume follow", "button compact follow-button");
  follow.hidden = true;
  transcript.append(events, follow);
  const usage = element("footer", "usage-footer");
  usage.hidden = true;
  transcriptPanel.append(transcript, usage);

  const diffPanel = element("section", "diff-pane");
  diffPanel.hidden = true;
  diffPanel.append(element("div", "empty-state", "Open this tab to load the worktree diff"));
  const replyComposer = element("form", "reply-composer");
  const replyText = element("textarea");
  replyText.name = "reply";
  replyText.placeholder = "Reply to this dispatch";
  replyText.maxLength = 32 * 1024;
  replyText.setAttribute("aria-label", "Reply to this dispatch");
  const replyControls = element("div", "reply-composer-controls");
  const replyHint = element("span", "reply-composer-hint");
  replyHint.setAttribute("aria-live", "polite");
  const replySend = button("Send now", "button primary");
  replySend.type = "submit";
  replyControls.append(replyHint, replySend);
  const profileAcceptance = element("label", "execution-profile-acceptance");
  const acceptExecutionProfile = document.createElement("input");
  acceptExecutionProfile.type = "checkbox";
  acceptExecutionProfile.name = "acceptExecutionProfile";
  const profileAcceptanceCopy = element("span");
  profileAcceptance.append(acceptExecutionProfile, profileAcceptanceCopy);
  replyComposer.append(replyText, profileAcceptance, replyControls);
  pane.append(paneToolbar, timeline, transcriptPanel, diffPanel, replyComposer);
  const planCard = element("section", "plan-card panel");
  const planHeader = element("header", "plan-card-header");
  const planState = badge("plan ready", "plan-state");
  planHeader.append(element("h2", "", "Implementation plan"), planState);
  const planText = element("pre", "plan-text");
  const planFeedback = element("textarea");
  planFeedback.placeholder = "What should change in the plan?";
  planFeedback.maxLength = 32 * 1024;
  planFeedback.setAttribute("aria-label", "Plan revision feedback");
  const approvePlan = button("Approve plan", "button primary");
  const revisePlan = button("Revise plan");
  const planActions = element("div", "plan-actions");
  planActions.append(revisePlan, approvePlan);
  planCard.append(
    planHeader,
    planText,
    field("Revision feedback", planFeedback, "field plan-feedback"),
    planActions,
  );
  const summary = element("div");
  const verification = element("section", "verification-card");
  const verificationHeader = element("header", "verification-header");
  const verificationVerdictBadge = badge("verify pending", "verification-verdict");
  const rerunVerify = button("Re-run verify", "button compact");
  rerunVerify.hidden = true;
  const verificationHeaderActions = element("div", "verification-header-actions");
  verificationHeaderActions.append(verificationVerdictBadge, rerunVerify);
  verificationHeader.append(element("h2", "", "Verification"), verificationHeaderActions);
  const verificationContext = element("div", "verification-context");
  const verificationAttempts = element("div", "verification-attempts");
  verificationAttempts.hidden = true;
  const verificationStepsList = element("div", "verification-steps");
  verification.append(
    verificationHeader,
    verificationContext,
    verificationAttempts,
    verificationStepsList,
  );
  const reviewHistoryCard = element("section", "review-history-card");
  renderReviewHistory(
    reviewHistoryCard,
    record.review,
    record.reviewParking,
    record.merged,
    record.gates?.find((gate) => gate.gate === "review")?.state,
  );
  const mergedStatus = element("div");
  renderDispatchSummary(summary, record);
  renderMergedStatus(mergedStatus, record);
  app.replaceChildren(
    header,
    siblingMergeWarning,
    pane,
    planCard,
    verification,
    reviewHistoryCard,
    mergedStatus,
    summary,
  );

  let following = true;
  let diffLoaded = false;
  let mergeInFlight = false;
  let reviewInFlight = false;
  let dismissInFlight = false;
  let replyInFlight = false;
  let planActionInFlight = false;
  let verifyRerunInFlight = false;
  let latestUsage = {};
  const seen = new Set();
  const verificationSteps = new Map();
  const verificationOutputNodes = new Map();

  function syncVerificationSteps() {
    const recordedSteps = record.verify?.steps || [];
    for (const [index, step] of recordedSteps.entries()) {
      const existing = verificationSteps.get(index) || {};
      verificationSteps.set(index, {
        ...existing,
        ...step,
        phase: "end",
        output: typeof step.tail === "string" ? step.tail : existing.output || "",
      });
    }
    if (["passed", "failed", "skipped"].includes(record.verify?.state)) {
      for (const index of verificationSteps.keys()) {
        if (index >= recordedSteps.length) verificationSteps.delete(index);
      }
    }
  }

  function renderVerification() {
    syncVerificationSteps();
    verificationVerdict(verdict, record.verify, record.state);
    verificationVerdict(verificationVerdictBadge, record.verify, record.state);
    verificationContext.textContent = verificationContextText(record.verify);
    verificationContext.hidden = !verificationContext.textContent;
    const rerunProject = state.projects.find((candidate) => candidate.name === record.project);
    const rerunAvailability = verifyRerunAvailability(record, rerunProject);
    rerunVerify.hidden = !rerunAvailability.available;
    rerunVerify.disabled = verifyRerunInFlight || Boolean(rerunAvailability.reason);
    rerunVerify.textContent = verifyRerunInFlight ? "Re-running…" : "Re-run verify";
    rerunVerify.title = rerunAvailability.reason ||
      "Re-run this project's verification commands in the dispatch worktree.";
    const attemptRows = verificationAttemptRows(record.verify);
    verificationAttempts.replaceChildren(...attemptRows);
    verificationAttempts.hidden = attemptRows.length === 0;
    verificationOutputNodes.clear();
    verificationStepsList.replaceChildren();
    const steps = [...verificationSteps.entries()].sort(([left], [right]) => left - right);
    if (steps.length === 0) {
      const verifyProject = state.projects.find((candidate) => candidate.name === record.project);
      verificationStepsList.append(
        element("div", "empty-state", verificationEmptyMessage(record, verifyProject)),
      );
      return;
    }
    for (const [index, step] of steps) {
      verificationStepsList.append(verificationStepView(index, step, verificationOutputNodes));
    }
  }

  function renderMergeControls() {
    const project = state.projects.find((candidate) => candidate.name === record.project);
    const available = record.state === "completed" && !record.merged && !record.reviewOf;
    const emptyDiffKnown = Boolean(state.dispatchDiffEmpty?.[record.id]) && !record.merged;
    const reasons = mergeGateReasons(record, project);
    const bakeoffWinner = bakeoffSiblings().find((sibling) => sibling.merged);
    approveMerge.hidden = !available;
    forceMerge.hidden = !available || reasons.length === 0 || Boolean(bakeoffWinner);
    approveMerge.disabled =
      mergeInFlight || reasons.length > 0 || emptyDiffKnown || Boolean(bakeoffWinner);
    forceMerge.disabled = mergeInFlight;
    approveMerge.textContent = mergeInFlight ? "Merging…" : "Approve & merge";
    forceMerge.textContent = mergeInFlight ? "Merging…" : "Force merge";
    approveMerge.title = reasons.length > 0 ? `Cannot merge: ${reasons.join("; ")}` : "";
    if (emptyDiffKnown) approveMerge.title = "No changes to merge - this run produced an empty diff (Dismiss is the right action)";
    if (bakeoffWinner) {
      approveMerge.title = `sibling ${bakeoffWinner.id} already merged - dismiss this attempt`;
    }
    forceMerge.title = reasons.length > 0 ? `Override: ${reasons.join("; ")}` : "";
    siblingMergeWarning.hidden = !bakeoffWinner;
    siblingMergeWarning.textContent = bakeoffWinner
      ? `Sibling ${bakeoffWinner.id} already merged - dismiss this attempt.`
      : "";
    mergedBadge.hidden = !record.merged;
    mergedBadge.textContent = record.merged?.forcedBy ? "force-merged" : "merged";
    mergedBadge.className = `badge ${record.merged?.forcedBy ? "force-merged" : "merged"}`;
    dismissedBadge.hidden = !record.dismissed;
    projectRemovedBadge.hidden = !record.projectRemoved;
    const dismissAction = dismissAvailability(record);
    dismiss.hidden = !dismissAction.available;
    dismiss.disabled = dismissInFlight;
    dismiss.textContent = dismissInFlight ? "Dismissing…" : dismissAction.label;
    renderMergedStatus(mergedStatus, record);
  }

  function renderReviewControls() {
    const reviewGateState = record.gates?.find((gate) => gate.gate === "review")?.state;
    reviewVerdict(reviewBadge, record.review, record.branchHead, reviewGateState);
    reviewAuditBadge.hidden = !record.reviewOf;
    const current = currentReview(record.review);
    const available =
      record.state === "completed" &&
      !record.merged &&
      !record.dismissed &&
      !record.reviewOf;
    const active = ["pending", "running"].includes(current?.verdict);
    startReview.hidden = !available;
    startReview.disabled = reviewInFlight || active || Boolean(record.reviewParking);
    startReview.textContent = reviewInFlight || active
      ? "Reviewing…"
      : current?.dispatchId ? "Review again" : "Run spec review";
    startReview.title = record.reviewParking
      ? `Review thread parked: ${record.reviewParking.reason}`
      : current?.summary || "Launch a linked read-only spec audit.";
    renderReviewHistory(
      reviewHistoryCard,
      record.review,
      record.reviewParking,
      record.merged,
      reviewGateState,
    );
  }

  function renderReplyControls() {
    const mismatchDetail = executionProfileMismatchDetail(record);
    profileAcceptance.hidden = !mismatchDetail;
    profileAcceptanceCopy.textContent = mismatchDetail
      ? `Accept this new execution profile for the next process spawn. ${mismatchDetail}`
      : "";
    const availability = replyAvailability(record, agent);
    const disabled = replyInFlight || !availability.label;
    const empty = !replyText.value.trim();
    const disabledReason = replyInFlight ? "Reply is being sent." : availability.reason;
    replyText.disabled = disabled;
    replyText.title = disabledReason || "";
    replySend.disabled = disabled || empty;
    replySend.textContent = replyInFlight ? "Sending…" : availability.label || "Reply unavailable";
    replyHint.textContent = replyInFlight
      ? "Sending reply…"
      : availability.reason || (empty ? `Enter a reply. ${availability.hint}` : availability.hint);
    replySend.title = disabledReason || (empty ? "Enter a reply to send." : "");
    replyComposer.title = disabledReason || "";
  }

  function captureExecutionProfileRefusal(error, operation) {
    const detail = String(error?.message || "");
    if (!detail.startsWith("EATELIER_EXECUTION_PROFILE_MISMATCH: ")) return false;
    record.executionProfileRefusal = {
      operation,
      detail,
      at: new Date().toISOString(),
    };
    return true;
  }

  function renderPlanControls() {
    const hasPlan = Boolean(record.plan?.text);
    const availability = planAvailability(record);
    const ready = availability.ready;
    planCard.hidden = !hasPlan;
    planText.textContent = stripAnsi(record.plan?.text || "");
    planState.textContent = record.plan?.state === "approved" ? "plan approved" : "plan ready";
    planFeedback.disabled = !ready || planActionInFlight;
    revisePlan.disabled = !ready || planActionInFlight || !planFeedback.value.trim();
    approvePlan.disabled = !ready || planActionInFlight;
    revisePlan.textContent = planActionInFlight ? "Working…" : "Revise plan";
    approvePlan.textContent = planActionInFlight ? "Working…" : "Approve plan";
    revisePlan.title = availability.reason;
    approvePlan.title = availability.reason;
    // Keep the controls visible when the refusal is the reason they are disabled,
    // so the operator can read why instead of watching them vanish.
    planActions.hidden = !ready && !availability.reason;
    planFeedback.parentElement.hidden = !ready && !availability.reason;
    planFeedback.title = availability.reason;
  }

  function updateRecordDisplay() {
    chip.className = `state-chip state-${record.state}`;
    chip.textContent = record.state.replaceAll("_", " ");
    stop.hidden = !["resuming", "running", "verifying"].includes(record.state);
    elapsed.textContent = elapsedBetween(record.startedAt, lastActivityAt(record));
    branchChip.update(record.branch);
    trustChip.update(trustProfileSummary(record));
    worktreeChip.update(record.worktreePath);
    if (openEditor) openEditor.hidden = !record.worktreePath;
    statusHistory.add(record.state);
    if (record.merged) {
      terminalDetail = `merged ${String(record.merged.commit || "").slice(0, 7)}`;
    } else if (TERMINAL_STATES.has(record.state) && !terminalDetail) {
      terminalDetail = record.exitSummary || "";
    }
    renderStatusTimeline(timeline, statusHistory, record.state, terminalDetail, Boolean(record.plan));
    renderVerification();
    renderMergeControls();
    renderReviewControls();
    renderReplyControls();
    renderPlanControls();
    renderDispatchSummary(summary, record);
    renderSidebar();
  }

  async function mergeRecord(force, forceAudit = {}) {
    mergeInFlight = true;
    renderMergeControls();
    try {
      let breakGlassToken;
      if (force) {
        try {
          const authorization = await api("/api/break-glass", {
            method: "POST",
            body: {
              dispatchId: record.id,
              action: "merge",
              targetSha: forceAudit.targetSha ?? record.branchHead ?? record.result?.commit,
              ...forceAudit,
            },
          });
          breakGlassToken = authorization.token;
        } catch (error) {
          // A stale target refusal means the dialog's captured record is stale.
          // Refresh before the caller reopens it so the current SHA is shown.
          await refreshRecord();
          throw error;
        }
      }
      record = await api(`/api/dispatch/${encoded(route.id)}/merge`, {
        method: "POST",
        body: { force, ...(breakGlassToken ? { breakGlassToken } : {}) },
      });
      const existing = state.dispatches.find((candidate) => candidate.id === record.id);
      if (existing) Object.assign(existing, record);
      else state.dispatches.unshift(record);
      showToast(`merged ${(record.merged?.commit || "unknown").slice(0, 7)}`, "success");
    } finally {
      mergeInFlight = false;
      updateRecordDisplay();
    }
  }

  async function requestReview(force = false) {
    const reviewRecord = await api(`/api/dispatch/${encoded(route.id)}/review`, {
      method: "POST",
      body: force ? { force: true } : {},
    });
    const existingReview = state.dispatches.find((candidate) => candidate.id === reviewRecord.id);
    if (existingReview) Object.assign(existingReview, reviewRecord);
    else state.dispatches.unshift(reviewRecord);
    await refreshRecord();
    showToast(`read-only review ${reviewRecord.id} started`, "success");
  }

  async function startReviewRecord(force = false) {
    reviewInFlight = true;
    renderReviewControls();
    try {
      await requestReview(force);
    } catch (error) {
      if (!force && isDispatchLimitError(error)) {
        openBudgetConfirmation(error, () => startReviewRecord(true));
      } else {
        showToast(error.message);
      }
    } finally {
      reviewInFlight = false;
      updateRecordDisplay();
    }
  }

  async function requestPlanContinuation(action, force = false) {
    record = await api(`/api/dispatch/${encoded(route.id)}/plan`, {
      method: "POST",
      body: {
        ...(action === "approve"
          ? { action }
          : { action, text: planFeedback.value.trim() }),
        ...(force ? { force: true } : {}),
        ...(acceptExecutionProfile.checked ? { acceptExecutionProfile: true } : {}),
      },
    });
    const existing = state.dispatches.find((candidate) => candidate.id === record.id);
    if (existing) Object.assign(existing, record);
    else state.dispatches.unshift(record);
    if (action === "revise") planFeedback.value = "";
    acceptExecutionProfile.checked = false;
    showToast(action === "approve" ? "Plan approved" : "Plan revision started", "success");
  }

  async function continuePlan(action) {
    const feedback = planFeedback.value.trim();
    if (action === "revise" && !feedback) return;
    planActionInFlight = true;
    renderPlanControls();
    try {
      await requestPlanContinuation(action);
    } catch (error) {
      if (action === "approve" && isDispatchLimitError(error)) {
        openBudgetConfirmation(error, async () => {
          planActionInFlight = true;
          renderPlanControls();
          try {
            await requestPlanContinuation(action, true);
          } finally {
            planActionInFlight = false;
            updateRecordDisplay();
          }
        });
      } else {
        captureExecutionProfileRefusal(error, "plan continuation");
        showToast(error.message);
      }
    } finally {
      planActionInFlight = false;
      updateRecordDisplay();
    }
  }

  async function dismissRecord() {
    dismissInFlight = true;
    renderMergeControls();
    try {
      record = await api(`/api/dispatch/${encoded(route.id)}/dismiss`, {
        method: "POST",
        body: {},
      });
      const existing = state.dispatches.find((candidate) => candidate.id === record.id);
      if (existing) Object.assign(existing, record);
      else state.dispatches.unshift(record);
      showToast(`dismissed ${record.id}`, "success");
    } catch (error) {
      showToast(error.message);
    } finally {
      dismissInFlight = false;
      updateRecordDisplay();
    }
  }

  // The POST returns as soon as the attempt is admitted (202), so the verdict
  // arrives over SSE like any other verification - the button must not pretend
  // to wait for it.
  async function rerunVerificationRecord() {
    verifyRerunInFlight = true;
    renderVerification();
    try {
      record = await api(`/api/dispatch/${encoded(route.id)}/verify`, {
        method: "POST",
        body: acceptExecutionProfile.checked ? { acceptExecutionProfile: true } : {},
      });
      const existing = state.dispatches.find((candidate) => candidate.id === record.id);
      if (existing) Object.assign(existing, record);
      else state.dispatches.unshift(record);
      acceptExecutionProfile.checked = false;
      verificationSteps.clear();
      showToast(`verification re-run started for ${record.id}`, "success");
    } catch (error) {
      captureExecutionProfileRefusal(error, "verification re-run");
      showToast(error.message);
    } finally {
      verifyRerunInFlight = false;
      updateRecordDisplay();
    }
  }

  function updateVerificationEvent(event) {
    const index = Number(event.step);
    if (!Number.isInteger(index) || index < 0) return;
    const current = verificationSteps.get(index) || { output: "" };
    if (event.type === "verify") {
      record.verify ||= { state: "running", steps: [] };
      if (event.phase === "start") record.verify.state = "running";
      verificationSteps.set(index, {
        ...current,
        command: event.command || current.command,
        phase: event.phase || current.phase,
        exitCode: event.exitCode,
        durationMs: event.durationMs,
      });
      renderVerification();
      return;
    }
    const output = verificationOutputNodes.get(index);
    const line = String(event.line || "");
    const atBottom = output
      ? output.scrollHeight - output.scrollTop - output.clientHeight < 12
      : true;
    current.output = current.output ? `${current.output}\n${line}` : line;
    verificationSteps.set(index, current);
    if (!output) {
      renderVerification();
      return;
    }
    output.append(
      document.createTextNode(`${output.textContent ? "\n" : ""}${stripAnsi(line)}`),
    );
    if (atBottom) output.scrollTop = output.scrollHeight;
  }

  updateRecordDisplay();

  function scrollToLatest() {
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }

  transcript.addEventListener("scroll", () => {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 70;
    following = nearBottom;
    follow.hidden = following;
  });
  follow.addEventListener("click", () => {
    following = true;
    follow.hidden = true;
    transcript.scrollTop = transcript.scrollHeight;
  });

  async function refreshRecord() {
    try {
      record = await api(`/api/dispatch/${encoded(route.id)}`);
      const existing = state.dispatches.find((candidate) => candidate.id === record.id);
      if (existing) Object.assign(existing, record);
      else state.dispatches.unshift(record);
      updateRecordDisplay();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function loadDiff() {
    diffPanel.replaceChildren(element("div", "loading-state", "Loading diff…"));
    try {
      const result = await api(`/api/dispatch/${encoded(route.id)}/diff?patch=1`);
      diffLoaded = true;
      state.dispatchDiffEmpty = state.dispatchDiffEmpty || {};
      state.dispatchDiffEmpty[record.id] = (result.files || []).length === 0;
      updateRecordDisplay();
      renderDiffPaneV2(diffPanel, result, (path) => {
        replyText.value = `re: ${path}\n`;
        renderReplyControls();
        replyComposer.scrollIntoView({ behavior: "smooth", block: "center" });
        replyText.focus();
      });
    } catch (error) {
      diffPanel.replaceChildren(banner(error.message, "info"));
    }
  }

  function selectTab(which) {
    const showTranscript = which === "transcript";
    transcriptPanel.hidden = !showTranscript;
    diffPanel.hidden = showTranscript;
    transcriptTab.classList.toggle("active", showTranscript);
    diffTab.classList.toggle("active", !showTranscript);
    transcriptTab.setAttribute("aria-selected", String(showTranscript));
    diffTab.setAttribute("aria-selected", String(!showTranscript));
    if (!showTranscript && !diffLoaded) void loadDiff();
  }
  transcriptTab.addEventListener("click", () => selectTab("transcript"));
  diffTab.addEventListener("click", () => selectTab("diff"));

  approveMerge.addEventListener("click", () => {
    void mergeRecord(false).catch((error) => showToast(error.message));
  });
  forceMerge.addEventListener("click", () => {
    const project = state.projects.find((candidate) => candidate.name === record.project);
    openForceMergeConfirmation(
      record,
      mergeGateReasons(record, project),
      (forceAudit) => mergeRecord(true, forceAudit),
    );
  });
  startReview.addEventListener("click", () => void startReviewRecord());
  rerunVerify.addEventListener("click", () => void rerunVerificationRecord());
  dismiss.addEventListener("click", () => {
    openDismissConfirmation(record, dismissRecord);
  });
  planFeedback.addEventListener("input", renderPlanControls);
  approvePlan.addEventListener("click", () => void continuePlan("approve"));
  revisePlan.addEventListener("click", () => void continuePlan("revise"));

  replyText.addEventListener("input", renderReplyControls);
  async function requestReply(text, force = false) {
    const replyOptions = {
      method: "POST",
      body: { text, ...(force ? { force: true } : {}) },
    };
    if (acceptExecutionProfile.checked) replyOptions.body.acceptExecutionProfile = true;
    record = await api(`/api/dispatch/${encoded(route.id)}/reply`, replyOptions);
    const existing = state.dispatches.find((candidate) => candidate.id === record.id);
    if (existing) Object.assign(existing, record);
    else state.dispatches.unshift(record);
    replyText.value = "";
    acceptExecutionProfile.checked = false;
    showToast(record.state === "running" ? "Reply sent" : "Reply accepted", "success");
  }
  replyComposer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = replyText.value.trim();
    if (!text || replySend.disabled) return;
    replyInFlight = true;
    renderReplyControls();
    try {
      await requestReply(text);
    } catch (error) {
      if (isDispatchLimitError(error)) {
        openBudgetConfirmation(error, async () => {
          replyInFlight = true;
          renderReplyControls();
          try {
            await requestReply(text, true);
          } finally {
            replyInFlight = false;
            updateRecordDisplay();
          }
        });
      } else {
        captureExecutionProfileRefusal(error, "reply resume");
        showToast(error.message);
      }
    } finally {
      replyInFlight = false;
      updateRecordDisplay();
    }
  });

  stop.addEventListener("click", async () => {
    stop.disabled = true;
    stop.textContent = "Stopping…";
    try {
      record = await api(`/api/dispatch/${encoded(route.id)}/stop`, {
        method: "POST",
        body: {},
      });
      await refreshRecord();
    } catch (error) {
      showToast(error.message);
      stop.disabled = false;
      stop.textContent = "Stop";
    }
  });

  const timer = window.setInterval(() => {
    elapsed.textContent = elapsedBetween(record.startedAt, lastActivityAt(record));
  }, 1_000);
  registerCleanup(() => window.clearInterval(timer));

  sseManager.open(
    `dispatch:${route.id}`,
    `/api/dispatch/${encoded(route.id)}/events`,
    ["status", "message", "reply", "plan", "usage", "exit", "review", "review-disposition", "verify-rerun", "verify", "verify-output", "post-merge"],
    {
      open() {
        connection.replaceChildren(element("span", "running-pulse"), document.createTextNode("Live"));
      },
      error() {
        connection.textContent = "Reconnecting…";
      },
      event(event) {
        if (!viewIsCurrent(token)) return;
        const identity = `${event.dispatchId}:${event.seq}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        void notifyTerminalDispatch(event, record);
        void notifyPostMergeFailure(event, record);
        if (event.type === "status") {
          record.state = event.state || record.state;
          statusHistory.add(record.state);
          if (event.detail) terminalDetail = event.detail;
          renderStatusTimeline(timeline, statusHistory, record.state, terminalDetail, Boolean(record.plan));
          void refreshRecord();
        } else if (event.type === "message" || event.type === "reply") {
          appendTranscriptEvent(events, event);
        } else if (event.type === "plan") {
          record.plan = { state: "ready", text: event.text || "" };
          renderPlanControls();
        } else if (event.type === "usage") {
          latestUsage = event;
          record.turns = event.turns;
          record.costUSD = event.costUSD;
          updateUsageFooter(usage, record, latestUsage);
        } else if (event.type === "exit") {
          record.exitSummary = event.summary || record.exitSummary;
          if (!terminalDetail) terminalDetail = record.exitSummary;
          renderStatusTimeline(timeline, statusHistory, record.state, terminalDetail, Boolean(record.plan));
          updateUsageFooter(usage, record, latestUsage);
          void refreshRecord();
        } else if (event.type === "review") {
          applyReviewEvent(record, event);
          if (event.branchHead) record.branchHead = event.branchHead;
          if (Array.isArray(event.gates)) record.gates = event.gates;
          else void refreshRecord();
          updateRecordDisplay();
        } else if (event.type === "review-disposition") {
          applyReviewDispositionEvent(record, event);
          updateRecordDisplay();
          void refreshRecord();
        } else if (event.type === "verify-rerun") {
          // A re-run's steps are a fresh list; keeping the failed attempt's rows
          // on screen would attribute them to the attempt now running.
          if (event.phase === "start") verificationSteps.clear();
          if (event.phase === "end" && event.flipped) {
            showToast(
              `verification ${event.verdict} on attempt ${event.attempt} (was ${event.previousState})`,
              event.verdict === "passed" ? "success" : undefined,
            );
          }
          void refreshRecord();
        } else if (event.type === "verify" || event.type === "verify-output") {
          updateVerificationEvent(event);
        } else if (event.type === "post-merge") {
          applyPostMergeEvent(record, event);
          renderMergedStatus(mergedStatus, record);
          if (event.phase === "end") void refreshRecord();
        }
        scrollToLatest();
      },
    },
  );
}

async function renderGroup(route, token) {
  const group = groupByName(route.name);
  if (!group) {
    renderNotFound(`Unknown group: ${route.name}`);
    return;
  }
  if (!viewIsCurrent(token)) return;
  const fragment = document.createDocumentFragment();
  fragment.append(
    viewHeader({
      eyebrow: "Project group",
      title: group.name,
      description: group.note || `${group.projects.length} linked projects`,
    }),
  );
  const members = element("div", "card-meta");
  for (const projectName of group.projects) members.append(badge(projectName, "repo-chip"));
  fragment.append(members);
  const unavailable = element("section", "git-state-card");
  unavailable.append(
    element("h2", "", "Group board unavailable"),
    element(
      "p",
      "",
      "This Atelier server exposes group metadata but no group state endpoint. The UI will not invent a union or fan-out dispatch contract.",
    ),
  );
  fragment.append(unavailable);
  app.replaceChildren(fragment);
}

const STYLEGUIDE_COLOR_TOKENS = [
  "--bg",
  "--panel",
  "--panel-raised",
  "--line",
  "--text",
  "--muted",
  "--accent",
  "--accent-strong",
  "--on-accent",
  "--success",
  "--danger",
  "--warning",
  "--verify",
  "--info",
  "--triage",
  "--priority-0",
  "--priority-1",
  "--priority-2",
  "--priority-3",
  "--priority-4",
  "--ready",
  "--blocked",
  "--progress",
  "--closed",
  "--page-glow",
  "--brand-border",
  "--brand-bg",
  "--focus-ring",
  "--status-ring",
  "--pulse-ring",
  "--pulse-clear",
  "--modal-backdrop",
  "--elevation-color-sm",
  "--elevation-color-md",
  "--elevation-color-lg",
  "--shadow-color",
];

const STYLEGUIDE_DISPATCH_STATES = [
  "queued",
  "preparing",
  "resuming",
  "running",
  "plan_ready",
  "verifying",
  "stopping",
  "completed",
  "completed_empty",
  "needs_input",
  "failed",
  "stopped",
  "prepare_failed",
  "rejected",
];

function styleguideSection(title, description) {
  const section = element("section", "styleguide-section");
  const header = element("header", "styleguide-section-header");
  header.append(element("p", "eyebrow", "Inventory"), element("h2", "", title));
  if (description) header.append(element("p", "", description));
  const content = element("div", "styleguide-section-content");
  section.append(header, content);
  return { section, content };
}

function styleguideGroup(title) {
  const group = element("section", "styleguide-component-group");
  group.append(element("h3", "section-label", title));
  const content = element("div", "styleguide-component-row");
  group.append(content);
  return { group, content };
}

function styleguideIssueCard(priority, assignee = "") {
  const card = element("article", `issue-card priority-p${priority}`);
  const meta = element("div", "card-meta");
  meta.append(
    element("span", "card-id", `atelier-demo-${priority}`),
    badge("task"),
    badge(`P${priority}`, `priority-chip p${priority}`),
  );
  if (assignee) meta.append(element("span", "card-assignee", `@${assignee}`));
  card.append(meta, element("div", "card-title", `Priority ${priority} issue card`));
  return card;
}

function styleguideToggle(label, { enabled = false, disabled = false } = {}) {
  const toggle = button("", `queue-toggle${enabled ? " enabled" : ""}`);
  toggle.disabled = disabled;
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(enabled));
  toggle.setAttribute("aria-label", label);
  toggle.append(element("span", "queue-toggle-knob"), element("span", "queue-toggle-label", label));
  return toggle;
}

function renderStyleguide(token) {
  if (!viewIsCurrent(token)) return;
  app.classList.add("styleguide-view");
  document.documentElement.removeAttribute("data-density");

  const header = viewHeader({
    eyebrow: "Design system",
    title: "Atelier styleguide",
    description:
      "A live inventory of Atelier tokens, scales, components, and states. Values are read from the active theme.",
  });

  const controls = element("div", "styleguide-controls panel");
  const controlsCopy = element("div");
  controlsCopy.append(
    element("span", "section-label", "Preview controls"),
    element("p", "", "Cycle the active theme or preview the dormant compact-density hook."),
  );
  const controlsActions = element("div", "toolbar");
  const themePreview = document.createElement("select");
  themePreview.className = "sidebar-toggle theme-select";
  themePreview.setAttribute("aria-label", "Theme");
  populateThemeSelect(themePreview);
  const densityPreview = styleguideToggle("Comfortable");
  controlsActions.append(themePreview, densityPreview);
  controls.append(controlsCopy, controlsActions);

  const tokens = styleguideSection(
    "Token swatches",
    "Every semantic color token is read live from the root element, so this inventory follows the CSS source of truth.",
  );
  const tokenGrid = element("div", "styleguide-token-grid");
  tokens.content.append(tokenGrid);

  const scales = styleguideSection(
    "Scales",
    "Fluid type, density-aware spacing, radii, and elevation geometry.",
  );
  const scaleGrid = element("div", "styleguide-scale-grid");
  scales.content.append(scaleGrid);

  const components = styleguideSection(
    "Components in all states",
    "Static examples use production classes and need no tracker or dispatch data.",
  );

  const buttons = styleguideGroup("Buttons");
  const disabledButton = button("Disabled", "button");
  disabledButton.disabled = true;
  buttons.content.append(
    button("Default"),
    button("Open in editor"),
    button("Primary", "button primary"),
    button("Danger", "button danger"),
    button("Compact", "button compact"),
    disabledButton,
  );

  const projectNavigation = styleguideGroup("Project tabs and settings");
  const projectPreview = element("div", "styleguide-project-preview");
  const projectTabs = element("div", "tabs project-tabs");
  const projectTabList = element("nav", "tab-list");
  projectTabList.append(
    button("Board", "tab"),
    button("Dispatches", "tab"),
    button("Settings", "tab active"),
  );
  projectTabs.append(projectTabList);
  const projectSettings = element("section", "project-settings-form panel");
  const readOnlyName = element("input");
  readOnlyName.value = "atelier";
  readOnlyName.readOnly = true;
  const sampleNotes = element("textarea");
  sampleNotes.value = "Local agent cockpit";
  const sampleAutomation = checkboxSetting("Auto-close tickets on merge", true, {
    hint: "Close a ticket after its dispatch is merged.",
  });
  projectSettings.append(
    field("Name", readOnlyName),
    field("Notes", sampleNotes, "field wide"),
    sampleAutomation.wrapper,
  );
  projectPreview.append(projectTabs, projectSettings);
  projectNavigation.content.append(projectPreview);

  const dispatchFilters = styleguideGroup("Dispatch filter bar");
  dispatchFilters.content.append(styleguideDispatchFilters());

  const badges = styleguideGroup("Badges");
  badges.content.append(
    badge("default"),
    badge("triage", "triage"),
    badge("repository", "repo-chip"),
    badge("committed", "tracker-committed"),
    badge("personal", "tracker-personal"),
    badge("no tracker", "tracker-none"),
    badge("verify running", "verification-verdict verify-running"),
    badge("verify passed", "verification-verdict verify-passed"),
    badge("verify failed", "verification-verdict verify-failed"),
    badge("verify skipped", "verification-verdict verify-skipped"),
    badge("merged", "merged"),
    badge("convoy 2", "convoy"),
    badge("bake-off", "bakeoff"),
    badge("filtered view", "filtered-view-badge"),
    ...[0, 1, 2, 3, 4].map((priority) =>
      badge(`P${priority}`, `priority-chip p${priority}`),
    ),
  );

  const states = styleguideGroup("Dispatch state chips");
  states.content.append(...STYLEGUIDE_DISPATCH_STATES.map((dispatchState) => stateChip(dispatchState)));

  const cards = styleguideGroup("Issue cards");
  const cardGrid = element("div", "styleguide-card-grid");
  for (let priority = 0; priority <= 4; priority += 1) {
    cardGrid.append(styleguideIssueCard(priority, priority === 2 ? "operator" : ""));
  }
  cards.content.append(cardGrid);

  const columnGroup = styleguideGroup("Column with fixed header and scrolling body");
  const { column, body: columnCards } = boardColumn("ready", "Ready", 6);
  column.classList.add("styleguide-column");
  columnCards.append(
    styleguideIssueCard(0),
    styleguideIssueCard(2, "operator"),
    styleguideIssueCard(4),
    styleguideIssueCard(3),
    styleguideIssueCard(1),
    styleguideIssueCard(2),
  );
  columnGroup.content.append(column);

  const timelineGroup = styleguideGroup("Status timeline");
  const timeline = element("section", "status-timeline styleguide-timeline");
  timeline.setAttribute("aria-label", "Example dispatch status timeline");
  for (const [label, className] of [
    ["reached", "reached"],
    ["resuming", "reached current"],
    ["pending", ""],
  ]) {
    const step = element("div", `timeline-step${className ? ` ${className}` : ""}`);
    step.append(element("span", "timeline-dot"), element("span", "timeline-label", label));
    timeline.append(step);
  }
  timelineGroup.content.append(timeline);

  const transcriptCards = styleguideGroup("Transcript activity");
  const transcriptPreview = element("div", "transcript-events styleguide-transcript");
  for (const event of [
    { type: "message", kind: "text", text: "I found the parser boundary and am updating its focused tests." },
    {
      type: "message",
      kind: "tool_use",
      name: "Bash",
      caption: "12:04:18",
      inputPreview: JSON.stringify({ command: "node --test server/lib/agents/codex.test.mjs" }),
      truncated: true,
    },
    { type: "message", kind: "tool_result", preview: "Exit 0", exitCode: 0, caption: "12:04:20" },
    { type: "message", kind: "files", text: "Applying 3 file changes" },
    { type: "message", kind: "tool_result", preview: "Exit 7", exitCode: 7, caption: "12:04:23" },
    { type: "message", kind: "raw", text: "unmatched companion detail preserved as raw output" },
  ]) {
    appendTranscriptEvent(transcriptPreview, event);
  }
  transcriptCards.content.append(transcriptPreview);

  const replies = styleguideGroup("Reply composer states");
  replies.content.append(
    styleguideReplyComposer("Send now", "Send live input to Claude Code."),
    styleguideReplyComposer(
      "Reply & resume",
      "Continue the captured Claude Code session in this worktree.",
    ),
    styleguideReplyComposer(
      "Reply unavailable",
      "Codex does not accept live input.",
      true,
    ),
  );

  const diffPane = styleguideGroup("Diff pane v2");
  const diffPreview = element("section", "diff-pane styleguide-diff-pane");
  renderDiffPaneV2(
    diffPreview,
    {
      files: [
        { path: "ui/app.js", insertions: 2, deletions: 1 },
        { path: "docs/DESIGN.md", insertions: 1, deletions: 0 },
      ],
      insertions: 3,
      deletions: 1,
      patch: [
        "diff --git a/ui/app.js b/ui/app.js",
        "--- a/ui/app.js",
        "+++ b/ui/app.js",
        "@@ -1,2 +1,3 @@",
        "-const oldValue = true;",
        "+const newValue = true;",
        "+const visible = true;",
        "diff --git a/docs/DESIGN.md b/docs/DESIGN.md",
        "--- a/docs/DESIGN.md",
        "+++ b/docs/DESIGN.md",
        "@@ -1 +1,2 @@",
        " Atelier design",
        "+Structured diffs",
      ].join("\n"),
    },
    () => {},
  );
  diffPane.content.append(diffPreview);

  const toasts = styleguideGroup("Toasts");
  const toastSamples = element("div", "styleguide-toast-samples");
  toastSamples.append(
    element("div", "toast", "Dispatch settings saved"),
    element("div", "toast error", "Dispatch could not be created"),
  );
  toasts.content.append(toastSamples);

  const banners = styleguideGroup("Banners");
  const bannerStack = element("div", "banner-stack styleguide-banner-stack");
  bannerStack.append(
    banner("Primary checkout has uncommitted changes."),
    banner("Dispatch failed its verification gate.", "error"),
    banner("Work always runs in an isolated worktree.", "info"),
  );
  banners.content.append(bannerStack);

  const forms = styleguideGroup("Form controls");
  const formGrid = element("div", "styleguide-form-grid");
  const textInput = element("input");
  textInput.value = "Editable value";
  const disabledInput = element("input");
  disabledInput.value = "Disabled value";
  disabledInput.disabled = true;
  const select = element("select");
  const firstOption = element("option", "", "Sonnet");
  firstOption.value = "sonnet";
  const secondOption = element("option", "", "Opus");
  secondOption.value = "opus";
  select.append(firstOption, secondOption);
  const disabledSelect = element("select");
  disabledSelect.disabled = true;
  disabledSelect.append(element("option", "", "Disabled select"));
  formGrid.append(
    field("Input", textInput),
    field("Input disabled", disabledInput),
    field("Select", select),
    field("Select disabled", disabledSelect),
  );
  const toggleSamples = element("div", "styleguide-toggle-samples");
  toggleSamples.append(
    styleguideToggle("Off"),
    styleguideToggle("On", { enabled: true }),
    styleguideToggle("Disabled", { disabled: true }),
  );
  forms.content.append(formGrid, toggleSamples);

  const modalGroup = styleguideGroup("Modal frame");
  const modalExample = element("section", "modal-root styleguide-modal-frame");
  modalExample.setAttribute("role", "dialog");
  modalExample.setAttribute("aria-label", "Static modal frame example");
  const modalHeader = element("header", "modal-header");
  const modalTitle = element("div");
  modalTitle.append(element("div", "card-id", "atelier-demo"), element("h2", "", "Review dispatch"));
  const modalClose = button("×", "icon-button");
  modalClose.setAttribute("aria-label", "Close example");
  modalHeader.append(modalTitle, modalClose);
  const modalBody = element("div", "modal-body");
  modalBody.append(
    element("p", "confirm-copy", "This static frame demonstrates modal chrome without opening a dialog."),
  );
  const ticketDispatches = element("section", "ticket-dispatch-links");
  ticketDispatches.append(element("div", "section-label", "Dispatch history"));
  const ticketDispatchRow = element("div", "ticket-dispatch-link-row");
  ticketDispatchRow.append(
    element("a", "table-link", "View dispatch demo-1 →"),
    stateChip("running"),
  );
  ticketDispatches.append(ticketDispatchRow);
  const dispatchGate = button("Dispatch", "button primary compact");
  dispatchGate.disabled = true;
  dispatchGate.title = "Ticket is being worked by dispatch demo-1.";
  modalBody.append(
    ticketDispatches,
    element("p", "dispatch-gate-hint", "Dispatch unavailable: being worked by dispatch demo-1."),
    dispatchGate,
  );
  const modalActions = element("div", "modal-actions");
  modalActions.append(button("Cancel"), button("Confirm", "button primary"));
  modalBody.append(modalActions);
  modalExample.append(modalHeader, modalBody);
  modalGroup.content.append(modalExample);

  components.content.append(
    buttons.group,
    projectNavigation.group,
    dispatchFilters.group,
    badges.group,
    states.group,
    cards.group,
    columnGroup.group,
    timelineGroup.group,
    transcriptCards.group,
    replies.group,
    diffPane.group,
    toasts.group,
    banners.group,
    forms.group,
    modalGroup.group,
  );

  function tokenValue(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "unset";
  }

  function renderTokenSwatches() {
    const fragment = document.createDocumentFragment();
    for (const name of STYLEGUIDE_COLOR_TOKENS) {
      const swatch = element("div", "styleguide-token-swatch");
      const color = element("span", "styleguide-token-color");
      color.style.background = `var(${name})`;
      swatch.append(
        color,
        element("code", "styleguide-token-name", name),
        element("span", "styleguide-token-value", tokenValue(name)),
      );
      fragment.append(swatch);
    }
    tokenGrid.replaceChildren(fragment);
  }

  function scaleBlock(title, names, buildSample) {
    const block = element("section", "styleguide-scale-block");
    block.append(element("h3", "section-label", title));
    const samples = element("div", "styleguide-scale-samples");
    for (const name of names) samples.append(buildSample(name));
    block.append(samples);
    return block;
  }

  function renderScales() {
    const type = scaleBlock(
      "Type ramp",
      [1, 2, 3, 4, 5, 6].map((step) => `--fs-${step}`),
      (name) => {
        const sample = element("div", "styleguide-type-sample");
        const text = element("span", "", "Atelier agent cockpit");
        text.style.fontSize = `var(${name})`;
        sample.append(
          element("code", "", name),
          text,
          element("span", "styleguide-scale-value", tokenValue(name)),
        );
        return sample;
      },
    );
    const spacing = scaleBlock(
      "Spacing",
      [1, 2, 3, 4, 5, 6, 7, 8].map((step) => `--space-${step}`),
      (name) => {
        const sample = element("div", "styleguide-spacing-sample");
        const bar = element("span", "styleguide-spacing-bar");
        bar.style.width = `calc(var(${name}) * 5)`;
        sample.append(
          element("code", "", name),
          bar,
          element("span", "styleguide-scale-value", tokenValue(name)),
        );
        return sample;
      },
    );
    const radii = scaleBlock(
      "Radii",
      [1, 2, 3, 4, 5].map((step) => `--radius-${step}`),
      (name) => {
        const sample = element("div", "styleguide-radius-sample");
        const shape = element("span", "styleguide-radius-shape");
        shape.style.borderRadius = `var(${name})`;
        sample.append(shape, element("code", "", name), element("span", "styleguide-scale-value", tokenValue(name)));
        return sample;
      },
    );
    const elevation = scaleBlock(
      "Elevation",
      ["--card-shadow", "--card-shadow-hover", "--panel-shadow", "--shadow"],
      (name) => {
        const sample = element("div", "styleguide-elevation-sample");
        const box = element("span", "styleguide-elevation-box");
        box.style.boxShadow = `var(${name})`;
        sample.append(box, element("code", "", name), element("span", "styleguide-scale-value", tokenValue(name)));
        return sample;
      },
    );
    scaleGrid.replaceChildren(type, spacing, radii, elevation);
  }

  function syncThemePreview() {
    themePreview.value = document.documentElement.dataset.theme || "auto";
    renderTokenSwatches();
  }

  function syncDensityPreview() {
    const compact = document.documentElement.dataset.density === "compact";
    densityPreview.classList.toggle("enabled", compact);
    densityPreview.setAttribute("aria-checked", String(compact));
    densityPreview.setAttribute("aria-label", compact ? "Use comfortable density" : "Preview compact density");
    densityPreview.querySelector(".queue-toggle-label").textContent = compact
      ? "Compact"
      : "Comfortable";
    renderScales();
  }

  themePreview.addEventListener("change", () => {
    setTheme(themePreview.value);
    syncThemePreview();
  });
  densityPreview.addEventListener("click", () => {
    if (document.documentElement.dataset.density === "compact") {
      document.documentElement.removeAttribute("data-density");
    } else {
      document.documentElement.dataset.density = "compact";
    }
    syncDensityPreview();
  });
  appearanceSelect.addEventListener("change", syncThemePreview);
  registerCleanup(() => {
    document.documentElement.removeAttribute("data-density");
    appearanceSelect.removeEventListener("change", syncThemePreview);
  });

  app.replaceChildren(header, controls, tokens.section, scales.section, components.section);
  syncThemePreview();
  syncDensityPreview();
}

function renderNotFound(message = "This Atelier view does not exist") {
  const dispatches = button("View all dispatches", "button primary");
  dispatches.addEventListener("click", () => navigate({ kind: "dispatches" }));
  app.replaceChildren(
    viewHeader({ eyebrow: "Not found", title: "Unknown view", description: message, actions: [dispatches] }),
  );
}

// Deliberately plain (atelier-e5x): a route and a table over GET /api/logs. The
// activity-feed rendering of these same events is atelier-28n's job, and this view
// exists so the mechanism is inspectable before that lands.
const LOG_VIEW_LIMITS = [50, 200, 500, 1_000];

async function renderLogs(_route, token) {
  const filters = {
    kind: "",
    project: "",
    limit: 200,
  };
  const kindFilter = element("input");
  kindFilter.type = "search";
  kindFilter.placeholder = "kind, or a comma-separated list";
  kindFilter.setAttribute("aria-label", "Filter by event kind");
  const projectFilter = element("select");
  projectFilter.setAttribute("aria-label", "Filter by project");
  projectFilter.append(option("", "All projects", ""));
  for (const project of state.projects) {
    projectFilter.append(option(project.name, project.name, ""));
  }
  const limitFilter = element("select");
  limitFilter.setAttribute("aria-label", "Maximum events");
  for (const value of LOG_VIEW_LIMITS) {
    limitFilter.append(option(String(value), `${value} events`, "200"));
  }
  const refresh = button("Refresh", "button compact");
  const count = element("span", "dispatch-filter-count");
  count.setAttribute("aria-live", "polite");
  const filterBar = element("form", "dispatch-filter-bar");
  filterBar.setAttribute("aria-label", "Filter events");
  filterBar.addEventListener("submit", (event) => event.preventDefault());
  filterBar.append(kindFilter, projectFilter, limitFilter, refresh, count);
  const tableHost = element("section", "panel log-table-host");
  const fragment = document.createDocumentFragment();
  fragment.append(
    viewHeader({
      eyebrow: "Observability",
      title: "Event log",
      description:
        "Every consequential decision Atelier made: queue drains, dispatch transitions, settings changes, budget verdicts.",
    }),
    filterBar,
    tableHost,
  );
  if (!viewIsCurrent(token)) return;
  app.replaceChildren(fragment);

  function renderRows(events) {
    if (events.length === 0) {
      tableHost.replaceChildren(
        element("p", "empty-state", "No events match these filters yet."),
      );
      return;
    }
    const table = element("table", "log-table");
    const head = element("thead");
    const headRow = element("tr");
    for (const label of ["Time", "Kind", "Project", "Actor", "Detail"]) {
      headRow.append(element("th", "", label));
    }
    head.append(headRow);
    const body = element("tbody");
    // Newest first here even though the API returns chronological order: an
    // operator opens this view to see what just happened.
    for (const event of [...events].reverse()) {
      const row = logEventRow(event);
      const tr = element("tr");
      tr.append(
        element("td", "log-cell-time", row.time),
        element("td", "log-cell-kind", row.kind),
        element("td", "", row.project),
        element("td", "", row.actor),
        element("td", "log-cell-detail", row.summary),
      );
      body.append(tr);
    }
    table.append(head, body);
    tableHost.replaceChildren(table);
  }

  async function load() {
    count.textContent = "Loading…";
    try {
      const payload = await api(`/api/logs${logQueryString(filters)}`);
      if (!viewIsCurrent(token)) return;
      const events = Array.isArray(payload.events) ? payload.events : [];
      count.textContent = logResultLabel(events.length, payload.truncated === true);
      renderRows(events);
    } catch (error) {
      if (!viewIsCurrent(token)) return;
      count.textContent = "";
      tableHost.replaceChildren(banner(`Could not read the event log: ${error.message}`, "error"));
    }
  }

  kindFilter.addEventListener("change", () => {
    filters.kind = kindFilter.value;
    void load();
  });
  projectFilter.addEventListener("change", () => {
    filters.project = projectFilter.value;
    void load();
  });
  limitFilter.addEventListener("change", () => {
    filters.limit = Number(limitFilter.value);
    void load();
  });
  refresh.addEventListener("click", () => void load());
  await load();
}

async function renderRoute() {
  const route = parseRoute();
  state.route = route;
  renderSidebar();
  const token = beginView();
  renderSidebar();
  try {
    if (route.kind === "project") await renderProject(route, token);
    else if (route.kind === "dispatch") await renderDispatch(route, token);
    else if (route.kind === "group") await renderGroup(route, token);
    else if (route.kind === "styleguide") renderStyleguide(token);
    else if (route.kind === "logs") await renderLogs(route, token);
    else if (route.kind === "dispatches") await renderAllDispatches(route, token);
    else renderNotFound();
    if (viewIsCurrent(token)) app.focus({ preventScroll: true });
  } catch (error) {
    if (!viewIsCurrent(token)) return;
    const retry = button("Retry", "button primary");
    retry.addEventListener("click", () => void renderRoute());
    app.replaceChildren(
      viewHeader({ eyebrow: "Atelier error", title: "Could not render view", description: error.message, actions: [retry] }),
    );
    showToast(error.message);
  }
}

modal.addEventListener("click", (event) => {
  if (event.target === modal) closeModal();
});

notificationToggle.addEventListener("click", () => void toggleNotifications());
populateThemeSelect(appearanceSelect);
appearanceSelect.addEventListener("change", () => setTheme(appearanceSelect.value));
worldThemeSelect.addEventListener("change", () => {
  void activateWorldTheme(worldThemeSelect.value);
});
themeHostSwitcher.addEventListener("change", () => {
  void activateWorldTheme(themeHostSwitcher.value);
});
themeDashboardReturn.addEventListener("click", () => {
  void activateWorldTheme("dashboard");
});
themeCommandTrigger.addEventListener("click", openCommandPalette);
sidebarMenuToggle.addEventListener("click", () => {
  setSidebarOpen(sidebarMenuToggle.getAttribute("aria-expanded") !== "true");
});
sidebarBackdrop.addEventListener("click", () => setSidebarOpen(false));
window.addEventListener("keydown", (event) => {
  if (shouldReturnToDashboard(event, document.body.classList.contains("theme-active"))) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void activateWorldTheme("dashboard");
    return;
  }
  if (event.key === "Escape") setSidebarOpen(false);
});
window.addEventListener("keydown", handleGlobalShortcut);

window.addEventListener("hashchange", () => {
  setSidebarOpen(false);
  void renderRoute();
});
window.addEventListener("beforeunload", () => {
  cleanupView();
  boardSseManager.close();
  void leaveActiveTheme();
});

async function bootstrap() {
  applyTheme();
  initializeNotifications();
  try {
    const sessionResponse = await fetch("/api/session");
    const session = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || typeof session.csrfToken !== "string") {
      throw new Error(session.error || `Session bootstrap failed with ${sessionResponse.status}`);
    }
    setAtelierCsrfToken(session.csrfToken);
    setWorldThemeInventory(await api("/api/themes"));
    await loadShell();
    boardSseManager.open();
    await activateWorldTheme(storageGet("atelier-world-theme", "dashboard"), {
      remember: false,
    });
    if (!location.hash) {
      const remembered = storageGet("atelier-last-project");
      const project = projectByName(remembered) || state.projects[0];
      navigate(project ? { kind: "project", name: project.name } : { kind: "dispatches" });
      return;
    }
    await renderRoute();
  } catch (error) {
    sidebar.replaceChildren(element("p", "sidebar-loading", "Registry unavailable"));
    app.replaceChildren(
      viewHeader({
        eyebrow: "Atelier error",
        title: "Could not load Atelier",
        description: error.message,
      }),
    );
    showToast(error.message);
  }
}

void bootstrap();
