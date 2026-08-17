import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { atelierServerUrl } from "./command-client.mjs";

test("atelierServerUrl refuses a symlinked daemon URL file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atelier-url-symlink-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "outside-url");
  await writeFile(target, "http://127.0.0.1:9999\n");
  await symlink(target, join(directory, "atelier.url"));

  assert.throws(
    () => atelierServerUrl({ directory, env: {} }),
    /refuses non-regular or symlinked state file/,
  );
  assert.equal(await readFile(target, "utf8"), "http://127.0.0.1:9999\n");
});
