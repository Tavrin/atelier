import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { finalizeResult, ResultFinalizationError } from "./result-finalizer.mjs";

const execFileAsync = promisify(execFile);

async function runGit(args) {
  const { stdout } = await execFileAsync("git", args, { encoding: "utf8" });
  return stdout;
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "atelier-result-finalizer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(["init", "-q", "--initial-branch=main", root]);
  await runGit(["-C", root, "config", "user.name", "Atelier Test"]);
  await runGit(["-C", root, "config", "user.email", "atelier@example.invalid"]);
  await writeFile(join(root, "code.mjs"), "export const value = 1;\n");
  await runGit(["-C", root, "add", "code.mjs"]);
  await runGit(["-C", root, "commit", "-q", "-m", "base"]);
  const baseCommit = (await runGit(["-C", root, "rev-parse", "HEAD"])).trim();
  return { root, baseCommit };
}

async function linkedRepository(t) {
  const container = await mkdtemp(join(tmpdir(), "atelier-result-linked-"));
  const primary = join(container, "primary");
  const root = join(container, "worktree");
  t.after(() => rm(container, { recursive: true, force: true }));
  await runGit(["init", "-q", "--initial-branch=main", primary]);
  await runGit(["-C", primary, "config", "user.name", "Atelier Test"]);
  await runGit(["-C", primary, "config", "user.email", "atelier@example.invalid"]);
  await writeFile(join(primary, "code.mjs"), "export const value = 1;\n");
  await runGit(["-C", primary, "add", "code.mjs"]);
  await runGit(["-C", primary, "commit", "-q", "-m", "base"]);
  const baseCommit = (await runGit(["-C", primary, "rev-parse", "HEAD"])).trim();
  await runGit(["-C", primary, "worktree", "add", "-q", "-b", "result", root, baseCommit]);
  return { root, primary, baseCommit, expectedCommonDir: join(primary, ".git") };
}

function finalizationInput(fixture) {
  return {
    worktreePath: fixture.root,
    baseCommit: fixture.baseCommit,
    runGit,
    ...(fixture.expectedCommonDir ? { expectedCommonDir: fixture.expectedCommonDir } : {}),
  };
}

async function assertTypedFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof ResultFinalizationError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test("dirty tracked files are committed exactly into a clean result", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 2;\n");

  const result = await finalizeResult(finalizationInput(fixture));
  const blobHash = (await runGit([
    "-C",
    fixture.root,
    "rev-parse",
    `${result.resultCommit}:code.mjs`,
  ])).trim();

  assert.equal(result.commitCreated, true);
  assert.equal(result.workspaceClean, true);
  assert.equal(result.baseCommit, fixture.baseCommit);
  assert.deepEqual(result.manifest, [{ path: "code.mjs", blobHash }]);
  assert.equal(await runGit(["-C", fixture.root, "status", "--porcelain=v1"]), "");
  assert.equal(
    await runGit(["-C", fixture.root, "show", "HEAD:code.mjs"]),
    "export const value = 2;\n",
  );
});

test("dirty tests and dirty code are both present in the result commit", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 3;\n");
  await writeFile(join(fixture.root, "code.test.mjs"), "assert.equal(value, 3);\n");

  const result = await finalizeResult(finalizationInput(fixture));

  assert.deepEqual(result.manifest.map(({ path }) => path), ["code.mjs", "code.test.mjs"]);
  assert.equal(
    await runGit(["-C", fixture.root, "show", "HEAD:code.test.mjs"]),
    "assert.equal(value, 3);\n",
  );
});

test("non-ignored untracked files are included and .beads remains excluded", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, "untracked.txt"), "included\n");
  await writeFile(join(fixture.root, ".gitignore"), "ignored.log\n");
  await runGit(["-C", fixture.root, "add", ".gitignore"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "ignore policy"]);
  fixture.baseCommit = (await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim();
  await mkdir(join(fixture.root, ".beads"));
  await writeFile(join(fixture.root, ".beads", "issues.jsonl"), "tracker\n");

  const result = await finalizeResult(finalizationInput(fixture));

  assert.deepEqual(result.manifest.map(({ path }) => path), ["untracked.txt"]);
  assert.equal(await runGit(["-C", fixture.root, "show", "HEAD:untracked.txt"]), "included\n");
  assert.equal(
    await runGit(["-C", fixture.root, "status", "--porcelain=v1", "--", ".beads"]),
    "?? .beads/\n",
  );
});

test("ignored-file surprises abort without creating a commit", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, ".gitignore"), "ignored.log\n");
  await runGit(["-C", fixture.root, "add", ".gitignore"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "ignore policy"]);
  fixture.baseCommit = (await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim();
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 4;\n");
  await writeFile(join(fixture.root, "ignored.log"), "surprise\n");

  await assertTypedFailure(finalizeResult(finalizationInput(fixture)), "ERESULT_IGNORED_FILES");

  assert.equal((await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim(), fixture.baseCommit);
  assert.match(await runGit(["-C", fixture.root, "status", "--porcelain=v1"]), /code\.mjs/);
});

test("operator-owned side-effect roots permit only named ignored paths after full status inspection", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, ".gitignore"), "allowed-cache/\nother-cache/\n");
  await runGit(["-C", fixture.root, "add", ".gitignore"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "ignore policy"]);
  fixture.baseCommit = (await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim();
  await mkdir(join(fixture.root, "allowed-cache"));
  await writeFile(join(fixture.root, "allowed-cache", "result.bin"), "operator-approved\n");

  const observed = [];
  const result = await finalizeResult({
    ...finalizationInput(fixture),
    verificationSideEffectAllowlist: ["allowed-cache"],
    runGit: async (args) => {
      if (args.includes("--ignored=matching")) observed.push([...args]);
      return runGit(args);
    },
  });
  assert.equal(result.workspaceClean, true);
  assert.equal(observed.length, 2);
  assert.equal(observed.every((args) => args.includes("--untracked-files=all")), true);

  await mkdir(join(fixture.root, "other-cache"));
  await writeFile(join(fixture.root, "other-cache", "result.bin"), "not approved\n");
  await assertTypedFailure(finalizeResult({
    ...finalizationInput(fixture),
    verificationSideEffectAllowlist: ["allowed-cache"],
  }), "ERESULT_IGNORED_FILES");
});

test("an ignored file created during staging is skipped and caught by the post-check", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, ".gitignore"), "late-ignored.log\n");
  await runGit(["-C", fixture.root, "add", ".gitignore"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "ignore policy"]);
  fixture.baseCommit = (await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim();
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 40;\n");
  let addArgs;
  const injectingRunGit = async (args) => {
    if (args[2] === "add") {
      addArgs = [...args];
      await writeFile(join(fixture.root, "late-ignored.log"), "arrived during finalize\n");
    }
    return runGit(args);
  };

  await assertTypedFailure(finalizeResult({
    ...finalizationInput(fixture),
    runGit: injectingRunGit,
  }), "ERESULT_IGNORED_FILES");
  assert.equal(addArgs.includes("--force"), false);
  await assert.rejects(
    runGit(["-C", fixture.root, "show", "HEAD:late-ignored.log"]),
  );
});

test("a symlink escaping the worktree aborts before staging", async (t) => {
  const fixture = await repository(t);
  await symlink(tmpdir(), join(fixture.root, "escape"));
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 5;\n");

  await assertTypedFailure(finalizeResult(finalizationInput(fixture)), "ERESULT_SYMLINK_ESCAPE");

  assert.equal((await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim(), fixture.baseCommit);
  assert.equal(await runGit(["-C", fixture.root, "diff", "--cached", "--name-only"]), "");
});

test("a special file aborts before staging", { skip: process.platform === "win32" }, async (t) => {
  const fixture = await repository(t);
  await execFileAsync("mkfifo", [join(fixture.root, "result.pipe")]);
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 6;\n");

  await assertTypedFailure(finalizeResult(finalizationInput(fixture)), "ERESULT_SPECIAL_FILE");

  assert.equal((await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim(), fixture.baseCommit);
  assert.equal(await runGit(["-C", fixture.root, "diff", "--cached", "--name-only"]), "");
});

test("a provider commit followed by dirt produces a new final result commit", async (t) => {
  const fixture = await repository(t);
  await writeFile(join(fixture.root, "provider.mjs"), "export const provider = true;\n");
  await runGit(["-C", fixture.root, "add", "provider.mjs"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "provider commit"]);
  const providerCommit = (await runGit(["-C", fixture.root, "rev-parse", "HEAD"])).trim();
  await writeFile(join(fixture.root, "after.txt"), "dirty after provider commit\n");

  const result = await finalizeResult(finalizationInput(fixture));

  assert.equal(result.commitCreated, true);
  assert.notEqual(result.resultCommit, providerCommit);
  assert.deepEqual(result.manifest.map(({ path }) => path), ["after.txt", "provider.mjs"]);
  assert.equal((await runGit(["-C", fixture.root, "rev-list", "--count", `${providerCommit}..HEAD`])).trim(), "1");
});

test("an already-clean standalone repository identifies HEAD without an empty commit", async (t) => {
  const fixture = await repository(t);
  const beforeCount = await runGit(["-C", fixture.root, "rev-list", "--count", "HEAD"]);

  const result = await finalizeResult(finalizationInput(fixture));

  assert.equal(result.commitCreated, false);
  assert.equal(result.resultCommit, fixture.baseCommit);
  assert.equal(result.workspaceClean, true);
  assert.deepEqual(result.manifest, []);
  assert.equal(await runGit(["-C", fixture.root, "rev-list", "--count", "HEAD"]), beforeCount);
});

test("an honest linked worktree validates against its primary common directory", async (t) => {
  const fixture = await linkedRepository(t);

  const result = await finalizeResult(finalizationInput(fixture));

  assert.equal(result.resultCommit, fixture.baseCommit);
  assert.equal(result.workspaceClean, true);
});

test("a gitfile pointing at a foreign repository fails linkage validation", async (t) => {
  const fixture = await linkedRepository(t);
  const expected = await repository(t);
  fixture.expectedCommonDir = join(expected.root, ".git");

  await assertTypedFailure(finalizeResult(finalizationInput(fixture)), "ERESULT_GIT_LINKAGE");
});

test("a symlinked top-level .git entry fails before invoking git", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-result-symlinked-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "git-target");
  await mkdir(target);
  await symlink(target, join(root, ".git"));
  let gitCalls = 0;

  await assertTypedFailure(finalizeResult({
    worktreePath: root,
    baseCommit: "1111111111111111111111111111111111111111",
    runGit: async () => {
      gitCalls += 1;
      return "";
    },
  }), "ERESULT_SYMLINK_ESCAPE");

  assert.equal(gitCalls, 0);
});

test("provider-committed code and .beads changes both appear in the complete manifest", async (t) => {
  const fixture = await repository(t);
  await mkdir(join(fixture.root, ".beads"));
  await writeFile(join(fixture.root, ".beads", "issues.jsonl"), "committed tracker state\n");
  await writeFile(join(fixture.root, "provider.mjs"), "export const provider = true;\n");
  await runGit(["-C", fixture.root, "add", ".beads/issues.jsonl", "provider.mjs"]);
  await runGit(["-C", fixture.root, "commit", "-q", "-m", "provider result"]);

  const result = await finalizeResult(finalizationInput(fixture));

  assert.deepEqual(result.manifest.map(({ path }) => path), [
    ".beads/issues.jsonl",
    "provider.mjs",
  ]);
  assert.equal(result.manifest[0].tracker, true);
  assert.equal("tracker" in result.manifest[1], false);
});

test("deleted manifest paths carry an explicit deleted marker", async (t) => {
  const fixture = await repository(t);
  await rm(join(fixture.root, "code.mjs"));

  const result = await finalizeResult(finalizationInput(fixture));

  assert.deepEqual(result.manifest, [{ path: "code.mjs", deleted: true }]);
});

test("an untracked embedded repository fails before staging", async (t) => {
  const fixture = await repository(t);
  const embedded = join(fixture.root, "vendor", "embedded");
  await mkdir(embedded, { recursive: true });
  await runGit(["init", "-q", embedded]);
  await writeFile(join(fixture.root, "code.mjs"), "export const value = 7;\n");

  await assertTypedFailure(finalizeResult(finalizationInput(fixture)), "ERESULT_EMBEDDED_REPO");

  assert.equal(await runGit(["-C", fixture.root, "diff", "--cached", "--name-only"]), "");
});

test("a tracked submodule is manifested as a gitlink, never a blob hash", async (t) => {
  const fixture = await repository(t);
  const dependency = await repository(t);
  await runGit([
    "-c",
    "protocol.file.allow=always",
    "-C",
    fixture.root,
    "submodule",
    "add",
    "-q",
    dependency.root,
    "vendor/dependency",
  ]);
  await runGit(["-C", fixture.root, "commit", "-q", "-am", "add submodule"]);
  const dependencyCommit = (await runGit([
    "-C",
    fixture.root,
    "rev-parse",
    "HEAD:vendor/dependency",
  ])).trim();

  const result = await finalizeResult(finalizationInput(fixture));
  const gitlink = result.manifest.find(({ path }) => path === "vendor/dependency");

  assert.deepEqual(gitlink, {
    path: "vendor/dependency",
    type: "gitlink",
    objectId: dependencyCommit,
  });
  assert.equal("blobHash" in gitlink, false);
});
