/**
 * GEOMETRY — the vocabulary of a carved wooden toy.
 *
 * One rule governs every shape in this file: A WOODEN TOY HAS NO SHARP ARRIS.
 * Every edge that a knife or a lathe would have broken is chamfered here, and
 * that single constraint is most of the difference between "low-poly village"
 * (an asset pack) and "a thing someone made" (the direction's whole thesis).
 * Chamfers cost a bevel ring of triangles and buy the light something to catch
 * on, which is why the village reads as handled rather than extruded.
 *
 * Everything is built from three.js CORE primitives — Extrude, Lathe, Cylinder,
 * Box — because the vendored build is r170 core and `BufferGeometryUtils` (with
 * `mergeGeometries`) lives in examples/jsm, which is not vendored. Where merging
 * would have been the optimisation, InstancedMesh is used instead; see world.mjs.
 */

import * as THREE from "../vendor/three.module.js";

/** A rounded rectangle as a Shape, ready to extrude. */
export function roundedRectShape(width, depth, radius) {
  const w = width / 2;
  const d = depth / 2;
  const r = Math.min(radius, Math.min(w, d) * 0.9);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -d);
  shape.lineTo(w - r, -d);
  shape.quadraticCurveTo(w, -d, w, -d + r);
  shape.lineTo(w, d - r);
  shape.quadraticCurveTo(w, d, w - r, d);
  shape.lineTo(-w + r, d);
  shape.quadraticCurveTo(-w, d, -w, d - r);
  shape.lineTo(-w, -d + r);
  shape.quadraticCurveTo(-w, -d, -w + r, -d);
  return shape;
}

/**
 * A box with every edge broken, standing on the ground plane.
 * The workhorse: cottage bodies, beams, the notice board, crates.
 */
export function chamferedBox(width, height, depth, { radius = 0.06, bevel = 0.035, segments = 2 } = {}) {
  const shape = roundedRectShape(width, depth, radius);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, height - bevel * 2),
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: segments,
    curveSegments: 3,
  });
  // Extrude builds along +z; stand it up and sit it on y=0.
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, bevel, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * How far every roof in the village oversails its walls. The gable roof's own
 * default was 0.18; the extra 0.06 is what puts the eave line clear of the
 * window heads, so the shadow it throws lands on plaster instead of on the
 * frame it is supposed to shelter.
 */
export const EAVE_OVERHANG = 0.24;

/**
 * Concatenate non-indexed geometries that share an attribute set.
 *
 * `BufferGeometryUtils.mergeGeometries` lives in examples/jsm and is not
 * vendored (see the header). Everything built here comes out of
 * `ExtrudeGeometry`, which is non-indexed with the same three attributes, so
 * merging is a buffer concatenation and needs no dependency. It exists so a
 * window frame can be four real mitred members and still cost ONE draw call
 * instead of four — the carved look without the draw-call bill.
 */
export function mergeGeometry(...geometries) {
  const parts = geometries.filter(Boolean);
  if (parts.length === 1) return parts[0];
  const names = ["position", "normal", "uv"];
  const merged = new THREE.BufferGeometry();
  for (const name of names) {
    if (!parts[0].attributes[name]) continue;
    const itemSize = parts[0].attributes[name].itemSize;
    let total = 0;
    for (const g of parts) total += g.attributes[name].array.length;
    const array = new Float32Array(total);
    let at = 0;
    for (const g of parts) {
      array.set(g.attributes[name].array, at);
      at += g.attributes[name].array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  for (const g of parts) g.dispose();
  return merged;
}

/**
 * A WINDOW, as joinery rather than as a decal.
 *
 * At the village framing a window is four pixels and any of this is wasted; the
 * square framing puts you close enough to read a cottage wall, and a flat
 * lozenge sitting proud of the plaster was the thing that gave the buildings
 * away as boxes with stickers on. So: the glass sits BEHIND the wall face,
 * four mitred frame members stand around the opening, and a sill lip runs
 * along the bottom and catches the one hard shadow that says "this is a hole
 * in a wall, and the wall has thickness".
 *
 * Returned as two geometries because they take two materials — the glass is
 * the surface that comes up warm at dusk, and the frame must never light.
 *
 * @returns {{ glass: THREE.BufferGeometry, frame: THREE.BufferGeometry }}
 */
export function windowUnit(width, height, { inset = 0.02, member = 0.055, sill = 0.04 } = {}) {
  /* Every piece here is centred on the ORIGIN, unlike `chamferedBox`, which
     stands on y=0 because that is what a building body wants. A window is
     placed by its middle, so mixing the two conventions is how a sill ends up
     halfway up the glass. */
  const centred = (w, h, d, opts) => {
    const g = chamferedBox(w, h, d, opts);
    g.translate(0, -h / 2, 0);
    return g;
  };
  const at = (g, x, y, z = 0) => {
    g.translate(x, y, z);
    return g;
  };

  const w = width / 2;
  const h = height / 2;
  const cheek = 0.055;

  // The glass sits BEHIND the wall face. This is the whole point of the unit.
  const glass = at(centred(width, height, 0.06, { radius: 0.014, bevel: 0.009, segments: 1 }), 0, 0, -inset);

  const frame = mergeGeometry(
    // head and foot, running the full width of the opening plus both jambs
    at(centred(width + member * 2, member, cheek, { radius: 0.01, bevel: 0.007, segments: 1 }), 0, h + member / 2),
    at(centred(width + member * 2, member, cheek, { radius: 0.01, bevel: 0.007, segments: 1 }), 0, -h - member / 2),
    // the two jambs, between them
    at(centred(member, height, cheek, { radius: 0.01, bevel: 0.007, segments: 1 }), -w - member / 2, 0),
    at(centred(member, height, cheek, { radius: 0.01, bevel: 0.007, segments: 1 }), w + member / 2, 0),
    // the sill: wider than the frame and standing proud of it, so it throws a
    // hard line of shadow down the plaster
    at(
      centred(width + member * 4, sill, cheek + 0.05, { radius: 0.012, bevel: 0.009, segments: 1 }),
      0,
      -h - member - sill / 2,
      0.022,
    ),
  );
  frame.computeVertexNormals();
  glass.computeVertexNormals();
  return { glass, frame };
}

/**
 * The fascia boards under a gable roof's two eaves.
 *
 * A roof plane that ends in nothing reads as a folded sheet. A darker board
 * closing the eave gives the overhang an edge to cast from and a visible
 * thickness, which is the difference between a roof and a lid.
 */
export function eaveFascia(width, depth, { overhang = EAVE_OVERHANG, thickness = 0.07, drop = 0.11 } = {}) {
  const length = depth + overhang * 2;
  const board = (x) => {
    const g = chamferedBox(thickness, drop, length, { radius: 0.018, bevel: 0.012, segments: 1 });
    g.translate(x, -drop, 0);
    return g;
  };
  const x = width / 2 + overhang - thickness / 2;
  const geometry = mergeGeometry(board(-x), board(x));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A gable roof: a triangle extruded along the ridge, bevelled like everything
 * else. `overhang` lets the eaves cast the shadow that makes a building read
 * as sheltering rather than as a solid.
 */
export function gableRoof(width, height, depth, { overhang = EAVE_OVERHANG, bevel = 0.03 } = {}) {
  const w = width / 2 + overhang;
  const shape = new THREE.Shape();
  shape.moveTo(-w, 0);
  shape.lineTo(w, 0);
  shape.lineTo(0, height);
  shape.lineTo(-w, 0);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: depth + overhang * 2,
    bevelEnabled: true,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: 1,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -(depth + overhang * 2) / 2);
  geometry.computeVertexNormals();
  return geometry;
}

/** A hipped roof — four slopes to a ridge. The town hall and the tower cap. */
export function hipRoof(width, height, depth, { overhang = 0.2 } = {}) {
  const geometry = new THREE.CylinderGeometry(
    0.001,
    Math.max(width, depth) * 0.5 + overhang,
    height,
    4,
    1,
  );
  geometry.rotateY(Math.PI / 4);
  geometry.translate(0, height / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A TURNED PEG VILLAGER.
 *
 * A lathe profile, because that is literally how these figures would be made:
 * one pass of a chisel against spinning stock. The silhouette carries the
 * whole character — there are no faces in this village, and there is no
 * expression to misread as a status signal.
 */
export function pegFigure(height = 1, build = "square") {
  const waist = build === "small" ? 0.15 : build === "tall" ? 0.155 : 0.175;
  const shoulder = build === "small" ? 0.16 : build === "tall" ? 0.17 : 0.2;
  const points = [
    [0.0, 0.0],
    [0.2, 0.0],
    [0.21, 0.03],
    [0.19, 0.07], // the foot's rounded lip
    [waist + 0.02, 0.16],
    [waist, 0.34],
    [shoulder, 0.52],
    [shoulder * 0.94, 0.62], // shoulders
    [0.085, 0.66], // the neck's quick cut
    [0.105, 0.7],
    [0.13, 0.78],
    [0.125, 0.87],
    [0.085, 0.94],
    [0.0, 0.97], // a rounded crown
  ];
  const geometry = new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(x, y * height)),
    14,
  );
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * THE STAND — a turned basswood plinth whose bevel shows raw end-grain at the
 * world's edge. The one detail that says you are looking at an object.
 * Returned as two geometries so the bevel can take the end-grain material
 * while the top takes long-grain: that contrast is the whole trick.
 */
export function standProfile(radius, { thickness = 1.5, bevel = 0.62 } = {}) {
  const top = new THREE.CylinderGeometry(radius, radius, 0.32, 96, 1, false);
  top.translate(0, -0.16, 0);

  // The bevel: a cone frustum, cut so the grain runs across the cut.
  const rim = new THREE.CylinderGeometry(radius, radius - bevel, bevel * 1.05, 96, 1, true);
  rim.translate(0, -0.32 - (bevel * 1.05) / 2, 0);

  // The turned foot below, in three quick steps of the chisel.
  const foot = new THREE.LatheGeometry(
    [
      [radius - bevel, 0],
      [radius - bevel - 0.05, -0.22],
      [radius - bevel - 0.42, -0.34],
      [radius - bevel - 0.5, -0.62],
      [radius - bevel - 0.3, -0.78],
      [radius - bevel - 0.34, -thickness],
      [0, -thickness],
    ].map(([x, y]) => new THREE.Vector2(Math.max(0.001, x), y - 0.32 - bevel * 1.05)),
    96,
  );

  for (const g of [top, rim, foot]) g.computeVertexNormals();
  return { top, rim, foot };
}

/** A simple tapered post — fence rails, sign posts, scaffold poles, pegs. */
export function post(radius, height, { taper = 0.86, segments = 7 } = {}) {
  const geometry = new THREE.CylinderGeometry(radius * taper, radius, height, segments, 1);
  geometry.translate(0, height / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/** A lantern housing: a small tapered cage with a glass belly. */
export function lanternGlass(radius = 0.11, height = 0.26) {
  const geometry = new THREE.LatheGeometry(
    [
      [0.001, 0],
      [radius * 0.8, 0.02],
      [radius, height * 0.42],
      [radius * 0.86, height * 0.8],
      [radius * 0.4, height],
      [0.001, height],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
    10,
  );
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A TREE — a turned trunk and two or three stacked canopy lobes. Deliberately
 * toy-like: this village is carved, and a carved tree is a shape, not a
 * billboard of leaves.
 */
export function treeCanopy(radius, lobes = 3) {
  const group = [];
  for (let i = 0; i < lobes; i++) {
    const t = i / Math.max(1, lobes - 1);
    const r = radius * (1 - t * 0.42);
    const geometry = new THREE.IcosahedronGeometry(r, 1);
    // Squash each lobe slightly: a canopy is wider than it is tall.
    geometry.scale(1, 0.82, 1);
    geometry.translate(0, radius * 0.55 + t * radius * 0.78, 0);
    group.push(geometry);
  }
  return group;
}

/** The well's stone ring. */
export function wellRing(radius = 0.9, height = 0.46) {
  const geometry = new THREE.CylinderGeometry(radius, radius * 1.06, height, 16, 1, true);
  geometry.translate(0, height / 2, 0);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A sheet that hangs and sags a little — paper on the notice board, a tarp
 * over a collapsed frame, laundry on a line. The sag is what stops it reading
 * as a decal.
 */
export function saggingSheet(width, height, { sag = 0.08, segments = 6 } = {}) {
  const geometry = new THREE.PlaneGeometry(width, height, segments, segments);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const u = (x / width) * 2;
    const v = (y / height + 0.5);
    // Pinned at the top, free at the bottom: sag grows downward and inward.
    pos.setZ(i, -Math.cos(u * Math.PI * 0.5) * sag * (1 - v) - sag * 0.25 * (1 - v));
  }
  geometry.computeVertexNormals();
  return geometry;
}
