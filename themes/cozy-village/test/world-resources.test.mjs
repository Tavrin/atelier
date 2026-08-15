import assert from "node:assert/strict";
import test from "node:test";

import {
  createOwnedGroupRegistry,
  disposeOwnedObject,
} from "../world/resources.mjs";

function disposableNode({ ownGeometry = true, ownMaterial = true } = {}) {
  const calls = [];
  return {
    calls,
    node: {
      geometry: { dispose() { calls.push("geometry"); } },
      material: {
        map: { dispose() { calls.push("map"); } },
        dispose() { calls.push("material"); },
      },
      userData: { ownGeometry, ownMaterial },
    },
  };
}

test("owned object disposal releases only geometry and material resources owned by the group", () => {
  const owned = disposableNode();
  const shared = disposableNode({ ownGeometry: false, ownMaterial: false });
  const group = {
    traverse(visit) {
      visit(owned.node);
      visit(shared.node);
    },
  };

  disposeOwnedObject(group);

  assert.deepEqual(owned.calls, ["geometry", "map", "material"]);
  assert.deepEqual(shared.calls, []);
});

test("transition registry disposes superseded and detached groups before forgetting them", () => {
  const events = [];
  const parent = {
    remove(group) {
      events.push(`remove:${group.id}`);
      group.parent = null;
    },
  };
  const makeGroup = (id) => ({
    id,
    parent,
    traverse() {
      events.push(`dispose:${id}`);
    },
  });
  const registry = createOwnedGroupRegistry(parent);
  const superseded = registry.track(makeGroup("superseded"));
  const detached = registry.track(makeGroup("detached"));

  assert.equal(registry.release(superseded), true);
  detached.parent = null;
  registry.releaseAll();

  assert.deepEqual(events, [
    "dispose:superseded",
    "remove:superseded",
    "dispose:detached",
    "remove:detached",
  ]);
  assert.equal(registry.size, 0);
  assert.equal(registry.release(superseded), false, "already released groups are idempotent");
});

test("owned resource cleanup continues after a disposal failure", () => {
  const calls = [];
  const group = {
    traverse(visit) {
      visit({
        geometry: { dispose() { calls.push("geometry:bad"); throw new Error("bad geometry"); } },
        material: {
          map: { dispose() { calls.push("map:bad"); } },
          dispose() { calls.push("material:bad"); },
        },
        userData: { ownGeometry: true, ownMaterial: true },
      });
      visit({
        geometry: { dispose() { calls.push("geometry:good"); } },
        userData: { ownGeometry: true },
      });
    },
  };

  let error;
  assert.throws(() => disposeOwnedObject(group), (caught) => {
    error = caught;
    return true;
  });

  assert.equal(error.name, "CozyVillageResourceCleanupError");
  assert.deepEqual(calls, [
    "geometry:bad",
    "map:bad",
    "material:bad",
    "geometry:good",
  ]);
});

test("transition registry forgets every terminally failed group", () => {
  const removed = [];
  const parent = {
    remove(group) {
      removed.push(group.id);
    },
  };
  const registry = createOwnedGroupRegistry(parent);
  registry.track({
    id: "bad",
    parent,
    traverse() {
      throw new Error("traverse failed");
    },
  });
  registry.track({
    id: "good",
    parent,
    traverse() {},
  });

  assert.throws(() => registry.releaseAll(), /owned group cleanup failed/);

  assert.deepEqual(removed, ["bad", "good"]);
  assert.equal(registry.size, 0);
});
