import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _clearProbeCache,
  probeProject,
  probeProjectPath,
  trackerMode,
} from "./capabilities.mjs";

async function gitFixture(t, tracker, initialBranch = "main") {
  const root = await mkdtemp(join(tmpdir(), "atelier-capabilities-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", `--initial-branch=${initialBranch}`], { cwd: root });
  await writeFile(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Atelier Test",
      "-c",
      "user.email=atelier@example.invalid",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );

  await mkdir(join(root, ".beads"));
  await writeFile(join(root, ".beads", "issues.jsonl"), "");
  if (tracker === "committed") {
    execFileSync("git", ["add", ".beads/issues.jsonl"], { cwd: root });
  }

  return { name: `fixture-${tracker}`, path: root, tracker };
}

test("probeProject reports git and marker capabilities with a 60s cache", async (t) => {
  const project = await gitFixture(t, "personal");
  _clearProbeCache();

  const first = await probeProject(project);
  assert.equal(first.beads, true);
  assert.equal(first.agentsMd, false);
  assert.equal(first.claudeMd, false);
  assert.equal(first.git.branch, "main");
  assert.deepEqual(first.git.branches, ["main"]);
  assert.equal(first.git.remoteHead, null);
  assert.equal(first.git.worktrees, 1);
  assert.equal(first.git.hasRemote, false);
  assert.ok(first.git.dirtyCount >= 1);

  await writeFile(join(project.path, "AGENTS.md"), "fixture\n");
  assert.equal((await probeProject(project)).agentsMd, false);
  _clearProbeCache();
  assert.equal((await probeProject(project)).agentsMd, true);
  assert.equal(existsSync(join(project.path, "AGENTS.md")), true);
});

test("onboarding prefers master when main is absent and otherwise keeps the current branch", async (t) => {
  const project = await gitFixture(t, "personal", "feature");
  execFileSync("git", ["branch", "master"], { cwd: project.path });
  _clearProbeCache();

  const withMaster = await probeProjectPath(project.path);
  assert.deepEqual(withMaster.git.branches, ["feature", "master"]);
  assert.equal(withMaster.inferred.mainBranch, "master");

  execFileSync("git", ["branch", "-D", "master"], { cwd: project.path });
  _clearProbeCache();
  assert.equal((await probeProjectPath(project.path)).inferred.mainBranch, "feature");
});

test("trackerMode distinguishes committed and personal beads", async (t) => {
  for (const declared of ["committed", "personal"]) {
    const project = await gitFixture(t, declared);
    const probe = await probeProject(project);
    assert.equal(await trackerMode(project, probe), declared);
  }
});

test("full-project capabilities and tracker mode inspect an external trackerPath", async (t) => {
  const project = await gitFixture(t, "personal");
  const trackerPath = join(project.path, "..", "trackers", project.name);
  await rm(join(project.path, ".beads"), { recursive: true, force: true });
  await mkdir(join(trackerPath, ".beads"), { recursive: true });
  await writeFile(join(trackerPath, ".beads", "issues.jsonl"), "");
  project.trackerPath = trackerPath;
  project.archetype = "full";
  _clearProbeCache();

  const probe = await probeProject(project);
  assert.equal(probe.beads, true);
  assert.equal(probe.git.isRepo, true);
  assert.equal(probe.git.branch, "main");
  assert.equal(await trackerMode(project, probe), "personal");
});

test("trackerMode warns when detection disagrees with the registry", async (t) => {
  const project = await gitFixture(t, "personal");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const probe = await probeProject(project);
    assert.equal(await trackerMode({ ...project, tracker: "none" }, probe), "personal");
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tracker mode mismatch/);
});

test("tracker-only capability and tracker probes skip git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-capabilities-tracker-only-"));
  await mkdir(join(root, ".beads"));
  await writeFile(join(root, ".beads", "issues.jsonl"), "");
  t.after(() => rm(root, { recursive: true, force: true }));
  _clearProbeCache();
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const project = { name: "notes", path: root, tracker: "personal", archetype: "tracker-only" };
    const probe = await probeProject(project);
    assert.equal(probe.git.isRepo, false);
    assert.equal(probe.git.branch, null);
    assert.equal(await trackerMode(project, probe), "personal");
  } finally {
    process.env.PATH = previousPath;
  }
});
