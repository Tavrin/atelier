/**
 * MATERIALS — milk paint on basswood, generated at runtime.
 *
 * The register of this world is a HAND-CARVED WOODEN TOY, not a level. That
 * distinction lives almost entirely in the surface: flat Lambert colour reads
 * as an asset pack, and paint with grain in it reads as an object somebody
 * made. So every material here is built from a procedural canvas — paint
 * streaks, wood grain, turned end-grain rings, thatch, cobble — and paired
 * with a roughness map cut from the same noise, so highlights break up the way
 * they do on a handled surface.
 *
 * Nothing is fetched. There are no image files in this theme: a canvas and a
 * value-noise function are the whole asset pipeline, which is what keeps the
 * theme droppable into a zero-dependency, no-network repo.
 *
 * Textures are built once and shared by the seven permanent stations. Agent
 * identity colors are used only for clothing and tools.
 */

import * as THREE from "../vendor/three.module.js";

/**
 * The theme's humanist stack, as a canvas `font` shorthand fragment. Kept
 * identical to `--cv-humanist` in theme.css — the vendored face first, the
 * old system faces behind it as the fallback they always should have been.
 */
export const HUMANIST =
  '"Ubuntu Sans derivative Cozy Village", Optima, Candara, "Gill Sans", "Trebuchet MS", sans-serif';

/* ── value noise ──────────────────────────────────────────────────────────*/

function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}

/** Fractal noise. `stretch` smears it along x, which is how grain works. */
function fbm(x, y, seed, octaves = 4, stretch = 1) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise((x * freq) / stretch, y * freq, seed + o * 101) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

/* ── canvas helpers ───────────────────────────────────────────────────────*/

function makeCanvas(size) {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(size, size)
      : Object.assign(document.createElement("canvas"), { width: size, height: size });
  return { canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }) };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Paint a texture pixel by pixel. `shade(x, y, u, v)` returns
 * `[r, g, b]` in 0-255. Returns the canvas, ready to wrap in a CanvasTexture.
 */
function paint(size, shade) {
  const { canvas, ctx } = makeCanvas(size);
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = shade(x, y, x / size, y / size);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function texture(canvas, { srgb = true, repeat = 1, aniso = 4 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  // Colour maps are sRGB; roughness is data and must stay linear or the
  // whole village turns to plastic.
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return tex;
}

const shade = (rgb, k) => [
  Math.max(0, Math.min(255, rgb[0] * k)),
  Math.max(0, Math.min(255, rgb[1] * k)),
  Math.max(0, Math.min(255, rgb[2] * k)),
];

/* ── the generators ───────────────────────────────────────────────────────*/

/**
 * MILK PAINT. Thin, chalky, brushed in one direction, letting a little of the
 * wood beneath read through. The streaks are what stop a painted wall from
 * looking like a solid fill.
 */
function milkPaintCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  return paint(size, (x, y) => {
    const brush = fbm(x / 5, y / 44, seed, 4, 7); // long horizontal strokes
    const tooth = fbm(x / 2.2, y / 2.2, seed + 33, 3, 1); // canvas tooth
    const thin = Math.max(0, brush - 0.62) * 1.9; // where paint ran thin
    const k = 0.9 + brush * 0.2 + tooth * 0.08 - thin * 0.16;
    return shade(base, k);
  });
}

function milkPaintRoughness(size, seed) {
  return paint(size, (x, y) => {
    const brush = fbm(x / 5, y / 44, seed, 4, 7);
    const tooth = fbm(x / 2.2, y / 2.2, seed + 33, 3, 1);
    // Chalky and dry: high roughness, varying where the brush loaded up.
    const r = 0.74 + brush * 0.16 + tooth * 0.1;
    const v = Math.max(0, Math.min(255, r * 255));
    return [v, v, v];
  });
}

/** BASSWOOD, sawn along the grain: soft, pale, close-figured. */
function woodCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  return paint(size, (x, y) => {
    const grain = fbm(x / 3, y / 60, seed, 5, 12);
    // Hard latewood lines: a thresholded ridge, not a sine, so they wander.
    const line = Math.abs(Math.sin((y / size) * Math.PI * 26 + grain * 5.5));
    const k = 0.88 + grain * 0.22 - Math.pow(1 - line, 9) * 0.28;
    return shade(base, k);
  });
}

/**
 * TURNED END-GRAIN. The bevel at the world's edge shows the stand was cut from
 * a billet — concentric rings, not a texture wrapped round a cylinder. This is
 * the single detail that says "object someone made" rather than "level someone
 * rendered", so it gets its own generator.
 */
function endGrainCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  const cx = size / 2;
  const cy = size / 2;
  return paint(size, (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    const wobble = fbm(x / 18, y / 18, seed, 3, 1) * 6;
    const ring = Math.abs(Math.sin((r + wobble) * 0.42));
    const rays = fbm(Math.atan2(dy, dx) * 14, r / 30, seed + 7, 2, 1) * 0.12;
    const k = 0.86 + rays + Math.pow(ring, 2.6) * 0.3;
    return shade(base, k);
  });
}

/** CLAY ROOF TILE / SHINGLE: overlapping courses, each one slightly its own. */
function shingleCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  const courses = 9;
  const perCourse = size / courses;
  return paint(size, (x, y) => {
    const row = Math.floor(y / perCourse);
    const inRow = (y % perCourse) / perCourse;
    // Every other course is offset half a tile, like real coursing.
    const offset = row % 2 ? 0.5 : 0;
    const col = Math.floor(x / perCourse + offset);
    const tint = hash2(col, row, seed) * 0.22 - 0.09; // each tile its own firing
    const weather = fbm(x / 9, y / 9, seed + 5, 3, 1) * 0.16;
    // A dark line where the course above overlaps, and a lit lower lip.
    const lip = inRow < 0.16 ? -0.3 * (1 - inRow / 0.16) : inRow > 0.86 ? 0.12 : 0;
    const seam = Math.abs(((x / perCourse + offset) % 1) - 0.5) > 0.47 ? -0.18 : 0;
    return shade(base, 0.92 + tint + weather + lip + seam);
  });
}

/** THATCH: combed straw, for the oldest cottages nearest the well. */
function thatchCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  return paint(size, (x, y) => {
    const straw = fbm(x / 1.6, y / 30, seed, 4, 16);
    const clump = fbm(x / 14, y / 20, seed + 3, 2, 1);
    const k = 0.78 + straw * 0.42 + clump * 0.16;
    return shade(base, k);
  });
}

/** COBBLE: rounded setts with mortar between, worn smooth where feet go. */
function cobbleCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  const cell = 22;
  return paint(size, (x, y) => {
    // Jittered lattice — cheap Worley without the full neighbour search.
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let best = 1e9;
    let bestId = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cxi = gx + ox;
        const cyi = gy + oy;
        const px = (cxi + 0.25 + hash2(cxi, cyi, seed) * 0.5) * cell;
        const py = (cyi + 0.25 + hash2(cxi, cyi, seed + 1) * 0.5) * cell;
        const d = Math.hypot(x - px, y - py);
        if (d < best) {
          best = d;
          bestId = hash2(cxi, cyi, seed + 2);
        }
      }
    }
    const mortar = Math.min(1, best / (cell * 0.46));
    const dome = 1 - Math.pow(mortar, 2.2) * 0.5; // each sett crowns slightly
    const stone = 0.82 + bestId * 0.3;
    const grit = fbm(x / 3, y / 3, seed + 9, 3, 1) * 0.12;
    return shade(base, stone * dome + grit - (mortar > 0.93 ? 0.24 : 0));
  });
}

/** GRASS: seasonal, mown in soft drifts rather than tufted noise. */
function grassCanvas(hex, deepHex, size, seed) {
  const base = hexToRgb(hex);
  const deep = hexToRgb(deepHex);
  return paint(size, (x, y) => {
    const drift = fbm(x / 26, y / 26, seed, 4, 1);
    const blades = fbm(x / 2, y / 3.5, seed + 4, 3, 1);
    const t = Math.max(0, Math.min(1, drift * 1.25 - 0.12));
    const mix = [base[0] + (deep[0] - base[0]) * t, base[1] + (deep[1] - base[1]) * t, base[2] + (deep[2] - base[2]) * t];
    return shade(mix, 0.9 + blades * 0.2);
  });
}

/** PLASTER: lime render over lath, trowelled and a little uneven. */
function plasterCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  return paint(size, (x, y) => {
    const trowel = fbm(x / 12, y / 12, seed, 4, 2);
    const pit = fbm(x / 1.8, y / 1.8, seed + 21, 2, 1);
    return shade(base, 0.9 + trowel * 0.18 + pit * 0.07);
  });
}

/** CANVAS TARP — what failure looks like. Muted, sagging, entirely unalarming. */
function tarpCanvas(hex, size, seed) {
  const base = hexToRgb(hex);
  return paint(size, (x, y) => {
    const weave =
      (Math.sin((x / size) * Math.PI * 128) > 0 ? 0.04 : -0.04) +
      (Math.sin((y / size) * Math.PI * 128) > 0 ? 0.04 : -0.04);
    const stain = fbm(x / 20, y / 20, seed, 3, 1) * 0.18;
    return shade(base, 0.9 + weave + stain);
  });
}

/* ── the library ──────────────────────────────────────────────────────────*/

/**
 * Build every material the village needs, once.
 *
 * @param {object} options
 *   palette   the milk-paint palette from state/village.mjs
 *   season    the seasonal colours (grass, canopy, litter)
 *   tier      "low" | "high" — halves texture resolution on integrated GPUs
 *   aniso     max anisotropy from the renderer
 */
export function createMaterialLibrary({ palette, season, tier = "high", aniso = 4 } = {}) {
  const S = tier === "low" ? 128 : 256;
  const BIG = tier === "low" ? 256 : 512;
  const disposables = [];

  const keep = (tex) => {
    disposables.push(tex);
    return tex;
  };

  /* Shared roughness for every painted surface: one map, six materials. */
  const paintRough = keep(texture(milkPaintRoughness(S, 91), { srgb: false, repeat: 1, aniso }));

  const paintCache = new Map();
  /**
   * A painted material for an identity colour. Cached by hex, so the six
   * villagers produce six clothing materials no matter how many are present.
   */
  function paintMaterial(hex, { repeat = 1, seed = 17 } = {}) {
    const key = `${hex}:${repeat}`;
    if (paintCache.has(key)) return paintCache.get(key);
    const map = keep(texture(milkPaintCanvas(hex, S, seed), { repeat, aniso }));
    const material = new THREE.MeshStandardMaterial({
      map,
      roughnessMap: paintRough,
      roughness: 0.92,
      metalness: 0,
    });
    paintCache.set(key, material);
    disposables.push(material);
    return material;
  }

  const woodRough = keep(texture(milkPaintRoughness(S, 44), { srgb: false, aniso }));

  function standard(map, extra = {}) {
    const material = new THREE.MeshStandardMaterial({
      map: keep(map),
      roughnessMap: woodRough,
      roughness: 0.86,
      metalness: 0,
      ...extra,
    });
    disposables.push(material);
    return material;
  }

  const library = {
    paintMaterial,

    /* The stand and its bevel — the thesis detail. */
    stand: standard(texture(woodCanvas(palette.basswood, BIG, 3), { repeat: 3, aniso }), { roughness: 0.78 }),
    standBevel: standard(texture(endGrainCanvas(palette.endGrain, BIG, 11), { repeat: 1, aniso }), {
      roughness: 0.7,
    }),

    /* Structure. */
    beam: standard(texture(woodCanvas(palette.beam, S, 7), { repeat: 2, aniso })),
    beamDark: standard(texture(woodCanvas(palette.beamDark, S, 23), { repeat: 2, aniso })),
    timber: standard(texture(woodCanvas(palette.basswoodDeep, S, 29), { repeat: 1, aniso })),
    plaster: standard(texture(plasterCanvas(palette.plaster, S, 13), { repeat: 1, aniso }), { roughness: 0.94 }),
    plasterDim: standard(texture(plasterCanvas(palette.plasterDim, S, 19), { repeat: 1, aniso }), {
      roughness: 0.94,
    }),

    /* Roofs. Madder for formal landmarks, thatch for the workshop huts. */
    roof: standard(texture(shingleCanvas(palette.madder, BIG, 5), { repeat: 1, aniso }), { roughness: 0.88 }),
    roofDeep: standard(texture(shingleCanvas(palette.madderDeep, BIG, 15), { repeat: 1, aniso }), {
      roughness: 0.88,
    }),
    thatch: standard(texture(thatchCanvas(palette.ochre, BIG, 31), { repeat: 1, aniso }), { roughness: 0.97 }),

    /* Ground. */
    cobble: standard(texture(cobbleCanvas(palette.cobble, BIG, 2), { repeat: 4, aniso }), { roughness: 0.9 }),
    cobbleDeep: standard(texture(cobbleCanvas(palette.cobbleDeep, BIG, 18), { repeat: 4, aniso }), {
      roughness: 0.92,
    }),
    grass: standard(texture(grassCanvas(season.grass, season.grassDeep, BIG, 8), { repeat: 9, aniso }), {
      roughness: 0.98,
    }),

    /* Failure is a canvas tarp, not an alarm. */
    tarp: standard(texture(tarpCanvas(palette.slate, S, 37), { repeat: 1, aniso }), { roughness: 0.95 }),

    /* Flat colours, for the small things that would gain nothing from grain. */
    flat: (hex, extra = {}) => {
      const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.9, metalness: 0, ...extra });
      disposables.push(material);
      return material;
    },

    /**
     * LAMP GOLD. Nothing else in this world is allowed to use it. Emissive so
     * it survives every hour of the clock unchanged — a decision lamp must
     * look identical at midday and midnight, which is the whole Lamp Law.
     */
    lamp: (() => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(palette.lampCore),
        emissive: new THREE.Color(palette.lamp),
        emissiveIntensity: 1,
        roughness: 0.5,
        metalness: 0,
      });
      disposables.push(material);
      return material;
    })(),

    /** An unlit lamp: the same glass, cold. */
    lampDark: (() => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#8C8579"),
        emissive: new THREE.Color("#000000"),
        roughness: 0.55,
        metalness: 0,
      });
      disposables.push(material);
      return material;
    })(),

    /** Window glass, warmed only by the hour. Ambience, never signal. */
    window: (() => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#3A3226"),
        emissive: new THREE.Color(palette.lamp),
        emissiveIntensity: 0,
        roughness: 0.4,
        metalness: 0,
      });
      disposables.push(material);
      return material;
    })(),

    /**
     * Clock-driven practical glass. Its apricot is deliberately distinct from
     * decision-lamp gold, and its intensity is changed only by applyClock().
     */
    practical: (() => {
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color("#6F5541"),
        emissive: new THREE.Color("#FFAA68"),
        emissiveIntensity: 0,
        roughness: 0.42,
        metalness: 0,
      });
      disposables.push(material);
      return material;
    })(),

    dispose() {
      const failures = [];
      for (const item of disposables) {
        try {
          item.dispose?.();
        } catch (error) {
          failures.push({ step: "material.dispose", error });
        }
      }
      paintCache.clear();
      disposables.length = 0;
      if (failures.length > 0) {
        const error = new AggregateError(
          failures.map((failure) => failure.error),
          "Cozy Village material cleanup failed",
        );
        error.name = "CozyVillageResourceCleanupError";
        error.failures = failures;
        throw error;
      }
    },
  };

  return library;
}

/**
 * A soft radial sprite used for practical lamp glow.
 */
export function createGlowTexture(size = 128, softness = 2.4) {
  const { canvas, ctx } = makeCanvas(size);
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    gradient.addColorStop(t, `rgba(255,255,255,${Math.pow(1 - t, softness).toFixed(4)})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * HAND-LETTERED SIGNBOARDS. Canvas-drawn so the paint has grain and the
 * lettering reads as painted on rather than typeset over. Every sign in the
 * village carries the exact words the silhouette cannot.
 */
export function createSignTexture({ name, ticket, line, palette, width = 512, height = 192 }) {
  const { canvas, ctx } = makeCanvas(1);
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = palette.chalk;
  ctx.fillRect(0, 0, width, height);

  // Paint tooth, so the board is not a flat swatch.
  const image = ctx.getImageData(0, 0, width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const k = 0.9 + fbm(x / 3, y / 26, 61, 3, 8) * 0.2;
      image.data[i] *= k;
      image.data[i + 1] *= k;
      image.data[i + 2] *= k;
    }
  }
  ctx.putImageData(image, 0, 0);

  ctx.strokeStyle = palette.beamDark;
  ctx.lineWidth = 6;
  ctx.strokeRect(9, 9, width - 18, height - 18);

  ctx.textAlign = "center";
  ctx.fillStyle = palette.ink;
  /* The signboards are painted onto a canvas, so they need the same face the
     chrome uses spelled out again — a canvas has no cascade to inherit from.
     `HUMANIST` is exported so the one stack lives in one place; `entry.mjs`
     waits for it to load before the world is built, because a canvas silently
     falls back to whatever is ready at the moment `fillText` runs and would
     bake the wrong face into a texture that is never redrawn. */
  ctx.font = `650 ${Math.round(height * 0.34)}px ${HUMANIST}`;
  ctx.fillText(name, width / 2, height * 0.42);

  ctx.font = `${Math.round(height * 0.17)}px ui-monospace, "DejaVu Sans Mono", monospace`;
  ctx.fillStyle = palette.beamDark;
  ctx.fillText(ticket ?? "", width / 2, height * 0.63);

  ctx.font = `italic 550 ${Math.round(height * 0.19)}px ${HUMANIST}`;
  ctx.fillStyle = palette.beam;
  ctx.fillText(line ?? "", width / 2, height * 0.85);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
