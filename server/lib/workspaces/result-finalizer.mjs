import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const NON_TRACKER_PATHS = Object.freeze([".", ":(exclude).beads"]);
const FINALIZE_SUBJECT = "chore(dispatch): finalize result [atelier-finalized]";
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/i;

export class ResultFinalizationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ResultFinalizationError";
    this.code = code;
  }
}

function finalizationError(code, message, cause) {
  return new ResultFinalizationError(code, message, cause ? { cause } : undefined);
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function inspectWorkspace(worktreePath) {
  let root;
  try {
    root = await realpath(worktreePath);
  } catch (error) {
    throw finalizationError(
      "ERESULT_WORKTREE",
      `Result worktree is unavailable: ${error.message}`,
      error,
    );
  }

  async function inspect(path, localPath) {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      throw finalizationError(
        "ERESULT_INSPECTION",
        `Could not inspect result path ${localPath || "."}: ${error.message}`,
        error,
      );
    }

    if (metadata.isSymbolicLink()) {
      let target;
      try {
        target = await readlink(path);
      } catch (error) {
        throw finalizationError(
          "ERESULT_INSPECTION",
          `Could not read result symlink ${localPath}: ${error.message}`,
          error,
        );
      }
      const resolvedTarget = resolve(dirname(path), target);
      if (!inside(root, resolvedTarget)) {
        throw finalizationError(
          "ERESULT_SYMLINK_ESCAPE",
          `Result finalization refused symlink outside the worktree: ${localPath}`,
        );
      }
      try {
        const canonicalTarget = await realpath(resolvedTarget);
        if (!inside(root, canonicalTarget)) {
          throw finalizationError(
            "ERESULT_SYMLINK_ESCAPE",
            `Result finalization refused symlink outside the worktree: ${localPath}`,
          );
        }
      } catch (error) {
        if (error instanceof ResultFinalizationError) throw error;
        if (error?.code !== "ENOENT") {
          throw finalizationError(
            "ERESULT_INSPECTION",
            `Could not resolve result symlink ${localPath}: ${error.message}`,
            error,
          );
        }
      }
      return;
    }

    if (metadata.isDirectory()) {
      let names;
      try {
        names = await readdir(path);
      } catch (error) {
        throw finalizationError(
          "ERESULT_INSPECTION",
          `Could not read result directory ${localPath || "."}: ${error.message}`,
          error,
        );
      }
      for (const name of names) {
        const childPath = localPath ? `${localPath}/${name}` : name;
        if (!localPath && (name === ".git" || name === ".beads")) continue;
        await inspect(resolve(path, name), childPath);
      }
      return;
    }

    if (!metadata.isFile()) {
      throw finalizationError(
        "ERESULT_SPECIAL_FILE",
        `Result finalization refused special file: ${localPath}`,
      );
    }
  }

  await inspect(root, "");
}

function parseStatus(output) {
  if (!output) return [];
  if (!output.includes("\0")) {
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  }
  const records = output.split("\0");
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    entries.push({ code, path });
    if (code.includes("R") || code.includes("C")) index += 1;
  }
  return entries;
}

function parseTree(output) {
  const blobs = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const metadata = record.slice(0, tab).split(" ");
    blobs.set(record.slice(tab + 1), metadata[2]);
  }
  return blobs;
}

async function git(runGit, args) {
  try {
    return String(await runGit(args));
  } catch (error) {
    if (error instanceof ResultFinalizationError) throw error;
    throw finalizationError(
      "ERESULT_GIT",
      `Result finalization git command failed: git ${args.join(" ")}: ${error.message}`,
      error,
    );
  }
}

async function status(runGit, worktreePath) {
  return parseStatus(await git(runGit, [
    "-C",
    worktreePath,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
    "-z",
    "--",
    ...NON_TRACKER_PATHS,
  ]));
}

function assertNoIgnored(entries) {
  const ignored = entries.filter(({ code }) => code === "!!").map(({ path }) => path);
  if (ignored.length > 0) {
    throw finalizationError(
      "ERESULT_IGNORED_FILES",
      `Result finalization refused ignored path${ignored.length === 1 ? "" : "s"}: ${ignored.join(", ")}`,
    );
  }
}

function dirtyEntries(entries) {
  return entries.filter(({ code }) => code !== "!!");
}

async function manifestFor(runGit, worktreePath, baseCommit, resultCommit) {
  const paths = (await git(runGit, [
    "-C",
    worktreePath,
    "diff",
    "--name-only",
    "-z",
    baseCommit,
    resultCommit,
    "--",
    ...NON_TRACKER_PATHS,
  ])).split("\0").filter(Boolean);
  if (paths.length === 0) return [];
  const blobs = new Map();
  for (let offset = 0; offset < paths.length; offset += 500) {
    const chunk = paths.slice(offset, offset + 500);
    const entries = parseTree(await git(runGit, [
      "--literal-pathspecs",
      "-C",
      worktreePath,
      "ls-tree",
      "-rz",
      "--full-tree",
      resultCommit,
      "--",
      ...chunk,
    ]));
    for (const [path, blobHash] of entries) blobs.set(path, blobHash);
  }
  return paths.map((path) => ({ path, blobHash: blobs.get(path) ?? null }));
}

export async function finalizeResult({ worktreePath, baseCommit, runGit }) {
  if (typeof runGit !== "function") {
    throw finalizationError("ERESULT_RUNNER", "Result finalization requires a git runner");
  }
  if (typeof worktreePath !== "string" || !worktreePath) {
    throw finalizationError("ERESULT_WORKTREE", "Result finalization requires a worktree path");
  }
  if (!COMMIT_PATTERN.test(String(baseCommit ?? ""))) {
    throw finalizationError("ERESULT_BASE", "Result finalization requires a valid base commit");
  }

  await inspectWorkspace(worktreePath);
  const before = await status(runGit, worktreePath);
  assertNoIgnored(before);
  const dirt = dirtyEntries(before);
  let commitCreated = false;
  if (dirt.length > 0) {
    await git(runGit, [
      "-C",
      worktreePath,
      "add",
      "--all",
      "--",
      ...NON_TRACKER_PATHS,
    ]);
    await git(runGit, [
      "-C",
      worktreePath,
      "commit",
      "-m",
      FINALIZE_SUBJECT,
      "--",
      ...NON_TRACKER_PATHS,
    ]);
    commitCreated = true;
  }

  const after = await status(runGit, worktreePath);
  assertNoIgnored(after);
  if (dirtyEntries(after).length > 0) {
    throw finalizationError(
      "ERESULT_DIRTY_WORKSPACE",
      "Result finalization left non-tracker workspace changes",
    );
  }
  await inspectWorkspace(worktreePath);

  const canonicalBase = (await git(runGit, [
    "-C",
    worktreePath,
    "rev-parse",
    "--verify",
    `${baseCommit}^{commit}`,
  ])).trim();
  const resultCommit = (await git(runGit, [
    "-C",
    worktreePath,
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ])).trim();
  const resultTree = (await git(runGit, [
    "-C",
    worktreePath,
    "rev-parse",
    "--verify",
    `${resultCommit}^{tree}`,
  ])).trim();
  for (const [label, value] of [
    ["base", canonicalBase],
    ["result", resultCommit],
    ["result tree", resultTree],
  ]) {
    if (!COMMIT_PATTERN.test(value)) {
      throw finalizationError("ERESULT_GIT_OUTPUT", `Git returned an invalid ${label} object id`);
    }
  }
  const manifest = await manifestFor(
    runGit,
    worktreePath,
    canonicalBase,
    resultCommit,
  );
  return {
    resultCommit,
    resultTree,
    baseCommit: canonicalBase,
    manifest,
    workspaceClean: true,
    commitCreated,
  };
}
