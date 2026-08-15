import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createBootStamp } from "./version.mjs";

test("createBootStamp reads the package version and creates an ISO boot time", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );

  const bootStamp = createBootStamp();

  assert.equal(bootStamp.version, packageJson.version);
  assert.equal(new Date(bootStamp.bootedAt).toISOString(), bootStamp.bootedAt);
});

test("createBootStamp honors explicit version and boot time overrides", () => {
  assert.deepEqual(
    createBootStamp({
      version: "9.8.7-test",
      bootedAt: "2026-07-22T08:15:30.000Z",
    }),
    {
      version: "9.8.7-test",
      bootedAt: "2026-07-22T08:15:30.000Z",
    },
  );
});
