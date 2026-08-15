import assert from "node:assert/strict";
import test from "node:test";

import { agents, getAgent } from "./index.mjs";

const METHODS = [
  "options",
  "resolveModel",
  "validate",
  "launch",
  "resume",
  "stop",
  "preLaunchChecks",
];
const CAPABILITIES = [
  "canResume",
  "commitsOwnWork",
  "liveInput",
  "liveStream",
  "reportsCost",
];

for (const [id, agent] of agents) {
  test(`${id} adapter satisfies the agent contract`, () => {
    assert.equal(Object.isFrozen(agent), true);
    assert.equal(agent.id, id);
    assert.equal(typeof agent.displayName, "string");
    assert.ok(agent.displayName.length > 0);
    assert.equal(getAgent(id), agent);

    for (const method of METHODS) assert.equal(typeof agent[method], "function", method);
    assert.deepEqual(Object.keys(agent.capabilities).sort(), CAPABILITIES);
    for (const capability of CAPABILITIES) {
      assert.equal(typeof agent.capabilities[capability], "boolean", capability);
    }

    const options = agent.options();
    assert.equal(Object.hasOwn(options, "models"), true);
    assert.equal(Object.hasOwn(options, "efforts"), true);
    if (Object.hasOwn(options, "resolvedModel")) {
      assert.equal(typeof options.resolvedModel, "string");
      assert.ok(options.resolvedModel.length > 0);
    }
    for (const kind of ["models", "efforts"]) {
      assert.equal(Array.isArray(options[kind]), true, kind);
      for (const choice of options[kind]) {
        assert.deepEqual(Object.keys(choice).sort(), ["label", "value"]);
        assert.equal(typeof choice.value, "string");
        assert.ok(choice.value.length > 0);
        assert.equal(typeof choice.label, "string");
        assert.ok(choice.label.length > 0);
      }
    }
  });
}

test("getAgent rejects unregistered lanes with the dispatcher error", () => {
  assert.throws(() => getAgent("missing"), /Unsupported lane: missing/);
});

test("claude adapter keeps its model defaults and verbatim whitelist errors", () => {
  const claude = agents.get("claude");
  assert.equal(claude.resolveModel(), "sonnet");
  assert.equal(claude.resolveModel({ profile: { model: "haiku" } }), "haiku");
  assert.equal(claude.resolveModel({ requested: "opus[1m]" }), "opus[1m]");
  assert.throws(
    () => claude.resolveModel({ requested: "fable" }),
    /Unsupported model: fable.*fable is reserved for the architect session/,
  );
});

test("codex adapter supports terminal resume but not live input", () => {
  assert.equal(agents.get("codex").capabilities.canResume, true);
  assert.equal(agents.get("codex").capabilities.liveInput, false);
});
