import assert from "node:assert/strict";
import test from "node:test";

import {
  LAST_PROJECT_KEY,
  rememberProject,
  selectVillageProject,
} from "../data/project-selection.mjs";

function storageWith(value) {
  const values = new Map(value == null ? [] : [[LAST_PROJECT_KEY, value]]);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, next) => values.set(key, next),
    values,
  };
}

const projects = [
  { name: "quiet" },
  { name: "atelier" },
  { name: "middle" },
];
const chronicles = new Map([
  ["quiet", { records: [] }],
  ["atelier", { records: Array.from({ length: 47 }, (_, id) => ({ id })) }],
  ["middle", { records: Array.from({ length: 12 }, (_, id) => ({ id })) }],
]);

test("multi-project live selection prefers query, then remembered, then richest chronicle", () => {
  const storage = storageWith("middle");
  assert.deepEqual(
    selectVillageProject({ projects, chronicles, search: "?project=quiet", storage }),
    { project: projects[0], reason: "query" },
  );
  assert.deepEqual(
    selectVillageProject({ projects, chronicles, storage }),
    { project: projects[2], reason: "remembered" },
  );
  assert.deepEqual(
    selectVillageProject({ projects, chronicles, storage: storageWith(null) }),
    { project: projects[1], reason: "richest" },
  );
});

test("unknown preferences fall through and chronicle ties preserve registry order", () => {
  const tied = new Map(projects.map((project) => [project.name, { records: [1] }]));
  assert.deepEqual(
    selectVillageProject({
      projects,
      chronicles: tied,
      search: "?project=missing",
      storage: storageWith("also-missing"),
    }),
    { project: projects[0], reason: "richest" },
  );
});

test("rememberProject survives unavailable storage", () => {
  const storage = storageWith(null);
  rememberProject(storage, "atelier");
  assert.equal(storage.values.get(LAST_PROJECT_KEY), "atelier");
  assert.doesNotThrow(() => rememberProject({
    setItem() {
      throw new Error("disabled");
    },
  }, "atelier"));
});
