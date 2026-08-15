---
title: A list-driven invariant silently exempts any member stored in a different shape
tags: [dispatch, invariants, process-fencing, refactoring]
crates: [server/lib/dispatch.mjs]
symptom: One instance of a rule-governed thing keeps its own private logic for years while every review reads the shared rule and concludes it is covered
root-cause: The rule is enforced by iterating a list of members, so a member persisted under a different shape is not in the list, and nothing that reads the list can notice its absence
prevention: Make the list entries know how to read and clear themselves (accessors, not field-name strings), so a differently-shaped member can JOIN the list instead of living beside it; then prove completeness by asserting the invariant at the choke point and running the suite
promoted: none
date: 2026-07-30
---

# The trap

atelier-tzw built a single death decision for fenced pids — `classifyFencedPid`,
`FENCING_FIELDS`, `resolveOrphanPid`, "cannot confirm death is not death" — and
it was correct. It was also enforced by `FENCING_FIELDS.some(({ pid }) =>
record[pid] > 0)`: a list of **flat field-name pairs**.

The post-merge verifier's fence was persisted at `postMerge.pid` /
`postMerge.pidIdentity` — nested, because it was written before the vocabulary
existed. It therefore could not be in that list, so:

- `hasFencingPid` returned false for a record that was fencing a live process;
- the boot scan-all-records pass never saw it;
- dismissal's reap-then-clear never reached it;
- `exposedRecord` never stripped it, and it leaked out of **every** record-serving
  HTTP route — including the one whose leak an earlier round had already fixed
  for the other six fields;
- and it kept its own hand-written boot recovery, which killed only on an exact
  identity match, never re-probed after the signal, and deleted both fields on
  every branch — the exact "unprovable death is not death" violation the shared
  rule exists to prevent.

Three review rounds read the shared rule and concluded the subsystem was covered.
Nothing was lying: the rule was right, the enforcement was right, and the member
simply was not in the set the enforcement iterated.

# How to detect

Ask of any list-driven invariant: *what would an instance stored in a different
shape look like from inside the loop?* If the answer is "identical to absent",
the loop cannot tell you whether the set is complete — so go and enumerate the
instances from the interface (or from the persistence format), never from the
list. Two independent derivations, because grep over field names finds spellings,
not members.

Then close it structurally rather than by vigilance: give the list entries
behaviour (`hold(record)` / `clear(record)`) so a nested or otherwise odd member
can be *added* rather than reimplemented next to it. A member that joins the
vocabulary gets every existing consumer for free and cannot drift back out.

For completeness proof, assert the invariant at the choke point and let the suite
answer: injecting `if (!fence) throw` into `runVerifyStep` and watching all 532
tests stay green is evidence about *behaviour*; counting call sites is evidence
about *text*.

# The corollary that bites on the way in

Extending an invariant to a new participant turns previously-harmless sloppiness
into a visible bug at every site that only ever *signalled* without awaiting a
verdict. `stop()` on a verifying dispatch did `killTracked(child)` fire-and-forget
and then released the tracker claim — fine while verify children were unfenced,
an unresolved-orphan flag on an ordinary user stop the moment they were not. When
you widen a fence, re-read every site that kills the newly-fenced thing and ask
whether it awaits a verdict or just fires a signal.

Related: a `publicRecord`-style serializer that returns nested objects **by
reference** means the "strip plumbing" layer must copy before deleting, or it
erases the fence the reaper needs.

# References

- `server/lib/dispatch.mjs` — `fencingPair` / `nestedFencingPair` /
  `FENCING_FIELDS` / `exposedRecord` / `runVerifyStep`
- Related: [[unprovable-death-is-not-death]] (the rule this member was exempt
  from), [[codex-process-age-is-not-liveness]] (what may authorize a signal)
