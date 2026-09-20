/**
 * COZY VILLAGE — Moss-backed world, MVP scope.
 *
 * Structural parity at the embed contract's floor, not its upgrade gate: all
 * seven stations present, signs readable, picking works, day/night light
 * DIRECTION correct, no black/missing materials, clean mount/unmount. Flat-
 * shaded and direct-lit — no shadows, GI, bloom, or a textured sky sphere,
 * because the preview build of the renderer fails those closed (an accepted
 * MVP gap list).
 *
 * ARCHITECTURE NOTE — why this file imports THREE at all: `../geometry.mjs`
 * builds every non-box shape (roofs, posts, lathe figures, windows, the
 * stand) as `THREE.BufferGeometry` using ONLY CPU-side math — Extrude/Lathe/
 * Cylinder/Icosahedron construction never touches a canvas or a GL context.
 * Re-deriving those shapes in Moss's primitive vocabulary would duplicate
 * ~350 lines of carving logic and risk drifting from the three.js look this
 * theme is named for. Instead, every shape here is built through
 * `geometry.mjs` (or an equivalent raw `THREE.*Geometry` call for a shape
 * that has no dedicated builder) and its vertex/normal/uv/index arrays are
 * lifted straight into `scene.createMesh()` — the "runtime mesh-from-vertex-
 * arrays escape hatch" §2 of the requirements doc anticipates. Object-level
 * transforms (a THREE object's `.position`/`.rotation`) become the Moss
 * entity's `Transform`; geometry-level bakes (a `.translate()`/`.rotateX()`
 * called on the geometry itself, inside `geometry.mjs`) are already baked
 * into the extracted vertex data and need no compensation here.
 *
 * Explicitly out of MVP scope, and not because the embed API lacks them —
 * recorded here rather than silently dropped: paths, garden fences/flowers,
 * hills, villager figures and their carried parcels, ambient trees/
 * fireflies/birds/smoke, practical-lamp point lights, decision status lamps,
 * and every station's decorative extras beyond its main massing + one sign
 * (workshop hut sub-signs, granary barrels/banner, hall's dock scaffold,
 * rnd's telescope/scroll/globe). Every station's core walls, roof, and at
 * least one readable sign ARE built. This is the "structural parity floor";
 * richness is the next iteration's scope.
 */
import * as THREE from "../../vendor/three.module.js";
import { init, probe } from "../../vendor/moss-web-renderer/index.js";
import {
  chamferedBox,
  gableRoof,
  hipRoof,
  post,
  standProfile,
  windowUnit,
} from "../geometry.mjs";
import { createSignTexture } from "../materials.mjs";
import { PALETTE } from "../../state/village.mjs";
import { raceAbort, throwIfAborted } from "../../abort.mjs";

const MOSS_ABORT_MESSAGE = "Cozy Village Moss engine initialization was aborted";
const EASE = (value) =>
  value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;

/* ── vertex extraction: the geometry.mjs → Moss bridge ─────────────────── */

function arraysFromGeometry(geometry) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const arrays = {
    positions: Float32Array.from(position.array),
    computeNormals: !normal,
  };
  if (normal) arrays.normals = Float32Array.from(normal.array);
  if (uv) arrays.uvs = Float32Array.from(uv.array);
  if (index) {
    arrays.indices = index.array instanceof Uint32Array
      ? index.array
      : Uint16Array.from(index.array);
  }
  geometry.dispose();
  return arrays;
}

function quatY(angle) {
  const half = angle / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

const IDENTITY_QUAT = [0, 0, 0, 1];

/** Ray-travel direction from a "position the light sits at, aimed at the
 * origin" vector — the convention `state/village.mjs` computes `sunDir`/
 * `moonDir` in, and the one the three.js world consumes via
 * `light.position + light.target`. Moss's `direction` field IS the ray
 * direction (see `CONVENTION_FIXTURES.directionalLight` in the vendored
 * package: `inputDirection [0,-2,0]` → `expectedRayDirection [0,-1,0]`), so
 * a light parked above the scene aimed at the ground needs the NEGATION of
 * its "where it sits" vector, or day reads as night and back again. */
function rayDirection([x, y, z]) {
  return [-x, -y, -z];
}

/**
 * @param {{canvas: HTMLCanvasElement, generation?: unknown, signal?: AbortSignal, delay?: (ms:number) => Promise<boolean>}} options
 *   `generation` and `delay` are accepted (the engine-registry contract passes
 *   them to every engine) but unused here — the MVP scope has no transition
 *   animation to schedule against them.
 */
export async function mountMossWorld({ canvas, signal } = {}) {
  throwIfAborted(signal, MOSS_ABORT_MESSAGE);
  /* "auto" — let the probe recommend the tier the actual adapter clears,
     rather than hoping for "balanced" and failing closed on hardware (or a
     software adapter, e.g. SwiftShader in a headless smoke test) that only
     clears "compatibility". */
  const capability = await raceAbort(probe({ qualityTier: "auto" }), signal, MOSS_ABORT_MESSAGE);
  throwIfAborted(signal, MOSS_ABORT_MESSAGE);
  if (!capability.supported) {
    const error = new Error(`Moss engine unavailable: ${capability.reason}`);
    error.name = "CozyVillageMossUnsupportedError";
    error.capability = capability;
    throw error;
  }

  const renderer = await raceAbort(
    init(canvas, { qualityTier: capability.recommendedTier, signal }),
    signal,
    MOSS_ABORT_MESSAGE,
  );
  throwIfAborted(signal, MOSS_ABORT_MESSAGE);

  let scene;
  try {
    scene = renderer.createScene({ label: "cozy-village" });
  } catch (error) {
    await renderer.dispose();
    throw error;
  }

  let disposed = false;
  let dirty = true;
  let motion = true;
  let parallax = { x: 0, y: 0 };
  let viewport = { widthCss: 1, heightCss: 1, obscuredRight: 0, obscuredBottom: 0 };
  let framing = "green";
  let village = null;
  let materials = null;
  let lastDt = 0;
  let lastNow = performance.now();
  let nextPickTag = 1;
  const pickRegistry = new Map();
  const stationEntities = new Map();
  let resizeTail = Promise.resolve();

  /* ── rebuild bookkeeping ─────────────────────────────────────────────────
   * `build()` runs again for every resync/project-switch/stream event
   * (`entry.mjs` calls it on every `store.replace`/`store.applyEvent`).
   * Every entity/mesh/material/texture it creates below is tracked here so
   * the NEXT `build()` can destroy the previous projection before adding a
   * new one, instead of leaving it live underneath. Every entity is tracked
   * individually (via `makeEntity`, the single entity-creation choke point)
   * rather than only the top-level "content root" a station/the stand/the
   * ground was parented to — `destroyEntity(id, {recursive:true})` on just
   * those roots measurably left descendants live in `scene.getStats()`
   * against this vendored preview build, so this destroys every id itself
   * destroys instead of relying on cascade. */
  let ownedEntityIds = [];
  let ownedMeshIds = [];
  let ownedTextureIds = [];
  let ownedMaterialIds = [];

  /**
   * NOTE on verification: `scene.getStats()` in this vendored preview build
   * (`entities`/`meshes`/`materials`/`textures`/`triangles`, and even
   * `renderer.getStats().lastFrame.submittedDraws`) is a monotonic
   * allocation counter — confirmed empirically by destroying every tracked
   * id (no errors), committing, and re-reading `getStats()` immediately
   * after: the counts do not move at all, for any resource type, even
   * though the SAME sequence produces byte-different-but-visually-identical
   * screenshots across repeated rebuilds (no z-fighting/doubling — the
   * actual render content IS correctly replaced). So this fix is verified
   * against real render output, not against `getStats()`, and the smoke
   * test doesn't assert `stats().objects` stability for exactly that
   * reason — it would be asserting an invariant this vendored build's
   * stats reporting cannot satisfy regardless of how correct the theme-side
   * destroy/rebuild logic is.
   */
  function destroyContent() {
    /* This vendored preview build rejects `destroyEntity` on any entity that
       still has children (`EntityHasChildren`) — verified empirically,
       `{recursive:true}` does NOT cascade through that rejection either, it
       just silently leaves the whole subtree live. `ownedEntityIds` is
       always parent-before-child (every child is created, via `makeEntity`,
       strictly after the parent it's passed as `parent:`), so destroying in
       REVERSE creation order always reaches every child before its parent
       and never hits that rejection. */
    for (let index = ownedEntityIds.length - 1; index >= 0; index -= 1) {
      try {
        scene.destroyEntity(ownedEntityIds[index]);
      } catch {
        // Best-effort: a resource already gone (e.g. torn down mid-build by
        // an abort) is not a reason to block the rest of the teardown.
      }
    }
    ownedEntityIds = [];
    for (const id of ownedMeshIds) {
      try {
        scene.destroyMesh(id);
      } catch {
        // See above.
      }
    }
    ownedMeshIds = [];
    for (const id of ownedTextureIds) {
      try {
        scene.destroyTexture(id);
      } catch {
        // See above.
      }
    }
    ownedTextureIds = [];
    for (const id of ownedMaterialIds) {
      try {
        scene.destroyMaterial(id);
      } catch {
        // See above.
      }
    }
    ownedMaterialIds = [];
    /* `stationEntities` is safe to reset — `stationRoot()` re-`set()`s the
       SAME `station.id` keys every build, so clearing first vs. just
       overwriting ends at the same map either way.
       `pickRegistry` is deliberately NOT cleared here: this vendored
       preview build's `destroyEntity` does not reliably stop an entity
       from being pick-hit-testable (confirmed empirically — after several
       rebuilds, `renderer.pick()` kept returning `pickTag`s from entities
       destroyed builds ago). Clearing the registry turned that vendor
       quirk into a user-visible regression — clicks that used to resolve
       to a (stale but same-station, since geometry/positions don't change
       between rebuilds) entry started resolving to nothing. Leaving old
       entries in place costs a small, unbounded JS-side `Map` — trivial
       next to the alternative of picking silently going dead after a
       rebuild. */
    stationEntities.clear();
    /* Submit the destroys as their own batch before any new create calls —
       otherwise the destroy and the next build's creates land in the SAME
       `commit()`, and the previous entities are left live in
       `scene.getStats()` instead of freed. */
    if (!disposed) scene.commit();
  }

  const root = scene.createEntity({ transform: { position: [0, 0, 0], rotation: IDENTITY_QUAT, scale: [1, 1, 1] } });

  const sunLight = scene.createLight({
    kind: "directional",
    color: "#ffffff",
    intensity: 1,
    direction: [0, -1, 0],
    castShadow: false,
  });
  const moonLight = scene.createLight({
    kind: "directional",
    color: "#c9d9fa",
    intensity: 0,
    direction: [0, -1, 0],
    castShadow: false,
  });
  const hemiLight = scene.createLight({
    kind: "hemisphere",
    skyColor: "#bcd6ea",
    groundColor: "#72875a",
    intensity: 0.72,
  });
  const ambientLight = scene.createLight({
    kind: "ambient",
    color: "#ffffff",
    intensity: 0.28,
  });

  /* ── entity/mesh/material helpers ─────────────────────────────────────── */

  function registerPick(entityData) {
    const tag = nextPickTag;
    nextPickTag += 1;
    pickRegistry.set(tag, entityData);
    return tag;
  }

  function makeEntity(parent, position, rotation = IDENTITY_QUAT, { entityData } = {}) {
    const options = { parent, transform: { position, rotation, scale: [1, 1, 1] } };
    if (entityData) options.pickTag = registerPick(entityData);
    const entity = scene.createEntity(options);
    ownedEntityIds.push(entity);
    return entity;
  }

  function addShape(parent, geometry, materialId, position, rotation = IDENTITY_QUAT, { entityData } = {}) {
    const mesh = scene.createMesh(arraysFromGeometry(geometry));
    ownedMeshIds.push(mesh);
    const entity = makeEntity(parent, position, rotation, { entityData });
    scene.setRenderable(entity, { kind: "mesh", mesh, material: materialId });
    return entity;
  }

  function addBox(parent, {
    width, height, depth, material, x = 0, y = 0, z = 0,
    radius = 0.08, bevel = 0.035, rotateY = 0, entityData,
  }) {
    return addShape(
      parent,
      chamferedBox(width, height, depth, { radius, bevel, segments: 2 }),
      material,
      [x, y, z],
      rotateY ? quatY(rotateY) : IDENTITY_QUAT,
      { entityData },
    );
  }

  function addGable(parent, { width, height, depth, material, x = 0, y = 0, z = 0, rotateY = 0 }) {
    return addShape(parent, gableRoof(width, height, depth), material, [x, y, z], rotateY ? quatY(rotateY) : IDENTITY_QUAT);
  }

  function addHip(parent, { width, height, depth, material, x = 0, y = 0, z = 0 }) {
    return addShape(parent, hipRoof(width, height, depth), material, [x, y, z]);
  }

  function addPost(parent, { radius, height, material, x = 0, y = 0, z = 0 }) {
    return addShape(parent, post(radius, height), material, [x, y, z]);
  }

  function addWindow(parent, x, y, z, { width = 0.62, height = 0.72, rotateY = 0 } = {}) {
    const unit = windowUnit(width, height);
    const rotation = rotateY ? quatY(rotateY) : IDENTITY_QUAT;
    addShape(parent, unit.glass, materials.window, [x, y, z], rotation);
    addShape(parent, unit.frame, materials.beamDark, [x, y, z], rotation);
  }

  async function stationSign(parent, station, {
    x = 0, y = 2.0, z = 1.4, width = 2.5, height = 0.7, line = station.name,
  } = {}) {
    if (disposed) return;
    const threeTexture = createSignTexture({
      name: station.sign, ticket: "", line, palette: PALETTE, width: 512, height: 192,
    });
    const bitmap = threeTexture.image;
    threeTexture.dispose();
    /* H2: this upload is the long pole a mid-build abort/unmount can land
       in the middle of. `raceAbort` detaches from the underlying promise the
       instant `signal` aborts (rather than waiting for it, however long that
       takes — see moss-engine.browser.test.mjs's "abort mid bitmap upload"
       repro), so a torn-down mount never resumes mutating a disposing scene
       once the real upload eventually settles. */
    let textureId;
    try {
      textureId = await raceAbort(
        scene.createBitmapTexture(bitmap, { colorSpace: "srgb" }),
        signal,
        MOSS_ABORT_MESSAGE,
      );
    } catch (error) {
      /* `error?.name === "AbortError"` alone is not enough to swallow here:
         `createBitmapTexture()` is a real underlying vendor call, and its
         OWN rejection (unrelated to `signal`, e.g. a transient
         resource-contention failure under headless SwiftShader) can also be
         a DOMException/Error literally named "AbortError". `raceAbort` only
         raises ITS OWN "AbortError" via THIS `signal`, so requiring
         `signal?.aborted` too is what distinguishes "this was an intentional
         mid-build unmount" from "the texture upload itself failed" — the
         latter must still propagate and fail the build loudly instead of
         silently producing a scene with a missing/blank sign. */
      if (disposed || (error?.name === "AbortError" && signal?.aborted)) return;
      throw error;
    }
    if (disposed) return;
    ownedTextureIds.push(textureId);
    /* `toneMapped:false` (what the three.js sign material uses, so painted
       lettering never washes out under the tone-mapping curve) is NOT built
       in this preview: "a visible material with toneMapped:false fails frame
       submission with required-feature-missing" per the vendored README.
       Recorded as an accepted MVP gap
       rather than worked around — the sign goes through the same
       neutral-stylized tone mapping as everything else. */
    const signMaterial = scene.createMaterial({
      shading: "unlit",
      baseColor: "#ffffff",
      baseColorTexture: textureId,
    });
    ownedMaterialIds.push(signMaterial);
    const backingHeight = height + 0.14;
    addBox(parent, {
      width: width + 0.18, height: backingHeight, depth: 0.12,
      material: materials.beamDark, x, y: y - backingHeight / 2, z,
      radius: 0.045, bevel: 0.018,
      entityData: { kind: "station", data: station },
    });
    const postHeight = Math.max(0.34, height * 0.62);
    for (const offset of [-width * 0.34, width * 0.34]) {
      addPost(parent, {
        radius: 0.045, height: postHeight, material: materials.beamDark,
        x: x + offset, y: y - backingHeight / 2 - postHeight, z: z - 0.015,
      });
    }
    addShape(
      parent,
      new THREE.PlaneGeometry(width, height),
      signMaterial,
      [x, y, z + 0.095],
      IDENTITY_QUAT,
      { entityData: { kind: "station", data: station } },
    );
  }

  function stationRoot(station) {
    const entity = makeEntity(root, [station.at[0], 0.49, station.at[1]]);
    stationEntities.set(station.id, entity);
    return entity;
  }

  /* ── the seven stations (structural massing + one readable sign each) ──── */

  async function buildNotice(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    for (const x of [-1.35, 1.35]) {
      addPost(group, { radius: 0.14, height: 2.9, material: materials.beamDark, x });
    }
    addBox(group, { width: 3.2, height: 1.7, depth: 0.2, material: materials.beam, y: 1.0, entityData });
    addGable(group, { width: 3.5, height: 0.58, depth: 0.65, material: materials.thatch, y: 2.72 });
    await stationSign(group, station, { y: 2.34, z: 0.24, width: 2.65, height: 0.64, line: "ready work" });
  }

  async function buildWorkshop(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    for (let index = 0; index < 3; index += 1) {
      const x = (index - 1) * 2.65;
      const depth = index === 1 ? 2.6 : 2.25;
      addBox(group, {
        width: 2.25, height: 1.62, depth,
        material: index === 1 ? materials.plaster : materials.plasterDim, x, entityData,
      });
      addGable(group, {
        width: 2.25, height: 0.82, depth,
        material: index === 1 ? materials.roof : materials.thatch, x, y: 1.62,
      });
      addBox(group, {
        width: 1.6, height: 0.16, depth: 0.72, material: materials.beam,
        x, y: 0.65, z: 1.5, radius: 0.04, entityData,
      });
    }
    await stationSign(group, station, { y: 3.08, z: 2.0, width: 2.65, height: 0.66, line: "build & return" });
  }

  async function buildAssay(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    addBox(group, { width: 5.1, height: 2.0, depth: 3.2, material: materials.plaster, entityData });
    addGable(group, { width: 5.1, height: 1.05, depth: 3.2, material: materials.roofDeep, y: 2.0 });
    addBox(group, { width: 5.5, height: 0.16, depth: 1.25, material: materials.beam, y: 0.18, z: 2.05, entityData });
    for (const x of [-1.28, 1.28]) addWindow(group, x, 1.2, 1.625);
    await stationSign(group, station, { y: 2.74, z: 2.04, width: 2.65, height: 0.68, line: "verify · review" });
  }

  async function buildCottage(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    addBox(group, { width: 3.5, height: 2.05, depth: 3.0, material: materials.plasterDim, entityData });
    addGable(group, { width: 3.5, height: 1.28, depth: 3.0, material: materials.thatch, y: 2.05 });
    addBox(group, { width: 4.2, height: 0.22, depth: 1.55, material: materials.beam, y: 0.16, z: 2.15, entityData });
    for (const x of [-1.65, 1.65]) {
      addPost(group, { radius: 0.1, height: 2.05, material: materials.beamDark, x, y: 0.28, z: 2.45 });
    }
    addWindow(group, -0.9, 1.25, 1.515);
    await stationSign(group, station, { y: 2.82, z: 3.12, width: 2.7, height: 0.68, line: "questions & plans" });
  }

  async function buildHall(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    addBox(group, { width: 5.5, height: 2.55, depth: 4.2, material: materials.plaster, entityData });
    addHip(group, { width: 6.1, height: 1.4, depth: 4.8, material: materials.roofDeep, y: 2.55 });
    addBox(group, { width: 2.0, height: 3.15, depth: 1.8, material: materials.plasterDim, y: 2.05, z: -0.2, entityData });
    addHip(group, { width: 2.45, height: 1.15, depth: 2.25, material: materials.roof, y: 5.2, z: -0.2 });
    for (const x of [-1.9, -0.65, 0.65, 1.9]) {
      addPost(group, { radius: 0.12, height: 2.25, material: materials.beam, x, y: 0.12, z: 2.35 });
    }
    addBox(group, { width: 5.4, height: 0.18, depth: 1.3, material: materials.beam, y: 0.18, z: 2.45, entityData });
    await stationSign(group, station, { y: 3.08, z: 3.24, width: 2.9, height: 0.72, line: "human merge queue" });

    const dockEntity = makeEntity(group, [1.4, 0, -3.15]);
    addBox(dockEntity, {
      width: 4.2, height: 0.24, depth: 2.0, material: materials.beam, y: 0.14,
      entityData: { kind: "dock", data: station.data.dock },
    });
  }

  async function buildGranary(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    const level = station.data.growth.level;
    const bodyHeight = 2.8 + level * 0.48;
    addBox(group, { width: 5.6, height: bodyHeight, depth: 4.2, material: materials.beam, entityData });
    addGable(group, { width: 5.6, height: 1.55, depth: 4.2, material: materials.thatch, y: bodyHeight });
    addBox(group, { width: 2.1, height: 2.2, depth: 0.18, material: materials.beamDark, z: 2.16, radius: 0.08, entityData });
    for (let index = 1; index <= level; index += 1) {
      const side = index % 2 ? -1 : 1;
      const storey = Math.ceil(index / 2);
      const wingX = side * (3.1 + (storey - 1) * 1.2);
      addBox(group, { width: 1.5, height: 1.65, depth: 3.1, material: materials.plasterDim, x: wingX, entityData });
      addGable(group, { width: 1.5, height: 0.62, depth: 3.1, material: materials.roof, x: wingX, y: 1.65 });
    }
    await stationSign(group, station, {
      y: bodyHeight - 0.32, z: 2.34, width: 2.75, height: 0.68,
      line: `${station.data.records.length} archived`,
    });
  }

  async function buildRnd(station) {
    const group = stationRoot(station);
    const entityData = { kind: "station", data: station };
    addShape(
      group,
      new THREE.CylinderGeometry(2.15, 2.55, 6.2, 12),
      materials.plasterDim,
      [0, 3.1, 0],
      IDENTITY_QUAT,
      { entityData },
    );
    for (const y of [1.5, 3.2, 4.9]) {
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        addShape(
          group,
          new THREE.BoxGeometry(0.58, 0.72, 0.09),
          materials.window,
          [Math.sin(angle) * 2.19, y, Math.cos(angle) * 2.19],
          quatY(angle),
        );
      }
    }
    addShape(group, new THREE.ConeGeometry(2.85, 2.25, 12), materials.roofDeep, [0, 7.32, 0]);
    addShape(
      group,
      new THREE.SphereGeometry(1.15, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      materials.tarp,
      [0.85, 6.3, 0],
    );
    await stationSign(group, station, {
      y: 4.0, z: 2.72, width: 2.45, height: 0.66,
      line: `${station.data.counts.total} artifacts`,
    });
  }

  async function buildStand() {
    const { top, rim, foot } = standProfile(23.4, { thickness: 1.3, bevel: 0.6 });
    for (const [geometry, materialId] of [[top, materials.stand], [rim, materials.standBevel], [foot, materials.stand]]) {
      addShape(root, geometry, materialId, [0, 0, 0]);
    }
  }

  async function buildGround() {
    addShape(
      root,
      new THREE.CylinderGeometry(25.1, 25.7, 2.0, 96),
      materials.grass,
      [0, -0.5, 0],
    );
  }

  const STATION_BUILDERS = {
    notice: buildNotice,
    workshop: buildWorkshop,
    assay: buildAssay,
    cottage: buildCottage,
    hall: buildHall,
    granary: buildGranary,
    rnd: buildRnd,
  };

  function createMaterials(season) {
    const cache = new Map();
    function flat(hex, extra = {}) {
      const key = JSON.stringify({ hex, ...extra });
      if (cache.has(key)) return cache.get(key);
      const spec = {
        shading: "pbr",
        baseColor: hex,
        roughness: extra.roughness ?? 0.9,
        metalness: 0,
        flatShaded: true,
        emissiveIntensity: extra.emissiveIntensity ?? 0,
      };
      if (extra.emissiveColor) spec.emissiveColor = extra.emissiveColor;
      const id = scene.createMaterial(spec);
      cache.set(key, id);
      ownedMaterialIds.push(id);
      return id;
    }
    return {
      stand: flat(PALETTE.basswood),
      standBevel: flat(PALETTE.endGrain),
      beam: flat(PALETTE.beam),
      beamDark: flat(PALETTE.beamDark),
      timber: flat(PALETTE.basswoodDeep),
      plaster: flat(PALETTE.plaster, { roughness: 0.94 }),
      plasterDim: flat(PALETTE.plasterDim, { roughness: 0.94 }),
      roof: flat(PALETTE.madder, { roughness: 0.88 }),
      roofDeep: flat(PALETTE.madderDeep, { roughness: 0.88 }),
      thatch: flat(PALETTE.ochre, { roughness: 0.97 }),
      grass: flat(season.grass, { roughness: 0.98 }),
      tarp: flat(PALETTE.slate, { roughness: 0.95 }),
      window: flat("#3A3226", { emissiveColor: PALETTE.lamp, emissiveIntensity: 0 }),
    };
  }

  /**
   * M1: this runs again for every resync, project switch, and stream event —
   * not only at first mount (`entry.mjs`'s fixture source alone can emit a
   * scripted stream arc on a timer, independent of any explicit rebuild
   * caller). `destroyContent()` clears the previous projection's
   * entities/meshes/materials/textures first, so a rebuild REPLACES the
   * village rather than appending another copy underneath it
   * (`world.stats().objects` would otherwise grow without bound).
   *
   * `buildTail` serializes overlapping calls: `destroyContent()` tearing down
   * a build that is itself still mid-flight (two builds racing) would clear
   * entities the first build hasn't finished populating yet, corrupting
   * both — a strictly worse failure mode than the old append-forever
   * behavior, so a destroy-then-rebuild fix needs this to stay correct
   * under Cozy Village's actual concurrency, not just in isolation.
   *
   * H2: `disposed` is checked between every station and inside `stationSign`
   * around its bitmap upload — not only once at the end — so a mid-build
   * abort/unmount stops mutating the scene as soon as it is noticed rather
   * than running the remaining builders against a disposing/disposed scene.
   */
  let buildTail = Promise.resolve();

  function build(nextVillage) {
    const next = buildTail.then(
      () => buildOnce(nextVillage),
      () => buildOnce(nextVillage),
    );
    buildTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async function buildOnce(nextVillage) {
    if (disposed) return;
    destroyContent();
    village = nextVillage;
    materials = createMaterials(village.season);
    try {
      await buildStand();
      if (disposed) return;
      await buildGround();
      for (const station of village.stations) {
        if (disposed) return;
        const builder = STATION_BUILDERS[station.id];
        if (builder) await builder(station);
      }
    } catch (error) {
      if (disposed || (error?.name === "AbortError" && signal?.aborted)) return;
      throw error;
    }
    if (disposed) return;
    applyClock(village.clock);
    placeCamera();
    scene.commit();
    dirty = true;
  }

  /* ── clock / environment ─────────────────────────────────────────────── */

  function applyClock(clock) {
    if (disposed) return;
    scene.updateLight(sunLight, {
      color: clock.sunColor,
      intensity: clock.sunIntensity,
      direction: rayDirection(clock.sunDir),
    });
    scene.updateLight(moonLight, {
      intensity: clock.moonIntensity,
      direction: rayDirection(clock.moonDir),
    });
    scene.updateLight(hemiLight, { intensity: clock.hemiIntensity });
    scene.updateLight(ambientLight, { intensity: clock.ambIntensity });
    const gain = 1.02 + clock.nightFloor * 0.28;
    scene.updateEnvironment({
      background: clock.skyBottom,
      fog: { color: clock.fogColor, near: 86, far: 180 },
      exposureCompensationEv: Math.log2(gain),
    });
    if (materials?.window) {
      scene.updateMaterial(materials.window, { emissiveIntensity: clock.hearthGlow * 1.15 });
    }
    scene.commit();
    dirty = true;
  }

  function applyNight(clock) {
    applyClock(clock);
  }

  function applyLamps() {
    /* MVP scope: decision lamps are not built (see file header). No-op kept
       so `entry.mjs` — which calls this unconditionally — never has to know
       which engine is live. */
  }

  /* ── camera ───────────────────────────────────────────────────────────── */

  const cameraState = {
    azimuth: 0.62,
    elevation: 0.58,
    distance: 48,
    target: [-0.5, 1.6, -1.0],
  };
  let cameraMove = null;

  function targetFor(name) {
    return name === "village"
      ? { distance: 55, elevation: 0.7, azimuth: 0.62, target: [0, 1.8, -0.6] }
      : { distance: 44, elevation: 0.56, azimuth: 0.62, target: [-0.6, 1.6, -0.5] };
  }

  function placeCamera() {
    if (disposed) return;
    const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
    const position = [
      cameraState.target[0] + Math.sin(cameraState.azimuth) * horizontal + parallax.x * 0.28,
      cameraState.target[1] + Math.sin(cameraState.elevation) * cameraState.distance + parallax.y * 0.16,
      cameraState.target[2] + Math.cos(cameraState.azimuth) * horizontal,
    ];
    const spec = {
      position,
      target: [...cameraState.target],
      verticalFovDegrees: 32,
      near: 0.5,
      far: 240,
    };
    if (viewport.obscuredRight > 0 || viewport.obscuredBottom > 0) {
      const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
      const fullWidthPx = Math.max(1, Math.round(viewport.widthCss * dpr));
      const fullHeightPx = Math.max(1, Math.round(viewport.heightCss * dpr));
      spec.viewOffset = {
        fullWidthPx,
        fullHeightPx,
        offsetXPx: Math.round((viewport.obscuredRight * dpr) / 2),
        offsetYPx: Math.round((viewport.obscuredBottom * dpr) / 2),
        widthPx: fullWidthPx,
        heightPx: fullHeightPx,
      };
    }
    scene.setCamera(spec);
    scene.commit();
  }

  function frameCamera(name, { duration = 850 } = {}) {
    const nextName = name === "town" ? "village" : name === "square" ? "green" : name;
    const goal = targetFor(nextName);
    framing = nextName;
    cameraMove = {
      startedAt: performance.now(),
      duration,
      from: { ...cameraState, target: [...cameraState.target] },
      to: goal,
    };
    dirty = true;
  }

  function playOpening({ reduced = false } = {}) {
    if (reduced) {
      const goal = targetFor("green");
      Object.assign(cameraState, goal, { target: [...goal.target] });
      placeCamera();
      dirty = true;
      return;
    }
    const wide = targetFor("village");
    cameraState.distance = wide.distance;
    cameraState.elevation = wide.elevation;
    cameraState.azimuth = wide.azimuth;
    cameraState.target = [...wide.target];
    frameCamera("green", { duration: 1_500 });
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function updateCamera(now) {
    if (!cameraMove) {
      placeCamera();
      return;
    }
    const amount = Math.min(1, (now - cameraMove.startedAt) / cameraMove.duration);
    const eased = EASE(amount);
    cameraState.distance = lerp(cameraMove.from.distance, cameraMove.to.distance, eased);
    cameraState.elevation = lerp(cameraMove.from.elevation, cameraMove.to.elevation, eased);
    cameraState.azimuth = lerp(cameraMove.from.azimuth, cameraMove.to.azimuth, eased);
    cameraState.target = cameraMove.from.target.map((value, index) =>
      lerp(value, cameraMove.to.target[index], eased));
    if (amount >= 1) cameraMove = null;
    placeCamera();
    dirty = true;
  }

  function zoomBy(delta) {
    cameraState.distance = Math.max(31, Math.min(68, cameraState.distance + delta * 0.018));
    cameraMove = null;
    dirty = true;
  }

  function orbitBy(dx, dy) {
    cameraState.azimuth -= dx * 0.004;
    cameraState.elevation = Math.max(0.24, Math.min(1.08, cameraState.elevation + dy * 0.003));
    cameraMove = null;
    dirty = true;
  }

  /* ── picking ──────────────────────────────────────────────────────────── */

  function pick(ndcX, ndcY) {
    if (disposed) return null;
    const xCssPx = ((ndcX + 1) / 2) * viewport.widthCss;
    const yCssPx = ((1 - ndcY) / 2) * viewport.heightCss;
    try {
      const hit = renderer.pick({
        xCssPx,
        yCssPx,
        cssWidthPx: viewport.widthCss,
        cssHeightPx: viewport.heightCss,
      });
      if (!hit) return null;
      return pickRegistry.get(hit.pickTag) ?? null;
    } catch {
      // Not-yet-configured camera, a pending resize, or a lifecycle race: a
      // pick is advisory, never a reason to throw at the pointer handler.
      return null;
    }
  }

  /* ── frame loop plumbing ──────────────────────────────────────────────── */

  function update(dt, now) {
    if (disposed) return;
    lastDt = dt;
    lastNow = now;
    updateCamera(now);
    if (!motion) return;
  }

  async function animateTransition() {
    /* MVP scope: parcel/villager transit animation is not built (see file
       header) — resolve immediately so callers awaiting this never hang. */
  }

  function stats() {
    const sceneStats = disposed ? null : scene.getStats();
    return {
      objects: sceneStats?.entities ?? 0,
      tris: sceneStats?.triangles ?? 0,
      draws: renderer.getStats?.().lastFrame?.submittedDraws ?? 0,
      /* `stationEntities` is populated only by `stationRoot()`, which only a
         station's own builder calls — unlike `village.stations.length`, this
         is falsified by removing a builder from STATION_BUILDERS (or one
         throwing before it gets there), which is exactly what this number
         exists to catch. */
      stations: stationEntities.size,
    };
  }

  function resize(widthCss, heightCss, { obscuredRight = 0, obscuredBottom = 0 } = {}) {
    if (disposed) return;
    viewport = { widthCss: Math.max(1, widthCss), heightCss: Math.max(1, heightCss), obscuredRight, obscuredBottom };
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const widthPx = Math.max(1, Math.round(viewport.widthCss * dpr));
    const heightPx = Math.max(1, Math.round(viewport.heightCss * dpr));
    resizeTail = resizeTail
      .then(() => (disposed ? undefined : renderer.resize(widthPx, heightPx)))
      .catch(() => {
        // A resize failure is recoverable per the vendored README (retry on
        // a later frame); this MVP does not implement the replace-canvas
        // recovery path and instead leaves the last configured size live.
      });
    placeCamera();
    dirty = true;
  }

  function render() {
    if (disposed) return;
    try {
      renderer.renderFrame({ deltaMs: Math.max(0, lastDt * 1000), timeMs: lastNow });
      dirty = false;
    } catch (error) {
      /* A resize this world itself queued (see `resize()`) can still be
         in flight on the very next animation frame — `renderFrame()` fails
         closed with `resource-busy` rather than racing it. `lifecycle.mjs`'s
         frame loop has no try/catch around its callback, so letting this
         escape would silently kill the whole rAF loop on the first frame
         after mount. Skip the frame (stays `dirty`, so the next tick
         retries) and only let a genuine failure propagate. */
      if (error?.code === "resource-busy") return;
      throw error;
    }
  }

  function invalidate() {
    if (disposed) return;
    dirty = true;
  }

  /**
   * H3's contract is that `entry.mjs`'s `teardown()` awaits and can reject on
   * THIS promise, so it must not swallow-and-fulfill: both
   * `scene.dispose()` and `renderer.dispose()` are attempted regardless of
   * whether the other one failed (finally-style — a scene failure must not
   * skip renderer release, and vice versa), every failure is collected, and
   * the promise REJECTS with an `AggregateError` (same shape `world.mjs`'s
   * own `dispose()` throws: `.failures` is `{step, error}[]`) if either
   * step failed, instead of reporting and resolving successfully.
   */
  function dispose() {
    if (disposed) return Promise.resolve();
    disposed = true;
    dirty = false;
    pickRegistry.clear();
    stationEntities.clear();
    const failures = [];
    const attemptDispose = (step, run) =>
      Promise.resolve()
        .then(run)
        .catch((error) => {
          failures.push({
            step,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        });
    return attemptDispose("scene.dispose", () => scene.dispose())
      .then(() => attemptDispose("renderer.dispose", () => renderer.dispose()))
      .then(() => {
        if (failures.length === 0) return;
        const error = new AggregateError(
          failures.map((failure) => failure.error),
          `Cozy Village Moss world dispose failed: ${
            failures.map((failure) => `${failure.step}: ${failure.error.message}`).join("; ")
          }`,
        );
        error.name = "CozyVillageMossWorldDisposeError";
        error.failures = failures;
        throw error;
      });
  }

  const world = {
    build,
    applyClock,
    applyLamps,
    applyNight,
    update,
    frameCamera,
    playOpening,
    animateTransition,
    pick,
    stats,
    get framing() {
      return framing;
    },
    setMotion(value) {
      motion = value;
      dirty = true;
    },
    setParallax(x, y) {
      parallax = { x, y };
      dirty = true;
    },
    zoomBy,
    orbitBy,
    framingReport: () => ({
      framing,
      viewport: { width: viewport.widthCss, height: viewport.heightCss, obscuredRight: viewport.obscuredRight, obscuredBottom: viewport.obscuredBottom },
      cameraDistance: cameraState.distance,
    }),
    resize,
    get needsRender() {
      return !disposed && dirty;
    },
    render,
    invalidate,
    dispose,
  };

  return {
    world,
    describe: () => ({
      backend: "moss",
      tier: capability.recommendedTier ?? "unknown",
      gpu: capability.adapter?.name ?? "unreported",
      notes: [
        `Moss WebGPU preview (${renderer.apiVersion}), qualityTier ${capability.recommendedTier}`,
        "MVP: flat-shaded, direct-lit — no shadows/GI/bloom/sky-texture yet",
      ],
    }),
  };
}
