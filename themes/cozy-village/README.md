# Cozy Village

Cozy Village is Atelier's functional world: seven permanent stations arranged
around a small, warm village green. The layout is the workflow. Dispatches are
parcels carried by recurring villagers, and movement occurs only when Atelier
observes an authoritative lifecycle transition.

The theme vendors three.js inside its own bundle. It adds no core runtime
dependency or build step.

## Reading the village

| Station | Projection | Meaning |
| --- | --- | --- |
| Notice | project state + queue | Ready tracker issues; a ribbon means tracker or queue degradation. |
| Workshop | dispatch records | Three lane/work-class benches hold active work and retained failed/stopped parcels. |
| Assay | verify, review, gates | Distinct verify and review bays; failed or stale work returns marked to its workshop. |
| Cottage | needs-input and plan state | The porch holds only a real question or plan awaiting the operator. |
| Town Hall | merge gates + current main health | Human merge queue inside; current main checks and unresolved failures at the attached dock. |
| Granary | boot-frozen chronicle | One exterior and a searchable wall of works. Local merges wait in the labelled “awaiting archive” vestibule until a later snapshot contains them. |
| R&D | boot-frozen artifacts | Searchable project specifications and design notes from the path-safe artifact index. |

The compact village key is visible by default. The rail repeats the current
station counts, ready work, in-flight parcels, gate strips, and aggregate
ledger so no fact depends on 3D perception alone.

## Movement and activity

The only paths are the real lifecycle links:

```text
Notice → Workshop ↔ Assay → Town Hall → test dock → Granary
                    ↕
                 Cottage
```

R&D is a static browsing presence and has no invented traffic.

A dispatch creation can carry a ready notice paper to a workshop. Verify or
review start moves work to the assay; failure or stale review returns it
marked. Human input moves work to the porch and a real resume returns it.
Passing required gates moves it to the hall. A merge crosses the square to
the dock and then enters the honest granary vestibule.

Observed `usage`, `status`, and `message` events produce a short labelled
activity burst at the current station, then settle. Atelier has no heartbeat, so
silence never becomes a continuous “working now” animation. Reduced-motion
mode removes carrying animation without removing any state or labels.

## Real data and freshness

Live mode consumes:

- `/api/projects/:project/state`
- `/api/projects/:project/queue`
- `/api/dispatches` and Atelier's bounded theme stream
- `/api/projects/:project/main-health`
- `/api/projects/:project/chronicle`
- `/api/projects/:project/artifacts`

The chronicle and artifact index are boot snapshots. Their `generatedAt`
timestamps are shown as freshness information. Main health, board, queue, and
dispatch data are fetched as current projections. Missing optional projections
degrade visibly; the theme does not reconstruct them from unrelated data.

The granary grows only at aggregate archive thresholds of 10, 25, 50, and 100
merges. Decorations are sparse and capped. R&D props derive only from artifact
counts. Ambient grass, trees, birds, fireflies, and chimney smoke encode no
health.

Fixture mode combines this repository's measured merge history with explicitly
hand-written live dispatches. The provenance rail labels both halves.

## Controls

| Input | Action |
| --- | --- |
| Pointer hover / click | Inspect a station, paper, parcel, villager, or dock item. |
| Drag / wheel | Orbit and zoom. |
| `?` | Open “How to read this”. |
| `T` | Toggle village/green framing. |
| `M` | Toggle local motion reduction; OS reduced-motion always wins. |
| `R` | Hide or show the rail. |
| `Escape` | Close theme overlays; the core `⌂ Dashboard` escape pill remains available. |

The project selector is always in the rail. Selection prefers an explicit
`?project=...`, then the remembered project, then the project with the richest
chronicle (registry order breaks ties).

Useful review URLs:

```text
?data=fixture
?data=fixture&time=noon&motion=off
?data=fixture&time=dusk&motion=off
?data=fixture&time=night&motion=off
```

Named time previews are stable visual-QA clocks and are labelled as previews.
Live mode remains the default.

## Honesty and lifecycle

The implementation follows `docs/THEMES.md` R1–R6:

- all progress geography comes from state and gate projections;
- contract strings enter the DOM through text nodes or `textContent`;
- one bounded aggregate stream resyncs after reconnect and visibility return;
- disposal releases generated resources, three.js, and the WebGL context;
- activity never supplies a verdict;
- reduced motion preserves every fact.

Failed and stopped dispatches remain visibly marked at a workshop until the
real dismiss action removes them. Main-health acknowledgement only quiets the
bell; the dock parcel and scaffold remain until the current projection
resolves them. Merge actions, replies, dismissals, and acknowledgements use the
same server actions and gates as the dashboard.

## Layout

```text
entry.mjs             mount, interaction, resync, actions, disposal
state/village.mjs     seven-station projection and transition grammar
state/gates.mjs       shared five-gate reading
data/live.mjs         current API projections and bounded stream
data/fixture.mjs      labelled fixture source
ui/chrome.mjs         accessible rail, cards, legend, and interiors
world/world.mjs       three.js scene and bounded animations
world/materials.mjs   shared procedural materials
world/geometry.mjs    reusable station geometry primitives
```
