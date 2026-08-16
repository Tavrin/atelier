import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULTS,
  loadRegistry,
  normalizeProject,
  projectOwnDispatchProfile,
  RegistryError,
  updateProject,
  validateProject,
  validateRegistry,
} from "./registry.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-registry-"));
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: projectPath });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, projectPath, registryPath: join(root, "projects.json") };
}

function validProject(projectPath) {
  return {
    name: "atelier.test",
    path: projectPath,
    mainBranch: "main",
    tracker: "committed",
    containerized: false,
    verifyMode: "worktree",
    verifyCommands: ["node --test server/"],
  };
}

test("loadRegistry validates and merges the default dispatch profile", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      defaults: { dispatchProfile: { agent: "codex", effort: "high" } },
      projects: [{ ...validProject(projectPath), dispatchProfile: { effort: "medium" } }],
      groups: [{ name: "core", projects: ["atelier.test"] }],
    }),
  );

  const registry = await loadRegistry(registryPath);
  assert.deepEqual(registry.projects[0].dispatchProfile, {
    agent: "codex",
    effort: "medium",
  });
  assert.deepEqual(projectOwnDispatchProfile(registry.projects[0]), {
    effort: "medium",
  });
  assert.equal(registry.projects[0].autoCommitTracker, false);
  assert.equal(registry.projects[0].autoCloseOnMerge, false);
  assert.equal(registry.projects[0].requireReview, false);
});

test("registry writes do not promote default dispatch profile values to project overrides", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      defaults: { dispatchProfile: { lane: "claude", maxTurns: 50 } },
      projects: [{ ...validProject(projectPath), defaultAgent: "codex" }],
      groups: [],
    }),
  );

  const registry = await loadRegistry(registryPath);
  await updateProject(registry, "atelier.test", { notes: "keep precedence" }, registryPath);

  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(stored.projects[0].dispatchProfile, undefined);
  assert.deepEqual(projectOwnDispatchProfile(registry.projects[0]), {});
  assert.deepEqual(registry.projects[0].dispatchProfile, { lane: "claude", maxTurns: 50 });
});

test("loadRegistry returns the starter registry when the file is missing", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await loadRegistry(join(root, "missing.json")), {
    version: 1,
    defaults: {},
    groups: [],
    projects: [],
  });
});

test("loadRegistry accepts an empty projects array", async (t) => {
  const { registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({ version: 1, defaults: {}, groups: [], projects: [] }),
  );

  const registry = await loadRegistry(registryPath);
  assert.deepEqual(registry.projects, []);
});

test("loadRegistry infers legacy full and git-only archetypes without rewriting", async (t) => {
  const { root, projectPath, registryPath } = await fixture(t);
  const gitOnlyPath = join(root, "git-only");
  await mkdir(gitOnlyPath);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: gitOnlyPath });
  const original = {
    version: 1,
    defaults: {},
    groups: [],
    projects: [
      validProject(projectPath),
      { ...validProject(gitOnlyPath), name: "git-only", tracker: "none" },
    ],
  };
  const raw = JSON.stringify(original);
  await writeFile(registryPath, raw);

  const registry = await loadRegistry(registryPath);
  assert.equal(registry.projects[0].archetype, "full");
  assert.equal(registry.projects[1].archetype, "git-only");
  assert.equal(await readFile(registryPath, "utf8"), raw);
});

test("validateProject enforces archetype git and tracker invariants", async (t) => {
  const { root, projectPath } = await fixture(t);
  const plainPath = join(root, "plain");
  await mkdir(plainPath);

  assert.deepEqual(
    validateProject({
      ...validProject(plainPath),
      archetype: "tracker-only",
      tracker: "personal",
      mainBranch: null,
    }),
    [],
  );
  assert.match(
    validateProject({ ...validProject(plainPath), archetype: "full" }).join("\n"),
    /full requires a git repo/,
  );
  assert.match(
    validateProject({ ...validProject(projectPath), archetype: "git-only" }).join("\n"),
    /git-only requires tracker none/,
  );
});

test("project daily limits validate their units and can be removed atomically", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  assert.deepEqual(
    validateProject({
      ...validProject(projectPath),
      budgetUSDPerDay: 12.5,
      unpricedDispatchCapPerDay: 3,
    }),
    [],
  );
  for (const budgetUSDPerDay of [0, -1, "5", Number.POSITIVE_INFINITY]) {
    assert.match(
      validateProject({ ...validProject(projectPath), budgetUSDPerDay }).join("\n"),
      /budgetUSDPerDay must be a positive number/,
    );
  }
  for (const unpricedDispatchCapPerDay of [0, -1, 1.5, "5", Number.POSITIVE_INFINITY]) {
    assert.match(
      validateProject({ ...validProject(projectPath), unpricedDispatchCapPerDay }).join("\n"),
      /unpricedDispatchCapPerDay must be a positive integer/,
    );
  }

  const registry = {
    version: 1,
    defaults: {},
    groups: [],
    projects: [{
      ...validProject(projectPath),
      budgetUSDPerDay: 12.5,
      unpricedDispatchCapPerDay: 3,
    }],
  };
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`);
  const updated = await updateProject(
    registry,
    "atelier.test",
    { budgetUSDPerDay: null, unpricedDispatchCapPerDay: null },
    registryPath,
  );
  assert.equal("budgetUSDPerDay" in updated, false);
  assert.equal(
    "budgetUSDPerDay" in JSON.parse(await readFile(registryPath, "utf8")).projects[0],
    false,
  );
  assert.equal("unpricedDispatchCapPerDay" in updated, false);
  assert.equal(
    "unpricedDispatchCapPerDay" in JSON.parse(await readFile(registryPath, "utf8")).projects[0],
    false,
  );
});

test("ready queue failure limits accept only positive integers and can be removed", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  assert.deepEqual(
    validateProject({ ...validProject(projectPath), queueFailureLimit: 4 }),
    [],
  );
  for (const queueFailureLimit of [0, -1, 1.5, "2"]) {
    assert.match(
      validateProject({ ...validProject(projectPath), queueFailureLimit }).join("\n"),
      /queueFailureLimit must be a positive integer/,
    );
  }
  assert.deepEqual(
    validateRegistry({
      version: 1,
      defaults: { queueFailureLimit: 3 },
      groups: [],
      projects: [validProject(projectPath)],
    }),
    [],
  );
  assert.match(
    validateRegistry({
      version: 1,
      defaults: { queueFailureLimit: 0 },
      groups: [],
      projects: [validProject(projectPath)],
    }).join("\n"),
    /defaults\.queueFailureLimit must be a positive integer/,
  );

  const registry = {
    version: 1,
    defaults: {},
    groups: [],
    projects: [{ ...validProject(projectPath), queueFailureLimit: 4 }],
  };
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`);
  const updated = await updateProject(
    registry,
    "atelier.test",
    { queueFailureLimit: null },
    registryPath,
  );
  assert.equal("queueFailureLimit" in updated, false);
  assert.equal(
    "queueFailureLimit" in JSON.parse(await readFile(registryPath, "utf8")).projects[0],
    false,
  );
});

test("trackerPath must be an absolute directory outside other registered project trees", async (t) => {
  const { root, projectPath } = await fixture(t);
  const external = join(root, "state", "trackers", "atelier.test");
  const otherPath = join(root, "other");
  const nestedInOther = join(otherPath, "nested-tracker");
  await mkdir(external, { recursive: true });
  await mkdir(nestedInOther, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: otherPath });

  assert.deepEqual(validateProject({ ...validProject(projectPath), trackerPath: external }), []);
  assert.match(
    validateProject({ ...validProject(projectPath), trackerPath: "relative/tracker" }).join("\n"),
    /trackerPath must be an absolute path/,
  );
  assert.match(
    validateProject({
      ...validProject(projectPath),
      trackerPath: join(root, "missing"),
    }).join("\n"),
    /trackerPath must be an existing directory/,
  );

  const base = {
    version: 1,
    defaults: {},
    groups: [],
    projects: [
      { ...validProject(projectPath), trackerPath: nestedInOther },
      { ...validProject(otherPath), name: "other" },
    ],
  };
  assert.match(validateRegistry(base).join("\n"), /trackerPath must not be inside projects\[1\]\.path/);
  assert.deepEqual(
    validateRegistry({
      ...base,
      projects: [{ ...base.projects[0], trackerPath: otherPath }, base.projects[1]],
    }),
    [],
  );
});

test("updateProject preserves trackerPath unless an internal update explicitly removes it", async (t) => {
  const { root, projectPath, registryPath } = await fixture(t);
  const trackerPath = join(root, "state", "trackers", "atelier.test");
  await mkdir(trackerPath, { recursive: true });
  const project = { ...validProject(projectPath), trackerPath };
  const registry = { version: 1, defaults: {}, groups: [], projects: [project] };
  await writeFile(registryPath, `${JSON.stringify(registry)}\n`);

  const preserved = await updateProject(registry, project.name, { notes: "keep path" }, registryPath);
  assert.equal(preserved.trackerPath, trackerPath);
  const removed = await updateProject(
    registry,
    project.name,
    { trackerPath: undefined },
    registryPath,
  );
  assert.equal("trackerPath" in removed, false);
  assert.equal("trackerPath" in JSON.parse(await readFile(registryPath, "utf8")).projects[0], false);
});

test("loadRegistry merges dispatchEnv defaults with project values winning key by key", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      defaults: {
        dispatchProfile: {
          dispatchEnv: { SHARED: "default", DEFAULT_ONLY: "inherited" },
        },
      },
      projects: [
        {
          ...validProject(projectPath),
          dispatchEnv: { SHARED: "project", PROJECT_ONLY: "configured" },
        },
      ],
      groups: [],
    }),
  );

  const registry = await loadRegistry(registryPath);
  assert.deepEqual(registry.projects[0].dispatchEnv, {
    SHARED: "project",
    DEFAULT_ONLY: "inherited",
    PROJECT_ONLY: "configured",
  });
  assert.deepEqual(registry.projects[0].dispatchProfile.dispatchEnv, {
    SHARED: "project",
    DEFAULT_ONLY: "inherited",
    PROJECT_ONLY: "configured",
  });
});

test("loadRegistry rejects secret-shaped dispatchEnv keys", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      defaults: { dispatchProfile: { dispatchEnv: { BUILD_TOKEN: "not-allowed" } } },
      projects: [validProject(projectPath)],
      groups: [],
    }),
  );

  await assert.rejects(
    loadRegistry(registryPath),
    (error) =>
      error instanceof RegistryError &&
      /defaults\.dispatchProfile\.dispatchEnv\.BUILD_TOKEN.*secrets do not belong/.test(
        error.message,
      ),
  );
});

test("loadRegistry rejects every SECRET_ENV_KEY pattern alternative as a dispatchEnv key", async (t) => {
  const keys = ["API_KEY", "BUILD_TOKEN", "APP_SECRET", "DB_PASSWORD", "AWS_CREDENTIAL"];
  for (const key of keys) {
    const { projectPath, registryPath } = await fixture(t);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [{ ...validProject(projectPath), dispatchEnv: { [key]: "not-allowed" } }],
        groups: [],
      }),
    );

    await assert.rejects(
      loadRegistry(registryPath),
      (error) =>
        error instanceof RegistryError &&
        new RegExp(`projects\\[0\\]\\.dispatchEnv\\.${key}.*secrets do not belong`).test(
          error.message,
        ),
      `expected ${key} to be rejected as secret-shaped`,
    );
  }
});

test("dispatchEnv rejects execution controls while allowing application flags", async (t) => {
  const denied = ["PATH", "HOME", "GIT_DIR", "NODE_OPTIONS", "http_proxy"];
  for (const key of denied) {
    const { projectPath } = await fixture(t);
    const problems = validateProject({
      ...validProject(projectPath),
      dispatchEnv: { [key]: "hostile" },
    }).join("\n");
    assert.match(problems, new RegExp(`${key} controls execution; not permitted in dispatchEnv`, "i"));
  }

  const { projectPath } = await fixture(t);
  assert.deepEqual(
    validateProject({ ...validProject(projectPath), dispatchEnv: { MY_APP_FLAG: "enabled" } }),
    [],
  );
});

test("loadRegistry validates dispatchEnv key and string value shape", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [
        {
          ...validProject(projectPath),
          dispatchEnv: { lowercase: "no", NUMBER_VALUE: 3, NUL_VALUE: "bad\0value" },
        },
      ],
      groups: [],
    }),
  );

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.match(error.message, /lowercase key must match/);
    assert.match(error.message, /NUMBER_VALUE must be a string/);
    assert.match(error.message, /NUL_VALUE must not contain NUL/);
    return true;
  });
});

test("invalid project fields are all reported together", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 2,
      projects: [
        {
          name: "Invalid Name",
          path: projectPath,
          tracker: "somewhere",
          containerized: "no",
          verifyMode: "wishful",
        },
      ],
      groups: [],
    }),
  );

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.ok(error instanceof RegistryError);
    assert.match(error.message, /version/);
    assert.match(error.message, /name/);
    assert.match(error.message, /mainBranch/);
    assert.match(error.message, /tracker/);
    assert.match(error.message, /containerized/);
    assert.match(error.message, /verifyMode/);
    assert.match(error.message, /verifyCommands/);
    assert.ok(error.problems.length >= 7);
    return true;
  });
});

test("groups may only reference known project names", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [validProject(projectPath)],
      groups: [{ name: "core", projects: ["missing"] }],
    }),
  );

  await assert.rejects(
    loadRegistry(registryPath),
    (error) => error instanceof RegistryError && /unknown project missing/.test(error.message),
  );
});

test("validateProject exposes field-level validation for tests", async (t) => {
  const { projectPath } = await fixture(t);
  assert.deepEqual(validateProject(validProject(projectPath)), []);
});

test("project defaultAgent must name a registered adapter", async (t) => {
  const { projectPath } = await fixture(t);
  assert.deepEqual(validateProject({ ...validProject(projectPath), defaultAgent: "codex" }), []);
  assert.deepEqual(
    validateProject({ ...validProject(projectPath), defaultAgent: "missing" }),
    ["projects[0].defaultAgent must be a registered agent id (claude, codex)"],
  );
});

test("tracker automation flags validate booleans and reject meaningless projects", async (t) => {
  const { root, projectPath } = await fixture(t);
  const trackerOnlyPath = join(root, "tracker-only");
  await mkdir(trackerOnlyPath);

  assert.deepEqual(
    validateProject({
      ...validProject(projectPath),
      autoCommitTracker: true,
      autoCloseOnMerge: false,
    }),
    [],
  );
  assert.match(
    validateProject({
      ...validProject(projectPath),
      autoCommitTracker: "yes",
    }).join("\n"),
    /autoCommitTracker must be a boolean/,
  );
  assert.match(
    validateProject({
      ...validProject(projectPath),
      tracker: "none",
      archetype: "git-only",
      autoCloseOnMerge: false,
    }).join("\n"),
    /autoCloseOnMerge is unavailable when tracker is none/,
  );
  assert.match(
    validateProject({
      ...validProject(trackerOnlyPath),
      tracker: "personal",
      archetype: "tracker-only",
      mainBranch: null,
      autoCommitTracker: true,
    }).join("\n"),
    /autoCommitTracker requires a Git checkout/,
  );
});

test("requireReview is an optional boolean merge-safety setting", async (t) => {
  const { projectPath } = await fixture(t);
  assert.deepEqual(validateProject({ ...validProject(projectPath), requireReview: true }), []);
  assert.match(
    validateProject({ ...validProject(projectPath), requireReview: "yes" }).join("\n"),
    /requireReview must be a boolean/,
  );
});

test("reviewPolicy defaults to strict and validates every project policy", async (t) => {
  const { projectPath } = await fixture(t);
  assert.equal(normalizeProject(validProject(projectPath)).reviewPolicy, "strict");
  for (const reviewPolicy of ["strict", "tiered", "advisory"]) {
    assert.deepEqual(validateProject({ ...validProject(projectPath), reviewPolicy }), []);
  }
  assert.match(
    validateProject({ ...validProject(projectPath), reviewPolicy: "permissive" }).join("\n"),
    /reviewPolicy must be strict, tiered, or advisory/,
  );
});

test("maxFixRounds defaults to four, validates overrides, and keeps inherited defaults live", async (t) => {
  const { projectPath, registryPath } = await fixture(t);
  assert.equal(DEFAULTS.maxFixRounds, 4);
  const base = {
    version: 1,
    defaults: { maxFixRounds: 6 },
    groups: [],
    projects: [validProject(projectPath)],
  };
  assert.deepEqual(validateRegistry(base), []);
  assert.match(
    validateRegistry({ ...base, defaults: { maxFixRounds: 0 } }).join("\n"),
    /defaults\.maxFixRounds must be a positive integer/,
  );
  assert.match(
    validateProject({ ...validProject(projectPath), maxFixRounds: 1.5 }).join("\n"),
    /maxFixRounds must be a positive integer/,
  );

  await writeFile(registryPath, JSON.stringify(base));
  const registry = await loadRegistry(registryPath);
  assert.equal(registry.projects[0].maxFixRounds, 6);
  await updateProject(registry, "atelier.test", { notes: "preserve inheritance" }, registryPath);
  const stored = JSON.parse(await readFile(registryPath, "utf8"));
  assert.equal(Object.hasOwn(stored.projects[0], "maxFixRounds"), false);

  // Negative control: an explicit project override is retained rather than
  // silently falling back to the default.
  await updateProject(registry, "atelier.test", { maxFixRounds: 3 }, registryPath);
  assert.equal(registry.projects[0].maxFixRounds, 3);
  assert.equal(JSON.parse(await readFile(registryPath, "utf8")).projects[0].maxFixRounds, 3);
});

test("defaults.editorCommand accepts only one executable name or absolute path", async (t) => {
  const { projectPath } = await fixture(t);
  const base = {
    version: 1,
    defaults: {},
    groups: [],
    projects: [validProject(projectPath)],
  };
  for (const editorCommand of ["code", "/usr/local/bin/cursor"]) {
    assert.deepEqual(validateRegistry({ ...base, defaults: { editorCommand } }), []);
  }
  for (const editorCommand of ["code --reuse-window", "code;touch", "../code", "code|tee"]) {
    assert.match(
      validateRegistry({ ...base, defaults: { editorCommand } }).join("\n"),
      /editorCommand/,
    );
  }
});
