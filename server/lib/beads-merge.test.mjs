import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { mergeJsonl } from "./beads-merge.mjs";

const driverPath = fileURLToPath(new URL("./beads-merge.mjs", import.meta.url));

function line(id, title, updatedAt) {
  return JSON.stringify({ id, title, updated_at: updatedAt });
}

test("three-way JSONL merge keeps side-only records and resolves both-changed by timestamp", () => {
  const old = "2026-07-21T08:00:00.000Z";
  const middle = "2026-07-21T08:01:00.000Z";
  const newest = "2026-07-21T08:02:00.000Z";
  const base = [line("both", "base", old), line("theirs-change", "base", old)].join("\n");
  const ours = [
    line("both", "ours", middle),
    line("ours-only", "ours", middle),
    line("theirs-change", "base", old),
  ].join("\n");
  const theirs = [
    line("both", "theirs", newest),
    line("theirs-change", "theirs", middle),
    line("theirs-only", "theirs", middle),
  ].join("\n");

  assert.equal(
    mergeJsonl(`${base}\n`, `${ours}\n`, `${theirs}\n`),
    [
      line("both", "theirs", newest),
      line("ours-only", "ours", middle),
      line("theirs-change", "theirs", middle),
      line("theirs-only", "theirs", middle),
      "",
    ].join("\n"),
  );
});

test("merge driver exits 1 on malformed JSONL without overwriting ours", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "atelier-beads-merge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const basePath = join(root, "base.jsonl");
  const oursPath = join(root, "ours.jsonl");
  const theirsPath = join(root, "theirs.jsonl");
  const ours = `${line("ours", "unchanged", "2026-07-21T08:00:00.000Z")}\n`;
  await writeFile(basePath, "");
  await writeFile(oursPath, ours);
  await writeFile(theirsPath, "not-json\n");

  const result = spawnSync(process.execPath, [driverPath, basePath, oursPath, theirsPath], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /beads merge failed: theirs line 1/);
  assert.equal(await readFile(oursPath, "utf8"), ours);
});
