---
title: One-sentence statement of the trap (symptom-first)
tags: [area-tags, e.g. persistence, ci, renderer, web]
crates: [crates_involved, e.g. moss_cooker]
symptom: What you observe when you hit it (one line)
root-cause: Why it happens (one line)
prevention: The rule that avoids it (one line — this is the payload)
promoted: none            # none | AGENTS.md §N | skill:<name> | recipe:<file> | mechanized:<gate>
date: YYYY-MM-DD
---

# The trap

2–6 lines: what goes wrong, in what situation, and what it cost when it was
first hit. Concrete, not abstract.

# How to detect

1–3 lines: the failure signature — which test/gate/behavior tells you you're
in this trap rather than a different one.

# References

- `path/to/relevant/file.rs` (illustrative — the prevention line above is the payload)
- Related docs/RFCs/lessons: [[other-lesson-slug]]

<!-- Keep the body ≤ ~30 lines. On recurrence, append a dated note instead of
     writing a duplicate lesson — recurrence is a promotion signal (see the
     moss-compound skill). Delete this file when its code path dies. -->
