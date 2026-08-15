import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { moveProjectTracker } from "./tracker-move.mjs";

async function fixture(t, { external = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atelier-tracker-move-"));
  const projectPath = join(root, "project");
  const stateDir = join(root, "state");
  const registryPath = join(root, "config", "projects.json");
  await mkdir(projectPath);
  await mkdir(stateDir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  const trackerPath = external ? join(stateDir, "trackers", "fixture") : projectPath;
  await mkdir(join(trackerPath, ".beads", "cache"), { recursive: true });
  await writeFile(join(trackerPath, ".beads", "issues.jsonl"), '{"id":"fixture-1"}\n');
  await writeFile(join(trackerPath, ".beads", "beads.db"), "sqlite-cache\n");
  await writeFile(join(trackerPath, ".beads", "cache", "metadata"), "nested\n");
  const project = {
    name: "fixture",
    path: projectPath,
    ...(external ? { trackerPath } : {}),
    mainBranch: "main",
    tracker: external ? "personal" : "committed",
    archetype: "full",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: [],
    dispatchProfile: {},
  };
  const registry = { version: 1, defaults: {}, groups: [], projects: [project] };
  await mkdir(join(root, "config"));
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectPath, stateDir, registryPath, registry, trackerPath };
}

test("moveProjectTracker moves both directions, including the SQLite cache, and is reversible", async (t) => {
  const setup = await fixture(t);
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd });
    return "";
  };

  const external = await moveProjectTracker({
    registry: setup.registry,
    name: "fixture",
    to: "external",
    stateDir: setup.stateDir,
    registryPath: setup.registryPath,
    run,
    brExecutable: "/fixture/br",
  });
  const externalRoot = join(setup.stateDir, "trackers", "fixture");
  assert.equal(external.method, "rename");
  assert.equal(external.project.trackerPath, externalRoot);
  assert.equal(external.project.tracker, "personal");
  assert.match(external.nextSteps, /Commit the removal/);
  assert.match(external.nextSteps, /Atelier never commits deletions/);
  assert.equal(await readFile(join(externalRoot, ".beads", "beads.db"), "utf8"), "sqlite-cache\n");
  assert.equal(
    await readFile(join(externalRoot, ".beads", "cache", "metadata"), "utf8"),
    "nested\n",
  );
  await assert.rejects(readFile(join(setup.projectPath, ".beads", "issues.jsonl")), /ENOENT/);
  assert.deepEqual(calls[0], { file: "/fixture/br", args: ["ready"], cwd: externalRoot });

  const inRepo = await moveProjectTracker({
    registry: setup.registry,
    name: "fixture",
    to: "in-repo",
    stateDir: setup.stateDir,
    registryPath: setup.registryPath,
    run,
    brExecutable: "/fixture/br",
  });
  assert.equal(inRepo.project.tracker, "committed");
  assert.equal("trackerPath" in inRepo.project, false);
  assert.match(inRepo.nextSteps, /Atelier never git-adds or commits/);
  assert.equal(await readFile(join(setup.projectPath, ".beads", "beads.db"), "utf8"), "sqlite-cache\n");
  await assert.rejects(readFile(join(externalRoot, ".beads", "issues.jsonl")), /ENOENT/);
  assert.deepEqual(calls[1], {
    file: "/fixture/br",
    args: ["ready"],
    cwd: setup.projectPath,
  });
  assert.equal(calls.some((call) => call.file === "git"), false);

  const stored = JSON.parse(await readFile(setup.registryPath, "utf8"));
  assert.equal("trackerPath" in stored.projects[0], false);
  assert.equal(stored.projects[0].tracker, "committed");
});

test("moveProjectTracker rolls filesystem and registry back when post-move br ready fails", async (t) => {
  const setup = await fixture(t);
  const externalRoot = join(setup.stateDir, "trackers", "fixture");
  await assert.rejects(
    moveProjectTracker({
      registry: setup.registry,
      name: "fixture",
      to: "external",
      stateDir: setup.stateDir,
      registryPath: setup.registryPath,
      run: async (_file, args, options) => {
        assert.deepEqual(args, ["ready"]);
        assert.equal(options.cwd, externalRoot);
        const duringSmoke = JSON.parse(await readFile(setup.registryPath, "utf8"));
        assert.equal(duringSmoke.projects[0].trackerPath, externalRoot);
        throw new Error("br cache refused relocated store");
      },
      brExecutable: "/fixture/br",
    }),
    (error) => error.status === 409 && /move rolled back/.test(error.message),
  );

  assert.equal(await readFile(join(setup.projectPath, ".beads", "beads.db"), "utf8"), "sqlite-cache\n");
  await assert.rejects(readFile(join(externalRoot, ".beads", "issues.jsonl")), /ENOENT/);
  assert.equal("trackerPath" in setup.registry.projects[0], false);
  assert.equal(setup.registry.projects[0].tracker, "committed");
  const stored = JSON.parse(await readFile(setup.registryPath, "utf8"));
  assert.equal("trackerPath" in stored.projects[0], false);
  assert.equal(stored.projects[0].tracker, "committed");
});

test("moveProjectTracker falls back to copy, verify, and remove across devices", async (t) => {
  const setup = await fixture(t, { external: true });
  let renameCalls = 0;
  const result = await moveProjectTracker({
    registry: setup.registry,
    name: "fixture",
    to: "in-repo",
    stateDir: setup.stateDir,
    registryPath: setup.registryPath,
    run: async () => "",
    brExecutable: "/fixture/br",
    fileOps: {
      rename: async (...args) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          const error = new Error("cross-device link");
          error.code = "EXDEV";
          throw error;
        }
        return rename(...args);
      },
    },
  });

  assert.equal(result.method, "copy");
  assert.equal(await readFile(join(setup.projectPath, ".beads", "issues.jsonl"), "utf8"), '{"id":"fixture-1"}\n');
  assert.equal(await readFile(join(setup.projectPath, ".beads", "beads.db"), "utf8"), "sqlite-cache\n");
  await assert.rejects(readFile(join(setup.trackerPath, ".beads", "issues.jsonl")), /ENOENT/);
});
