# The Atelier World Contract — v0 draft (architect)

2026-07-30 · claude-arch · Contract revision: `0.3.0`. Status: DRAFT for
the maintainer's review. This is the
constitution of the theme/plugin system. v0 fixes the architecture and
enumerates every surface; marked `EMPIRICAL` items are finalized by
harvesting the 8 bake-off heroes' independently-invented state shapes and
by the maintainer's conventions review. Everything here rides on machinery that is
already merged (event log, parity manifest, record projections) — the
contract is mostly a formalization, not an invention.

## 1. Principles (settled, maintainer interview 2026-07-30)

1. **One machinery, many worlds.** The data model, projections, event
   stream, and action surface are identical for every presentation layer.
   The dense dashboard is itself a theme.
2. **The contract enforces honesty, never taste.** Structural: verified
   state and activity data are SEPARATE surfaces (§4); a theme cannot
   accidentally render trust-by-vibes. Tone, register, attention economy,
   aesthetics: absolute creative freedom.
3. **Tiered permissions** (§7): manifest-declared, user-granted;
   deep integration reachable with minimal risk.
4. **Core stays zero-dep; theme bundles are self-contained** and may ship
   their own dependencies (three.js sanctioned). 3D themes render through a
   scene-adapter seam (§8) for future WebGPU-renderer interchangeability.
5. **Progression never gates capability.** Delight layers (gamification
   dial, audio layers) are per-user opt-ins (§9).

## 2. Surfaces overview

A theme consumes exactly four inputs and produces UI:

| Surface | Transport | Today's implementation |
|---|---|---|
| **State projections** (§3) | `GET /api/*` + SSE snapshots | `exposedRecord`, board state, queue state, main-health, rollup |
| **Event stream** (§4) | `GET /api/logs` + SSE (`/api/dispatches/events`, per-dispatch streams, board events) | event-log (13 kinds, `{v,ts,seq,source,kind}`), stream.mjs normalized SSE |
| **Action API** (§5) | HTTP routes mirrored 1:1 by the parity manifest | `parity.mjs` — the SAME mechanically-asserted manifest MCP uses |
| **Identity & words** (§6) | fields within projections/events | lanes/models, exitSummary, needs_input questions, review verdicts |

## 3. State projections

The verified-truth surface. Themes render world state FROM THESE ONLY.

- `record` (via `exposedRecord`): id, project, ticketId, lane, model, state,
  outcome, verify {state, attempts[]}, review {current, rounds[]} (post-2q6),
  merged, dismissed, orphanUnresolved, restartResumeReady, warnings[],
  costUSD, timestamps. Plumbing (pids/identities) is stripped — themes
  never see it.
- `gates` — **EMPIRICAL/NEW**: the contract formalizes the five-gate
  projection every designer re-derived by hand: `CHANGES · VERIFY · REVIEW
  · MERGE · MAIN`, each `passed | failed | empty | pending | skipped |
  not-run | unknown(no-signal)`. `empty` belongs to the changes gate when a
  completed outcome has no diff; it is categorically distinct from `failed`
  and does not count as a pass. v0 proposal: computed server-side once
  (`gatesFor(record)`), served in the record, so every theme reads the SAME
  gate truth (no per-theme reimplementation drift).
- board/queue/project: issues, queue state incl. parked + spend-vs-budget,
  main-health, registry (redacted). `state.issues` is a pass-through of the
  configured tracker's JSONL objects. `state.readyIssues` maps the configured
  tracker's own `br ready` snapshot back to those objects and removes Atelier's
  parked queue tickets, so notice boards and ready-work actions cannot drift
  from tracker or queue truth. The concrete optional fields and readiness
  ownership are documented in `docs/THEMES.md`.
- history aggregates for accretion & scorecards — **EMPIRICAL**: merged-
  per-project ledger (the "permanent bed/wall/shelf" every world needed),
  outcome-only stats (cost-per-merged, review pass-rate, rounds-per-thread),
  with boot-derived merge-commit footprints
  (`diff: {files, insertions, deletions} | null`) on per-project and aggregate
  chronicle entries.
- project artifact index — **NEW in 0.2**:
  `GET /api/projects/:project/artifacts` boot-snapshots Markdown regular files
  below the fixed `docs/specs/**` and `docs/design/**` roots as
  `{kind: "spec"|"design", title, path, updatedAt}`. The request never carries
  a filesystem path. Both roots and every descendant component reject
  symlinks, canonical paths must remain inside their selected project docs
  root, and missing roots produce an empty list. The result and its
  `generatedAt` timestamp stay frozen for the server boot.

## 4. Event stream

The time surface. Two classes, structurally separated:

- **Verdict events** (state transitions with gate consequences):
  `dispatch.transition/review/merge/dismiss`, `queue.park/unpark`,
  `budget.evaluation`, `service.*`, `registry.change`, `queue.settings`.
  Themes may celebrate/animate PROGRESS only from these.
- **Activity events** (presence; carries no health semantics by
  construction): today the per-dispatch SSE message/tool stream plus observed
  aggregate `usage` and `status` activity. Atelier has no heartbeat. Themes may
  show a brief labelled burst after an observed activity event and must then
  settle; silence can never support an indefinite working animation. Planned
  (`B-1`) signed hook events remain separate future work.
  The contract REQUIRES activity data to carry no verdict fields, so a
  theme physically cannot derive health from it.
- Catch-up: the log's deterministic replay powers time-lapse (user-invoked
  only), morning digest, decision-gated push (user-settable).

## 5. Action API

The interaction surface. One rule: **themes never invent actions; they
express these, diegetically or plainly.** The set = the parity manifest
(mechanically asserted, annotated read-only/destructive): dispatch, reply,
plan approve/revise, merge (+force semantics), dismiss, stop, verify-rerun,
review, queue enable/resume, settings patch, ticket ops, doctor/gc, logs.
Themes call them through one client (`/theme-lib/request.mjs` — actor header
`theme:<id>` **NEW**), inheriting actor attribution in the forensic log.
Command palette: core-provided, always available, themes may summon it.

## 6. Identity & words

- Agents: lane+model are the honest "class"; per-theme naming/persona hooks
  are presentation-side (**EMPIRICAL**: stable per-dispatch persona seed).
- Real-words hooks: needs_input questions, exitSummary/handoff, review
  verdict text — themes may voice agents with their actual output.
  Theme-authored flavor may never contradict state (honesty floor).

## 7. Plugin model

- **Bundle**: a directory (manifest.json + entry module + assets + vendored
  deps). Served by atelier's static layer from a themes dir; boot-snapshot
  discipline applies (a theme is immutable per server boot).
- Shared-vendor deduplication for common theme dependencies such as three.js
  is **DEFERRED**. Bundles vendor their own copies today; no shared-vendor
  loader or core runtime dependency belongs in contract 0.1.
- **Manifest**: id, name, version, contractVersion (semver; server refuses
  incompatible), tier request, entry, optional audio/gamification
  capabilities, adapter requirements (2D | webgl | future moss-webgpu).
- **Tiers** (user grants at install/enable):
  T0 render-only (projections + events, no actions);
  T1 + standard actions (through the Action API only);
  T2 + panels/routes/settings surfaces (deep integration).
  Isolation — **SETTLED (maintainer, 2026-07-30): three-level trust model.**
  First-party themes: same-page ES modules. Community themes: sandboxed
  iframe + postMessage bridge implementing the contract at the granted
  tier — the bridge IS the tier enforcement (worlds are equivalent to
  same-page: full-viewport rendering, native WebGL/WebGPU, all
  projections/events/actions; the only structural limits are no direct
  core-DOM reach — "+panels" becomes declarative slots — and no raw API
  access around the granted tier). Escape valve: a user-granted
  **full-trust promotion** runs a chosen community theme same-page behind
  a plainly-worded consent — creators are never hindered, users knowingly
  hold the sharp knife. Contract v1 freezes around this model.
- Failure containment: a crashed theme never takes down the cockpit; core
  falls back to the dashboard theme.

## 8. Renderer adapter seam

Theme world-state = plain JS objects derived from §3/§4 (no renderer types
in state). 3D themes talk to a thin scene interface (create/update/remove
node, transform, material-key, animation-clip-key) implemented today by
three.js, later by a WebGPU web renderer — Atelier worlds double as its
test bed. Renderer policy (maintainer, 2026-07-30): bake-off prototypes =
WebGL (three.js default, compatibility/velocity); the FLAGSHIP build
targets three.js WebGPURenderer with WebGL fallback, keeping the pipeline
adjacent to that renderer's WebGPU output from the first real slice. Manifest
adapter values: `2d | webgl | webgpu | moss-webgpu`. **EMPIRICAL**: the interface's exact shape is extracted from
the 8 heroes' scene code (what they all actually needed).

## 9. User dials (core-owned, themes honor)

Gamification: off | cosmetics | full progression (never gates capability).
Audio: silent default; opt-in chimes / ambience / music (theme-supplied).
Catch-up: replay (on request) / digest / decision-push toggles.
Accessibility floor for FIRST-PARTY themes: reduced-motion parity of
facts, geometry+color dual coding, keyboard reachability. Community
themes: encouraged via template, never enforced (creative freedom).

## 10. Compatibility & versioning

`contractVersion` semver. Additive = minor. Contract `0.2` added the path-safe
project artifact projection; `0.3` adds the authoritative `state.readyIssues`
projection. Because pre-1.0 compatibility is minor-strict, older-minor themes
are refused until updated.
The contract is append-heavy by design (new event kinds and projection fields
must not break themes: themes ignore unknown kinds/fields — REQUIRED
behavior). Breaking changes need a major + migration notes. The
parity-manifest import-time assert extends to the theme-visible action set
(drift = server refuses to boot).

## 11. Path to v1 (exhaustive)

1. Harvest the 8 bake-off heroes: their fake-data schemas → §3 gates/
   history shapes; their scene code → §8 interface. (Sonnet task, after
   landing.)
2. the maintainer's conventions review of this draft (esp. §7 isolation OPEN).
3. B-1 spec (signed hook events) as its own ticket — feeds §4 activity.
4. `gatesFor()` + actor-header + themes-dir loader as the first
   implementation slice (Track B slice 1, after flagship world choice).
5. AGENTS.md amendment (theme-bundle dependency exception) — the maintainer signs.
6. **EMPIRICAL, contract v1 harvest:** multi-project world projections beyond
   the aggregate chronicle, including per-project districting data. Do not
   freeze or build those shapes in contract 0.2.
