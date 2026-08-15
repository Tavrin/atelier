# Changelog

Atelier uses semantic versions for product milestones. Dates below record when each milestone was assembled in this repository.

## [Unreleased]

- **atelier-3sw:** Added structured severity-tagged review findings, append-only
  human dispositions, disposition-aware review briefs and trajectory parking,
  the `passed-with-dispositions` review gate, strict/tiered/advisory per-project
  review policies with durable tiered follow-ups, fail-closed untagged findings,
  per-line malformed-tag resilience, explicit new-evidence reopening for
  redirects, redacted redirect tickets, contradictory-verdict rejection,
  full-result severity extraction beyond the bounded exit summary, explicit
  waiver semantics (bare acceptance remains open), one linked follow-up ticket
  per remaining tiered finding, client parity for advisory-filing prerequisites,
  latest-lineage-disposition reopening for redirect disputes, bounded structured
  finding payloads with one lossless follow-up per overflow finding, one shared
  server/dashboard/theme assessment for every overflow finding, exact overflow
  severity distributions in chronicle statistics, unconditional severity-aware
  trajectory parking, abbreviation-safe finding identity, inline-code tag
  isolation, success-only
  first-pass review scoring, markdown/ordered/Unicode bullet recognition,
  pre-cleanup merge/debt journaling, doctor-visible retry debt, and
  mandatory force-merge audit provenance. The additive gate vocabulary raises the theme
  contract to `0.4.0`.
- **atelier-pys:** Added the authoritative server-side `state.readyIssues`
  projection, excluding in-progress, dependency-blocked, and queue-parked
  tickets while retaining the complete `state.issues` tracker view. The
  built-in dashboard and Cozy Village now consume the same ready truth, and
  the theme contract is `0.3.0`.
- **Cozy Village functional redesign:** Replaced merge-by-merge monument
  buildings with seven permanent lifecycle stations, authoritative
  parcel-carrying transitions, a real ready-work notice board, current
  main-health dock, honest archive vestibule, aggregate granary growth, and a
  searchable R&D index. Added the boot-frozen, symlink-rejecting
  `GET /api/projects/:project/artifacts` projection and raised the theme
  contract to `0.2.0`.
- **atelier-2q6:** Made linked spec-audit rounds append-only and visible as a trajectory in the cockpit/API, with mechanically counted contract findings. Atelier now parks review threads on a mechanically contradicted implementation handoff, a non-shrinking count, or the configurable `maxFixRounds` hard backstop (default 4); parking refuses further fix replies, respects ticket-wide claim fencing, emits the park in `dispatch.review`, and posts a bounded ticket re-spec with the last findings and branch/HEAD salvage pointer.
- **atelier-e5x:** Added the structured operational event log: append-only, size-rotated JSONL under `~/.local/state/atelier/logs/`, redacted at write time, carrying queue drain decisions (picked/skipped with a machine-readable reason and the candidates considered), dispatch transitions with failure kinds, settings/registry changes with actor and field diffs, budget verdicts, park/un-park, review/merge/dismiss and service lifecycle. Read it with `atelier logs [--follow]`, `GET /api/logs`, the `atelier_logs` MCP tool, or the `#/logs` UI table. Logging is structurally incapable of failing a dispatch (one total, never-awaited tap; an observer dispatcher writes nothing), and the queue card now shows spend-today against the daily budget so a budget-blocked queue is visible at a glance instead of buried in `lastError`.
- **atelier-yqk + atelier-kaz:** Fenced every verification runner Atelier spawns - first-run verify, explicit re-run, and post-merge verify - under the one fencing vocabulary, so a crash can no longer orphan a heavy suite invisibly and no boot can double-start a verifier beside a surviving one. The post-merge pair moved *into* that vocabulary: its recovery was the last site that folded "cannot confirm death" into death, deleting the pid on the live-but-uncorroborated branch. The four pairs now differ in exactly one declared way (`holdsClaim`), so an unproven post-merge verifier is surfaced and never double-started without falsely retaining a tracker claim. Both verifier pairs are persistence-only and stripped from every served record.
- **atelier-za6:** Reap codex companion process trees (app-server + MCP children) on terminal transitions, dismissal, merge, and a boot/interval GC sweep. Every kill is identity-corroborated through atelier-tzw's single classifier, scoped to Atelier's own dispatch worktrees, and never based on age. **Operational default flipped:** a terminal record's app-server is no longer retained for a possible resume — a resume cold-starts its own broker, so retaining them bounded memory by unmerged-undismissed dispatch count.

## [0.3.0] - 2026-07-21

- **DS-A:** Established CSS cascade layers, primitive/semantic/component token tiers, `light-dark()` themes, shared scales, and container-query foundations.
- **DS-B:** Extracted app-state-free DOM primitives, added the living `#/styleguide`, and documented the design system.
- **V3-1:** Added service installation, safe per-project dispatch environments, and an informational Codex Git-writability probe.
- **V3-1.5:** Made a fresh install bootable, added UI project onboarding, and introduced full, Git-only, and tracker-only archetypes.
- **V3-2a:** Hardened merge fallback, cleanup/GC, claim healing, duplicate/race handling, and output redaction.
- **V3-2b:** Added opt-in tracker automation, stranded-write harvesting, a `.beads` merge driver, and service PATH handling.
- **V3-2.5:** Introduced the agent adapter contract and drove composer choices from registered adapter capabilities.
- **V3-3a:** Added persisted agent sessions, reply/resume, live mid-run input, and matching server/CLI surfaces.
- **V3-3b:** Added steering UI, project tabs, dispatch filters, honest ticket gating, editor links, and expanded diff review.
- **V3-3c:** Made external tracker placement the default, kept in-repo tracking opt-in, and added reversible tracker migration.
- **V3-4:** Added opt-in plan preview, sequential convoys, two-lane bake-offs, and per-project daily budgets.
- **V3-5a:** Added Codex log streaming, live board events, command robustness, bounded persistence/replay, locks, and orphan hygiene.
- **V3-5b:** Added keyboard shortcuts, an installable manifest and original glyph, verified product docs, a portability audit, and the pre-OSS checklist.
- **V4-1:** Added adapter-owned commit capability declarations and Atelier-owned pre-verification commits for completed Codex work.
- **V4:** Added an honest per-project daily dispatch-count fallback for lanes that cannot report trustworthy cost.
- **V4-2:** Added `needs_input` and `completed_empty` outcomes with fail-closed detection, so a dispatch that ends on a clarifying question with nothing to show can no longer record as a verified success.
- **V4-3:** Added an explicit verification re-run for a completed dispatch whose verdict failed, with a retained per-attempt history, so one flaky suite can no longer strand a mergeable dispatch behind a `force` merge that records nothing.

## [0.2.0] - 2026-07-21

- **Spec D:** Made persisted dispatch history live without restart, fixed aggregate SSE resume IDs, and rendered raw transcript lines safely.
- **Spec E:** Added harness verification, approve-and-merge, ready-queue autonomy, and cost rollups to the server core.
- **Spec F:** Surfaced verification, merge, queue, rollup, and desktop-notification workflows in the cockpit UI.
- **Spec G:** Completed the board, transcript, table, theme, sidebar, and phone-responsive polish pass.

## [0.1.0] - 2026-07-21

- **Spec A:** Lifted the zero-dependency server core with request, registry, capability, and tracker security primitives.
- **Spec B:** Added isolated dispatch worktrees, append-only event streaming, the loopback server, and the CLI foundation.
- **Spec C:** Shipped the initial board, composer, live dispatch view, and all-dispatches UI.
