import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  timelineEvidenceHref,
  timelineGroups,
  timelineLinkHref,
  timelineStageLabel,
  timelineStageOrder,
} from "./timeline-view.mjs";

function item(id, stage, state, code = stage) {
  return {
    stage,
    code,
    state,
    subject: { kind: "dispatch", id, project: "fixture" },
  };
}

test("timeline groups dispatches and orders steps by the fixed stage vocabulary", () => {
  const groups = timelineGroups({
    items: [
      item("dispatch-b", "execution", "pending"),
      item("dispatch-a", "merge", "done"),
      item("dispatch-a", "work", "done"),
      item("dispatch-a", "attention", "blocked"),
    ],
  });

  // dispatch-b first because the SERVER emitted it first. The view must not
  // re-sort by id: the server orders newest-first and truncates from the tail,
  // so an alphabetical re-sort here would undo the ordering the bound relied on.
  assert.deepEqual(groups.map(({ id, state }) => ({ id, state })), [
    { id: "dispatch-b", state: "pending" },
    { id: "dispatch-a", state: "blocked" },
  ]);
  assert.deepEqual(groups[1].steps.map(({ stage }) => stage), ["work", "attention", "merge"]);
  assert.ok(timelineStageOrder("review") < timelineStageOrder("main_health"));
  assert.equal(timelineStageLabel("main_health"), "Main health");
});

test("timeline evidence navigation accepts only existing API surfaces", () => {
  assert.equal(
    timelineEvidenceHref({ http: "/api/dispatch/dispatch-a/events" }),
    "/api/dispatch/dispatch-a/events",
  );
  assert.equal(timelineEvidenceHref({ http: "https://example.invalid/evidence" }), null);
  assert.equal(timelineEvidenceHref({}), null);
});

test("cross-dispatch timeline targets navigate to the existing dispatch detail", () => {
  assert.equal(
    timelineLinkHref({ to: { kind: "dispatch", id: "dispatch/a b" } }),
    "#/dispatch/dispatch%2Fa%20b",
  );
  assert.equal(timelineLinkHref({ to: { kind: "commit", id: "abc123" } }), null);
  assert.equal(timelineLinkHref({}), null);
});

test("timeline cards render cross-dispatch targets as anchors", async () => {
  const app = await readFile(new URL("./app.js", import.meta.url), "utf8");
  assert.match(app, /const targetHref = timelineLinkHref\(link\)/);
  assert.match(app, /target\.href = targetHref/);
  assert.match(app, /row\.append\(document\.createTextNode\(" Target: "\), target\)/);
});
