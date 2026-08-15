import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVillageArtifacts,
  assertVillageChronicle,
} from "./village-live-smoke.mjs";

const records = Array.from({ length: 47 }, (_, index) => ({
  id: String(index),
  diff: index < 44 ? { files: 1, insertions: index, deletions: 0 } : null,
}));

test("village live smoke requires more than 40 records and over 90% measured diffs", () => {
  assert.deepEqual(assertVillageChronicle({ records }), {
    records: 47,
    measured: 44,
    coverage: 44 / 47,
  });
  assert.throws(
    () => assertVillageChronicle({ records: records.slice(0, 40) }),
    /more than 40/,
  );
  assert.throws(
    () => assertVillageChronicle({
      records: records.map((record, index) => ({
        ...record,
        diff: index < 42 ? record.diff : null,
      })),
    }),
    /coverage above 90%/,
  );
});

test("village live smoke accepts only the bounded artifact projection", () => {
  const payload = {
    project: "atelier",
    generatedAt: "2026-07-30T12:00:00.000Z",
    artifacts: [
      {
        kind: "spec",
        title: "Village redesign",
        path: "docs/specs/atelier-spec-village-redesign.md",
        updatedAt: "2026-07-30T11:00:00.000Z",
      },
      {
        kind: "design",
        title: "World contract",
        path: "docs/design/world-contract-v0.md",
        updatedAt: "2026-07-30T11:30:00.000Z",
      },
    ],
  };
  assert.deepEqual(assertVillageArtifacts(payload, { project: "atelier" }), {
    artifacts: 2,
    specs: 1,
    designs: 1,
  });
  assert.throws(
    () => assertVillageArtifacts({
      ...payload,
      artifacts: [{ ...payload.artifacts[0], path: "docs/specs/../private.md" }],
    }),
    /traverses/,
  );
  assert.throws(
    () => assertVillageArtifacts({
      ...payload,
      artifacts: [{ ...payload.artifacts[0], kind: "design" }],
    }),
    /disagrees/,
  );
  assert.throws(
    () => assertVillageArtifacts({ ...payload, artifacts: [] }),
    /at least 1 artifact/,
  );
});
