// The Atelier side of the Switchgear `contract-v1-rc1` freeze.
//
// This file is the executable half of the pin. `contracts/switchgear/contract-v1-rc1/`
// holds a verbatim copy of Switchgear's frozen public contract-fixture corpus plus the
// two closed result schemas; `PIN.json` beside it records the tag, the peeled commit,
// the component versions and a sha256 of every vendored file. What follows asserts the
// consumer expectations Atelier's future Switchgear adapter will depend on, against
// those real captured records.
//
// What this is NOT: an adapter. Nothing here spawns a provider, reads a Switchgear
// state root, shells out to `switchgear`, or touches the network. Every assertion is a
// pure read of committed JSON, which is exactly what the program's §10 asks for --
// "contract tests with Switchgear are FIXTURES generated from recorded real records --
// no live SG in Atelier CI, no Atelier in SG CI; each repo pins the other's fixture set
// version". This file is Atelier's half of that pin.
//
// The decode rules below (`liftV1ToV2`, `projectV2ToV1`, `resolveNormalizedVersion`,
// `changePresence`, `providerExecution`, `validateClosedRecord`) are the consumer
// obligations stated as code rather than as prose. They are deliberately kept here and
// not in `server/`: the adapter that will import a production version of them is
// blocked, and a rule with no caller belongs beside its proof, not in a lib nobody
// loads. When WP-A2-ADAPTER lands, it must satisfy these same tables.
//
// A note on what the corpus can and cannot prove. The fixtures are real values from a
// real hermetic capture run: job ids, timestamps, digests, durations and costs CHANGE
// on every re-capture and are never asserted here. What is asserted is contract shape
// and the relationships between fields.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const PIN_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "switchgear",
  "contract-v1-rc1",
);
const PIN = readJson(join(PIN_DIR, "PIN.json"));
const PACK_DIR = join(PIN_DIR, PIN.vendored.fixture_pack);
const MANIFEST = readJson(join(PACK_DIR, "MANIFEST.json"));

// Keyed by the exact `$ref` string the schemas use, so resolution is a lookup rather than
// a path join.
const SCHEMAS = {
  "result.schema.json": readJson(join(PIN_DIR, "schemas", "result.schema.json")),
  "result-v1.schema.json": readJson(join(PIN_DIR, "schemas", "result-v1.schema.json")),
  "model.schema.json": readJson(join(PIN_DIR, "schemas", "model.schema.json")),
  "session-binding.schema.json": readJson(
    join(PIN_DIR, "schemas", "session-binding.schema.json"),
  ),
};

// The scenarios that are whole job records (a directory), as opposed to the two
// standalone gc projections.
const SCENARIOS = [
  "awaiting_external_review",
  "crashed_launch_only",
  "dirty",
  "empty_final_text_with_change",
  "legacy_v1",
  "needs_input",
  "ok",
  "provider_error",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function scenarioFile(scenario, name) {
  return join(PACK_DIR, scenario, name);
}

function readScenario(scenario, name) {
  return readJson(scenarioFile(scenario, name));
}

function readEvents(scenario, version) {
  return readFileSync(scenarioFile(scenario, `events.v${version}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

// --------------------------------------------------------------------------------
// The consumer rules, as code.
// --------------------------------------------------------------------------------

// Versions this pin can honour. Anything else fails closed -- which is the whole point:
// a future Switchgear that bumps a component turns this red instead of being silently
// decoded with the wrong vocabulary.
const SUPPORTED = {
  normalized_events: [1, 2],
  result_schema: [1, 2],
  digest: [1],
  session_binding: [1],
};

class ContractRefusal extends Error {}

// contract-v1-rc1 §5. The version a finished job's normalized stream speaks is resolved
// per job, in this precedence -- NOT from the current build, and NOT from the artifact
// filename:
//
//   1. the result record's `artifacts.events_normalized_version`;
//   2. else, for a job with NO RESULT, `runner.json`'s `events_normalized_version`;
//   3. else 1, for records written before either key existed.
//
// Two details matter and are easy to get subtly wrong, so they are spelled out. The
// runner fallback is scoped to "no result record" -- a result that exists but omits the
// key is case 3, not a licence to consult the runner. And a key that is PRESENT but
// unspellable refuses, `null` included: quietly defaulting a malformed value to 1 would
// be a fail-OPEN on a version boundary, which is precisely the bug class B1 was.
function resolveNormalizedVersion({ result, runner }) {
  let declared;
  if (result) {
    declared = "events_normalized_version" in (result.artifacts ?? {})
      ? result.artifacts.events_normalized_version
      : 1;
  } else if (runner && "events_normalized_version" in runner) {
    declared = runner.events_normalized_version;
  } else {
    declared = 1;
  }
  if (!Number.isInteger(declared) || !SUPPORTED.normalized_events.includes(declared)) {
    throw new ContractRefusal(
      `unsupported normalized-event version ${JSON.stringify(declared)}`,
    );
  }
  return declared;
}

// contract-v1-rc1 §2. `status` is DERIVED from four independently recorded facts, and an
// adapter that re-derives it wrongly is the failure this pins. Stated as the precedence
// the persisted statuses imply, and checked against every record in the corpus.
function projectStatus(result) {
  const execution = providerExecution(result);
  const integrity = result?.integrity?.outcome;
  const acceptance = result?.acceptance?.state;
  if (integrity === "dirty") return "dirty"; // integrity outranks a healthy provider
  if (execution === "timeout") return "timeout";
  if (execution === "provider_error") return "provider_error";
  if (acceptance === "awaiting_external_review") return "awaiting_external_review";
  if (acceptance === "awaiting_review") return "awaiting_review";
  return "ok";
}

// contract-v1-rc1 §5, the v1 -> v2 direction. This is a CONSUMER mapping; Switchgear
// deliberately does not implement it, because doing so would create a second place that
// could invent a `final_text_state` v1 never recorded. `unknown` is the honest value.
function liftV1ToV2(v1Status) {
  switch (v1Status) {
    case "completed":
      return { status: "completed", final_text_state: "present" };
    case "completed_empty":
      return { status: "completed", final_text_state: "empty" };
    case "needs_input":
      return { status: "needs_input", final_text_state: "unknown" };
    case "failed":
      return { status: "failed", final_text_state: "unknown" };
    default:
      throw new ContractRefusal(`unknown v1 finished.status ${JSON.stringify(v1Status)}`);
  }
}

// contract-v1-rc1 §5, the v2 -> v1 direction. Exact, and implemented on both sides.
function projectV2ToV1({ status, final_text_state: finalTextState }) {
  const key = `${status}/${finalTextState}`;
  const table = {
    "completed/present": "completed",
    "completed/empty": "completed_empty",
    "needs_input/present": "needs_input",
    "needs_input/empty": "needs_input",
    "failed/present": "failed",
    "failed/empty": "failed",
  };
  const projected = table[key];
  if (projected === undefined) throw new ContractRefusal(`no v1 spelling for ${key}`);
  return projected;
}

// contract-v1-rc1 §4 and §10. Change presence comes from the controller's measurement of
// the worktree, NEVER from the terminal transcript status. This is the rule that
// I-AT-002 was filed about: an adapter reading `completed_empty` as "changed nothing"
// silently refuses to merge work that really landed.
function changePresence(result) {
  const state = result?.change?.state;
  if (state !== "none" && state !== "frozen") {
    throw new ContractRefusal(`unknown change.state ${JSON.stringify(state)}`);
  }
  return { changed: state === "frozen", files: result?.freeze?.changed_files ?? [] };
}

// contract-v1-rc1 §4 / B4. Three questions, three fields. This one answers only "did the
// provider process execute successfully?", and it reads the result, not the transcript.
function providerExecution(result) {
  const outcome = result?.execution?.outcome;
  if (!["completed", "provider_error", "timeout"].includes(outcome)) {
    throw new ContractRefusal(`unknown execution.outcome ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

// contract-v1-rc1 B5. `harness` (agent CLI family) and `pool` (model-serving provider)
// are the canonical nouns. Bare `provider` is a surface-specific legacy alias and is
// never read as a cross-surface field.
function canonicalNouns(jobsRow) {
  const { harness, pool } = jobsRow;
  if (typeof harness !== "string" || typeof pool !== "string") {
    throw new ContractRefusal("jobs row lacks canonical harness/pool");
  }
  return { harness, pool };
}

// A deliberately small schema checker. It is NOT a JSON Schema engine and does not
// pretend to be. It honours exactly: `type`, `const`, `enum`, `required`, `properties`,
// `additionalProperties` (both `false` and a map schema), `items`, `pattern`, `minimum`,
// `minLength`, and `$ref` against the vendored schema set. Everything else in a real schema it ignores.
//
// That reach is stated rather than implied because the "strict and distinct" claim rests
// on it. Two consequences a reader should hold onto:
//
//   - `$ref` MUST resolve. `result.schema.json` refs `model.schema.json` for the field
//     carrying pool identity; without resolution that whole subtree goes unchecked, and
//     an adapter's most load-bearing read would be unpinned.
//   - Several nested objects in the real schemas are deliberately OPEN
//     (`integrity`, `artifacts`, `freeze`, `process`, `correlation`, `review`,
//     `provider_calls`, `resumed`, and two array item shapes). This checker cannot make
//     them strict, because the contract does not. G29's standing obligation -- never
//     codegen nested shapes -- is the reason, not an oversight here.
function validateClosedRecord(schema, value, path = "$", registry = SCHEMAS) {
  if (schema.$ref) {
    const target = registry[schema.$ref];
    // An unresolvable ref must be an error, never a silently-skipped subtree.
    if (!target) return [`${path}: unresolvable $ref ${schema.$ref}`];
    return validateClosedRecord(target, value, path, registry);
  }
  return validateShape(schema, value, path, registry);
}

function validateShape(schema, value, path, registry) {
  const errors = [];
  const type = schema.type;
  const types = Array.isArray(type) ? type : type ? [type] : [];
  if (types.length > 0) {
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : Number.isInteger(value)
            ? "integer"
            : typeof value === "number"
              ? "number"
              : typeof value;
    const ok = types.some(
      (t) => t === actual || (t === "number" && actual === "integer"),
    );
    if (!ok) errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
  }
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: ${value} below minimum ${schema.minimum}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) errors.push(`${path}: missing required ${required}`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (properties[key]) {
        errors.push(
          ...validateClosedRecord(properties[key], child, `${path}.${key}`, registry),
        );
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unknown property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        // A map shape: every value is checked against the one declared schema.
        errors.push(
          ...validateClosedRecord(schema.additionalProperties, child, `${path}.${key}`, registry),
        );
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateClosedRecord(schema.items, item, `${path}[${i}]`, registry));
    });
  }
  return errors;
}

// --------------------------------------------------------------------------------

describe("switchgear contract-v1-rc1 pin: provenance", () => {
  it("pins the exact tag, peeled commit and component versions", () => {
    assert.equal(PIN.contract, "contract-v1-rc1");
    assert.equal(PIN.source.repository, "Tavrin/switchgear");
    assert.equal(PIN.source.tag, "contract-v1-rc1");
    assert.equal(PIN.source.tag_object, "ff62b59679979a66b62bacc68090d76928de6804");
    assert.equal(PIN.source.commit, "7fce0fd836cc55fb2b2fb1aee5bdfebbd3e2b1ab");
    assert.deepEqual(PIN.component_versions, {
      result_schema: { current: 2, historical_readable: [1] },
      normalized_events: { current: 2, historical_readable: [1] },
      digest_projection: 1,
      session_binding: 1,
      contract_fixture_pack: 1,
    });
  });

  // The pin is only worth anything if the bytes beside it are the frozen bytes. This is
  // the check that makes a silent edit -- or a half-finished re-pin -- fail loudly.
  it("every vendored file matches its recorded sha256, and none is unaccounted for", () => {
    const onDisk = readdirSync(PIN_DIR, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(PIN_DIR, join(entry.parentPath ?? entry.path, entry.name)))
      .filter((path) => path !== "PIN.json" && path !== "README.md")
      .sort();

    assert.deepEqual(onDisk, Object.keys(PIN.vendored.sha256).sort());
    assert.equal(onDisk.length, PIN.vendored.file_count);

    for (const path of onDisk) {
      const digest = createHash("sha256")
        .update(readFileSync(join(PIN_DIR, path)))
        .digest("hex");
      assert.equal(digest, PIN.vendored.sha256[path], `digest drift in ${path}`);
    }
  });

  // The corpus carries its own provenance; a re-pin that loses it must not pass quietly.
  it("the fixture pack keeps Switchgear's manifest, provenance and version declaration", () => {
    assert.equal(MANIFEST.pack, PIN.vendored.fixture_pack);
    assert.equal(MANIFEST.pack_version, PIN.component_versions.contract_fixture_pack);
    assert.deepEqual(MANIFEST.contract_versions, {
      digest_version: PIN.component_versions.digest_projection,
      normalized_events_version: PIN.component_versions.normalized_events.current,
      result_schema_version: PIN.component_versions.result_schema.current,
    });
    // Captured, never hand-authored, and the capture's own cleanliness is recorded.
    assert.equal(MANIFEST.captured_from_sources_dirty, false);
    assert.match(MANIFEST.captured_from_commit, /^[0-9a-f]{40}$/);
    assert.match(MANIFEST.capture_generator_sha256, /^[0-9a-f]{64}$/);
    assert.equal(MANIFEST.derivations.legacy_v1.startsWith("DERIVED_BY_REAL_PROJECTION"), true);
    assert.deepEqual(
      Object.keys(MANIFEST.scenarios).sort(),
      [...SCENARIOS, "gc_applied.json", "gc_plan.json"].sort(),
    );
  });

  // The corpus is normalized, not sanitised by hand. If a real absolute path ever
  // survived a re-capture it would be both a leak and a hermeticity break.
  it("carries no host-absolute paths and no /home leakage", () => {
    // Checked over parsed values, not over the raw text: the normalization keeps the
    // structure AFTER the placeholder ("<ABSOLUTE_PATH>/syn/wt"), so a text-level regex
    // for a leading slash flags every correctly-normalized path. The real rule is that
    // no string may BEGIN with a slash.
    const offenders = [];
    const walk = (value, where) => {
      if (typeof value === "string") {
        if (value.startsWith("/")) offenders.push(`${where} = ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${where}[${i}]`));
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
      }
    };

    for (const path of Object.keys(PIN.vendored.sha256)) {
      const text = readFileSync(join(PIN_DIR, path), "utf8");
      assert.equal(text.includes("/home/"), false, `${path} leaks a home path`);
      const documents = path.endsWith(".jsonl")
        ? text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
        : [JSON.parse(text)];
      documents.forEach((document, i) => walk(document, `${path}#${i}`));
    }
    assert.deepEqual(offenders, []);
  });
});

describe("switchgear contract-v1-rc1 pin: normalized event vocabulary", () => {
  it("every captured stream declares a version this consumer supports", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue; // no stream: it never ran
      const version = scenario === "legacy_v1" ? 1 : 2;
      for (const event of readEvents(scenario, version)) {
        assert.equal(event.v, version, `${scenario}: every line carries its own v`);
        assert.equal(SUPPORTED.normalized_events.includes(event.v), true);
      }
    }
  });

  it("historical normalized v1 remains valid and decodable", () => {
    const events = readEvents("legacy_v1", 1);
    const finished = events.at(-1);
    assert.equal(finished.event, "finished");
    assert.equal(finished.v, 1);
    // v1 spells the two facts as one token and has no `final_text_state` at all.
    assert.equal(finished.status, "completed_empty");
    assert.equal("final_text_state" in finished, false);
  });

  // Each scenario's terminal event is pinned EXACTLY, not by set membership. Membership
  // alone lets a re-capture scramble which scenario means what and still go green -- the
  // `ok` job could start reporting empty text, or `awaiting_external_review` could start
  // reporting `failed`, and nothing would notice.
  const TERMINAL = {
    ok: { status: "completed", final_text_state: "present", sawTerminal: true },
    empty_final_text_with_change: { status: "completed", final_text_state: "empty", sawTerminal: true },
    awaiting_external_review: { status: "completed", final_text_state: "present", sawTerminal: true },
    provider_error: { status: "completed", final_text_state: "empty", sawTerminal: true },
    needs_input: { status: "needs_input", final_text_state: "empty", sawTerminal: false },
    dirty: { status: "completed", final_text_state: "present", sawTerminal: true },
  };

  it("normalized v2 remains valid, with status and text presence orthogonal", () => {
    for (const [scenario, expected] of Object.entries(TERMINAL)) {
      const finished = readEvents(scenario, 2).at(-1);
      assert.equal(finished.event, "finished");
      assert.equal(finished.status, expected.status, `${scenario} status`);
      assert.equal(
        finished.final_text_state,
        expected.final_text_state,
        `${scenario} final_text_state`,
      );
      assert.equal(finished.sawTerminal, expected.sawTerminal, `${scenario} sawTerminal`);
      // §4: a LIVE v2 run never emits `unknown`. It exists only for lifted v1 evidence.
      assert.notEqual(finished.final_text_state, "unknown");
      assert.equal("completed_empty" in finished, false);
      assert.notEqual(finished.status, "completed_empty");
    }
    // Every v2 scenario is accounted for, so adding one cannot slip past unpinned.
    assert.deepEqual(
      Object.keys(TERMINAL).sort(),
      SCENARIOS.filter((s) => s !== "crashed_launch_only" && s !== "legacy_v1").sort(),
    );
    // And the corpus really does exercise the orthogonality rather than one corner of it.
    const pairs = new Set(
      Object.values(TERMINAL).map((t) => `${t.status}/${t.final_text_state}`),
    );
    assert.equal(pairs.has("completed/present"), true);
    assert.equal(pairs.has("completed/empty"), true);
    assert.equal(pairs.has("needs_input/empty"), true);
  });

  // §4's cascade correction: the error branch runs BEFORE the truncation branch, so a
  // run parked back to the operator reports needs_input while never closing its stream.
  it("sawTerminal:false is never `completed`, and validly accompanies needs_input", () => {
    let sawUnterminated = false;
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue;
      const finished = readEvents(scenario, scenario === "legacy_v1" ? 1 : 2).at(-1);
      if (finished.sawTerminal === false) {
        sawUnterminated = true;
        assert.notEqual(finished.status, "completed");
      }
    }
    assert.equal(sawUnterminated, true, "the corpus must exercise the truncated case");
    const needsInput = readEvents("needs_input", 2).at(-1);
    assert.equal(needsInput.status, "needs_input");
    assert.equal(needsInput.sawTerminal, false);
  });
});

// A limit worth stating plainly, because it bounds what this section proves. The corpus
// contains exactly ONE v1 record (`legacy_v1`, itself declared derived), and it spells
// `completed_empty`. There is no captured v1 `needs_input` or `failed` record anywhere,
// so the `unknown` half of the lift has NO fixture backing and cannot acquire any from
// this pack. Those assertions check the mapping table against the contract's §5 table as
// transcribed here -- they are a durable, reviewable statement of the consumer rule, not
// evidence from Switchgear. Every assertion below that DOES touch a fixture says so.
describe("switchgear contract-v1-rc1 pin: v1/v2 mapping", () => {
  it("v1 completed_empty means completed + empty final text", () => {
    assert.deepEqual(liftV1ToV2("completed_empty"), {
      status: "completed",
      final_text_state: "empty",
    });
    // And the real v1 fixture lifts to exactly that.
    assert.deepEqual(liftV1ToV2(readEvents("legacy_v1", 1).at(-1).status), {
      status: "completed",
      final_text_state: "empty",
    });
  });

  // The load-bearing half of the same rule, and the reason I-AT-002 was filed. Proved
  // against a real record rather than a constructed one: a job that DID change the tree
  // down-projects to `completed_empty`. An adapter reading that token as "empty diff"
  // would refuse to merge work that landed.
  it("v1 completed_empty NEVER means an empty diff", () => {
    const result = readScenario("empty_final_text_with_change", "result.json");
    const finished = readEvents("empty_final_text_with_change", 2).at(-1);

    assert.equal(projectV2ToV1(finished), "completed_empty");

    const change = changePresence(result);
    assert.equal(change.changed, true);
    assert.deepEqual(change.files, ["tracked.txt"]);
  });

  it("v1 needs_input/failed lift to final-text presence `unknown`", () => {
    assert.deepEqual(liftV1ToV2("needs_input"), {
      status: "needs_input",
      final_text_state: "unknown",
    });
    assert.deepEqual(liftV1ToV2("failed"), {
      status: "failed",
      final_text_state: "unknown",
    });
    // v1 threw the fact away; inventing it on the way up is the failure mode this
    // guards. `unknown` must never appear for the two v1 spellings that DID record it.
    assert.notEqual(liftV1ToV2("completed").final_text_state, "unknown");
    assert.notEqual(liftV1ToV2("completed_empty").final_text_state, "unknown");
  });

  it("the v2 -> v1 projection is exact over all six legal pairs", () => {
    assert.deepEqual(
      ["completed", "needs_input", "failed"].flatMap((status) =>
        ["present", "empty"].map((final_text_state) =>
          projectV2ToV1({ status, final_text_state }),
        ),
      ),
      ["completed", "completed_empty", "needs_input", "needs_input", "failed", "failed"],
    );
  });

  // The round trip is lossless for exactly the two v1 spellings that recorded text
  // presence, and is NOT closed for the two that discarded it -- lifting them yields
  // `unknown`, which has no v1 spelling because a live v2 run never emits it. Asserting
  // a clean round trip over all four would have been a nicer-sounding claim and a false
  // one; this is the asymmetry §5 describes, pinned in both directions.
  it("the v1 round trip is lossless where v1 kept the fact, and refuses where it did not", () => {
    for (const v1 of ["completed", "completed_empty"]) {
      assert.equal(projectV2ToV1(liftV1ToV2(v1)), v1, `v1 ${v1} did not round-trip`);
    }
    for (const v1 of ["needs_input", "failed"]) {
      assert.equal(liftV1ToV2(v1).final_text_state, "unknown");
      assert.throws(() => projectV2ToV1(liftV1ToV2(v1)), ContractRefusal);
    }
  });
});

describe("switchgear contract-v1-rc1 pin: which field answers which question", () => {
  // B4. The `provider_error` fixture is the committed proof that the transcript and the
  // execution outcome legitimately disagree.
  it("provider execution comes from result.execution, never from the transcript", () => {
    const result = readScenario("provider_error", "result.json");
    const finished = readEvents("provider_error", 2).at(-1);

    assert.equal(finished.status, "completed"); // the transcript's reading
    assert.equal(finished.final_text_state, "empty");
    assert.equal(providerExecution(result), "provider_error"); // the authoritative fact
    assert.equal(result.status, "provider_error"); // the job outcome
    assert.equal(result.exit, 7); // the PROVIDER's exit code, not the CLI's
  });

  // The same divergence in the other direction: the transcript says the worker parked
  // for input, the record says the provider process failed.
  it("a transcript needs_input does not make the job outcome needs_input", () => {
    const result = readScenario("needs_input", "result.json");
    assert.equal(readEvents("needs_input", 2).at(-1).status, "needs_input");
    assert.equal(providerExecution(result), "provider_error");
  });

  // One direction only, because only one direction is a contract statement. G19's
  // closure says a frozen change carries a populated `freeze`; nothing says a non-null
  // `freeze` implies `change.state == frozen`, and asserting that biconditional would
  // red-line on the first legitimate re-capture that produces one without the other.
  it("a frozen change always carries a populated freeze binding", () => {
    let sawFrozen = false;
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue; // no result record exists
      const result = readScenario(scenario, "result.json");
      const change = changePresence(result);
      if (!change.changed) continue;
      sawFrozen = true;
      assert.notEqual(result.freeze, null, `${scenario}: frozen change with no binding`);
      assert.equal(change.files.length > 0, true, `${scenario}`);
      // G19 was closed by populating these; an empty binding is the old defect.
      assert.match(result.freeze.head, /^[0-9a-f]{40}$/, `${scenario}`);
      assert.match(result.freeze.tree_digest, /^[0-9a-f]{64}$/, `${scenario}`);
      assert.equal(typeof result.freeze.worktree, "object", `${scenario}`);
    }
    assert.equal(sawFrozen, true, "the corpus must exercise a frozen change");
  });

  // §2: `status` is DERIVED from the four facts. An adapter re-deriving it wrongly is
  // the most likely way to misread a job, and until now nothing here cross-checked them.
  it("the recorded status agrees with the four facts it projects, on every record", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue;
      const result = readScenario(scenario, "result.json");
      assert.equal(projectStatus(result), result.status, `${scenario}: status vs facts`);
    }
  });

  // §3's warning, half-checkable here: the record carries the PROVIDER's exit 0 on a job
  // the CLI exits 2 for. Only the record side is in the corpus -- no CLI exit code is
  // captured anywhere in the pack -- so the record half is asserted and the CLI half is
  // documentation. An adapter must not read the record's `exit` as the CLI's.
  it("the record's `exit` is the provider's, and integrity is its own fact", () => {
    const dirty = readScenario("dirty", "result.json");
    assert.equal(dirty.status, "dirty");
    assert.equal(dirty.integrity.outcome, "dirty");
    assert.equal(dirty.integrity.identity_changed, true);
    assert.equal(dirty.exit, 0);
    assert.equal(providerExecution(dirty), "completed"); // the provider itself was fine
    assert.equal(changePresence(dirty).changed, false); // and nothing was promoted
  });

  // G8, the external-acceptance branch Atelier reads and must never set.
  it("external acceptance is a readable state that leaves the decision to the caller", () => {
    const result = readScenario("awaiting_external_review", "result.json");
    assert.equal(result.status, "awaiting_external_review");
    assert.equal(result.acceptance.state, "awaiting_external_review");
    assert.equal(providerExecution(result), "completed");
    assert.equal(changePresence(result).changed, true);
    // G16: the evidence is identical to the ordinary case. Success-pending, not failure.
    assert.equal(result.integrity.outcome, "clean");
  });

  // G22, closed: destructive collection protects a job whose external decision is
  // outstanding, and says why.
  it("gc protects awaiting_external_review and reports its reason", () => {
    const plan = readJson(join(PACK_DIR, "gc_plan.json"));
    assert.equal(plan.dry_run, true);
    const external = plan.protected.find(
      (entry) => entry.state === "awaiting_external_review",
    );
    assert.notEqual(external, undefined);
    assert.equal(typeof external.reason, "string");
    const candidates = plan.jobs.map((job) => job.state);
    assert.equal(candidates.includes("awaiting_external_review"), false);
    assert.equal(candidates.includes("awaiting_review"), false);

    const applied = readJson(join(PACK_DIR, "gc_applied.json"));
    assert.equal(applied.dry_run, false);
    // Only the applied shape can carry this, so the two projections stay distinguishable.
    // Asserted non-empty: `Array.isArray([])` is true, so a shape check alone would pass
    // an applied projection that collected nothing and proved nothing.
    assert.equal(Array.isArray(applied.launch_artifacts_removed), true);
    assert.equal(applied.launch_artifacts_removed.length > 0, true);
    assert.equal(applied.removed.length > 0, true);
    // Protection survives the apply, and nothing protected was removed.
    const removed = new Set(applied.removed.map((entry) => entry.job_id ?? entry));
    for (const entry of applied.protected ?? []) {
      assert.equal(removed.has(entry.job_id), false, `gc removed a protected job`);
    }
  });

  // G7, closed: a job that died before writing a result still appears with attribution.
  it("a crashed launch-only job is visible and still carries its attribution", () => {
    const row = readScenario("crashed_launch_only", "jobs-row.json");
    const runner = readScenario("crashed_launch_only", "runner.json");
    assert.equal(row.state, "died");
    assert.equal(row.job_id, runner.job_id);
    assert.equal(row.harness, "opencode");
    // Attribution records what the job was LAUNCHED to run. It is never evidence that
    // the harness executed -- that inference is gated on `state`.
    assert.equal(typeof runner.pid, "number");
    assert.equal(typeof runner.boot_id, "string");
    assert.equal(typeof runner.starttime, "string");
  });
});

describe("switchgear contract-v1-rc1 pin: canonical vocabulary", () => {
  // Pinned to the values the capture actually produced. A length check would pass on
  // "X"/"Y" and gate nothing; these are the two nouns an adapter routes on.
  it("harness and pool are canonical on every jobs row", () => {
    for (const scenario of SCENARIOS) {
      const { harness, pool } = canonicalNouns(readScenario(scenario, "jobs-row.json"));
      assert.equal(harness, "opencode", `${scenario} harness`);
      assert.equal(pool, "opencode-go", `${scenario} pool`);
    }
  });

  // The alias trap holds on EVERY scenario with both surfaces, not just one job.
  it("the two surfaces disagree on bare `provider` for every captured job", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue; // no result record exists
      const row = readScenario(scenario, "jobs-row.json");
      const result = readScenario(scenario, "result.json");
      assert.equal(row.job_id, result.job_id, `${scenario}`);
      assert.equal(row.provider, row.pool, `${scenario}: row provider is the pool`);
      assert.equal(result.provider, result.harness, `${scenario}: record provider is the harness`);
      assert.notEqual(row.provider, result.provider, `${scenario}`);
      // The canonical reading agrees across surfaces; the alias does not.
      assert.equal(row.harness, result.harness, `${scenario}`);
      assert.equal(row.pool, result.model.provider, `${scenario}`);
    }
  });

  // B5. This is why bare `provider` is unusable: on a jobs row it is the POOL, on a
  // result record it is the HARNESS, and the corpus shows both spellings of the same job.
  it("bare `provider` is a surface-specific legacy alias, never cross-surface", () => {
    const row = readScenario("ok", "jobs-row.json");
    const result = readScenario("ok", "result.json");
    assert.equal(row.job_id, result.job_id); // the same job, two surfaces

    assert.equal(row.provider, row.pool);
    assert.equal(row.provider, "opencode-go");
    assert.equal(result.provider, result.harness);
    assert.equal(result.provider, "opencode");
    assert.notEqual(row.provider, result.provider); // the trap, on one job

    // The canonical reading agrees across both surfaces; the alias does not.
    assert.equal(row.harness, result.harness);
    assert.equal(row.pool, result.model.provider);
  });
});

describe("switchgear contract-v1-rc1 pin: result schemas v1/v2", () => {
  const V2 = SCHEMAS["result.schema.json"];
  const V1 = SCHEMAS["result-v1.schema.json"];

  // Deliberately narrow title. The schemas are closed AT THE TOP LEVEL; several nested
  // objects are open by design (G29), and claiming otherwise would be the overclaim this
  // pin exists to prevent.
  it("both schemas are closed at the top level, and differ only by session_store_id", () => {
    assert.equal(V2.additionalProperties, false);
    assert.equal(V1.additionalProperties, false);
    assert.equal(V2.properties.schema_version.const, 2);
    assert.equal(V1.properties.schema_version.const, 1);
    assert.equal("session_store_id" in V2.properties, true);
    assert.equal("session_store_id" in V1.properties, false);
    // v1 predates explicit versioning, so the field may be absent on a v1 record.
    assert.equal((V1.required ?? []).includes("schema_version"), false);
    assert.equal((V2.required ?? []).includes("schema_version"), true);
  });

  it("every v2 fixture record validates against v2 and is REJECTED by v1", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only" || scenario === "legacy_v1") continue;
      const record = readScenario(scenario, "result.json");
      assert.equal(record.schema_version, 2);
      assert.deepEqual(validateClosedRecord(V2, record), [], `${scenario} vs v2`);
      const rejected = validateClosedRecord(V1, record);
      assert.equal(rejected.length > 0, true, `${scenario} was NOT rejected by v1`);
    }
  });

  it("the v1 fixture record validates against v1 and is REJECTED by v2", () => {
    const record = readScenario("legacy_v1", "result.json");
    assert.equal(record.schema_version, 1);
    assert.equal("session_store_id" in record, false);
    assert.deepEqual(validateClosedRecord(V1, record), []);
    assert.equal(validateClosedRecord(V2, record).length > 0, true);
  });

  // `model` carries pool identity and reaches the checker only through a `$ref`. An
  // unresolved ref would leave the single most load-bearing subtree unvalidated while
  // the suite stayed green, so both the resolution and its failure mode are pinned.
  it("resolves the model $ref, and treats an unresolvable ref as an error", () => {
    assert.equal(V2.properties.model.$ref, "model.schema.json");
    const model = SCHEMAS["model.schema.json"];
    assert.equal(model.additionalProperties, false);
    assert.deepEqual(model.required, ["id", "provider"]);

    const record = readScenario("ok", "result.json");
    assert.deepEqual(validateClosedRecord(V2, record), []);
    // Garbage inside the ref'd subtree must be caught.
    assert.equal(
      validateClosedRecord(V2, { ...record, model: { anything: true } }).length > 0,
      true,
    );
    assert.equal(
      validateClosedRecord(V2, {
        ...record,
        model: { ...record.model, bogus_key: [1, 2] },
      }).length > 0,
      true,
    );
    assert.deepEqual(validateClosedRecord({ $ref: "absent.schema.json" }, {}), [
      "$: unresolvable $ref absent.schema.json",
    ]);
  });

  // The checker must be able to fail, or the assertions above prove nothing. Counts are
  // asserted as "at least one" rather than exactly one: pinning an exact error count
  // turns red when the schema legitimately tightens, which is the wrong reason to fail.
  it("the closed-shape checker rejects unknown properties, bad consts, enums and bounds", () => {
    const record = readScenario("ok", "result.json");
    const rejects = (mutation) =>
      assert.equal(validateClosedRecord(V2, { ...record, ...mutation }).length > 0, true);
    rejects({ invented: 1 });
    rejects({ schema_version: 3 });
    rejects({ job_id: "" });
    rejects({ generation: -99 });
    rejects({ status: "invented_status" });
  });

  // `session-binding.schema.json` is a pinned component version; loading it is what makes
  // that pin mean anything.
  it("the session binding schema is present, closed and binds a lineage", () => {
    const binding = SCHEMAS["session-binding.schema.json"];
    assert.equal(binding.additionalProperties, false);
    assert.equal(binding.properties.binding_version.type, "integer");
    assert.equal(binding.properties.binding_version.minimum, PIN.component_versions.session_binding);
    // A lineage is a controller-minted uuid4, not an inference from the filesystem.
    assert.match("77beffb9-f421-4fe5-8116-d18da692df19", new RegExp(binding.properties.session_store_id.pattern));
    for (const required of ["binding_version", "session_store_id", "harness", "worktree"]) {
      assert.equal(binding.required.includes(required), true, `binding requires ${required}`);
    }
  });
});

describe("switchgear contract-v1-rc1 pin: unknown versions fail closed", () => {
  it("resolves a finished job's vocabulary by the documented precedence", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue;
      const result = readScenario(scenario, "result.json");
      const runner = readScenario(scenario, "runner.json");
      const version = resolveNormalizedVersion({ result, runner });
      assert.equal(version, scenario === "legacy_v1" ? 1 : 2, `${scenario}`);
      // And the version it resolves is the one the artifact filename actually spells.
      assert.equal(
        result.artifacts.events_normalized.endsWith(`events.v${version}.jsonl`),
        true,
        `${scenario}: declared version and artifact filename disagree`,
      );
    }
  });

  // The result record wins over the runner record. `legacy_v1` is the case that proves
  // the ordering is real rather than incidental: its runner still says 2.
  it("the result record outranks the runner record", () => {
    const runner = readScenario("legacy_v1", "runner.json");
    assert.equal(runner.events_normalized_version, 2);
    assert.equal(
      resolveNormalizedVersion({
        result: readScenario("legacy_v1", "result.json"),
        runner,
      }),
      1,
    );
  });

  it("falls back to the runner record for a job with no result yet", () => {
    const runner = readScenario("crashed_launch_only", "runner.json");
    assert.equal(resolveNormalizedVersion({ result: null, runner }), 2);
  });

  it("treats a record predating both keys as v1", () => {
    assert.equal(resolveNormalizedVersion({ result: { artifacts: {} }, runner: {} }), 1);
  });

  // `null` is in this list on purpose. Treating a present-but-malformed version as
  // "absent, so default to 1" is a fail-OPEN on a version boundary -- B1's bug class,
  // reintroduced on the consumer side. A key that exists and cannot be spelled refuses.
  it("refuses any version this pin cannot spell, null included", () => {
    for (const bogus of [0, 3, -1, 1.5, "2", true, null, {}, []]) {
      assert.throws(
        () =>
          resolveNormalizedVersion({
            result: { artifacts: { events_normalized_version: bogus } },
            runner: {},
          }),
        ContractRefusal,
        `version ${JSON.stringify(bogus)} did not fail closed`,
      );
      assert.throws(
        () =>
          resolveNormalizedVersion({
            result: null,
            runner: { events_normalized_version: bogus },
          }),
        ContractRefusal,
        `runner version ${JSON.stringify(bogus)} did not fail closed`,
      );
    }
  });

  // §5 step 2 scopes the runner fallback to a job with NO RESULT. A result that exists
  // but omits the key is step 3 (v1), not a licence to consult the runner -- which would
  // silently prefer a version the authoritative record never claimed.
  it("never consults the runner when a result record exists", () => {
    assert.equal(
      resolveNormalizedVersion({
        result: { artifacts: {} },
        runner: { events_normalized_version: 2 },
      }),
      1,
    );
  });

  it("refuses an unknown v1 status, change.state and execution.outcome", () => {
    assert.throws(() => liftV1ToV2("completed_but_weird"), ContractRefusal);
    assert.throws(() => projectV2ToV1({ status: "completed", final_text_state: "unknown" }), ContractRefusal);
    assert.throws(() => changePresence({ change: { state: "partial" } }), ContractRefusal);
    assert.throws(() => providerExecution({ execution: { outcome: "cancelled" } }), ContractRefusal);
    assert.throws(() => canonicalNouns({ provider: "opencode" }), ContractRefusal);
  });

  // The drift gate. A re-pin against a Switchgear that bumped a component must land a
  // reviewed PIN.json, not slip through because the fixtures still parse.
  it("the pinned component versions are ones this consumer supports", () => {
    assert.equal(
      SUPPORTED.normalized_events.includes(PIN.component_versions.normalized_events.current),
      true,
    );
    assert.equal(
      SUPPORTED.result_schema.includes(PIN.component_versions.result_schema.current),
      true,
    );
    assert.equal(SUPPORTED.digest.includes(PIN.component_versions.digest_projection), true);
    assert.equal(
      SUPPORTED.session_binding.includes(PIN.component_versions.session_binding),
      true,
    );
  });

  // §10: branch on `digest_v`, and on an unrecognised value fall back to
  // `logs --format normalized` rather than decoding. That rule needs the key to be
  // PRESENT -- a guarded `if ("digest_v" in line)` would go green on a pack that stopped
  // stamping it, which is the exact drift being gated.
  it("the digest projection stamps its version on the envelope and every event", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue;
      const digest = readScenario(scenario, "logs-digest.json");
      assert.equal(digest.format, "digest", `${scenario}`);
      assert.equal(digest.digest_v, PIN.component_versions.digest_projection, `${scenario}`);
      assert.equal(SUPPORTED.digest.includes(digest.digest_v), true, `${scenario}`);
      // The digest carries the EVENT vocabulary version separately from its own.
      assert.equal(digest.events_v, scenario === "legacy_v1" ? 1 : 2, `${scenario}`);
      assert.equal(Array.isArray(digest.events), true, `${scenario}`);
      for (const event of digest.events) {
        assert.equal(event.digest_v, digest.digest_v, `${scenario}: unstamped digest event`);
      }
    }
  });

  // `logs --format normalized` is a §10 do-rely-on surface, and is the projection the
  // `legacy_v1` scenario was derived THROUGH. It was previously vendored but never read.
  it("the normalized projection agrees with the durable event file", () => {
    for (const scenario of SCENARIOS) {
      if (scenario === "crashed_launch_only") continue;
      const version = scenario === "legacy_v1" ? 1 : 2;
      const projection = readScenario(scenario, "logs-normalized.json");
      assert.equal(projection.format, "normalized", `${scenario}`);
      assert.equal(projection.v, version, `${scenario}`);
      assert.equal(projection.job_id, readScenario(scenario, "result.json").job_id, `${scenario}`);
      // The recomputed view and the durable file must say the same thing; if they can
      // diverge, "the terminal file is the sole evidence" stops being a safe rule.
      assert.deepEqual(projection.events, readEvents(scenario, version), `${scenario}`);
      for (const event of projection.events) assert.equal(event.v, version, `${scenario}`);
    }
  });
});
