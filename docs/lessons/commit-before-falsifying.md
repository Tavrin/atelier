# Commit before falsifying, or the revert-undo eats the fix

**Date:** 2026-07-30 · **Source:** atelier-9dt round 2 (implementer self-report)

## What happened

During fails-on-old verification, the implementer temporarily reverted an
enforcement in `dispatch.mjs` to prove the new test goes red, then undid the
revert with `git checkout -- server/lib/dispatch.mjs`. The round's fixes were
still **uncommitted** in that same file — the checkout silently discarded all
three of them. The next full-suite run passed anyway, because the tests were
also mid-edit; only a baseline re-check caught the loss before handoff.

## The rule

**Commit the fix before falsifying it.** Every fails-on-old check follows:

1. Commit the enforcement + its test.
2. Apply the local revert (edit or `git revert -n`, never `checkout` of a
   dirty file).
3. Run the test, observe red.
4. Restore with `git checkout -- <file>` / `git restore` — now safe, because
   the fix is committed — or keep the revert as a file copy and diff it back.

A green suite immediately after an undo proves nothing if both the code and
its tests were dirty in the same window; re-verify against the committed
baseline.

## Why it compounds

Fails-on-old verification is standard in this repo's review loop (every
round of atelier-tzw/za6/8r6/9dt used it). Any implementer doing it on
uncommitted work has this trap in front of them; the failure mode is silent
and self-masking.
