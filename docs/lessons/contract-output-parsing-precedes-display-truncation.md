---
title: Contract output disappears when parsing starts from a display summary
tags: [dispatch, review, persistence]
crates: [server]
symptom: A severity finding after character 2000 is absent from the review gate even though the agent emitted it.
root-cause: Review extraction parsed the bounded exitSummary projection instead of the complete captured final result.
prevention: Parse machine-significant verdicts and findings from the complete captured agent result before deriving any bounded display summary.
promoted: mechanized:server/lib/dispatch.test.mjs
date: 2026-07-31
---

# The trap

`exitSummary` is intentionally bounded for storage and display. It cannot also
be the source of truth for review findings: a valid BLOCKER after that boundary
vanishes and may make every merge policy appear eligible.

Capture the adapter's complete final result, parse and persist the bounded
structured review result before terminal settlement, and strip that internal
capture from API exposure. The regression must place a BLOCKER beyond the
display boundary and prove it still gates strict, tiered, and advisory policy.

# How to detect

The review dispatch's `exitSummary` lacks the late finding while the target's
structured current review retains it and rejects an unforced merge.

# References

- `server/lib/dispatch.mjs`
- `server/lib/agents/claude.mjs`
- `server/lib/agents/codex.mjs`
