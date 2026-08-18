import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareVerificationSideEffectRoots,
  resolveVerificationSideEffectAllowlist,
  verificationSideEffectAllowed,
} from "./verification-side-effects.mjs";

test("verification side-effect roots resolve deterministically and match only path boundaries", () => {
  const allowlist = resolveVerificationSideEffectAllowlist({
    verificationSideEffectAllowlist: ["generated/cache/", "generated/cache", "reports"],
  });
  assert.deepEqual(allowlist, ["generated/cache", "reports"]);
  assert.equal(verificationSideEffectAllowed("generated/cache/result.bin", allowlist), true);
  assert.equal(verificationSideEffectAllowed("reports", allowlist), true);
  assert.equal(verificationSideEffectAllowed("generated/cache-shadow/result.bin", allowlist), false);
});

test("verification side-effect roots refuse symlink components before granting a writable bind", () => {
  const root = mkdtempSync(join(tmpdir(), "atelier-side-effects-"));
  const outside = mkdtempSync(join(tmpdir(), "atelier-side-effects-outside-"));
  try {
    symlinkSync(outside, join(root, "generated"), "dir");
    assert.throws(
      () => prepareVerificationSideEffectRoots(root, ["generated/cache"]),
      (error) => error.code === "EATELIER_VERIFICATION_SIDE_EFFECT_PATH_INVALID",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
