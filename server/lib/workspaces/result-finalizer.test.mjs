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

function finalizationInput(fixture) {
  return {
    worktreePath: fixture.root,
    baseCommit: fixture.baseCommit,
    runGit,
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

test("an already-clean workspace identifies HEAD without an empty commit", async (t) => {
  const fixture = await repository(t);
  const beforeCount = await runGit(["-C", fixture.root, "rev-list", "--count", "HEAD"]);

  const result = await finalizeResult(finalizationInput(fixture));

  assert.equal(result.commitCreated, false);
  assert.equal(result.resultCommit, fixture.baseCommit);
  assert.equal(result.workspaceClean, true);
  assert.deepEqual(result.manifest, []);
  assert.equal(await runGit(["-C", fixture.root, "rev-list", "--count", "HEAD"]), beforeCount);
});
