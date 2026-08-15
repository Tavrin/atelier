import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { runFile } from "./exec.mjs";
import { RegistryError, validateProject } from "./registry.mjs";
import { trackerDirectory } from "./tracker.mjs";

const CACHE_TTL_MS = 60_000;
const PROJECT_CONFIG_FIELDS = new Set([
  "name",
  "mainBranch",
  "tracker",
  "archetype",
  "containerized",
  "verifyMode",
  "verifyCommands",
  "smokeCommand",
  "warn",
  "group",
  "dispatchProfile",
  "defaultAgent",
  "budgetUSDPerDay",
  "autoCommitTracker",
  "autoCloseOnMerge",
  "dispatchEnv",
  "notes",
  "requireReview",
  "reviewPolicy",
  "maxFixRounds",
]);
const probeCache = new Map();

async function optionalRun(file, args, options) {
  try {
    return await runFile(file, args, options);
  } catch {
    return undefined;
  }
}

async function gitBranch(path) {
  const current = (await optionalRun("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: path }))
    ?.trim();
  if (current && current !== "HEAD") return current;
  const symbolic = (
    await optionalRun("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: path })
  )?.trim();
  if (symbolic) return symbolic;
  for (const name of ["main", "master"]) {
    const found = await optionalRun(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${name}`],
      { cwd: path },
    );
    if (found !== undefined) return name;
  }
  return null;
}

async function gitBranches(path) {
  const output = await optionalRun(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { cwd: path },
  );
  return (output || "")
    .split(/\r?\n/)
    .map((branch) => branch.trim())
    .filter(Boolean);
}

async function gitRemoteHead(path) {
  const remotes = (await optionalRun("git", ["remote"], { cwd: path }) || "")
    .split(/\r?\n/)
    .map((remote) => remote.trim())
    .filter(Boolean);
  const ordered = ["origin", ...remotes.filter((remote) => remote !== "origin")];
  for (const remote of ordered) {
    if (!remotes.includes(remote)) continue;
    const symbolic = (
      await optionalRun(
        "git",
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        { cwd: path },
      )
    )?.trim();
    if (symbolic?.startsWith(`${remote}/`)) return symbolic.slice(remote.length + 1);
  }
  return null;
}

async function gitRemote(path) {
  const origin = (await optionalRun("git", ["remote", "get-url", "origin"], { cwd: path }))?.trim();
  if (origin) return origin;
  const first = (await optionalRun("git", ["remote"], { cwd: path }))
    ?.split(/\r?\n/)
    .find(Boolean);
  if (!first) return null;
  return (await optionalRun("git", ["remote", "get-url", first], { cwd: path }))?.trim() || null;
}

async function basicProbe(path, { skipGit = false } = {}) {
  const cacheKey = `${skipGit ? "tracker" : "git"}:${path}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const topLevel = skipGit
    ? undefined
    : (await optionalRun("git", ["rev-parse", "--show-toplevel"], { cwd: path }))?.trim();
  const isRepo = Boolean(topLevel);
  let branch = null;
  let branches = [];
  let remoteHead = null;
  let status = "";
  let worktrees = "";
  let remote = null;
  if (isRepo) {
    [branch, branches, remoteHead, status, worktrees, remote] = await Promise.all([
      gitBranch(path),
      gitBranches(path),
      gitRemoteHead(path),
      optionalRun("git", ["status", "--porcelain"], { cwd: path }).then((value) => value || ""),
      optionalRun("git", ["worktree", "list", "--porcelain"], { cwd: path }).then(
        (value) => value || "",
      ),
      gitRemote(path),
    ]);
  }

  const beads = existsSync(join(path, ".beads", "issues.jsonl"));
  let detectedTracker = "none";
  if (beads) {
    const tracked = isRepo
      ? await optionalRun("git", ["ls-files", "--error-unmatch", ".beads/issues.jsonl"], {
          cwd: path,
        })
      : undefined;
    detectedTracker = tracked === undefined ? "personal" : "committed";
  }
  const value = {
    beads,
    detectedTracker,
    agentsMd: existsSync(join(path, "AGENTS.md")),
    claudeMd: existsSync(join(path, "CLAUDE.md")),
    git: {
      isRepo,
      branch,
      branches,
      remoteHead,
      dirtyCount: status.split(/\r?\n/).filter(Boolean).length,
      worktrees: worktrees.split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length,
      remote,
      hasRemote: Boolean(remote),
    },
  };

  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function inferredName(path) {
  return (
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "project"
  );
}

async function inferredVerifyCommands(path) {
  const commands = [];
  if (existsSync(join(path, "Cargo.toml"))) commands.push("cargo check --workspace");
  if (existsSync(join(path, "package.json"))) {
    try {
      const packageJson = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
      if (typeof packageJson?.scripts?.test === "string" && packageJson.scripts.test.trim()) {
        commands.push("npm test");
      }
    } catch {
      // A malformed package manifest does not make the directory un-probeable.
    }
  }
  if (existsSync(join(path, "Makefile"))) {
    const makefile = await readFile(join(path, "Makefile"), "utf8");
    if (/^test:/m.test(makefile)) commands.push("make test");
  }
  if (existsSync(join(path, "go.mod"))) commands.push("go test ./...");
  return commands;
}

async function atelierDefaults(path, base) {
  const filePath = join(path, ".atelier.json");
  if (!existsSync(filePath)) return base;
  let configured;
  try {
    configured = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new RegistryError([`.atelier.json cannot be parsed: ${error.message}`]);
  }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new RegistryError([".atelier.json must be an object"]);
  }
  const unknown = Object.keys(configured).filter((key) => !PROJECT_CONFIG_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new RegistryError(unknown.map((key) => `.atelier.json.${key} is not a project field`));
  }
  const merged = { ...base, ...configured, path };
  const problems = validateProject(merged).map((problem) =>
    problem.replace(/^projects\[0\]/, ".atelier.json"),
  );
  if (problems.length > 0) throw new RegistryError(problems);
  return merged;
}

export async function probeProjectPath(path) {
  if (!isAbsolute(path)) {
    const error = new Error("path must be an absolute path");
    error.status = 400;
    throw error;
  }
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      const missing = new Error(`Path does not exist: ${path}`);
      missing.status = 404;
      throw missing;
    }
    throw error;
  }
  if (!details.isDirectory()) {
    const error = new Error(`Path is not a directory: ${path}`);
    error.status = 400;
    throw error;
  }
  const capabilities = await basicProbe(path);
  const archetype = capabilities.git.isRepo
    ? capabilities.beads
      ? "full"
      : "git-only"
    : "tracker-only";
  const conventionalBranch = ["main", "master"].find((branch) =>
    capabilities.git.branches.includes(branch));
  const base = {
    name: inferredName(path),
    path,
    mainBranch: conventionalBranch || capabilities.git.branch,
    tracker: archetype === "tracker-only" ? "personal" : capabilities.detectedTracker,
    archetype,
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: await inferredVerifyCommands(path),
    warn: "",
    dispatchProfile: {},
  };
  const inferred = await atelierDefaults(path, base);
  delete inferred.path;
  return {
    path,
    exists: true,
    git: { ...capabilities.git },
    tracker: { detected: capabilities.detectedTracker },
    inferred,
  };
}

export async function probeProject(project) {
  const value = await basicProbe(project.path, { skipGit: project.archetype === "tracker-only" });
  const trackerValue = project.trackerPath
    ? await basicProbe(trackerDirectory(project), { skipGit: true })
    : value;
  return {
    beads: trackerValue.beads,
    agentsMd: value.agentsMd,
    claudeMd: value.claudeMd,
    git: { ...value.git },
  };
}

export async function trackerMode(project, probe) {
  let mode = "none";
  if (probe.beads) {
    if (project.archetype === "tracker-only") {
      mode = "personal";
    } else {
      try {
        await runFile("git", ["ls-files", "--error-unmatch", ".beads/issues.jsonl"], {
          cwd: trackerDirectory(project),
        });
        mode = "committed";
      } catch {
        mode = "personal";
      }
    }
  }

  if (mode !== project.tracker) {
    console.warn(
      `[atelier] tracker mode mismatch for ${project.name}: registry=${project.tracker}, detected=${mode}`,
    );
  }
  return mode;
}

export function _clearProbeCache() {
  probeCache.clear();
}
