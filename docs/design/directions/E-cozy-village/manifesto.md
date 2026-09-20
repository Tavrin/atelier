# Direction E — THE COZY VILLAGE

**Atelier · Pelican-town register** — a cockpit for supervising agent teams, drawn as a
village that is *carved*: a music-box town on a turned basswood stand, painted in milk
paint, lit by your actual clock.

Hero: the original 3D prototype that argued for this direction is not shipped
in this repository. The direction it argued for is, as the `cozy-village`
theme under `themes/cozy-village/`.

---

## The manifesto

The client named Stardew Valley and Animal Crossing, so the *scene* is theirs without
argument: a square, a well, a notice board, workshops down six lanes, gardens, lanterns,
seasons. What is not theirs is the **finish**. This village is a hand-carved wooden toy —
turned peg villagers, milk-paint walls, a lathed stand whose bevel shows raw end-grain at
the world's edge. That single detail is the thesis: you are looking at an *object someone
made*, not a level someone rendered. It is the one real risk in this direction, and it is
taken deliberately, because "low-poly village" is an asset pack and a beloved wooden toy
is not.

The village works because Atelier's actual shape already is a village. A dispatch is a
worker with a plot. A merge is a barn raising. The merge inbox is a board in the square
with paper pinned to it. And the thing a supervisor most needs — *is anyone waiting on
me?* — is the oldest signal in any village: **someone is standing at your door.**

But charm is the cheap half. The expensive half is that **this village cannot flatter
anyone**, and three refusals do the work:

**Structure is the only thing a gate can buy.** Nothing turns green. Passing verify does
not tint anything — it *raises a frame*. Passing review *boards a roof*. The stages are
silhouettes, readable across the square, and an unbuilt stage looks unbuilt whether it is
unrun, running, skipped or blocked, because none of those earned it. Greyscale the page
and you lose nothing.

**Green is the grass.** The village is full of green and green means *nothing* — we made
the success colour worthless by spending it on scenery. There is no channel by which
looking healthy can be faked, because healthy has no colour.

**Motion is presence, and presence is not progress.** Juniper is sawing, visibly, in a
yard containing four pegs and a string. She has been dispatched for fifty minutes and has
committed nothing, so she has built nothing, and the animation says only *she is here*.
That is the whole doctrine in one figure: **you cannot farm this town by looking busy.**

And the town remembers. Twenty-five merges stand permanently around the square, oldest
nearest the well, and one of them wears a **scaffold that will not come off** — it merged
clean and broke main. Acknowledging it dims the clocktower lamp. It does not take the
scaffold down, because in Atelier only a later passing merge commit resolves a post-merge
failure. The village's memory is append-only, including its mistakes.

---

## Who the villagers actually are

The client asked for **named recurring villagers with personality**. That raised a real
question: Atelier has **no persistent agent identity** — every dispatch is a fresh process.
So what recurs?

The answer is in the registry: there are exactly **two lanes** (`claude`, `codex`) and
**five claude models**. That is six hands you can call on, and you call on them again and
again. **A villager is a lane+model pair** — the only recurring agent identity Atelier
actually has.

Their personality is not flavour text. It is the capability set, verified in
`server/lib/agents/{claude,codex}.mjs`:

| Villager | lane · model | Drawn from |
|---|---|---|
| **Wren**, joiner | claude · opus | slow, costly, exact |
| **Marisol**, joiner with a long memory | claude · opus[1m] | 1M context |
| **Tobin**, carpenter | claude · sonnet | built most of the town |
| **Juniper**, carpenter, long memory | claude · sonnet[1m] | the big untidy jobs |
| **Pell**, errand-runner | claude · haiku | small, fast |
| **Alder**, mason from over the hill | codex | `liveInput:false` → **his workshop has no window, shutters closed: you cannot call through to him while he works**. `reportsCost:false` → **he never says what it cost**. `commitsOwnWork:false` → **he leaves the work loose on the bench for someone else to put away** |

Alder's three quirks are three boolean flags. That is the standard this direction holds
itself to: if a villager has a trait, point at the field.

Villager paint is **identity only**, drawn from a palette that shares no hue with any
status signal — no green, no lamp-gold, no tarp-slate. You can never mistake *who* for
*how it is going*.

---

## The honesty map

Every row is a field Atelier already has. Nothing is rendered from vibes, elapsed time,
token volume, or output length.

### Gates → the barn raising

| Gate | Source field | Yard state | Why it cannot lie |
|---|---|---|---|
| — | `outcome == null` | **String and pegs.** The footprint of a building that does not exist | A dispatch with no commits has zero structure. Six hours of work looks like four pegs. |
| **Changes** | `outcome.changes === "changed"` | **Materials.** Timber stacked, stone piled | The only thing that puts material in the yard is a diff existing. |
| **Verify** | `verify.state === "passed"` | **Frame raised.** Sky visible through it | Discrete. A frame is potential, not a building — which is what a passing suite actually earns. |
| **Review** | `review.verdict === "pass"` | **Roof boarded.** Closed, unpainted | The highest a plot can get *in the yard*. Paint requires the town. |
| **Merge** | `merged` | **It moves onto the square.** Painted, permanent | The one celebration. The town only ever grows here. |
| **Main** | `postMerge.state` | **The clocktower**, and a permanent **scaffold** on the guilty building | Roof-wide: no single plot can look fine while main is red. |

### Gate states → geometry

Track-B §5.2 defines seven states. **It cannot express `outcome.changes`, which has
three values** — `changed | empty | unknown` — of which only one maps cleanly. This
direction adds two, and reports them upstream as a spec gap rather than smuggling them in:

| State | Geometry in the strip | In the village |
|---|---|---|
| `pass` | solid **ink** bar (not green — ink) | the stage stands |
| `fail` | bar **broken** by a centred gap | frame down under a tarp; roof boards pulled back off |
| `unrun` | hollow, faded | the stage simply is not built |
| `running` | hollow + achromatic sweep | **nothing built** — running has earned nothing |
| `stale` | dotted border | a chalk X on the door: re-review required |
| `skipped` | hollow + centre dash | not built. Skipped is not passed, and merge refuses it |
| `blocked` | hatched | cannot run until an earlier gate passes |
| **`empty`** *(new)* | hollow + **hollow centre dot** | ran, found nothing to carry forward. **Not a failure** — an agent that stops to ask you a question produces an empty diff and has done nothing wrong. Drawing it as `fail` would slander it |
| **`unknown`** *(new)* | hatched + dotted, cool | Atelier could not determine it at all |
| **`awaiting`** *(new)* | hollow, **double-ruled gold** | the strip's only gold, lit on exactly the condition as the board lantern: nothing machine-checkable remains, so the blocker is you. `unrun` would draw this as "nothing happened", the opposite of what it means |

### States → world

| Product state | World element |
|---|---|
| `running` / `verifying` | Villager in the yard, **moving**. Sawing, carrying. Never adds material |
| Awaiting your merge (derived: `completed && !merged && mergeGateReasons()` empty) | **Paper pinned to the board's upper rail**, board lantern lit, age in the card |
| `needs_input` + `outcome.question` | **Villager standing at your porch**, porch lamp lit, their real question in the card |
| `plan_ready` + `plan.text` | Same porch, same lamp — a plan is a conversation too |
| `verify.state === "failed"` | **Frame collapsed**, canvas tarp over it, **cause tag on the board's lower rail** carrying the real command and exit code |
| `completed_empty` | Pegs and string, villager standing, done. *"Dismiss is the right action"* |
| Merged | **The building moves to the square** and is painted. Permanent |
| `postMerge.state === "failed"`, unresolved | **Scaffold that never comes off** + clocktower lamp until acknowledged |
| Real time of day | Sun/moon arc, sky ramp, windows and street lanterns warming at dusk |

### No-signal: Atelier drawing its own blindness

**Atelier has no heartbeat, no `lastSeen`, and no liveness ping.** (`": heartbeat"` in the
codebase is an SSE keepalive — transport, not agents.) So fog here can never mean "we have
not heard from them". It means **a specific named field came back indeterminate**:

| Field | What the card says |
|---|---|
| `orphanUnresolved` | Atelier could not prove the worker died |
| `outcome.changes === "unknown"` | Could not compare this branch against its base |
| `outcome.finalMessage === "unavailable"` | The last words could not be retrieved |
| `postMerge.error` contains *unknown* | Main health went unknown mid-check |

Any of these fogs the plot, hatches the ground, and **removes the villager from the
scene**. There is never a working figure inside fog. The card lists the fields by name.
Pell's plot is fogged on three of them at once.

### Seasons: convoys, because releases do not exist

**Atelier has no release, milestone, sprint or version concept** — confirmed absent across
`tracker.mjs`, `registry.mjs`, `bin/atelier.mjs`. "Seasons follow releases" had nothing to
bind to, so rather than invent a field, seasons bind to the nearest real merge-gated
primitive: the **convoy**, an operator-ordered run of tickets whose cursor advances *only
on a merge*. **The year turns when a convoy closes.** Progress within a convoy is printed
as text ("3 of 7 merged") and moves nothing, because partial progress has earned no season.

### What deliberately maps to nothing

**Token spend, tool-call volume, turn count, session length and time-since-dispatch have
no channel at all.** A chatty agent and a silent one build identically, because they have
verified identically. There is no soil-richness meter, no watering, no streak, no decay
from neglect. Cost is printed as a number in the card — and for Alder it reads *"cost not
reported"*, because `reportsCost:false`.

One mapping is deliberate and worth contesting: **a merged building's footprint is its
diff size** (`insertions + deletions`, from `GET /api/dispatch/:id/diff`). That is a
measured fact, and it gives the town a skyline that means something. It is **explicitly
not importance** — a three-line fix can be the most important merge of the month.
Importance is not in the data, so nothing on screen encodes it, and the card says so.

---

## The signature element

### THE LAMP LAW — three lights the clock cannot turn on

Every light in this village is on the real clock: windows, street lanterns, the forge.
They warm at dusk and go out at dawn, **identically for a thriving town and a broken
one**. Ambient light is therefore worthless as a status signal, by construction.

Exactly three lamps are exempt, and each burns only while you owe a decision:

1. **The notice-board lantern** — lit while anything can be merged right now.
2. **The porch lamp** — lit while a villager is at your door with a question or a plan.
3. **The clocktower lamp** — lit while main is red and unacknowledged.

Zero decisions and all three are dark, and the village is lit only by the hour. It is the
brief's *"the eye is tugged gently and only by real decisions"* discharged as a **rule of
physics rather than a style note** — and it is falsifiable in a single still frame:
**at midday, ambient glow is zero and the only lit things in the entire village are the
three lamps.** That is the screenshot. (Verified: at 12:40 `hearthGlow: 0`, all three
lamps lit.)

The gentle tug is a 4.2 s luminance breathe at ±14%, on those three lamps and nothing
else. No flashing, anywhere, ever.

---

## Craft notes

**Palette** — milk paint on basswood. Basswood `#D9BC8C`, beams `#A8834F`, painted
plaster `#EDE2CC`, madder roofs `#A6533F`, sage grass `#8FA882` *(scenery only)*, tarp
slate `#7E8D99`, fog `#C3CBD1`, and **lamp gold `#FFC46B`, which nothing else in the
world is allowed to use**. Failure is a canvas tarp, not an alarm — muted, sad, entirely
unalarming, and legible.

**Type** — two roles. A humanist face with calligraphic stress
(Optima / Candara / Gill Sans) for everything a *person* wrote or reads — villager names,
signboards, the agents' own words. A monospace for everything a *machine* wrote — ids,
shas, commands, exit codes. Nothing else. Signboards are canvas-drawn with a paint grain
so they read as lettered by hand.

**Structure** — the six plot chips along the bottom are not a summary; they are the
**accessible mirror**. Every fact drawn in the village is also a focusable button with a
text gate strip, so the world is ornament on top of a legible instrument rather than the
only way to read the state. Tab reaches all of it.

**Motion budget**, stated so it can be audited. Ambient and carrying nothing: villager
idle-bob, saw stroke, fog drift, falling leaves, a mouse-parallax of 1.5 world units.
Redundant reinforcement of a fact already static: the 4.2 s lamp breathe. One reward
event: **a merge**, ~1.6 s, the roofed shell lifting from the yard and settling onto its
slot in the town, then taking paint. It fires a `village:merged` DOM event carrying the
real dispatch id — the chime hook. Nothing else loops, and nothing loops to signal
aliveness. `prefers-reduced-motion` renders **one still frame with the full fact set** and
lands merges instantly; a **Motion** toggle in the rail makes that path demonstrable
without changing OS settings.

**Architecture** — `village.state.js` is pure: no DOM, no three.js, no imports. It turns
Atelier records into a semantic village ("this plot is framed and unlit"). `village.world.js`
is the only file containing a three.js call and owns all geometry. A WebGPU adapter
replaces the second file and touches nothing in the first.

---

## What this direction does NOT establish

- **60 fps is not measured.** The scene's *workload* is light and known: **398 draw calls,
  ~28k triangles**, three lights, one 2048² shadow map, Lambert only, no post-processing,
  and a **CPU scene update of 0.01 ms/frame** (measured). Draw calls were cut 644 → 398 by
  a merge-by-material pass. But wall-clock fps could not be measured in that setup: the
  automation tab is permanently `visibilityState:"hidden"` so `requestAnimationFrame`
  never fires, and headless Chrome **hangs on WebGL2 context creation**. Both paths are
  closed. Treat 60 fps as *expected from workload*, not as verified.
- **The fixture is a fixture.** Field *names* and *shapes* are real and cited; the values
  are invented. No Atelier instance was queried.
- **`outcome.question` is not currently rendered anywhere in Atelier's main dispatch view**
  (only a button hint and a desktop notification consume it). The porch is a proposal to
  surface it, not a description of today.
- **Awaiting-merge is derived, not stored.** There is no `awaiting_merge` state; the board
  is computed from `mergeGateReasons()`. If that helper drifts, the board drifts with it.
- **The three new gate states are additions to Track-B §5.2**, not part of it. They need a
  decision before they become house style.
