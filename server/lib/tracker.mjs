import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { resolveBrExecutable, runFile } from "./exec.mjs";

let runner = runFile;
let brResolver = resolveBrExecutable;
const lastFlushByTracker = new Map();
const pendingFlushByTracker = new Map();
const flushVersionByTracker = new Map();
const FLUSH_DEBOUNCE_MS = 1_000;

function trackerArg(value, name) {
  const normalized = String(value);
  if (normalized.startsWith("-")) {
    throw new Error(`${name} must not start with "-"`);
  }
  return normalized;
}

export function trackerDirectory(project) {
  return project.trackerPath ?? project.path;
}

async function issueFileStat(project) {
  try {
    const details = await stat(
      join(trackerDirectory(project), ".beads", "issues.jsonl"),
    );
    return { mtimeMs: details.mtimeMs, size: details.size };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function issueFileAdvanced(before, after) {
  if (!before || !after) return true;
  return after.mtimeMs > before.mtimeMs || after.size !== before.size;
}

async function flushTracker(project, { run, br }) {
  const directory = trackerDirectory(project);
  const pending = pendingFlushByTracker.get(directory);
  if (pending) return pending;

  const flush = (async () => {
    const elapsed = Date.now() - (lastFlushByTracker.get(directory) ?? 0);
    if (elapsed < FLUSH_DEBOUNCE_MS) {
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, FLUSH_DEBOUNCE_MS - elapsed));
    }
    lastFlushByTracker.set(directory, Date.now());
    flushVersionByTracker.set(directory, (flushVersionByTracker.get(directory) ?? 0) + 1);
    await run(br, ["sync", "--flush-only"], { cwd: directory });
  })();
  pendingFlushByTracker.set(directory, flush);
  try {
    return await flush;
  } finally {
    if (pendingFlushByTracker.get(directory) === flush) {
      pendingFlushByTracker.delete(directory);
    }
  }
}

export async function runTrackerMutation(
  project,
  args,
  { run = runner, br = brResolver(), options = {} } = {},
) {
  const directory = trackerDirectory(project);
  const before = await issueFileStat(project);
  const result = await run(br, args, { ...options, cwd: directory });
  const flushVersionAfterMutation = flushVersionByTracker.get(directory) ?? 0;
  const after = await issueFileStat(project);
  if (issueFileAdvanced(before, after)) return result;
  if ((flushVersionByTracker.get(directory) ?? 0) > flushVersionAfterMutation) {
    return result;
  }

  await flushTracker(project, { run, br });
  return result;
}

function runBr(project, args) {
  return runTrackerMutation(project, args);
}

function appendWarning(record, warning) {
  if (!Array.isArray(record?.warnings) || record.warnings.includes(warning)) return;
  record.warnings.push(warning);
}

export async function commitBeads(project, message, { record, run = runner } = {}) {
  if (!project.autoCommitTracker) return { committed: false, skipped: "disabled" };
  const directory = trackerDirectory(project);
  try {
    await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
  } catch {
    return { committed: false, skipped: "not-git" };
  }
  try {
    await run("git", ["-C", directory, "add", "--", ".beads"]);
    try {
      await run("git", ["-C", directory, "diff", "--cached", "--quiet", "--", ".beads"]);
      return { committed: false, clean: true };
    } catch {
      // git diff --quiet exits 1 when the pathspec has staged changes.
    }
    await run("git", [
      "-C",
      directory,
      "commit",
      "-m",
      message,
      "--",
      ".beads",
    ]);
    return { committed: true };
  } catch (error) {
    const warning = `tracker auto-commit failed: ${error.message}`;
    appendWarning(record, warning);
    return { committed: false, warning };
  }
}

function trackerPrefix(name) {
  const prefix = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  if (!prefix) throw new Error("Project name cannot produce a tracker prefix");
  return prefix;
}

export async function initializeTrackerDirectory(project) {
  if (existsSync(join(trackerDirectory(project), ".beads", "issues.jsonl"))) return false;
  if (!existsSync(brResolver())) {
    const error = new Error("br is required to initialize a tracker but was not found");
    error.status = 409;
    throw error;
  }
  try {
    await runBr(project, ["init", "--prefix", trackerPrefix(project.name)]);
  } catch (cause) {
    const error = new Error(`Could not initialize tracker: ${cause.message}`);
    error.status = 409;
    throw error;
  }
  return true;
}

export function parseIssuesJsonl(raw) {
  const issues = [];
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    try {
      const issue = JSON.parse(line);
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
        throw new Error("issue is not an object");
      }
      issues.push(issue);
    } catch (error) {
      throw new Error(`Invalid .beads/issues.jsonl line ${index + 1}: ${error.message}`);
    }
  }

  return issues;
}

export async function loadIssues(project) {
  const path = join(trackerDirectory(project), ".beads", "issues.jsonl");
  return parseIssuesJsonl(await readFile(path, "utf8"));
}

export async function createIssue(project, body) {
  const title = trackerArg(body.title, "title");
  const desc = trackerArg(body.desc, "desc");
  const ac = body.ac === undefined ? undefined : trackerArg(body.ac, "ac");
  const type = body.type === undefined ? "task" : trackerArg(body.type, "type");
  const priority =
    body.priority === undefined ? undefined : trackerArg(body.priority, "priority");

  const args = ["create", title, "--description", desc, "--type", type, "--silent"];
  if (priority !== undefined) args.push("--priority", priority);
  const id = (await runBr(project, args)).trim();
  if (!id || /\s/.test(id)) throw new Error("br create did not return a valid issue id");

  if (ac !== undefined) {
    await runBr(project, ["update", id, "--acceptance-criteria", ac]);
  }
  await commitBeads(project, `chore(tracker): create ${id} [atelier]`);
  return id;
}

export async function promoteIssue(project, id) {
  const safeId = trackerArg(id, "id");
  await runBr(project, ["update", safeId, "--status", "open"]);
  await commitBeads(project, `chore(tracker): promote ${safeId} [atelier]`);
  return safeId;
}

export async function commentIssue(project, id, text) {
  const safeId = trackerArg(id, "id");
  const safeText = trackerArg(text, "text");
  await runBr(project, ["comments", "add", safeId, safeText]);
  await commitBeads(project, `chore(tracker): comment ${safeId} [atelier]`);
  return safeId;
}

export async function closeIssue(project, id, reason) {
  const safeId = trackerArg(id, "id");
  const safeReason = reason === undefined ? undefined : trackerArg(reason, "reason");
  const args = ["close", safeId];
  if (safeReason !== undefined) args.push("--reason", safeReason);
  await runBr(project, args);
  await commitBeads(project, `chore(tracker): close ${safeId} [atelier]`);
  return safeId;
}

export async function claimIssue(project, id, actor) {
  const safeId = trackerArg(id, "id");
  const safeActor = trackerArg(actor, "actor");
  await runBr(project, ["update", safeId, "--claim", "--actor", safeActor]);
  await commitBeads(project, `chore(tracker): claim ${safeId} [atelier]`);
  return { id: safeId, actor: safeActor };
}

export function _setRunner(nextRunner = runFile) {
  runner = nextRunner;
}

export function _setBrResolver(nextResolver = resolveBrExecutable) {
  brResolver = nextResolver;
}
