# Moss Web Embed — requirements to replace three.js in Atelier themes

Authored by the Atelier architect 2026-07-31. This is the consumer-side
contract: what `moss_shell_web` must provide to be a drop-in renderer
backend behind Atelier's theme world-adapter seam, replacing the vendored
three.js WebGL build with equal-or-better results. The concrete consumer
is `themes/cozy-village/world/*.mjs` — derive the exact API surface from
that code, not from this prose.

## 1. Embed mode (a library, not an app)
- Initialize into a caller-provided `<canvas>` inside an existing page: no
  fullscreen takeover, no built-in UI, no default input handlers.
- ES-module JS package wrapping the wasm: async `init(canvas, options)`,
  explicit `dispose()` that provably releases everything (GPU device
  destroyed, render loop stopped, wasm memory freeable) — verified by an
  event/promise, because a theme must leave zero residual cost after
  unmount.
- Multiple init/dispose cycles per page session; DOM overlay UI composites
  above the canvas; no COOP/COEP or service-worker requirements that
  constrain the host page (or document them precisely).
- Capability probe API before init (WebGPU availability, limits) so the
  host can fall back to its three.js path with an honest reason.

## 2. Runtime scene API from JS (no cooking step for dynamic content)
- Create/destroy entities at runtime: transforms, parenting, visibility.
- Primitive meshes: box (with chamfer), cylinder/lathe profiles, plane,
  sphere — or a runtime mesh-from-vertex-arrays escape hatch.
- PBR-ish material params settable at runtime: albedo, roughness,
  metalness, emissive color/intensity, flat-shaded option; per-object
  color changes without recreating the mesh.
- Smooth animation: per-frame transform updates from JS at 60 Hz, or
  engine-side tweens JS can start/cancel.
- Text/signs: SDF text or acceptance of caller-provided bitmap textures
  (canvas-generated) on quads.
- Asset path (second phase, design now): runtime glTF/GLB loading OR
  pre-cooked bundle fetch over HTTP; discrete size variants, not uniform
  scaling.

## 3. Visual parity-or-better for the village look
- Directional sun + ambient/hemisphere with runtime-adjustable color and
  intensity (day/night cycle driven from JS), soft shadows, distance fog,
  emissive materials (windows, lanterns), sRGB-correct output, tone
  mapping suitable for a stylized cozy look, clean edges at 1080p (MSAA
  or TAA-class).
- The "better" opportunities that justify the swap: the probe-GI /
  irradiance work for grounded ambient light, PCSS-quality shadows, bloom
  on lanterns/windows at night. The village should look visibly richer
  than the three.js build, not merely equivalent.

## 4. Interaction interop
- Pick API: screen coordinates → entity id (raycast), for hover/click
  tooltips handled by the host.
- Camera API: set position/target/fov from JS, optional engine-smoothed
  transitions; no pointer capture unless requested.

## 5. Lifecycle and performance budgets
- Init to first frame ≤ ~2 s on the dev box; wasm+JS payload budgeted and
  stated (target ≤ ~15 MB compressed, streaming-instantiated).
- Idle village scene: low single-digit ms GPU per frame at 1080p;
  background-tab throttling.
- `dispose()` returns the page to zero engine cost — no rAF, no device,
  no leaked workers — testable from the host.

## 6. Testability and determinism
- A headless capture path usable in CI for the evidence workflow
  (1920×1080 PNGs, e.g. noon/dusk/night states): headless-Chrome WebGPU
  or a native-parity capture of the identical scene; output stable enough
  for golden comparison.

## 7. Contract hygiene
- Semver'd JS API with TypeScript definitions, no globals, vendorable
  license, a minimal example page, and documentation sufficient for a
  theme author who has never built Moss.

## 8. Explicit v1 non-goals
- No Lua, no physics, no editor, no full ECS authoring surface — the
  theme drives everything from JS state projections. The engine is a
  rendering backend here.

## Acceptance
Reimplement the current cozy-village scene graph 1:1 against this API
behind the adapter seam; side-by-side noon/dusk/night captures judged
same-or-better; the dashboard-exit teardown test passes with zero
residual cost; the budgets in §5 hold. Until every section lands, Atelier
keeps three.js as the default backend and this document is the gap list.

## MVP status (atelier-rvs, 2026-08-03)

The renderer-factory/engine-registry seam landed
(`themes/cozy-village/world/engine.mjs`), plus a first Moss-backed world
(`themes/cozy-village/world/engines/moss-world.mjs`) behind `?engine=moss` /
`context.engine === "moss"`. Default stays `three`, unchanged, byte-identical.
This is the §7.1 structural-parity floor, not the §7.2 upgrade gate. Gaps
below are either the vendored preview build's own limits (Group A — an API
gap, not a choice) or this MVP's scope cut for time (Group B — buildable
against the current API, deferred to the next iteration).

**Group A — the vendored `@moss/web-renderer` 0.1.0 preview build itself
fails these closed** (see `themes/cozy-village/vendor/moss-web-renderer/VENDOR.md`
and that package's own README):
- Shadows: a visible, positive-intensity `castShadow:true` light rejects
  `required-feature-missing` on Balanced/Fidelity. This theme now passes
  `castShadow:false` on every light, everywhere.
- A non-null `skyGradientTexture` and `gi.enabled:true` both reject
  `required-feature-missing` — no sky-sphere texture, no GI. The sky is a flat
  `background` color instead (see §3's "better opportunities" — none of them
  are available in this build).
- Bloom is accepted on every tier but has no visible effect outside
  Balanced/Fidelity, and isn't wired up in this MVP at all
  (`bloom.enabled` is never set to `true`).
- **`toneMapped:false` fails frame submission with `required-feature-missing`
  for any visible material.** This was not in the original mapping table —
  the three.js sign material relies on `toneMapped:false` so painted
  lettering doesn't wash out under the tone-mapping curve. The Moss sign
  material omits it; sign readability holds, color fidelity of the signboard
  is a known minor gap.

**Group B — MVP scope cut, buildable against the current API, not attempted
yet**: paths, garden fences/flowers, ground hills, villager figures and their
carried parcels, ambient decoration (trees, fireflies, birds, chimney smoke),
practical-lamp point lights, the three decision status lamps, and each
station's decorative extras beyond its main massing + one sign (workshop hut
sub-signs, granary barrels/banner, the hall dock's scaffold, R&D's
telescope/scroll/globe props). All seven stations' core walls/roof/windows
and one readable sign per station ARE built, camera + orbit/zoom + framing +
day-night light direction + picking all work.

Not measured against this doc's §5 payload budget (~15MB compressed): the
vendored `moss_shell_web_bg.wasm` is ~18.2MiB uncompressed on disk.
