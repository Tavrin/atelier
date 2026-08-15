/**
 * The fixture labels invented live work and measured archive history, while
 * exercising every functional station with contract-shaped records.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { gatesFor } from "../../../server/lib/world-contract.mjs";
import { createFixtureSource } from "../data/fixture.mjs";
import { gatesOf, stripFor } from "../state/gates.mjs";
import { buildVillage, STATION_DEFINITIONS } from "../state/village.mjs";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function freshFixture() {
  return createFixtureSource({ scripted: false }).load();
}

test("the archive fixture carries unique measured commits, timestamps, and diffs", async () => {
  const { chronicle } = await freshFixture();
  assert.ok(chronicle.records.length >= 40);
  assert.equal(new Set(chronicle.records.map(({ id }) => id)).size, chronicle.records.length);
  assert.equal(
    new Set(chronicle.records.map(({ merged }) => merged.commit)).size,
    chronicle.records.length,
  );
  for (const record of chronicle.records) {
    assert.match(record.id, /^[0-9a-f]{8}$/);
    assert.match(record.merged.commit, /^[0-9a-f]{7}$/);
    assert.match(record.mergedAt, ISO);
    assert.equal(record.mergedAt, record.merged.mergedAt);
    assert.ok(Date.parse(record.startedAt) <= Date.parse(record.mergedAt));
    assert.ok(record.diff.files >= 1);
    const churn = record.diff.insertions + record.diff.deletions;
    assert.ok(churn > 0 || /tracker/i.test(record.title));
  }
});

test("the fixture builds exactly seven permanent stations and honest parcels", async () => {
  const fixture = await freshFixture();
  const village = buildVillage({
    ...fixture,
    now: new Date("2026-07-30T12:00:00.000Z"),
  });

  assert.deepEqual(
    village.stations.map(({ id }) => id),
    STATION_DEFINITIONS.map(({ id }) => id),
  );
  assert.equal(village.stations.length, 7);
  assert.equal(village.parcels.length, fixture.dispatches.filter((record) => !record.merged).length);
  assert.equal(village.board.papers.length, 1, "the blocked tracker issue is not ready work");
  assert.equal(village.board.warning, false);
  assert.equal(village.hall.dock.failures.length, 1);
  assert.equal(village.rnd.artifacts.length, 4);

  for (const record of fixture.dispatches) {
    assert.deepEqual(record.gates, gatesFor(record), `${record.id}: stale fixture gates`);
    assert.equal(gatesOf(record).source, "server", `${record.id}: port fallback used`);
    assert.equal(stripFor(record, fixture.project).slots.length, 5);
  }
  for (const parcel of village.parcels) {
    assert.ok(village.stationById[parcel.stationId], `${parcel.id}: unknown station`);
    assert.equal(parcel.kind, "parcel");
    assert.ok(parcel.villager, `${parcel.id}: no agent identity`);
  }
});

test("the scripted arc addresses real records and carries fresh gates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const source = createFixtureSource();
  const { dispatches } = await source.load();
  const known = new Set(dispatches.map(({ id }) => id));
  const seen = [];
  const unsubscribe = source.subscribe((event) => seen.push(event));
  t.mock.timers.tick(60_000);
  unsubscribe();

  assert.equal(seen.length, 5);
  for (const event of seen) {
    assert.ok(known.has(event.dispatchId) || event.record?.id === event.dispatchId);
    if (event.record) assert.deepEqual(event.record.gates, gatesFor(event.record));
  }
});

test("the fixture source says which facts are measured and which are hand-written", async () => {
  const source = createFixtureSource({ scripted: false });
  assert.deepEqual(source.describe(), {
    mode: "fixture",
    label: "Fixture — measured archive, scripted present",
    detail: "not loaded yet",
  });
  const loaded = await source.load();
  const described = source.describe();
  assert.equal(source.mode, "fixture");
  assert.equal(described.mode, "fixture");
  assert.match(described.detail, new RegExp(`^${loaded.chronicle.records.length} merges read from git`));
  assert.match(described.detail, /measured/);
  assert.match(described.detail, /hand-written/);
  assert.match(loaded.chronicle.generatedAt, ISO);
});
