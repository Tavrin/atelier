---
title: A && chain "ran the tests" but gated on grep, not the test exit - a red suite got committed with a green claim
symptom: Commit lands with "N tests pass" in the message while the suite is failing
root-cause: `cmd | grep pattern && commit` gates on grep finding output lines, not on the suite's exit code; also acted on a verifier's tool-behavior claim (index.js "dead code") without executing the check first in a gated step
prevention: Test steps must gate the chain on THEIR exit code (run separately or use pipefail + explicit rc capture); re-verify any verifier claim about tool behavior by execution BEFORE destructive action; canonical test command here is `npm test` (scripts/test-batch.mjs, the exact batch CI gates on) - NEVER bare `node --test`, which discovers the browser suites and HANGS rather than failing
date: 2026-07-21
---
Recurrence of the masked-exit-code class (previously seen as commitlint
formatting traps and a piped git commit). Caught within minutes by re-reading the chain output;
commit amended, AGENTS.md verify line corrected.

2026-08-22: the prevention line above still prescribed bare `node --test` long
after AGENTS.md and CONTRIBUTING.md were corrected. That command does not just
resolve a directory oddly - it HANGS, and an unbounded hang is what left CI
gating nothing for this whole campaign. A lesson file that outlives the
instruction it teaches is its own instance of the class it describes.
