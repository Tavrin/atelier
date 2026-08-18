import {
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
  // Records written before ATT-009 have no discriminator and must retain their
  // original companion lifecycle. Every new record persists an explicit choice.
  return entry?.record?.codexAdapter !== "app-server";
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
  capabilities: codexAppServerAgent.capabilities,
  options: (...args) => codexAppServerAgent.options(...args),
  resolveModel: (...args) => companionAgent.resolveModel(...args),
  validate: (...args) => codexAppServerAgent.validate(...args),
  executionEnv(env, { project } = {}) {
    return project?.legacyCodexCompanion
      ? companionAgent.executionEnv(env)
      : codexAppServerAgent.executionEnv(env);
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

export const _legacyCodexWarning = LEGACY_WARNING;

export function _setPollIntervalMs(value) {
  setCompanionPollIntervalMs(value);
  setAppServerPollIntervalMs(value);
}
