import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { snapshotThemeBundles } from "./themes.mjs";

async function fixture(t, manifest = {}) {
  const root = await mkdtemp(join(tmpdir(), "atelier-themes-"));
  const bundle = join(root, manifest.id ?? "forest");
  await mkdir(bundle);
  await mkdir(join(bundle, "vendor"));
  await writeFile(join(bundle, "entry.mjs"), "export function mount() {}\n");
  await writeFile(join(bundle, "asset.txt"), "first boot\n");
  await writeFile(join(bundle, "vendor", "renderer.js"), "export const renderer = true;\n");
  await writeFile(join(bundle, "manifest.json"), JSON.stringify({
    id: "forest",
    name: "Forest",
    version: "1.0.0",
    contractVersion: "0.4.0",
    tier: "render+actions",
    adapter: "webgl",
    entry: "entry.mjs",
    ...manifest,
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, bundle };
}

test("theme loader validates manifests and snapshots every bundle asset for one boot", async (t) => {
  const { root, bundle } = await fixture(t);
  const first = snapshotThemeBundles(root);

  assert.deepEqual(first.themes, [{
    id: "forest",
    name: "Forest",
    version: "1.0.0",
    contractVersion: "0.4.0",
    tier: "render+actions",
    adapter: "webgl",
    entry: "entry.mjs",
    entryUrl: "/themes/forest/entry.mjs",
  }]);
  assert.equal(first.assets.get("/themes/forest/asset.txt").body.toString(), "first boot\n");
  assert.equal(
    first.assets.get("/themes/forest/entry.mjs").contentType,
    "text/javascript; charset=utf-8",
  );
  assert.equal(
    first.assets.get("/themes/forest/vendor/renderer.js").body.toString(),
    "export const renderer = true;\n",
    "self-contained theme dependencies stay inside the theme bundle",
  );

  await writeFile(join(bundle, "asset.txt"), "second boot\n");
  assert.equal(
    first.assets.get("/themes/forest/asset.txt").body.toString(),
    "first boot\n",
    "the boot snapshot must not observe request-time disk changes",
  );
  assert.equal(
    snapshotThemeBundles(root).assets.get("/themes/forest/asset.txt").body.toString(),
    "second boot\n",
  );
});

test("theme loader rejects incompatible and escaping manifests instead of partially serving them", async (t) => {
  const incompatible = await fixture(t, {
    id: "future",
    contractVersion: "1.0.0",
  });
  assert.throws(
    () => snapshotThemeBundles(incompatible.root),
    /contractVersion 1\.0\.0 is incompatible/,
  );

  const incompatibleMinor = await fixture(t, {
    id: "past-minor",
    contractVersion: "0.1.0",
  });
  assert.throws(
    () => snapshotThemeBundles(incompatibleMinor.root),
    /contractVersion 0\.1\.0 is incompatible with 0\.4\.0/,
  );

  const escaping = await fixture(t, {
    id: "escape",
    entry: "../outside.mjs",
  });
  assert.throws(
    () => snapshotThemeBundles(escaping.root),
    /entry must stay inside its theme directory/,
  );
});

test("theme semver accepts build metadata and rejects leading-zero identifiers", async (t) => {
  const metadata = await fixture(t, {
    id: "metadata",
    version: "1.2.3+sha.abcdef",
    contractVersion: "0.4.0+sha.host",
  });
  assert.equal(snapshotThemeBundles(metadata.root).themes[0].version, "1.2.3+sha.abcdef");

  for (const [id, version] of [
    ["zero-major", "01.2.3"],
    ["zero-minor", "1.02.3"],
    ["zero-patch", "1.2.03"],
    ["zero-prerelease", "1.2.3-01"],
  ]) {
    const invalid = await fixture(t, { id, version });
    assert.throws(
      () => snapshotThemeBundles(invalid.root),
      /version must be semantic/,
      version,
    );
  }
});

test("theme manifest entry rejects a symlink even when its target stays in the bundle", async (t) => {
  const { root, bundle } = await fixture(t, { id: "linked-entry" });
  await writeFile(join(bundle, "real-entry.mjs"), "export function mount() {}\n");
  await rm(join(bundle, "entry.mjs"));
  await symlink("real-entry.mjs", join(bundle, "entry.mjs"));

  assert.throws(
    () => snapshotThemeBundles(root),
    /entry must not use symbolic links/,
  );
});

test("theme handbook carries the complete normative contract and deferred roadmap", async () => {
  const handbook = await readFile(
    new URL("../../docs/THEMES.md", import.meta.url),
    "utf8",
  );
  const worldContract = await readFile(
    new URL("../../docs/design/world-contract-v0.md", import.meta.url),
    "utf8",
  );

  assert.deepEqual(
    [...handbook.matchAll(/^R([1-6])\./gm)].map((match) => Number(match[1])),
    [1, 2, 3, 4, 5, 6],
  );
  for (const required of [
    "[a-z0-9][a-z0-9-]{0,39}",
    "minor-strict",
    "symlink",
    "boot-frozen",
    "GET /api/chronicle",
    "visibilitychange",
    "safeText",
    "createThemeStream",
    "context.generation",
    "json(\"/api/dispatches\", { signal: instance.signal })",
    "json(\"/api/chronicle\", { signal: instance.signal })",
    "export async function dispose(generation)",
    "Teardown never calls `getContext()`",
    "sandboxed iframe",
  ]) {
    assert.match(handbook, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(handbook, /not implemented\s+by the current first-party loader/);
  assert.match(worldContract, /Shared-vendor deduplication[\s\S]*\*\*DEFERRED\*\*/);
  assert.match(worldContract, /\*\*EMPIRICAL, contract v1 harvest:\*\*[\s\S]*districting/);
});
