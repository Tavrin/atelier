---
title: A codex app-server's age says nothing about whether anything still needs it
tags: [codex, process-lifecycle, memory, reaper]
crates: [server/lib/agents/codex-processes.mjs, server/lib/dispatch.mjs]
symptom: A live codex resume dies mid-turn, killed by a cleanup that only looked at how old its app-server was
root-cause: A resume relaunches the companion in the ORIGINAL worktree, so it reuses that workspace's existing broker/app-server - which is therefore exactly as old as the first turn
prevention: Gate the reap on the dispatch's STATE (only a turn in flight keeps its tree) plus ONE proof of ownership - an identity Atelier itself persisted, read in the same /proc pass that found the process. Never elapsed time, never cwd, never argv shape: those are report annotations
promoted: none
date: 2026-07-30
---

# The trap

The leak is real: 3 processes per companion job plus per-session MCP children,
none of them in the task-worker's process group, so the companion's own
`kill(-job.pid)` cancel leaves the whole app-server subtree resident. One day of
unattended operation left 211 app-servers and ~10 GiB PSS. Age looks like the
obvious filter, and it is the one that reads as safe - "nothing needs a
five-hour-old app-server". It isn't: `codex resume` reuses the broker keyed to
that workspace's cwd, so an in-flight resume's app-server dates from the
*original* turn. The manual sweep that recovered 12 GiB also killed a live
resume (`e5x`) that way.

The second trap sits right next to it: the deleted-worktree criterion is only
safe once it is scoped to Atelier's OWN `<stateDir>/worktrees` tree. A human's
Claude Code session running a codex companion in a checkout they since deleted
reads as "deleted worktree" too, and reaping it kills their editor's agent.

# How to detect

Point the reap set at an ACTIVE record and see whether anything is signalled -
if it is, the state gate is gone and the e5x class of failure is back. Then spawn
a fixture tree in a `(deleted)` directory OUTSIDE `<stateDir>/worktrees` and check
it is neither killed nor even named.

# References

- `server/lib/dispatch.mjs` — `codexSweepVerdict` / `reapCodexProcessTree`
- Related: [[unprovable-death-is-not-death]] (same asymmetry: uncorroborated is
  not actionable), [[killmode-mixed-kills-detached-codex-workers]] (why these
  processes outlive the server at all)

# 2026-07-30 — the corollary, decided after this lesson was written

Protecting a terminal record's app-server *because it might be resumed* looks like
the same lesson applied one step further. It is not, and it was reverted: the
recorded incident was a LIVE resume, which the state gate already covers, while
retaining finished turns' trees bounds memory by unmerged-undismissed dispatch
count and rebuilds the pile-up. The reason it is safe to reap them is narrow and
worth keeping in one place: codex threads are persisted rollout files under
`~/.codex/sessions`, and `ensureBrokerSession(cwd)` starts a broker on demand, so
a resume after a reap costs one cold start, not the session.

# 2026-07-30 (round 2) — the same trap one level down: self-derived identity

Reading a pid's own `/proc` start time and storing it does not make the pid ours.
Three places had quietly assumed it did: an ordinary poll adopted whatever pid the
companion reported (a recycled pid could be re-minted as owned, and its
descendants captured); the capture probed each member a second time, so a pid that
exited between the two reads was recorded under a stranger's identity; and the cwd
sweep signalled anything standing in a Atelier worktree, which a user's own shell or
editor agent can do. The corroboration has to tie a process to ATELIER - a fence
Atelier's own poller established, membership of a tree Atelier captured, or argv that
is provably the companion family - not merely to itself.

# How to detect (round 2)

Seed a corroborated fence, then have the companion report a *different* live pid,
and check nothing is adopted or captured. Point the sweep at a plain `sh` in a
deleted dispatch worktree and check it is listed, never signalled.

# 2026-07-30 (round 3) — the final form

Round 2 fixed two of the three self-derived-identity holes and left one in: the cwd
sweep still accepted "argv looks like the codex companion family" as a kill
qualifier. It is not one. argv is self-reported, so any process can name
`codex-companion.mjs` in its command line - and a user's OWN codex companion can
legitimately be running with a cwd inside a atelier worktree, so shape plus location
still describes a stranger. The spec's constraint 1 was amended with the code: the
kill set is identity-corroboration against persisted Atelier state and nothing else;
cwd and argv survive as report annotations.

The reason this costs little is worth remembering, because it is what makes the
strict rule affordable: the capture path persists a tree on every live poll, so a
crash leaves persisted members behind. The cwd pass only gives up the case where
Atelier captured nothing at all - where it has no evidence, and listing is the honest
answer.
