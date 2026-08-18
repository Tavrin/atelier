import { mkdir } from "node:fs/promises";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { configDir } from "./paths.mjs";
import { readFileNoFollowSync, writeFileAtomic } from "./fs-integrity.mjs";
import { agents } from "./agents/index.mjs";
import { SECRET_ENV_KEY } from "./exec.mjs";
import { assertAllowedDispatchEnvKey } from "./execution/environment-policy.mjs";

const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const DISPATCH_ENV_KEY = /^[A-Z][A-Z0-9_]*$/;
const TRACKER_MODES = new Set(["committed", "personal", "none"]);
const ARCHETYPES = new Set(["full", "git-only", "tracker-only"]);
const REVIEW_POLICIES = new Set(["strict", "tiered", "advisory"]);
const VERIFY_MODES = new Set([
  "worktree",
  "container-primary",
  "primary-postmerge",
  "advisory",
]);
const PROJECT_OWN_DISPATCH_PROFILE = Symbol("projectOwnDispatchProfile");
const PROJECT_OWN_MAX_FIX_ROUNDS = Symbol("projectOwnMaxFixRounds");

export const DEFAULTS = Object.freeze({
  dispatchProfile: Object.freeze({}),
  maxFixRounds: 4,
});

export const STARTER_REGISTRY = Object.freeze({
  version: 1,
  defaults: Object.freeze({}),
  groups: Object.freeze([]),
  projects: Object.freeze([]),
});

export class RegistryError extends Error {
  constructor(problems) {
    super(`Invalid Atelier registry:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "RegistryError";
    this.problems = problems;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExistingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isGitCheckout(path) {
  return typeof path === "string" && existsSync(join(path, ".git"));
}

function canonicalize(path) {
  // Resolve symlinks so containment checks cannot be dodged with paths
  // like /proc/self/cwd/... - for not-yet-created paths, canonicalize the
  // nearest existing ancestor and rejoin the remainder.
  let base = resolve(path);
  const tail = [];
  while (base !== dirname(base) && !existsSync(base)) {
    tail.unshift(basename(base));
    base = dirname(base);
  }
  try {
    base = realpathSync(base);
  } catch {
    // Unreadable ancestor: fall back to the resolved lexical form.
  }
  return join(base, ...tail);
}

function pathIsStrictlyInside(candidate, parent) {
  const segment = relative(canonicalize(parent), canonicalize(candidate));
  return segment !== "" && !segment.startsWith("..") && !isAbsolute(segment);
}

export function projectArchetype(project) {
  if (ARCHETYPES.has(project?.archetype)) return project.archetype;
  return isGitCheckout(project?.path) && project?.tracker !== "none" ? "full" : "git-only";
}

function validateDispatchEnv(dispatchEnv, prefix) {
  if (dispatchEnv === undefined) return [];
  if (!isObject(dispatchEnv)) return [`${prefix} must be an object`];

  const problems = [];
  for (const [key, value] of Object.entries(dispatchEnv)) {
    if (!DISPATCH_ENV_KEY.test(key)) {
      problems.push(`${prefix}.${key} key must match ${DISPATCH_ENV_KEY}`);
    }
    if (SECRET_ENV_KEY.test(key)) {
      problems.push(`${prefix}.${key} is secret-shaped; secrets do not belong in the registry`);
    }
    try {
      assertAllowedDispatchEnvKey(key);
    } catch (error) {
      problems.push(`${prefix}.${error.message}`);
    }
    if (typeof value !== "string") {
      problems.push(`${prefix}.${key} must be a string`);
    } else if (value.includes("\0")) {
      problems.push(`${prefix}.${key} must not contain NUL`);
    }
  }
  return problems;
}

function validateDispatchProfile(profile, prefix) {
  if (profile === undefined) return [];
  if (!isObject(profile)) return [`${prefix} must be an object`];

  const problems = [];
  for (const key of ["model", "defaultModel", "effort", "lane", "agent"]) {
    if (profile[key] !== undefined && (typeof profile[key] !== "string" || !profile[key])) {
      problems.push(`${prefix}.${key} must be a non-empty string`);
    }
  }
  if (
    profile.maxTurns !== undefined &&
    (!Number.isInteger(profile.maxTurns) || profile.maxTurns < 1)
  ) {
    problems.push(`${prefix}.maxTurns must be a positive integer`);
  }
  if (profile.allowedTools !== undefined) {
    if (!Array.isArray(profile.allowedTools)) {
      problems.push(`${prefix}.allowedTools must be an array of strings`);
    } else {
      for (let index = 0; index < profile.allowedTools.length; index += 1) {
        if (typeof profile.allowedTools[index] !== "string") {
          problems.push(`${prefix}.allowedTools[${index}] must be a string`);
        }
      }
    }
  }
  problems.push(...validateDispatchEnv(profile.dispatchEnv, `${prefix}.dispatchEnv`));
  return problems;
}

function validateEditorCommand(editorCommand) {
  if (editorCommand === undefined) return [];
  if (typeof editorCommand !== "string" || !editorCommand) {
    return ["defaults.editorCommand must be a non-empty string"];
  }
  if (/\s/.test(editorCommand) || /[;&|<>()$`'"{}\[\]*?!#~]/.test(editorCommand)) {
    return ["defaults.editorCommand must not contain spaces or shell metacharacters"];
  }
  const executableName = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
  if (!isAbsolute(editorCommand) && !executableName.test(editorCommand)) {
    return ["defaults.editorCommand must be an executable name or absolute path"];
  }
  return [];
}

export function validateProject(project, index = 0) {
  const prefix = `projects[${index}]`;
  const problems = [];

  if (!isObject(project)) {
    return [`${prefix} must be an object`];
  }

  if (typeof project.name !== "string" || !PROJECT_NAME.test(project.name)) {
    problems.push(`${prefix}.name must match ${PROJECT_NAME}`);
  }

  if (typeof project.path !== "string" || !isAbsolute(project.path)) {
    problems.push(`${prefix}.path must be an absolute path`);
  } else if (!isExistingDirectory(project.path)) {
    problems.push(`${prefix}.path must be an existing directory`);
  }

  if (project.trackerPath !== undefined) {
    if (typeof project.trackerPath !== "string" || !isAbsolute(project.trackerPath)) {
      problems.push(`${prefix}.trackerPath must be an absolute path`);
    } else if (!isExistingDirectory(project.trackerPath)) {
      problems.push(`${prefix}.trackerPath must be an existing directory`);
    }
  }

  if (project.mainBranch !== null && typeof project.mainBranch !== "string") {
    problems.push(`${prefix}.mainBranch must be a string or null`);
  }

  if (
    project.budgetUSDPerDay !== undefined &&
    (!Number.isFinite(project.budgetUSDPerDay) || project.budgetUSDPerDay <= 0)
  ) {
    problems.push(`${prefix}.budgetUSDPerDay must be a positive number`);
  }

  if (
    project.queueFailureLimit !== undefined &&
    (!Number.isInteger(project.queueFailureLimit) || project.queueFailureLimit < 1)
  ) {
    problems.push(`${prefix}.queueFailureLimit must be a positive integer`);
  }

  if (
    project.unpricedDispatchCapPerDay !== undefined &&
    (!Number.isInteger(project.unpricedDispatchCapPerDay) ||
      project.unpricedDispatchCapPerDay < 1)
  ) {
    problems.push(`${prefix}.unpricedDispatchCapPerDay must be a positive integer`);
  }

  if (project.requireReview !== undefined && typeof project.requireReview !== "boolean") {
    problems.push(`${prefix}.requireReview must be a boolean`);
  }
  if (
    project.legacyCodexCompanion !== undefined &&
    typeof project.legacyCodexCompanion !== "boolean"
  ) {
    problems.push(`${prefix}.legacyCodexCompanion must be a boolean`);
  }
  if (project.reviewPolicy !== undefined && !REVIEW_POLICIES.has(project.reviewPolicy)) {
    problems.push(`${prefix}.reviewPolicy must be strict, tiered, or advisory`);
  }
  if (
    project.maxFixRounds !== undefined &&
    (!Number.isInteger(project.maxFixRounds) || project.maxFixRounds < 1)
  ) {
    problems.push(`${prefix}.maxFixRounds must be a positive integer`);
  }

  if (!TRACKER_MODES.has(project.tracker)) {
    problems.push(`${prefix}.tracker must be committed, personal, or none`);
  }

  const archetype = projectArchetype(project);
  if (project.archetype !== undefined && !ARCHETYPES.has(project.archetype)) {
    problems.push(`${prefix}.archetype must be full, git-only, or tracker-only`);
  } else if (archetype === "full") {
    if (!isGitCheckout(project.path)) problems.push(`${prefix}.archetype full requires a git repo`);
    if (project.tracker === "none") problems.push(`${prefix}.archetype full requires a tracker`);
  } else if (archetype === "git-only") {
    if (!isGitCheckout(project.path)) {
      problems.push(`${prefix}.archetype git-only requires a git repo`);
    }
    if (project.tracker !== "none") {
      problems.push(`${prefix}.archetype git-only requires tracker none`);
    }
  } else if (archetype === "tracker-only" && project.tracker !== "personal") {
    problems.push(`${prefix}.archetype tracker-only requires tracker personal`);
  }

  for (const key of ["autoCommitTracker", "autoCloseOnMerge"]) {
    if (project[key] !== undefined && typeof project[key] !== "boolean") {
      problems.push(`${prefix}.${key} must be a boolean`);
    }
    if (project[key] !== undefined && project.tracker === "none") {
      problems.push(`${prefix}.${key} is unavailable when tracker is none`);
    }
    if (
      project[key] !== undefined &&
      archetype === "tracker-only" &&
      !isGitCheckout(project.path)
    ) {
      problems.push(`${prefix}.${key} requires a Git checkout`);
    }
  }

  if (typeof project.containerized !== "boolean") {
    problems.push(`${prefix}.containerized must be a boolean`);
  }

  if (!VERIFY_MODES.has(project.verifyMode)) {
    problems.push(
      `${prefix}.verifyMode must be worktree, container-primary, primary-postmerge, or advisory`,
    );
  }

  if (!Array.isArray(project.verifyCommands)) {
    problems.push(`${prefix}.verifyCommands must be an array of strings`);
  } else {
    for (let commandIndex = 0; commandIndex < project.verifyCommands.length; commandIndex += 1) {
      if (typeof project.verifyCommands[commandIndex] !== "string") {
        problems.push(`${prefix}.verifyCommands[${commandIndex}] must be a string`);
      }
    }
  }

  for (const key of ["smokeCommand", "warn", "group", "notes"]) {
    if (project[key] !== undefined && typeof project[key] !== "string") {
      problems.push(`${prefix}.${key} must be a string`);
    }
  }

  if (project.defaultAgent !== undefined && !agents.has(project.defaultAgent)) {
    problems.push(
      `${prefix}.defaultAgent must be a registered agent id (${[...agents.keys()].join(", ")})`,
    );
  }

  problems.push(...validateDispatchEnv(project.dispatchEnv, `${prefix}.dispatchEnv`));
  problems.push(...validateDispatchProfile(project.dispatchProfile, `${prefix}.dispatchProfile`));

  return problems;
}

function validateGroups(groups, knownProjects) {
  if (!Array.isArray(groups)) return ["groups must be an array"];

  const problems = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const prefix = `groups[${index}]`;
    if (!isObject(group)) {
      problems.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof group.name !== "string" || !group.name) {
      problems.push(`${prefix}.name must be a non-empty string`);
    }
    if (!Array.isArray(group.projects)) {
      problems.push(`${prefix}.projects must be an array`);
      continue;
    }
    for (let projectIndex = 0; projectIndex < group.projects.length; projectIndex += 1) {
      const projectName = group.projects[projectIndex];
      if (typeof projectName !== "string") {
        problems.push(`${prefix}.projects[${projectIndex}] must be a string`);
      } else if (!knownProjects.has(projectName)) {
        problems.push(`${prefix}.projects[${projectIndex}] references unknown project ${projectName}`);
      }
    }
  }
  return problems;
}

export function validateRegistry(registry) {
  const problems = [];
  if (!isObject(registry)) return ["registry must be an object"];

  if (registry.version !== 1) problems.push("version must equal 1");

  if (!Array.isArray(registry.projects)) {
    problems.push("projects must be an array");
  } else {
    const names = new Set();
    const paths = new Set();
    for (let index = 0; index < registry.projects.length; index += 1) {
      const project = registry.projects[index];
      problems.push(...validateProject(project, index));
      if (!isObject(project)) continue;
      if (typeof project.name === "string") {
        if (names.has(project.name)) problems.push(`projects[${index}].name duplicates ${project.name}`);
        names.add(project.name);
      }
      if (typeof project.path === "string" && isAbsolute(project.path)) {
        const normalizedPath = canonicalize(project.path);
        if (paths.has(normalizedPath)) {
          problems.push(`projects[${index}].path duplicates ${project.path}`);
        }
        paths.add(normalizedPath);
      }
      if (typeof project.trackerPath === "string" && isAbsolute(project.trackerPath)) {
        for (let otherIndex = 0; otherIndex < registry.projects.length; otherIndex += 1) {
          if (otherIndex === index) continue;
          const otherPath = registry.projects[otherIndex]?.path;
          if (typeof otherPath !== "string" || !isAbsolute(otherPath)) continue;
          const trackerPath = canonicalize(project.trackerPath);
          const canonicalOtherPath = canonicalize(otherPath);
          if (
            trackerPath === canonicalOtherPath ||
            pathIsStrictlyInside(trackerPath, canonicalOtherPath)
          ) {
            problems.push(
              `projects[${index}].trackerPath must not be inside projects[${otherIndex}].path ` +
                `or equal to it`,
            );
          }
        }
      }
    }
    for (let leftIndex = 0; leftIndex < registry.projects.length; leftIndex += 1) {
      const left = registry.projects[leftIndex];
      if (typeof left?.path !== "string" || !isAbsolute(left.path)) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < registry.projects.length; rightIndex += 1) {
        const right = registry.projects[rightIndex];
        if (typeof right?.path !== "string" || !isAbsolute(right.path)) continue;
        const leftPath = canonicalize(left.path);
        const rightPath = canonicalize(right.path);
        if (
          pathIsStrictlyInside(leftPath, rightPath) ||
          pathIsStrictlyInside(rightPath, leftPath)
        ) {
          problems.push(
            `projects[${leftIndex}] (${left.name}).path overlaps projects[${rightIndex}] ` +
              `(${right.name}).path; move one project so neither path contains the other`,
          );
        }
        if (
          typeof left.trackerPath === "string" &&
          isAbsolute(left.trackerPath) &&
          (
            rightPath === canonicalize(left.trackerPath) ||
            pathIsStrictlyInside(rightPath, canonicalize(left.trackerPath))
          )
        ) {
          problems.push(
            `projects[${rightIndex}] (${right.name}).path must not be inside ` +
              `projects[${leftIndex}] (${left.name}).trackerPath`,
          );
        }
        if (
          typeof right.trackerPath === "string" &&
          isAbsolute(right.trackerPath) &&
          (
            leftPath === canonicalize(right.trackerPath) ||
            pathIsStrictlyInside(leftPath, canonicalize(right.trackerPath))
          )
        ) {
          problems.push(
            `projects[${leftIndex}] (${left.name}).path must not be inside ` +
              `projects[${rightIndex}] (${right.name}).trackerPath`,
          );
        }
      }
    }
  }

  let defaultDispatchProfile = DEFAULTS.dispatchProfile;
  if (registry.defaults !== undefined) {
    if (!isObject(registry.defaults)) {
      problems.push("defaults must be an object");
    } else if (
      registry.defaults.dispatchProfile !== undefined &&
      !isObject(registry.defaults.dispatchProfile)
    ) {
      problems.push("defaults.dispatchProfile must be an object");
    } else if (registry.defaults.dispatchProfile !== undefined) {
      defaultDispatchProfile = registry.defaults.dispatchProfile;
    }
  }
  problems.push(...validateDispatchProfile(defaultDispatchProfile, "defaults.dispatchProfile"));
  if (
    registry.defaults?.queueFailureLimit !== undefined &&
    (!Number.isInteger(registry.defaults.queueFailureLimit) ||
      registry.defaults.queueFailureLimit < 1)
  ) {
    problems.push("defaults.queueFailureLimit must be a positive integer");
  }
  if (
    registry.defaults?.maxFixRounds !== undefined &&
    (!Number.isInteger(registry.defaults.maxFixRounds) ||
      registry.defaults.maxFixRounds < 1)
  ) {
    problems.push("defaults.maxFixRounds must be a positive integer");
  }
  problems.push(...validateEditorCommand(registry.defaults?.editorCommand));

  const knownProjects = new Set(
    Array.isArray(registry.projects)
      ? registry.projects
          .filter((project) => isObject(project) && typeof project.name === "string")
          .map((project) => project.name)
      : [],
  );
  problems.push(...validateGroups(registry.groups, knownProjects));
  return problems;
}

export function normalizeProject(project, defaults = {}) {
  const defaultDispatchProfile = defaults.dispatchProfile || DEFAULTS.dispatchProfile;
  const projectDispatchProfile = projectOwnDispatchProfile(project);
  const projectMaxFixRounds = Object.hasOwn(project, PROJECT_OWN_MAX_FIX_ROUNDS)
    ? project[PROJECT_OWN_MAX_FIX_ROUNDS]
    : Object.hasOwn(project, "maxFixRounds")
      ? project.maxFixRounds
      : undefined;
  const hasDispatchEnv =
    defaultDispatchProfile.dispatchEnv !== undefined ||
    projectDispatchProfile.dispatchEnv !== undefined ||
    project.dispatchEnv !== undefined;
  const dispatchEnv = {
    ...(defaultDispatchProfile.dispatchEnv || {}),
    ...(projectDispatchProfile.dispatchEnv || {}),
    ...(project.dispatchEnv || {}),
  };
  return {
    ...project,
    [PROJECT_OWN_DISPATCH_PROFILE]: Object.hasOwn(project, PROJECT_OWN_DISPATCH_PROFILE)
      ? project[PROJECT_OWN_DISPATCH_PROFILE]
      : project.dispatchProfile,
    [PROJECT_OWN_MAX_FIX_ROUNDS]: projectMaxFixRounds,
    archetype: projectArchetype(project),
    autoCommitTracker: project.autoCommitTracker ?? false,
    autoCloseOnMerge: project.autoCloseOnMerge ?? false,
    requireReview: project.requireReview ?? false,
    legacyCodexCompanion: project.legacyCodexCompanion ?? false,
    reviewPolicy: project.reviewPolicy ?? "strict",
    maxFixRounds: projectMaxFixRounds ?? defaults.maxFixRounds ?? DEFAULTS.maxFixRounds,
    ...(hasDispatchEnv ? { dispatchEnv } : {}),
    dispatchProfile: {
      ...defaultDispatchProfile,
      ...projectDispatchProfile,
      ...(hasDispatchEnv ? { dispatchEnv } : {}),
    },
  };
}

export function projectOwnDispatchProfile(project) {
  if (Object.hasOwn(project, PROJECT_OWN_DISPATCH_PROFILE)) {
    return project[PROJECT_OWN_DISPATCH_PROFILE] || {};
  }
  return project.dispatchProfile || {};
}

export function resolveProjectDefaultAgent(project, defaults = {}) {
  return (
    projectOwnDispatchProfile(project).lane ??
    project.defaultAgent ??
    defaults.dispatchProfile?.lane ??
    "claude"
  );
}

function registryForStorage(registry) {
  return {
    ...registry,
    projects: registry.projects.map((project) => {
      const hasOwnDispatchProfile = Object.hasOwn(project, PROJECT_OWN_DISPATCH_PROFILE);
      const hasOwnMaxFixRounds = Object.hasOwn(project, PROJECT_OWN_MAX_FIX_ROUNDS);
      const hasTrackerNoneDerivedFlags =
        project.tracker === "none" &&
        ["autoCommitTracker", "autoCloseOnMerge"].some((key) => Object.hasOwn(project, key));
      if (!hasOwnDispatchProfile && !hasOwnMaxFixRounds && !hasTrackerNoneDerivedFlags) return project;
      const stored = { ...project };
      if (hasOwnDispatchProfile) {
        const ownProfile = project[PROJECT_OWN_DISPATCH_PROFILE];
        delete stored[PROJECT_OWN_DISPATCH_PROFILE];
        if (ownProfile === undefined) delete stored.dispatchProfile;
        else stored.dispatchProfile = ownProfile;
      }
      if (hasOwnMaxFixRounds) {
        const ownMaxFixRounds = project[PROJECT_OWN_MAX_FIX_ROUNDS];
        delete stored[PROJECT_OWN_MAX_FIX_ROUNDS];
        if (ownMaxFixRounds === undefined) delete stored.maxFixRounds;
        else stored.maxFixRounds = ownMaxFixRounds;
      }
      if (stored.tracker === "none") {
        delete stored.autoCommitTracker;
        delete stored.autoCloseOnMerge;
      }
      return stored;
    }),
  };
}

export function validateProjectAddition(registry, project) {
  if (registry.projects.some((candidate) => candidate.name === project?.name)) {
    throw new RegistryError([`project name already exists: ${project?.name}`]);
  }
  if (
    typeof project?.path === "string" &&
    registry.projects.some((candidate) => resolve(candidate.path) === resolve(project.path))
  ) {
    throw new RegistryError([`project path already exists: ${project.path}`]);
  }
  const problems = validateRegistry({
    ...registry,
    projects: [...registry.projects, project],
  });
  if (problems.length > 0) throw new RegistryError(problems);
}

function normalizedRegistry(registry) {
  const defaultDispatchProfile = registry.defaults?.dispatchProfile || DEFAULTS.dispatchProfile;
  return {
    ...registry,
    defaults: {
      ...registry.defaults,
      dispatchProfile: { ...defaultDispatchProfile },
    },
    projects: registry.projects.map((project) => normalizeProject(project, registry.defaults)),
  };
}

export async function writeRegistryAtomic(
  registry,
  filePath = join(configDir(), "projects.json"),
  { fileOps } = {},
) {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  writeFileAtomic(filePath, `${JSON.stringify(registryForStorage(registry), null, 2)}\n`, {
    mode: 0o600,
    fileOps,
  });
}

export async function addProject(
  registry,
  project,
  filePath = join(configDir(), "projects.json"),
) {
  validateProjectAddition(registry, project);

  const created = normalizeProject(project, registry.defaults);
  const stored = { ...registry, projects: [...registry.projects, created] };
  await writeRegistryAtomic(stored, filePath);
  registry.projects.push(created);
  return created;
}

export async function updateProject(
  registry,
  name,
  changes,
  filePath = join(configDir(), "projects.json"),
) {
  const index = registry.projects.findIndex((project) => project.name === name);
  if (index === -1) throw new RegistryError([`unknown project: ${name}`]);

  const candidate = { ...registry.projects[index], ...changes };
  if (Object.hasOwn(changes, "dispatchProfile")) {
    candidate[PROJECT_OWN_DISPATCH_PROFILE] = changes.dispatchProfile;
  }
  if (Object.hasOwn(changes, "maxFixRounds")) {
    candidate[PROJECT_OWN_MAX_FIX_ROUNDS] = changes.maxFixRounds ?? undefined;
    if (changes.maxFixRounds === null) delete candidate.maxFixRounds;
  }
  if (Object.hasOwn(changes, "trackerPath") && changes.trackerPath === undefined) {
    delete candidate.trackerPath;
  }
  if (Object.hasOwn(changes, "budgetUSDPerDay") && changes.budgetUSDPerDay === null) {
    delete candidate.budgetUSDPerDay;
  }
  if (Object.hasOwn(changes, "queueFailureLimit") && changes.queueFailureLimit === null) {
    delete candidate.queueFailureLimit;
  }
  if (
    Object.hasOwn(changes, "unpricedDispatchCapPerDay") &&
    changes.unpricedDispatchCapPerDay === null
  ) {
    delete candidate.unpricedDispatchCapPerDay;
  }
  if (candidate.tracker === "none") {
    if (!("autoCommitTracker" in changes)) delete candidate.autoCommitTracker;
    if (!("autoCloseOnMerge" in changes)) delete candidate.autoCloseOnMerge;
  }
  const projects = registry.projects.map((project, projectIndex) =>
    projectIndex === index ? candidate : project,
  );
  const stored = { ...registry, projects };
  const problems = validateRegistry(stored);
  if (problems.length > 0) throw new RegistryError(problems);

  await writeRegistryAtomic(stored, filePath);
  const updated = normalizeProject(candidate, registry.defaults);
  registry.projects.splice(index, 1, updated);
  return updated;
}

export async function removeProject(
  registry,
  name,
  filePath = join(configDir(), "projects.json"),
) {
  const index = registry.projects.findIndex((project) => project.name === name);
  if (index === -1) return undefined;
  const removed = registry.projects[index];
  const groups = registry.groups.map((group) => ({
    ...group,
    projects: group.projects.filter((projectName) => projectName !== name),
  }));
  const stored = {
    ...registry,
    groups,
    projects: registry.projects.filter((project) => project.name !== name),
  };
  const problems = validateRegistry(stored);
  if (problems.length > 0) throw new RegistryError(problems);

  await writeRegistryAtomic(stored, filePath);
  registry.projects.splice(index, 1);
  registry.groups.splice(0, registry.groups.length, ...groups);
  return removed;
}

export async function loadRegistry(filePath = join(configDir(), "projects.json")) {
  let registry;
  try {
    // projects.json is trusted-local configuration and is commonly managed by
    // a dotfiles symlink. Follow that one config path, then retain the strict
    // regular-file/no-follow read at its final target. State under stateDir is
    // deliberately not granted this exception.
    const resolvedFilePath = realpathSync(filePath);
    registry = JSON.parse(readFileNoFollowSync(resolvedFilePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      try {
        lstatSync(filePath);
      } catch (pathError) {
        if (pathError.code === "ENOENT") {
          return {
            version: STARTER_REGISTRY.version,
            defaults: {},
            groups: [],
            projects: [],
          };
        }
      }
    }
    const detail = String(error.message).replaceAll("state file", "config file");
    throw new RegistryError([`cannot read or parse config ${filePath}: ${detail}`]);
  }

  if (!isObject(registry)) {
    throw new RegistryError(["registry must be an object"]);
  }
  const problems = validateRegistry(registry);
  if (problems.length > 0) throw new RegistryError(problems);
  return normalizedRegistry(registry);
}
