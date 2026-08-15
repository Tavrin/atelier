import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import { isAbsolute, relative, dirname, join, resolve } from "node:path";

import { resolveBrExecutable, runFile } from "./exec.mjs";
import {
  projectArchetype,
  RegistryError,
  updateProject,
  validateRegistry,
} from "./registry.mjs";
import { trackerDirectory } from "./tracker.mjs";

const MOVE_TARGETS = new Set(["external", "in-repo"]);
const DEFAULT_FILE_OPS = Object.freeze({
  cp,
  createReadStream,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
});

function moveError(status, message, cause = undefined) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.status = status;
  return error;
}

async function pathExists(path, fileOps) {
  try {
    await fileOps.lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryManifest(root, fileOps) {
  const manifest = [];

  async function fileHash(path) {
    const hash = createHash("sha256");
    for await (const chunk of fileOps.createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }

  async function visit(path, relativePath) {
    const details = await fileOps.lstat(path);
    if (details.isDirectory()) {
      manifest.push({ path: relativePath, type: "directory" });
      const names = (await fileOps.readdir(path)).sort();
      for (const name of names) {
        await visit(join(path, name), relativePath === "." ? name : join(relativePath, name));
      }
      return;
    }
    if (details.isFile()) {
      manifest.push({
        path: relativePath,
        type: "file",
        size: details.size,
        sha256: await fileHash(path),
      });
      return;
    }
    if (details.isSymbolicLink()) {
      manifest.push({ path: relativePath, type: "symlink", target: await fileOps.readlink(path) });
      return;
    }
    throw new Error(`Unsupported tracker entry type: ${relativePath}`);
  }

  await visit(root, ".");
  return manifest;
}

async function moveDirectory(source, destination, fileOps) {
  await fileOps.mkdir(dirname(destination), { recursive: true });
  try {
    await fileOps.rename(source, destination);
    return "rename";
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }

  let verified = false;
  try {
    await fileOps.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
    });
    const [sourceManifest, destinationManifest] = await Promise.all([
      directoryManifest(source, fileOps),
      directoryManifest(destination, fileOps),
    ]);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(destinationManifest)) {
      throw new Error("Cross-device tracker copy verification failed");
    }
    verified = true;
    await fileOps.rm(source, { recursive: true, force: false });
    return "copy";
  } catch (error) {
    // Before verification the source is authoritative, so discard only the
    // incomplete copy. After verification, retain both copies if source
    // removal failed; preserving data is safer than guessing which to erase.
    if (!verified) {
      await fileOps.rm(destination, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

function projectWithChanges(registry, name, changes) {
  const projects = registry.projects.map((project) => {
    if (project.name !== name) return project;
    const candidate = { ...project, ...changes };
    if (changes.trackerPath === undefined) delete candidate.trackerPath;
    return candidate;
  });
  const candidateRegistry = { ...registry, projects };
  const problems = validateRegistry(candidateRegistry);
  if (problems.length > 0) throw new RegistryError(problems);
}

function nextSteps(project, to) {
  const inRepoTracker = join(project.path, ".beads");
  if (to === "in-repo") {
    return `Commit ${inRepoTracker} in your repository yourself. Atelier never git-adds or commits a moved tracker into your repository; it is your repo and your commit. Future Atelier mutations may be auto-committed only if autoCommitTracker is enabled.`;
  }
  return `Commit the removal of ${inRepoTracker} from your repository yourself. Atelier never commits deletions of tracked files in your repository.`;
}

export async function moveProjectTracker({
  registry,
  name,
  to,
  stateDir,
  registryPath,
  run = runFile,
  brExecutable = resolveBrExecutable(),
  fileOps: fileOpOverrides = {},
}) {
  if (!MOVE_TARGETS.has(to)) throw moveError(400, "to must be external or in-repo");
  const project = registry.projects.find((candidate) => candidate.name === name);
  if (!project) throw moveError(404, `Unknown project: ${name}`);
  if (projectArchetype(project) !== "full" || project.tracker === "none") {
    throw moveError(409, `Move tracker unavailable for project ${name}`);
  }

  const currentlyExternal =
    Boolean(project.trackerPath) && resolve(project.trackerPath) !== resolve(project.path);
  if ((to === "external") === currentlyExternal) {
    throw moveError(409, `Project ${name} tracker is already ${to}`);
  }

  const fileOps = { ...DEFAULT_FILE_OPS, ...fileOpOverrides };
  const sourceRoot = trackerDirectory(project);
  const destinationRoot = to === "external"
    ? join(stateDir, "trackers", project.name)
    : project.path;
  if (to === "external") {
    // Validate the derived destination against every registered project
    // BEFORE creating anything - the canonical containment check in the
    // registry validator is the authority; here we only need the cheap
    // pre-check that the Atelier-owned trackers namespace does not resolve
    // into someone's repo (symlink-proof via the registry's rules, which
    // run again at the registry update below).
    for (const other of registry.projects) {
      if (other.name === project.name) continue;
      const rel = relative(resolve(other.path), resolve(destinationRoot));
      if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
        throw moveError(409, `Destination resolves inside project ${other.name}`);
      }
    }
    await fileOps.mkdir(destinationRoot, { recursive: true });
  }
  const source = join(sourceRoot, ".beads");
  const destination = join(destinationRoot, ".beads");
  let sourceDetails;
  try {
    sourceDetails = await fileOps.lstat(source);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw moveError(409, `Tracker directory does not exist: ${source}`);
    }
    throw error;
  }
  if (!sourceDetails.isDirectory()) {
    throw moveError(409, `Tracker path is not a directory: ${source}`);
  }
  if (await pathExists(destination, fileOps)) {
    throw moveError(409, `Tracker destination already exists: ${destination}`);
  }

  const changes = to === "external"
    ? { trackerPath: destinationRoot, tracker: "personal" }
    : { trackerPath: undefined, tracker: "committed" };
  projectWithChanges(registry, name, changes);
  const previousChanges = {
    trackerPath: project.trackerPath,
    tracker: project.tracker,
  };

  const method = await moveDirectory(source, destination, fileOps);
  let updated;
  try {
    updated = await updateProject(registry, name, changes, registryPath);
  } catch (error) {
    try {
      await moveDirectory(destination, source, fileOps);
    } catch (rollbackError) {
      throw moveError(
        500,
        `Registry update failed (${error.message}) and tracker rollback failed: ${rollbackError.message}`,
        error,
      );
    }
    throw error;
  }

  try {
    await run(brExecutable, ["ready"], { cwd: destinationRoot });
  } catch (smokeError) {
    try {
      await moveDirectory(destination, source, fileOps);
    } catch (rollbackError) {
      throw moveError(
        409,
        `Tracker smoke failed (${smokeError.message}) and filesystem rollback failed: ${rollbackError.message}`,
        smokeError,
      );
    }
    try {
      await updateProject(registry, name, previousChanges, registryPath);
    } catch (rollbackError) {
      let alignment = "";
      try {
        await moveDirectory(source, destination, fileOps);
        alignment = " Filesystem restored to the updated registry location.";
      } catch (alignmentError) {
        alignment = ` Filesystem realignment also failed: ${alignmentError.message}`;
      }
      throw moveError(
        409,
        `Tracker smoke failed (${smokeError.message}) and registry rollback failed: ${rollbackError.message}.${alignment}`,
        smokeError,
      );
    }
    throw moveError(
      409,
      `Tracker smoke failed after move: ${smokeError.message}; move rolled back`,
      smokeError,
    );
  }

  return {
    project: updated,
    from: sourceRoot,
    to: destinationRoot,
    method,
    nextSteps: nextSteps(project, to),
  };
}
