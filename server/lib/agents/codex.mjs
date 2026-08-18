import {
  _setAppServerProber as setAppServerProber,
  _setModelFileOps as setAppServerModelFileOps,
  _setPollIntervalMs as setAppServerPollIntervalMs,
  codexAppServerAgent,
} from "./codex-app-server.mjs";
import {
  _setModelFileOps as setCompanionModelFileOps,
  _setPollIntervalMs as setCompanionPollIntervalMs,
  codexAgent as companionAgent,
} from "./codex-companion.mjs";

const LEGACY_WARNING =
  "deprecated Codex companion adapter selected; migrate this project to the supported Codex app-server adapter";

function legacy(entry) {
  const record = entry?.record ?? {};
  if (record.codexAdapter === "legacy-companion") return true;
  if (record.codexAdapter === "app-server") return false;
  // Owner ruling C1: an undiscriminated record is legacy only when it carries
  // durable companion evidence. The companion must then come from its recorded
  // profile; this branch never authorizes a fresh plugin-cache glob.
  return Boolean(
    record.codexJobId ||
    record.codexWorkspace ||
    record.executionProfile?.companionPath,
  );
}

function selected(entry) {
  return legacy(entry) ? companionAgent : codexAppServerAgent;
}

function warnLegacy(entry) {
  if (!legacy(entry)) return;
  if (!Array.isArray(entry.record.warnings)) entry.record.warnings = [];
  if (!entry.record.warnings.includes(LEGACY_WARNING)) entry.record.warnings.push(LEGACY_WARNING);
}

export const codexAgent = Object.freeze({
  id: "codex",
  displayName: "Codex",
  networkAccess: "required",
  capabilities: codexAppServerAgent.capabilities,
  options: (...args) => codexAppServerAgent.options(...args),
  resolveModel: (...args) => companionAgent.resolveModel(...args),
  validate: (...args) => codexAppServerAgent.validate(...args),
  executionEnv(env, { project, entry } = {}) {
    const useLegacy = entry
      ? legacy(entry)
      : project?.legacyCodexCompanion === true;
    return useLegacy ? companionAgent.executionEnv(env) : codexAppServerAgent.executionEnv(env);
  },
  executionProfile(options) {
    return selected(options.entry).executionProfile(options);
  },
  async preLaunchChecks(options) {
    warnLegacy(options.entry);
    return selected(options.entry).preLaunchChecks(options);
  },
  launch(options) {
    warnLegacy(options.entry);
    return selected(options.entry).launch(options);
  },
  resume(options) {
    warnLegacy(options.entry);
    return selected(options.entry).resume(options);
  },
  reattach(options) {
    return selected(options.entry).reattach(options);
  },
  detach(options) {
    return selected(options.entry).detach(options);
  },
  stop(options) {
    return selected(options.entry).stop(options);
  },
});

export {
  _extractUsage,
  _parseCompanionLogLines,
  _recordUsage,
  _setCompanionResolver,
  _setGitDirFileOps,
  _setLogFileOps,
  _setLogPath,
  _tailLogOnce,
} from "./codex-companion.mjs";

export function _setModelFileOps(nextFileOps) {
  setAppServerModelFileOps(nextFileOps);
  setCompanionModelFileOps(nextFileOps);
}

export function _setAppServerProber(nextProber) {
  setAppServerProber(nextProber);
}

export const _legacyCodexWarning = LEGACY_WARNING;

export function _setPollIntervalMs(value) {
  setCompanionPollIntervalMs(value);
  setAppServerPollIntervalMs(value);
}
