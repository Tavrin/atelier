---
title: Head-and-tail evidence can omit the only failing subtest
tags: [dispatch, verification, persistence, alerts]
crates: [server]
symptom: A red verification alert contains passing tests and summary counts but no failing subtest name.
root-cause: Uniform head-and-tail truncation treats the diagnostic signal like ordinary context and can discard a middle TAP failure.
prevention: Capture TAP not-ok lines and bounded YAML blocks while streaming, reserve evidence space for them first, then spend the remainder on head-and-tail context.
promoted: mechanized:server/lib/dispatch.test.mjs
date: 2026-07-22
---

# The trap

Long `node --test` output can put its sole `not ok` record between Atelier's
retained head and tail. The first live post-merge failure therefore raised a
correct MAIN IS RED alarm without identifying the failed test, forcing a
manual rerun. Failure-aware capture must happen before the middle is discarded,
and every later evidence cap must preserve the captured failure again.
