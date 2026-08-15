---
title: A liveness probe that cannot corroborate a pid must return "unresolved", never "dead"
tags: [dispatch, concurrency, restart, process-fencing]
crates: [server/lib/dispatch.mjs]
symptom: Two writers in one worktree, or a ticket silently released while its agent is still committing
root-cause: Every "cannot tell" branch of a pid probe collapsed into the dead branch, because dead is the branch that lets the code continue
prevention: Give the probe three outcomes (absent / dead / unresolved), make only CONFIRMED death clear the fence, and make unresolved a persisted state that retains the claim and blocks successors
promoted: none
date: 2026-07-30
---

# The trap

Fencing a surviving child on pid + `/proc` start-time identity looks airtight
until you enumerate the answers a probe can actually give. Round 2 of atelier-tzw
had five distinct branches - no pid, no persisted identity, unreadable identity,
mismatched identity, matched-but-unkillable - and quietly folded four of them
into "dead", because "dead" is the outcome that lets the caller proceed. Result:
a crash-window record whose identity never landed was declared dead, its claim
released, and its resume offered while the real worker was still writing.

The asymmetry that is easy to get backwards: a live pid whose identity
*mismatches* IS confirmed death (the OS recycled the pid, so our child exited);
a live pid whose identity is *missing* is not death at all. And a zombie is dead
even though its `/proc` entry still reads back the matching identity - round 2
signalled it, saw the identity again, and refused forever.

# How to detect

Seed a record with a live pid and a `null` identity, boot, and see whether the
claim is released; and point a record at a real zombie (`sh -c 'true & echo $!;
exec sleep 30'`) and see whether it is treated as unkillable. If either "just
works", the unresolvable branches have been folded into death.

# References

- `server/lib/dispatch.mjs` — `probeProcess` / `resolveOrphanPid` / `admitSpawn`
- Related: [[killmode-mixed-kills-detached-codex-workers]] (why children outlive
  the server at all), [[persisted-history-must-become-live-before-mutation]]
