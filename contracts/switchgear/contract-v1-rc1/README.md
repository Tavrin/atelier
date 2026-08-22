# Switchgear `contract-v1-rc1` — Atelier-side pin

This directory is Atelier's frozen copy of Switchgear's first externally consumable
execution contract. It exists so that Atelier's consumer expectations are testable in
Atelier's own CI, hermetically, with no Switchgear checkout, no state root, no provider
execution and no network — the arrangement `specs/PROGRAM-2026-08-20.md` §10 requires
("contract tests with Switchgear are FIXTURES generated from recorded real records — no
live SG in Atelier CI, no Atelier in SG CI; each repo pins the other's fixture set
version").

There is **no adapter here**. `WP-A2-ADAPTER` remains blocked; this is the contract half
of its foundation.

## What is pinned

| | |
|---|---|
| Repository | `Tavrin/switchgear` |
| Tag | `contract-v1-rc1` |
| Tag object | `ff62b59679979a66b62bacc68090d76928de6804` (annotated) |
| Peeled commit | `7fce0fd836cc55fb2b2fb1aee5bdfebbd3e2b1ab` |
| Verified against the remote | 2026-08-22, via `git ls-remote origin 'refs/tags/contract-v1-rc1*'` |
| Atelier baseline | `fe94036dfd7d4448d96d4edca35e89ca42e7c42a` |

Component versions, which are **separate axes** from the `contract-v1` name — there is no
requirement that the numbers match, and none is implied:

| component | version |
|---|---|
| `result.json` record schema | **2** for new records; absent/`1` remains readable, version-dispatched, both closed at the top level |
| normalized event stream | **2**; historical `v1` remains readable and reproducible |
| `logs` digest projection | **1** |
| session store binding | **1** |
| contract fixture pack | **1** |

## Contents

- `adapter-v1-contract-fixtures.v1/` — a verbatim copy of Switchgear's
  `tests/fixtures/adapter-v1-contract-fixtures.v1/` at the pinned commit, including its
  own `MANIFEST.json`. The pack was **captured from real hermetic runs of the real code
  paths**, never hand-authored; `legacy_v1` is the one declared derived exception and
  says so in the manifest. Capturing rather than authoring is what caught the two
  meanings of `exit` and a published key list that was wrong by twelve keys — a
  hand-written fixture would have made the fields agree.
- `schemas/` — the two result schemas (`result.schema.json` v2, `result-v1.schema.json`
  v1), `model.schema.json` (which both `$ref`, and which carries pool identity — without
  it that subtree would go unvalidated) and `session-binding.schema.json`, copied from
  `python/switchgear/data/schemas/` at the same commit.
- `PIN.json` — the machine-readable pin: tag, tag object, peeled commit, component
  versions, and a sha256 of every file in this directory.

`../../../shared/switchgear-contract-pin.test.mjs` is the executable half. It runs in the
canonical gated batch and re-derives every digest in `PIN.json`, so an edit here — or a
half-finished re-pin — fails loudly rather than quietly.

`../../../scripts/switchgear-pin-mutation-check.mjs` proves that suite actually gates:
it breaks one contract fact at a time in a copy of this corpus, **restamps the digests so
tamper-evidence is not what fires**, and requires the suite to turn red (23/23 detected).
Run it after any re-pin or any change to the suite. Fourteen of its mutations exist
because a blind adversarial review demonstrated them passing against the first draft.

## Consumer rules this pin binds Atelier to

These are asserted by the test file and the future adapter must satisfy the same tables.
Rules 1-3 and 5-9 are asserted against the real captured records; rule 4's `unknown` half
is a transcription of the contract's table, for the reason given under "What this pin does
NOT prove".

1. **Historical normalized v1 remains valid.** It is decoded, never rewritten or
   migrated.
2. **Normalized v2 remains valid**, with `status` and `final_text_state` orthogonal.
   `final_text_state: unknown` never appears from a live run.
3. **v1 `completed_empty` means completed + empty final text — never an empty diff.**
   This is the load-bearing one: an adapter reading that token as "changed nothing"
   silently refuses to merge work that really landed, which is the dangerous direction.
   Proved on a real record: `empty_final_text_with_change` down-projects to
   `completed_empty` while `freeze.changed_files` is `["tracked.txt"]`.
4. **v1 `needs_input` / `failed` lift to `final_text_state: unknown`** in v2 terms. v1
   discarded the fact; inventing it on the way up is forbidden. One consequence, stated
   carefully because it is easy to read backwards: the *lift* always succeeds and yields
   `unknown`; it is the *return* leg that refuses, because `unknown` has no v1 spelling
   and a live v2 run never produces it. So the v1→v2→v1 round trip is closed for
   `completed` and `completed_empty`, and deliberately open for the other two.
5. **`change.state` and `freeze` determine change presence** — always, and never the
   terminal transcript status.
6. **Authoritative provider execution comes from `result.execution.outcome`**;
   `result.status` is the job outcome; `finished.status` is a transcript interpretation
   and answers neither. The `provider_error` fixture is the committed proof that they
   legitimately disagree.
7. **`harness` and `pool` are the canonical nouns.** Bare `provider` is a
   surface-specific legacy alias: on a `jobs --json` row it is the pool, on a result
   record it is the harness — asserted on every captured job, both surfaces of each.
8. **Result schemas v1 and v2 are strict and distinct.** Both are closed at the top
   level (`additionalProperties: false`) and version-dispatched; a v1 record is rejected
   by v2 and a v2 record by v1. Nested openness is covered above.
9. **Unknown future contract or component versions fail closed** — refused with the
   offending value, never decoded with the current vocabulary and never treated as
   history.

A finished job's vocabulary is resolved per job, in Switchgear's documented precedence:
the result record's `artifacts.events_normalized_version`, else `runner.json`'s
`events_normalized_version` for a job with no result, else `1`. The result record
outranks the runner record — `legacy_v1` is the case that proves the ordering is real,
since its runner still says `2`.

## What this pin does NOT prove

Stated plainly, because a pin that overstates its reach is worse than a smaller honest
one:

- **Nothing behavioural.** No `promote` refusal, no launch-attribution refusal, no
  session-lineage or HEAD-movement behaviour, no `gc` execution. A fixture pack is
  records, not a running system. Those facts live in the consumer-review report's §2b and
  become WP-A2-ADAPTER's acceptance tests.
- **Not the `unknown` half of rule 4.** The corpus holds exactly one v1 record
  (`legacy_v1`, itself declared derived) and no v1 `needs_input`/`failed` record at all.
  Those assertions transcribe the contract's §5 table; they are not fixture evidence.
- **Not nested-shape strictness.** Both result schemas are closed at the top level, and
  `model` is checked through its `$ref`, but `integrity`, `artifacts`, `freeze`,
  `process`, `correlation`, `review`, `provider_calls` and `resumed` are open by design.
  That is G29's standing obligation — never codegen nested shapes — not a gap here.
- **The checker is not a JSON Schema engine.** It honours `type`, `const`, `enum`,
  `required`, `properties`, `additionalProperties`, `items`, `pattern`, `minimum`,
  `minLength` and `$ref`, and ignores everything else.

## What must NOT be relied on

Job ids, timestamps, digests, durations and costs in this pack are real values from a
real capture run and **change on every re-capture**. Assert the contract, never these
values. Byte-stability across a re-capture is explicitly not promised.

## One inconsistency on the Switchgear side, recorded not smoothed

At this exact commit, `docs/CONTRACT-V1-RC1-CANDIDATE.md` still opens with "**CANDIDATE,
not accepted** … Nothing here is declared, tagged or published", while the annotated tag
says the opposite and describes the freeze in detail. **Atelier's position: the tag wins
and the file header is stale** — the tag postdates the text, describes exactly this tree,
and Atelier's own review independently reached SAFE TO FREEZE. It should be raised with
Switchgear. Nothing in this pin rests on it: every consumer rule is asserted against
captured records, not against that prose.

## Re-pinning

A new Switchgear contract tag means: re-copy the pack and schemas, regenerate `PIN.json`,
and review the diff. Do not regenerate digests to make a red test green — the digest
check exists precisely to force that review. If a component version moves outside the set
`shared/switchgear-contract-pin.test.mjs` declares as supported, the suite refuses, which
is the intended behaviour: a version bump is a consumer decision, not a silent upgrade.
