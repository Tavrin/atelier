---
title: KillMode=mixed still SIGKILLs a detached companion worker - only KillMode=process leaves it alone
tags: [systemd, lifecycle, codex]
crates: [atelier-service, atelier-dispatch]
symptom: atelier-tzw's spec named KillMode=mixed as the already-decided shutdown mode, but a codex companion job persisted for boot reattach was gone immediately after a systemd restart in three independent prior attempts
root-cause: per systemd.kill(5), KillMode=mixed SIGTERMs only the main process, but still SIGKILLs every other process left in the unit's control group - either once the main process exits, or at TimeoutStopSec, whichever comes first. A detached grandchild (the codex companion's background worker) is still in that cgroup, so it dies at the exact moment it needs to survive.
prevention: use KillMode=process for a unit that deliberately leaves workers running after shutdown - it signals only the tracked main PID and never touches the rest of the cgroup. Do the explicit termination of ordinary children yourself, in code, before the main process exits (lane-asymmetric shutdown).
promoted: mechanized:server/lib/service.test.mjs
date: 2026-07-30
---

# The trap

"KillMode=mixed" sounds like the safe middle ground between "kill everything"
(control-group) and "kill nothing extra" (process/none), and the ticket's own
"Design already decided" comment named it explicitly. It is not the safe
middle ground for this use case: systemd still SIGKILLs the whole cgroup once
the main process is gone, which is exactly when Atelier's shutdown code has
already returned control to systemd. Three independent implementation
attempts at atelier-tzw converged on KillMode=process instead (one of them via a
lesson doc identical in spirit to this one) - written from scratch, without
copying that work forward, and then independently re-verified against the
systemd.kill(5) man page.

# How to detect

Render the unit and grep for `KillMode=` - "mixed" or "control-group" here is
the fastest local reproduction; a real restart takes longer to notice than
the render.

# References

- `server/lib/service.mjs` (`renderServiceUnit`, `restartServiceSafely`)
- `server/lib/dispatch.mjs` (`shutdown()` - lane-asymmetric: codex `detach()`s, everyone else transitions to failed)
- `server/lib/agents/codex.mjs` (`reattach()`/`detach()`)
