import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configDir, ensureDir, stateDir } from "./paths.mjs";

test("ATELIER directory overrides win on every platform", (t) => {
  const previousConfig = process.env.ATELIER_CONFIG_DIR;
  const previousState = process.env.ATELIER_STATE_DIR;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.ATELIER_CONFIG_DIR;
    else process.env.ATELIER_CONFIG_DIR = previousConfig;
    if (previousState === undefined) delete process.env.ATELIER_STATE_DIR;
    else process.env.ATELIER_STATE_DIR = previousState;
  });

  process.env.ATELIER_CONFIG_DIR = "C:\\atelier-test\\config";
  process.env.ATELIER_STATE_DIR = "C:\\atelier-test\\state";

  assert.equal(configDir(), "C:\\atelier-test\\config");
  assert.equal(stateDir(), "C:\\atelier-test\\state");
});

test("ensureDir creates nested directories and returns the path", (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nested = join(root, "one", "two");

  assert.equal(ensureDir(nested), nested);
  assert.equal(ensureDir(nested), nested);
});
