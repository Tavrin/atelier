import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const NON_TRACKER_PATHS = Object.freeze([
  ".",
  ":(exclude).beads",
  ":(exclude).atelier-workspace.json",
]);
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

async function canonicalPath(path, code, label) {
  try {
    return await realpath(path);
  } catch (error) {
    throw finalizationError(code, `Could not resolve ${label}: ${error.message}`, error);
  }
}

async function validateGitLinkage(worktreePath, expectedCommonDir, runGit) {
  const root = await canonicalPath(worktreePath, "ERESULT_WORKTREE", "result worktree");
  const gitEntry = join(root, ".git");
  let metadata;
  try {
    // This lstat must precede every git invocation. A substituted symlink must
    // never get a chance to redirect even the linkage probe.
    metadata = await lstat(gitEntry);
  } catch (error) {
    throw finalizationError(
      "ERESULT_GIT_LINKAGE",
      `Result worktree has no trustworthy .git entry: ${error.message}`,
      error,
    );
  }
  if (metadata.isSymbolicLink()) {
    throw finalizationError(
      "ERESULT_SYMLINK_ESCAPE",
      "Result finalization refused a symlinked top-level .git entry",
    );
  }
  if (metadata.isDirectory()) {
    if (expectedCommonDir) {
      const expected = await canonicalPath(
        expectedCommonDir,
        "ERESULT_GIT_LINKAGE",
        "expected git common directory",
      );
      const reported = (await git(runGit, ["-C", root, "rev-parse", "--git-common-dir"])).trim();
      const common = await canonicalPath(
        isAbsolute(reported) ? reported : resolve(root, reported),
        "ERESULT_GIT_LINKAGE",
        "worktree git common directory",
      );
      if (common !== expected) {
        throw finalizationError(
          "ERESULT_GIT_LINKAGE",
          "Result worktree git common directory does not match the configured project",
        );
      }
    }
    return root;
  }
  if (!metadata.isFile()) {
    throw finalizationError(
      "ERESULT_GIT_LINKAGE",
      "Result worktree .git entry is neither a gitfile nor a directory",
    );
  }

  let contents;
  try {
    contents = await readFile(gitEntry, "utf8");
  } catch (error) {
    throw finalizationError(
      "ERESULT_GIT_LINKAGE",
      `Could not read result worktree gitfile: ${error.message}`,
      error,
    );
  }
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);
  if (!match) {
    throw finalizationError(
      "ERESULT_GIT_LINKAGE",
      "Result worktree .git file is not a valid gitdir linkage",
    );
  }
  const gitDir = await canonicalPath(
    isAbsolute(match[1]) ? match[1] : resolve(root, match[1]),
    "ERESULT_GIT_LINKAGE",
    "result worktree gitdir",
  );
  const reported = (await git(runGit, ["-C", root, "rev-parse", "--git-common-dir"])).trim();
  const common = await canonicalPath(
    isAbsolute(reported) ? reported : resolve(root, reported),
    "ERESULT_GIT_LINKAGE",
    "worktree git common directory",
  );
  if (expectedCommonDir) {
    const expected = await canonicalPath(
      expectedCommonDir,
      "ERESULT_GIT_LINKAGE",
      "expected git common directory",
    );
    if (common !== expected) {
      throw finalizationError(
        "ERESULT_GIT_LINKAGE",
        "Result worktree git common directory does not match the configured project",
      );
    }
  }
  const worktreesRoot = await canonicalPath(
    join(common, "worktrees"),
    "ERESULT_GIT_LINKAGE",
    "git worktrees directory",
  );
  if (gitDir === worktreesRoot || !inside(worktreesRoot, gitDir)) {
    throw finalizationError(
      "ERESULT_GIT_LINKAGE",
      "Result worktree gitfile does not point inside the configured repository's worktrees",
    );
  }
  return root;
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

  const embeddedRepos = [];
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
        if (localPath && name === ".git") {
          embeddedRepos.push(localPath);
          continue;
        }
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
  return embeddedRepos;
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
  const entries = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const metadata = record.slice(0, tab).split(" ");
    entries.set(record.slice(tab + 1), {
      mode: metadata[0],
      type: metadata[1],
      objectId: metadata[2],
    });
  }
  return entries;
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

async function assertTrackedEmbeddedRepos(runGit, worktreePath, embeddedRepos) {
  if (embeddedRepos.length === 0) return;
  let configured = "";
  try {
    configured = await git(runGit, [
      "config",
      "--file",
      join(worktreePath, ".gitmodules"),
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]);
  } catch {
    // Missing or malformed .gitmodules is not a reason to trust a nested repo.
  }
  const submodulePaths = new Set(configured
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.search(/\s/) + 1).trim()));
  for (const path of embeddedRepos) {
    const staged = await git(runGit, [
      "--literal-pathspecs",
      "-C",
      worktreePath,
      "ls-files",
      "--stage",
      "-z",
      "--",
      path,
    ]);
    const record = staged.split("\0").find(Boolean) ?? "";
    const tab = record.indexOf("\t");
    const metadata = tab === -1 ? [] : record.slice(0, tab).split(" ");
    const trackedPath = tab === -1 ? "" : record.slice(tab + 1);
    if (metadata[0] !== "160000" || trackedPath !== path || !submodulePaths.has(path)) {
      throw finalizationError(
        "ERESULT_EMBEDDED_REPO",
        `Result finalization refused untracked embedded repository: ${path}`,
      );
    }
  }
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
  ])).split("\0").filter(Boolean);
  if (paths.length === 0) return [];
  const treeEntries = new Map();
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
    for (const [path, entry] of entries) treeEntries.set(path, entry);
  }
  return paths.map((path) => {
    const tracker = path === ".beads" || path.startsWith(".beads/")
      ? { tracker: true }
      : {};
    const entry = treeEntries.get(path);
    if (!entry) return { path, deleted: true, ...tracker };
    if (entry.mode === "160000") {
      return { path, type: "gitlink", objectId: entry.objectId, ...tracker };
    }
    return { path, blobHash: entry.objectId, ...tracker };
  });
}

export async function finalizeResult({ worktreePath, baseCommit, runGit, expectedCommonDir }) {
  if (typeof runGit !== "function") {
    throw finalizationError("ERESULT_RUNNER", "Result finalization requires a git runner");
  }
  if (typeof worktreePath !== "string" || !worktreePath) {
    throw finalizationError("ERESULT_WORKTREE", "Result finalization requires a worktree path");
  }
  if (!COMMIT_PATTERN.test(String(baseCommit ?? ""))) {
    throw finalizationError("ERESULT_BASE", "Result finalization requires a valid base commit");
  }

  await validateGitLinkage(worktreePath, expectedCommonDir, runGit);
  const embeddedRepos = await inspectWorkspace(worktreePath);
  await assertTrackedEmbeddedRepos(runGit, worktreePath, embeddedRepos);
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
      "--force",
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
  // A detached descendant writing after this final clean check can mutate only
  // the disposable worktree, not the frozen result commit. ATT-003/004 bind
  // downstream verification and review to that SHA; writer quiescence is ATT-017.
  const finalEmbeddedRepos = await inspectWorkspace(worktreePath);
  await assertTrackedEmbeddedRepos(runGit, worktreePath, finalEmbeddedRepos);

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
