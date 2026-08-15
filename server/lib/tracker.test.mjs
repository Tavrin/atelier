import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setRunner,
  claimIssue,
  closeIssue,
  commitBeads,
  commentIssue,
  createIssue,
  loadIssues,
  parseIssuesJsonl,
  promoteIssue,
  runTrackerMutation,
} from "./tracker.mjs";

test("JSONL parsing preserves full issue records including comments and dependencies", () => {
  const issue = {
    id: "atelier-1",
    title: "Keep all fields",
    comments: [{ author: "agent", text: "context" }],
    dependencies: [{ issue_id: "atelier-1", depends_on_id: "atelier-0" }],
  };

  assert.deepEqual(parseIssuesJsonl(`${JSON.stringify(issue)}\n`), [issue]);
  assert.throws(() => parseIssuesJsonl("[]\n"), /issue is not an object/);
  assert.throws(() => parseIssuesJsonl("{}\nnot-json\n"), /line 2/);
});

test("loadIssues reads the primary checkout JSONL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-tracker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".beads"));
  const issue = { id: "atelier-2", title: "Primary" };
  await writeFile(join(root, ".beads", "issues.jsonl"), `${JSON.stringify(issue)}\n`);

  assert.deepEqual(await loadIssues({ path: root }), [issue]);
});

test("tracker mutations flush stale JSONL, debounce, and skip advanced JSONL", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-tracker-flush-"));
  const issuesPath = join(root, ".beads", "issues.jsonl");
  await mkdir(join(root, ".beads"));
  await writeFile(issuesPath, `${JSON.stringify({ id: "atelier-flush" })}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const staleCalls = [];
  await runTrackerMutation(
    { path: root },
    ["comments", "add", "atelier-flush", "stale"],
    {
      br: "/fixture/br",
      run: async (_file, args, options) => {
        staleCalls.push({ args, options });
        return "";
      },
    },
  );
  assert.deepEqual(staleCalls.map((call) => call.args), [
    ["comments", "add", "atelier-flush", "stale"],
    ["sync", "--flush-only"],
  ]);
  assert.ok(staleCalls.every((call) => call.options.cwd === root));

  const advancingRoot = join(root, "advancing");
  const advancingIssues = join(advancingRoot, ".beads", "issues.jsonl");
  await mkdir(join(advancingRoot, ".beads"), { recursive: true });
  await writeFile(advancingIssues, `${JSON.stringify({ id: "atelier-advanced" })}\n`);
  const advancedCalls = [];
  await runTrackerMutation(
    { path: advancingRoot },
    ["update", "atelier-advanced", "--status", "open"],
    {
      br: "/fixture/br",
      run: async (_file, args) => {
        advancedCalls.push(args);
        await appendFile(advancingIssues, " ");
        return "";
      },
    },
  );
  assert.deepEqual(advancedCalls, [["update", "atelier-advanced", "--status", "open"]]);

  const debounceRoot = join(root, "debounce");
  await mkdir(join(debounceRoot, ".beads"), { recursive: true });
  await writeFile(
    join(debounceRoot, ".beads", "issues.jsonl"),
    `${JSON.stringify({ id: "atelier-debounce" })}\n`,
  );
  const debounceCalls = [];
  let mutationCount = 0;
  let releaseMutations;
  const bothMutationsStarted = new Promise((resolvePromise) => {
    releaseMutations = resolvePromise;
  });
  const run = async (_file, args) => {
    debounceCalls.push(args);
    if (args[0] !== "sync") {
      mutationCount += 1;
      if (mutationCount === 2) releaseMutations();
      await bothMutationsStarted;
    }
    return "";
  };
  await Promise.all([
    runTrackerMutation(
      { path: debounceRoot },
      ["update", "atelier-debounce", "--status", "open"],
      { br: "/fixture/br", run },
    ),
    runTrackerMutation(
      { path: debounceRoot },
      ["comments", "add", "atelier-debounce", "parallel"],
      { br: "/fixture/br", run },
    ),
  ]);
  assert.equal(
    debounceCalls.filter((args) => args.join("\0") === ["sync", "--flush-only"].join("\0"))
      .length,
    1,
  );
});

test("loadIssues and tracker wrappers route through trackerPath when configured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-tracker-external-"));
  const trackerPath = join(root, "trackers", "project");
  await mkdir(join(trackerPath, ".beads"), { recursive: true });
  const issue = { id: "atelier-ext", title: "External" };
  await writeFile(join(trackerPath, ".beads", "issues.jsonl"), `${JSON.stringify(issue)}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const calls = [];
  _setRunner(async (file, args, options) => {
    calls.push({ file, args, options });
    return args[0] === "create" ? "atelier-ext\n" : "";
  });
  t.after(() => _setRunner());
  const project = { path: join(root, "code"), trackerPath };

  assert.deepEqual(await loadIssues(project), [issue]);
  await createIssue(project, { title: "Title", desc: "Description" });
  await promoteIssue(project, "atelier-ext");
  await commentIssue(project, "atelier-ext", "Progress");
  await closeIssue(project, "atelier-ext");
  await claimIssue(project, "atelier-ext", "codex");
  assert.ok(calls.every((call) => call.options.cwd === trackerPath));
});

test("tracker wrappers use seed argv shapes and project.path as cwd", async (t) => {
  const calls = [];
  _setRunner(async (file, args, options) => {
    calls.push({ file, args, options });
    return args[0] === "create" ? "atelier-3\n" : "";
  });
  t.after(() => _setRunner());
  const project = { path: "/primary/checkout" };

  assert.equal(
    await createIssue(project, {
      title: "Title",
      desc: "Description",
      ac: "Acceptance",
      type: "bug",
      priority: "2",
    }),
    "atelier-3",
  );
  assert.equal(await promoteIssue(project, "atelier-3"), "atelier-3");
  assert.equal(await commentIssue(project, "atelier-3", "Progress"), "atelier-3");
  assert.equal(await closeIssue(project, "atelier-3", "MCP completed it"), "atelier-3");
  assert.deepEqual(await claimIssue(project, "atelier-3", "codex"), {
    id: "atelier-3",
    actor: "codex",
  });

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      [
        "create",
        "Title",
        "--description",
        "Description",
        "--type",
        "bug",
        "--silent",
        "--priority",
        "2",
      ],
      ["update", "atelier-3", "--acceptance-criteria", "Acceptance"],
      ["update", "atelier-3", "--status", "open"],
      ["comments", "add", "atelier-3", "Progress"],
      ["close", "atelier-3", "--reason", "MCP completed it"],
      ["update", "atelier-3", "--claim", "--actor", "codex"],
    ],
  );
  assert.ok(calls.every((call) => call.options.cwd === project.path));
  assert.ok(calls.every((call) => typeof call.file === "string" && call.file.length > 0));
});

test("tracker wrappers defensively reject leading-dash user arguments", async (t) => {
  let called = false;
  _setRunner(async () => {
    called = true;
    return "";
  });
  t.after(() => _setRunner());

  await assert.rejects(promoteIssue({ path: "/primary" }, "--help"), /must not start/);
  await assert.rejects(closeIssue({ path: "/primary" }, "--help"), /must not start/);
  await assert.rejects(
    closeIssue({ path: "/primary" }, "atelier-1", "--reason-file"),
    /must not start/,
  );
  await assert.rejects(
    createIssue(
      { path: "/primary" },
      { title: "Safe", desc: "--file", type: "task" },
    ),
    /must not start/,
  );
  assert.equal(called, false);
});

test("commitBeads stages and commits only the .beads pathspec", async () => {
  const calls = [];
  const record = { warnings: [] };
  const project = { path: "/primary/checkout", autoCommitTracker: true };
  const result = await commitBeads(
    project,
    "chore(tracker): close atelier-3 [atelier]",
    {
      record,
      run: async (file, args) => {
        calls.push([file, args]);
        if (args[2] === "diff") throw new Error("staged changes");
        return "";
      },
    },
  );

  assert.deepEqual(result, { committed: true });
  assert.deepEqual(calls, [
    ["git", ["-C", project.path, "rev-parse", "--show-toplevel"]],
    ["git", ["-C", project.path, "add", "--", ".beads"]],
    ["git", ["-C", project.path, "diff", "--cached", "--quiet", "--", ".beads"]],
    [
      "git",
      [
        "-C",
        project.path,
        "commit",
        "-m",
        "chore(tracker): close atelier-3 [atelier]",
        "--",
        ".beads",
      ],
    ],
  ]);
  assert.equal(calls.flat(2).includes("-A"), false);
  assert.deepEqual(record.warnings, []);
});

test("commitBeads skips commit when .beads has nothing staged and defaults off", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, args]);
    return "";
  };

  assert.deepEqual(
    await commitBeads(
      { path: "/primary/checkout", autoCommitTracker: true },
      "unused",
      { run },
    ),
    { committed: false, clean: true },
  );
  assert.equal(calls.length, 3);

  calls.length = 0;
  assert.deepEqual(
    await commitBeads({ path: "/primary/checkout" }, "disabled", { run }),
    { committed: false, skipped: "disabled" },
  );
  assert.deepEqual(calls, []);
});

test("commitBeads turns Git failures into record warnings", async () => {
  const record = { warnings: [] };
  const result = await commitBeads(
    { path: "/primary/checkout", autoCommitTracker: true },
    "unused",
    {
      record,
      run: async (_file, args) => {
        if (args[2] === "rev-parse") return "/primary/checkout\n";
        throw new Error("read-only checkout");
      },
    },
  );

  assert.deepEqual(result, {
    committed: false,
    warning: "tracker auto-commit failed: read-only checkout",
  });
  assert.deepEqual(record.warnings, ["tracker auto-commit failed: read-only checkout"]);
});

test("commitBeads silently skips a non-Git external tracker and detects a Git trackers dir", async () => {
  const trackerPath = "/atelier-state/trackers/project";
  const project = {
    path: "/primary/checkout",
    trackerPath,
    autoCommitTracker: true,
  };
  const skippedCalls = [];
  assert.deepEqual(
    await commitBeads(project, "unused", {
      run: async (file, args) => {
        skippedCalls.push([file, args]);
        throw new Error("not a git repository");
      },
    }),
    { committed: false, skipped: "not-git" },
  );
  assert.deepEqual(skippedCalls, [
    ["git", ["-C", trackerPath, "rev-parse", "--show-toplevel"]],
  ]);

  const gitCalls = [];
  const committed = await commitBeads(project, "sync external tracker", {
    run: async (file, args) => {
      gitCalls.push([file, args]);
      if (args[2] === "diff") throw new Error("staged changes");
      return "/atelier-state/trackers\n";
    },
  });
  assert.deepEqual(committed, { committed: true });
  assert.ok(gitCalls.every(([, args]) => args[1] === trackerPath));
  assert.ok(gitCalls.some(([, args]) => args[2] === "commit"));
});

test("tracker mutation wrappers auto-commit with operation-specific messages", async (t) => {
  const commits = [];
  _setRunner(async (file, args) => {
    if (file !== "git") return args[0] === "create" ? "atelier-auto\n" : "";
    if (args[2] === "diff") throw new Error("staged changes");
    if (args[2] === "commit") commits.push(args[4]);
    return "";
  });
  t.after(() => _setRunner());
  const project = { path: "/primary/checkout", autoCommitTracker: true };

  await createIssue(project, { title: "Title", desc: "Description" });
  await promoteIssue(project, "atelier-auto");
  await commentIssue(project, "atelier-auto", "Progress");
  await closeIssue(project, "atelier-auto");
  await claimIssue(project, "atelier-auto", "codex");

  assert.deepEqual(commits, [
    "chore(tracker): create atelier-auto [atelier]",
    "chore(tracker): promote atelier-auto [atelier]",
    "chore(tracker): comment atelier-auto [atelier]",
    "chore(tracker): close atelier-auto [atelier]",
    "chore(tracker): claim atelier-auto [atelier]",
  ]);
});
