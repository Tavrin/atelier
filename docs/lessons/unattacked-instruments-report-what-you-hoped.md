---
title: A test, harness or report that nothing has attacked tells you what you hoped, not what is true
tags: [testing, ci, verification, evidence]
symptom: A purpose-built check is green, and the thing it exists to protect is broken anyway
root-cause: The instrument was validated against the shape in front of its author - a happy path, a short stream, a quiet machine - and never against an adversary
prevention: Before citing any instrument as evidence, break the thing it watches and require it to go red; commit that mutation so the claim stays re-runnable instead of becoming a sentence in a spec
promoted: none
date: 2026-08-22
---

# The trap

An instrument built to prove something reports success while proving nothing.
This repository produced six instances in one campaign: an escape-harness case
asserting `deepEqual(X, X)`; a mutation matrix that reported all five guards
UNGUARDED while merely blind to the reporter format; a leak report that could
not see a planted leak; a CI job that hung for the entire campaign while its
silence read as success; a tracker close that succeeded while its scoping
comment silently failed; and a contract-pin test that stayed green through
**14 of 25** mutations of the corpus it existed to pin.

None was carelessness. Every one was written carefully, by someone who then
validated it against the case they already had in mind.

# How to detect

You cannot, by looking. A green instrument and a blind one are identical from
outside - that is the whole trap. The only signal is an experiment: mutate the
guarded thing and require red. If you have never seen the instrument fail, you
do not know that it can.

# References

- `test-system/mutation-matrix.mjs` - breaks one production guard at a time and
  requires the named gate to redden AND localize
- `test-system/leak-report.mjs` - plants a leak and refuses to report if the
  detector cannot see it
- `specs/P0-DECLARATION-BUNDLE.md` §4, §5, §9 - the campaign-level record
- Related: [[ungated-chains-mask-red-tests]] (the exit-code half of the same family)
