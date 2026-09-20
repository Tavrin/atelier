# Lessons Index — known traps, one line each

> Skim before working the matching area; open a lesson only on a match.
> Format: copy `_TEMPLATE.md`. Founding lessons inherited from the project
> that birthed this tool (summaries here are load-bearing):

- (inherited) br-state-is-per-checkout — worktree agents' br writes strand in the worktree's own `.beads`; run br against the configured tracker directory (the PRIMARY checkout by default)
- (inherited) green-checks-that-cannot-see-the-failure — a check that structurally cannot see the failure is not evidence (bind-mounted container verify reflects the PRIMARY, not the worktree - hence advisory verifyMode)
- (inherited) non-isolated-agents-clobber-worktree — fan-out agents sharing a tree can revert uncommitted edits; isolate, re-check git status after
- ungated-chains-mask-red-tests — test steps must gate chains on their OWN exit code; `| grep` gates on grep; canonical suite command is `npm test` (NEVER bare `node --test`, which hangs)
- shared-contract-files-during-parallel-writers — a concurrent job owns the test file? satisfy the old contract, queue the rename; never race a shared file
- allowedtools-preapproves-not-restricts — claude -p --allowedTools only pre-approves; enforce restrictions with --disallowedTools (caught in V3-4 verification)
- close-resources-before-server-close — `server.close()` waits for active SSE sockets, so end streams and watchers before awaiting `close` or shutdown deadlocks
- mcp-schemas-must-validate-runtime-arguments — advertised inputSchema metadata does not reject bad calls; validate unknown, missing, and mistyped fields before any proxy request
- failure-evidence-must-prioritize-failures — bounded verify evidence reserves space for every TAP `not ok` line and its capped YAML diagnostics before head-and-tail context
- persisted-history-must-become-live-before-mutation — reserve and mark inert records live before awaited mutations, or background refresh can replace the object mid-operation
- static-ui-must-be-a-boot-snapshot — request-time reads can pair a newly merged app.js with an older process allowlist; snapshot every allowlisted UI asset before listening
- killmode-mixed-kills-detached-codex-workers — systemd KillMode=mixed still SIGKILLs every other process in the cgroup once the main process exits; only KillMode=process leaves a deliberately-detached worker alone
- unprovable-death-is-not-death — a pid probe that cannot corroborate must return "unresolved", not "dead"; only confirmed death (ESRCH, zombie, identity MISMATCH on a live pid) may clear a fence or release a claim
- codex-process-age-is-not-liveness — nothing a process says about itself (age, its own /proc identity, cwd, argv shape) makes it Atelier's to kill; the kill set is identity-corroboration against persisted Atelier state, everything else is report-only. Terminal records get NO resumability exemption - a resume cold-starts its own broker
- [codex-prompts-belong-in-files](codex-prompts-belong-in-files.md) — generated review briefs can exceed the kernel's per-argument limit; persist the complete prompt in Atelier state and pass only a short file-reading instruction in argv
- [commit-before-falsifying](commit-before-falsifying.md) — fails-on-old reverts on uncommitted work: git checkout silently eats the fix; commit first (atelier-9dt round 2)
- [a-list-driven-invariant-exempts-whatever-is-stored-differently](a-list-driven-invariant-exempts-whatever-is-stored-differently.md) — a rule enforced by iterating a list of field-name pairs cannot see a member persisted in a different shape; give the entries accessors so odd members JOIN the vocabulary, and prove completeness by asserting at the choke point (atelier-kaz: the post-merge fence sat outside FENCING_FIELDS through three review rounds)
- [contract-output-parsing-precedes-display-truncation](contract-output-parsing-precedes-display-truncation.md) — parse machine-significant verdicts and findings from the complete captured agent result before deriving any bounded display summary
- [unattacked-instruments-report-what-you-hoped](unattacked-instruments-report-what-you-hoped.md) — a test/harness/report nothing has attacked tells you what you hoped; break the guarded thing and require red before citing it as evidence (six instances in one campaign, incl. a contract test green through 14 of 25 mutations)
