import assert from "node:assert/strict";
import test from "node:test";

import {
  timelineEvidenceHref,
  timelineGroups,
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

  assert.deepEqual(groups.map(({ id, state }) => ({ id, state })), [
    { id: "dispatch-a", state: "blocked" },
    { id: "dispatch-b", state: "pending" },
  ]);
  assert.deepEqual(groups[0].steps.map(({ stage }) => stage), ["work", "attention", "merge"]);
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
