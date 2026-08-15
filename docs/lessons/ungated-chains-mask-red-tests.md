---
title: A && chain "ran the tests" but gated on grep, not the test exit - a red suite got committed with a green claim
symptom: Commit lands with "N tests pass" in the message while the suite is failing
root-cause: `cmd | grep pattern && commit` gates on grep finding output lines, not on the suite's exit code; also acted on a verifier's tool-behavior claim (index.js "dead code") without executing the check first in a gated step
prevention: Test steps must gate the chain on THEIR exit code (run separately or use pipefail + explicit rc capture); re-verify any verifier claim about tool behavior by execution BEFORE destructive action; canonical test command here is `node --test` from the repo root (node resolves `node --test <dir>` as a module path on this version)
date: 2026-07-21
---
Recurrence of the masked-exit-code class (Moss: commitlint-formatting-traps,
piped git commit). Caught within minutes by re-reading the chain output;
commit amended, AGENTS.md verify line corrected.
