import assert from "node:assert/strict";
import test from "node:test";

import {
  composerAgentId,
  dispatchLanePayload,
  onboardingAgentId,
  settingsAgentId,
  withOnboardingDefaultAgent,
} from "./agent-selection.mjs";
import { resolveProjectDefaultAgent } from "../server/lib/registry.mjs";

const agents = [{ id: "claude" }, { id: "codex" }];

test("composer seeds the resolved agent but leaves an untouched lane out of the payload", () => {
  const project = {
    dispatchProfile: { lane: "claude" },
    ownDispatchProfile: {},
    defaultAgent: "codex",
    resolvedDefaultAgent: "codex",
  };

  assert.equal(composerAgentId(project, agents), "codex");
  assert.deepEqual(dispatchLanePayload(false, "codex"), {});
  assert.deepEqual(dispatchLanePayload(true, "claude"), { lane: "claude" });
});

test("settings seeds defaultAgent before a conflicting merged or project-owned lane", () => {
  const project = {
    dispatchProfile: { lane: "claude" },
    ownDispatchProfile: { lane: "claude" },
    defaultAgent: "codex",
    resolvedDefaultAgent: "claude",
  };

  assert.equal(settingsAgentId(project, agents), "codex");
});

test("onboarding inherits the registry-wide agent until a project agent is explicitly selected", () => {
  const inferred = { name: "new-project", dispatchProfile: {} };
  const untouchedSelection = onboardingAgentId(inferred, agents);
  const untouchedSubmission = withOnboardingDefaultAgent(inferred, untouchedSelection);

  assert.equal(untouchedSelection, "");
  assert.equal(Object.hasOwn(untouchedSubmission, "defaultAgent"), false);
  assert.equal(
    resolveProjectDefaultAgent(untouchedSubmission, { dispatchProfile: { lane: "codex" } }),
    "codex",
  );

  const explicitSubmission = withOnboardingDefaultAgent(inferred, "claude");
  assert.equal(explicitSubmission.defaultAgent, "claude");
  assert.equal(
    resolveProjectDefaultAgent(explicitSubmission, { dispatchProfile: { lane: "codex" } }),
    "claude",
  );
});
