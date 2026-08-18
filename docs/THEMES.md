# Atelier theme author handbook

Atelier themes are boot-frozen, self-contained browser bundles that render the
same verified projections and actions as the built-in dashboard. Core remains
zero-dependency. A theme may vendor its own runtime dependencies inside its
bundle; three.js is sanctioned.

## Bundle and manifest

Place a first-party theme at:

```text
themes/<id>/
  manifest.json
  entry.mjs
  assets/
  vendor/
```

`manifest.json` has these currently supported fields:

| Field | Required value and validation |
| --- | --- |
| `id` | 1–40 characters matching `[a-z0-9][a-z0-9-]{0,39}`. It must exactly equal the bundle directory name. |
| `name` | Non-empty display-name string. |
| `version` | Semantic version. Numeric identifiers may not have leading zeroes; prerelease and build metadata are accepted. |
| `contractVersion` | Semantic version compatible with the host. While the host contract is `0.x`, compatibility is minor-strict: major and minor must both match. Atelier currently requires `0.4.x`; build metadata does not affect compatibility. |
| `tier` | Currently exactly `"render+actions"`. It is metadata in the first-party same-page loader, not an enforced grant. |
| `adapter` | Currently `"webgl"` or `"webgpu"`. |
| `entry` | Relative path to an existing `.js` or `.mjs` regular file inside this bundle. Absolute paths, escapes, missing files, non-JavaScript files, and a symlink anywhere in the entry path are rejected. |

Example:

```json
{
  "id": "cozy-village",
  "name": "Cozy Village",
  "version": "1.0.0",
  "contractVersion": "0.4.0",
  "tier": "render+actions",
  "adapter": "webgl",
  "entry": "entry.mjs"
}
```

The theme directory itself must be a real directory, and `manifest.json` must
not be a symlink. Atelier ignores symlinked bundle assets and never follows them
outside the bundle. At server start it validates every manifest and snapshots
every served bundle byte. The inventory at `GET /api/themes`, entry modules,
and assets remain frozen for that boot; changing or adding files takes effect
only after Atelier restarts. Invalid discovered manifests fail loading rather
than being partially served.

The entry module exports `mount(root, context)` (or a default mount function)
and may export `dispose(generation)`. Every mount receives a unique opaque
`context.generation`; the host passes that same token to the exported dispose
hook. A theme with module-level instance state must key it by this token. A
stale cleanup may release only its own generation, never a newer mount of the
same cached entry module.

`context.signal` is aborted as soon as the user switches away, including while
an asynchronous mount is still loading. Themes must pass it to in-flight
requests, check it before and after every asynchronous allocation boundary, and
dispose anything already allocated before returning an abort. `mount` may also
return a cleanup function for compatibility. On unmount or switch, the host
invokes both distinct cleanup hooks, waits at most two seconds, and removes that
generation's private subtree. Context types are recorded when the theme acquires
them: existing WebGL contexts are force-released and must confirm the
`webglcontextlost` event; WebGPU, 2D, and uninitialized canvases are released by
removal without WebGL confirmation. Teardown never calls `getContext()` to
create a context. A failed, timed-out, or unconfirmed WebGL cleanup sends the
cockpit to the dashboard.

Theme entries are loaded with a dynamic import only after their world is
selected. The dashboard does not preload theme entries or vendor bundles, so a
session that never opens a 3D world does not parse or retain three.js.

### Theme library imports

Theme bundles import Atelier's theme-facing core modules only through these
sanctioned, stable absolute URLs:

| URL | Exports |
| --- | --- |
| `/theme-lib/request.mjs` | `createThemeActionClient` and the core request helpers. |
| `/theme-lib/actor.mjs` | Theme/request actor validation helpers. |
| `/theme-lib/theme-stream.mjs` | `createThemeStream` and `safeText`. |

These modules are captured in the same immutable boot snapshot as the built-in
UI. Do not import through a relative source-tree path such as
`../../../ui/request.mjs`, and do not rely on the flat built-in UI routes.

## The four contract surfaces

### 1. State projections

Use the loopback `/api/*` projections. Do not infer verified state from pixels,
animation completion, transcript activity, or elapsed time.

`GET /api/dispatches` returns `DispatchRecord[]`; `GET
/api/dispatch/:id` returns one:

```js
{
  id, project, ticketId,
  lane, model, state,
  startedAt, endedAt, turns, costUSD,
  outcome: {
    kind, changes, finalMessage, question, answerPath, detectedAt, detail
  } | null,
  verify: { state, attempts, steps, ... } | null,
  review: { current, rounds } | null,
  reviewDispositions: [{
    ref, findingRef, disposition, redirectProject?, redirectTicket?, note, actor, at
  }],
  merged: { mergedAt, commit, forcedBy?, reason?, dispositionRef?, ... } | null,
  postMerge: { state, steps, ... } | null,
  dismissed, warnings,
  gates: [
    { gate: "changes", state },
    { gate: "verify", state },
    { gate: "review", state },
    { gate: "merge", state },
    { gate: "main", state }
  ]
}
```

Every gate state is one of:

| State | Meaning |
| --- | --- |
| `passed` | Atelier observed a successful verdict for this gate. |
| `passed-with-dispositions` | The reviewer did not pass the round, but every latest-round MAJOR and MINOR/NIT finding has a recorded human disposition and no BLOCKER exists. This is merge-eligible and remains distinct from reviewer `passed`. |
| `failed` | Atelier observed a failed, error, or malformed verdict. |
| `empty` | The changes gate completed with no diff (`completed_empty` or `outcome.changes === "empty"`). This is categorically not a failure and is not a pass. |
| `pending` | Work or a human decision for this gate is outstanding. |
| `skipped` | The gate was intentionally inapplicable, such as verification on a read-only run or main checks explicitly skipped. This is not a pass. |
| `not-run` | No run or verdict exists. Missing post-merge data and a nominal `passed` post-merge record with zero successful checks are `not-run`, never passed. |
| `unknown` | A signal exists but Atelier cannot honestly map it to a verdict. This is not a pass. |

Structured review rounds may carry `findings` entries shaped as `{ ref,
severity: "blocker"|"major"|"minor"|"nit", file, line, summary, novelty }`;
`file` and `line` are `null` when a tagged line's location is unparseable.
New captures expose at most 10 entries and `findingCount <= 10`. When reviewer
output exceeds that contract, `findingsTruncated: true` is served and the tenth
entry remains the tenth actual finding. Atelier retains every later finding line
for one lossless tracker follow-up ticket per finding and preserves
`findingOverflowCount`, ordered `findingOverflowSeverities`, per-severity
`findingOverflowSeverityCounts`, and the highest overflow severity. The shared
assessment reconstructs every overflow finding from that metadata for gates,
client policy, and statistics. Per-finding `file` and
`summary` are bounded to 500 and 1,000 characters; round `summary` and
`findingsText` are bounded to 2,000 and 4,000, with `...[truncated]` suffixes.
`novelty` is `new`, `repeated`, or `redirect-disputed`; the last state refers
back to a prior redirected disposition through `dispositionRef` and is excluded
from trajectory scoring only while that redirect remains the latest applicable
disposition. Matching identity is the normalized file, 10-line band, and a
bounded normalized first-sentence prefix; only a period followed by whitespace
and an uppercase letter ends that prefix, so abbreviations and file extensions
remain identity-bearing, as do commas and semicolons. The latest timestamped
disposition across every matching finding
in the whole round lineage governs; a later `accepted` ruling anywhere in that
lineage reopens it. A redirected re-flag becomes
open/new only when the
summary appends `— NEW EVIDENCE: <specific code or behavior changed since
redirect>`. Dispositions are append-only. The latest timestamped entry for a
`findingRef` is current (append order breaks equal-timestamp ties) and uses
`accepted`, `refuted`, `redirected`, or `waived`; a redirected disposition
always includes an existing separate tracker ticket in `redirectTicket` and its
owning project in `redirectProject`. The ticket id is redacted before persistence
and again on exposure.

First-party themes import `shared/review-assessment.mjs`; they do not maintain a
theme-local copy of finding, lineage-disposition, or policy logic. The same
boot-snapshotted browser module is consumed by the dashboard and Cozy Village.

The review gate remains a verdict projection. Under a project's `tiered` or
`advisory` policy, a failed review containing only policy-eligible findings can
still be merge-ready; themes must use the served project plus
`mergeGateReasons(record, project)` for the human merge affordance. BLOCKER is
never policy-eligible. Tiered open MINOR/NIT findings are eligible only when
Atelier can file them: the record must have a source `ticketId`, the project must
have a tracker, and the current review must carry its linked `dispatchId`.
Themes must block the normal merge affordance when those prerequisites are
missing and expose the existing audited force path.

For a failing latest round, only `refuted`, `redirected`, and `waived`
neutralize a finding under strict, tiered, and advisory policy. A bare
`accepted` entry records the human ruling but remains open until a fix passes a
new review or a later explicit waiver is appended. A refuted finding's note
records the human's evidence, while Atelier validates its presence rather than
trying to judge the evidence. Redirected findings require the separate ticket.

When a merge overrides open findings, the merge gate object and the nested
`merged` record both carry the audit triple `{ forcedBy, reason,
dispositionRef }`. Non-forced merges omit it. Themes must render this as human
override provenance rather than rewriting the failed review gate as passed.

Other state projections retain their server shapes:

```js
// GET /api/projects/:project/state
{ issues: [], readyIssues: [], source, tracker, degraded, generatedAt }

// GET /api/projects/:project/queue
{
  enabled, unavailable?,
  consecutiveFailures?, lastError?, failureLimit?, parkedTickets?,
  budget?, unpricedDispatches?
}

// GET /api/projects/:project/main-health
{ project, state, checksTotal, unresolvedFailures, running }

// GET /api/rollup
{ projects: [{ project, runs, completed, failed, merged, forcedMerged, turns, costUSD }],
  days: [{ day, runs, costUSD }],
  totals: { runs, merged, forcedMerged, turns, costUSD } }
```

Themes must ignore additive unknown fields.

#### Tracker issue and ready-work projections

`state.issues` is not a second Atelier issue schema. When tracker detection is
healthy, Atelier parses the configured tracker's `.beads/issues.jsonl` and
returns each JSON object unchanged. When the tracker is degraded it returns an
empty array and sets `degraded: true`. Consequently every issue field is
optional from a theme's point of view.

Contract 0.3 has two distinct degraded state shapes:

```js
// Tracker degradation: the tracker itself could not be detected.
{
  issues: [],
  readyIssues: [],
  source: "/configured/tracker/.beads/issues.jsonl",
  tracker: "none",
  degraded: true,
  generatedAt: "2026-07-31T10:00:00.000Z"
}

// Readiness degradation: tracker records were read, but `br ready` failed
// closed. The unchanged issue records remain available for non-ready views.
{
  issues: [{ id: "atelier-example", /* tracker-owned fields */ }],
  readyIssues: [],
  source: "/configured/tracker/.beads/issues.jsonl",
  tracker: "committed", // or another detected non-"none" tracker
  degraded: true,
  generatedAt: "2026-07-31T10:00:00.000Z"
}
```

A theme distinguishes these variants with `tracker === "none"`, not by testing
whether `issues` happens to be empty. Tracker degradation means issues are
unavailable. Readiness degradation means issues are available but no ticket
may be represented as ready: `readyIssues` failed closed. A 0.3 theme should
render those as separate conditions such as “Tracker unavailable” and
“Readiness unavailable”; it must not hide the preserved issue list in the
second case or derive a replacement ready list from it.

`state.readyIssues` maps the configured tracker's own `br ready` snapshot back
to those same unchanged issue objects, then excludes ticket ids present in the
dispatcher's current `parkedTickets` queue state. Atelier does not reinterpret
status, `defer_until`, dependency types, or issue-kind exclusions: blocking
dependencies, parent-child links, pinned/ephemeral/template/wisp records, and
the other readiness rules remain tracker-owned. The projection retains Atelier's
ready-queue ordering. When tracker detection is degraded, both arrays are
empty. When readiness alone is degraded, `issues` remains populated while
`readyIssues` is empty. Themes must consume `readyIssues` directly rather than
recreate readiness from `issues` or queue fields.

The fields in the current committed tracker records are:

```js
{
  id, title, description, status, priority, issue_type, assignee,
  dependencies, comments,
  created_at, created_by, updated_at, closed_at, close_reason,
  compaction_level, original_size,
  source_repo, source_repo_path
}
```

`dependencies` is an array. Existing tracker records and compatibility inputs
may identify the prerequisite as a string or as an object with
`depends_on_id`, `id`, or `issue_id`; an embedded `status` may be present.
Atelier prefers the matching issue's current top-level `status`, treats unknown
dependencies as blocking, and requires an issue id before including it in the
ready-work projection. Themes may use the full dependency records to explain
why an issue is blocked, but must not invent readiness from field absence.

#### Chronicle, artifacts, and freshness

`GET /api/projects/:project/chronicle` returns:

```js
{
  project,
  generatedAt,
  records: [{
    id, ticketId, title, mergedAt, costUSD, rounds, postMerge,
    forcedBy?, reason?, dispositionRef?,
    diff: { files, insertions, deletions } | null
  }],
  summary: {
    merges, forcedMerges, firstPassReviews, reviewedMerges, reviewPassRate,
    costPerMergeUSD, unlandedSpendUSD
  },
  truncated
}
```

`firstPassReviews` counts a one-round merge only when its final review gate is
`passed` or `passed-with-dispositions`; tiered/advisory merges of a one-round
`FAIL` remain reviewed merges but are not first-pass successes.
`merges`, `reviewedMerges`, and `costPerMergeUSD` describe ordinary merges;
`forcedMerges` counts audited break-glass outcomes separately. Forced records
remain present in `records` with their authorization fields.

`GET /api/chronicle` returns every project present at boot, merged in
chronological order under the same 500-entry bound:

```js
{
  generatedAt,
  records: [{
    id, ticketId, title, mergedAt, costUSD, rounds, postMerge, project,
    forcedBy?, reason?, dispositionRef?,
    diff: { files, insertions, deletions } | null
  }],
  truncated
}
```

Chronicles are snapshots of the boot record set, not live history.
`generatedAt` is the freshness contract and equals that server boot's
timestamp. A project registered after boot gets an empty per-project chronicle
with that timestamp and is absent from the aggregate until restart. Use SSE to
notice live changes, then refetch projections; do not mutate a chronicle
locally and present it as durable history. Atelier derives each footprint from
the recorded merge commit with a boot-time, per-project batched Git numstat
read. `diff` is `null` when that commit cannot be resolved; absence is never
reported as a zero-sized change.

The boot snapshot also backfills durable Git merge history whose subject starts
with Atelier's lower-case `merge:` convention. Retained dispatcher records win
on duplicate commit/id so cost, review, and post-merge evidence are preserved;
older Git-only entries remain explicit unknowns for fields Git cannot provide.

`GET /api/projects/:project/artifacts` is the contract `0.2` additive
projection:

```js
{
  project,
  generatedAt,
  artifacts: [{
    kind: "spec" | "design",
    title,
    path,
    updatedAt
  }]
}
```

Atelier indexes Markdown regular files under the fixed project roots
`docs/specs/**` and `docs/design/**`. `title` is the first Markdown heading, or
the filename when no heading exists. `path` is project-relative and uses `/`;
`updatedAt` is the file modification time. The directory set, file contents,
titles, and timestamps are snapshotted at server boot. Missing roots produce
an empty list. A project registered after boot also receives an empty list
until restart. The index rejects a symbolic link at either root or anywhere
below it and verifies canonical containment before reading a file. Request
data never selects a filesystem path.

### 2. Event streams

The aggregate stream is `GET /api/dispatches/events`. It carries `status`,
`usage`, `exit`, `reply`, `plan`, `review`, and `post-merge` events for all
dispatches. A per-dispatch stream at `GET /api/dispatch/:id/events` also
carries `message`, `verify-rerun`, `verify`, and `verify-output`.

Every event has the envelope:

```js
{ type, dispatchId, seq, ...kindSpecificFields }
```

Representative kind fields are:

```js
{ type: "status", state, detail?, gates }
{ type: "message", kind: "text" | "tool_use" | "tool_result" | "raw", ... }
{ type: "usage", turns, costUSD, inputTokens, outputTokens }
{ type: "exit", success, summary }
{ type: "reply", text }
{ type: "plan", text }
{ type: "review", verdict, summary, round, gates, ... }
{ type: "verify-rerun", phase, attempt, verdict?, gates, ... }
{ type: "verify", ... }
{ type: "verify-output", ... }
{ type: "post-merge", phase, state, commit, steps, gates, ... }
```

`status` events always carry the server-computed five-gate projection.
`review`, `verify-rerun`, and `post-merge` events carry it as well. Activity
events such as `message` describe presence only and carry no health verdict.
Ignore unknown future event kinds and fields.

Import `/theme-lib/theme-stream.mjs` and call `createThemeStream(...)`. It owns exactly
one aggregate `EventSource`, offers `subscribeDispatch(id, handler)` for a
default maximum of three per-dispatch sources, and evicts the least-recently
used source at the bound. Its reconnect delay grows exponentially from 250ms
and is capped at 10s. On every reconnect it awaits the supplied `resync(scope)`
callback before delivering events from the new source. Call the returned
unsubscribe function and call `stream.close()` from `dispose(generation)`.

### 3. Action API

Themes express existing Atelier actions; they do not invent parallel mutations.
Import `createThemeActionClient` from `/theme-lib/request.mjs` and use its returned
function for `/api/*` reads and writes:

```js
const request = createThemeActionClient("cozy-village");
const response = await request(`/api/dispatch/${encodeURIComponent(id)}/merge`, {
  method: "POST",
  body: { force: false }
});
```

The client JSON-encodes `body`, applies the mutation content type, rejects
non-`/api/` and cross-origin targets, and stamps mutations with
`X-Atelier-Actor: theme:<id>`. Reads are not actor-stamped. The actor label is
bounded audit attribution, not authentication or proof that the named theme
originated the request. Check `response.ok` and parse the returned `Response`;
server gates and confirmations still apply equally to themes, the dashboard,
and MCP.

### 4. Identity and words

Use `lane` and `model` as the honest agent identity/class. Contract words come
from record and event fields such as `ticketId`, `promptPreview`,
`exitSummary`, `outcome.question`, plan text, review verdict/summary, and
verification output. Theme-authored names and flavor are presentation only and
must never contradict those values. Put every contract string into the DOM via
`safeText(value)` from `/theme-lib/theme-stream.mjs` or by assigning `textContent`.

## Isolation and trust model

The current in-repository loader is for first-party themes. They execute as
same-page ES modules with direct DOM and loopback API reach; `tier:
"render+actions"` is metadata, not a security boundary.

The settled community-theme model for contract v1 has three trust levels:

1. T0 render-only: projections and events, no actions.
2. T1 standard actions: the Action API at the granted tier.
3. T2 deep integration: declarative panels, routes, and settings surfaces.

Community themes run in a sandboxed iframe. A `postMessage` bridge implements
the contract and is the tier-enforcement boundary while preserving
full-viewport rendering, native WebGL/WebGPU, projections, events, and granted
actions. The iframe has no direct core-DOM reach and no raw API path around its
grant. A user may explicitly promote a chosen community theme to full trust;
Atelier then runs it same-page only after plainly worded consent. This bridge,
grant UI, and promotion path are settled architecture but are not implemented
by the current first-party loader.

## REQUIREMENTS

R1. Progress must be state-driven, never paint-driven. Handle
`visibilitychange`: a backgrounded tab may throttle or suspend rendering, so
refetch projections when it becomes visible and render the current facts
without replaying missed paint as progress.

R2. Contract strings reach the DOM only via `safeText`/`textContent`—never
`innerHTML`.

R3. Use `/theme-lib/theme-stream.mjs` or equal discipline: one aggregate stream, bounded
per-dispatch subscriptions, and resync-on-reconnect.

R4. Export generation-owned `dispose(generation)` and release only that mount's
renderer context. The host fallback is a last line of containment, not the
renderer's lifecycle implementation.

R5. Honesty floor: render verdicts only from gates or verdict events. Activity
may show presence, never health. A decision awaiting the human must be visible.

R6. Reduced-motion mode must preserve parity of facts. It may remove movement,
transitions, and celebration effects; it may not remove state, verdict,
identity, pending-decision, or freshness information.

## Minimal theme skeleton

This is an inline starting point, not a shipped bundle:

```js
import { createThemeActionClient } from "/theme-lib/request.mjs";
import { createThemeStream, safeText } from "/theme-lib/theme-stream.mjs";

const THEME_ID = "example-world";
const request = createThemeActionClient(THEME_ID);
const instances = new Map();

async function json(path, options) {
  const response = await request(path, options);
  if (!response.ok) throw new Error((await response.json()).error || response.statusText);
  return response.json();
}

async function resync(instance) {
  const [dispatches, chronicle] = await Promise.all([
    json("/api/dispatches", { signal: instance.signal }),
    json("/api/chronicle", { signal: instance.signal })
  ]);
  instance.projection = { dispatches, chronicle };
  render(instance);
}

function render(instance) {
  if (!instance.host) return;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = document.createElement("section");
  frame.className = reducedMotion ? "world reduced-motion" : "world";
  const heading = document.createElement("h1");
  heading.append(safeText(`Dispatches: ${instance.projection.dispatches.length}`));
  const freshness = document.createElement("p");
  freshness.append(safeText(`History generated at ${instance.projection.chronicle.generatedAt}`));
  frame.append(heading, freshness);
  instance.host.replaceChildren(frame);
}

export async function mount(root, { generation, signal }) {
  const instance = {
    host: root,
    signal,
    projection: { dispatches: [], chronicle: null },
    renderer: undefined,
    stream: undefined,
    visibilityHandler: undefined
  };
  instances.set(generation, instance);
  signal.throwIfAborted();
  await resync(instance);
  signal.throwIfAborted();
  instance.stream = createThemeStream({
    async resync() {
      await resync(instance);
    },
    onAggregateEvent(event) {
      // Status/review/post-merge events carry gates. Refetching keeps every
      // projection coherent instead of treating activity or animation as truth.
      if (["status", "review", "post-merge"].includes(event.type)) void resync(instance);
    }
  });
  instance.visibilityHandler = () => {
    if (document.visibilityState === "visible") void resync(instance);
  };
  document.addEventListener("visibilitychange", instance.visibilityHandler);
  return () => dispose(generation);
}

export async function dispose(generation) {
  const instance = instances.get(generation);
  if (!instance) return;
  instances.delete(generation);
  document.removeEventListener("visibilitychange", instance.visibilityHandler);
  instance.stream?.close();
  instance.renderer?.dispose?.();
  instance.renderer?.forceContextLoss?.();
  instance.host = undefined;
}
```

## Deferred roadmap

Shared-vendor deduplication for common bundle dependencies such as three.js is
deferred. Today every theme vendors its own copy inside its boot-frozen bundle;
do not add a core runtime dependency or a shared-vendor mechanism ad hoc.

The aggregate chronicle remains the only multi-project world projection in
contract `0.2`; the artifact index is deliberately per-project. Per-project
districting and other multi-project projection
shapes remain **EMPIRICAL** inputs to the contract v1 harvest; themes should not
invent a parallel contract for them.
