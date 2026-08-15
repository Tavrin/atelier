---
title: Complete prompts belong in files, not argv
tags: [dispatch, codex, review, subprocess]
crates: [server]
symptom: A Codex review with a large accumulated diff fails before launch with spawn E2BIG.
root-cause: The complete generated review brief was passed as one argv item, crossing the kernel's per-argument length limit.
prevention: Write every complete Codex launch or resume prompt to a mode-0600 Atelier state file and pass only a short instruction containing its path.
promoted: mechanized:server/lib/dispatch.test.mjs
date: 2026-07-31
---

# The trap

The process-wide argv budget is not the only limit. Linux also caps each
individual argument, so a generated review brief can fail even when the
companion command has only a handful of arguments. Accumulated diffs and review
history make this a normal scale boundary, not an exceptional input.

Do not truncate the prompt: that silently weakens the audit. Persist the full
UTF-8 content under Atelier's state directory with owner-only permissions, then
pass a bounded instruction telling the agent to read that file first. Exercise
the real operating-system spawn path with a brief larger than 200 KiB so a
regression back to inline argv fails for the original reason.
