/**
 * COZY VILLAGE — seven permanent stations rendered with three.js.
 *
 * No geometry is synthesized per merge. Records are parcels and villagers;
 * the only buildings are the seven functional stations in the state model.
 */

import * as THREE from "../vendor/three.module.js";
import {
  createGlowTexture,
  createMaterialLibrary,
  createSignTexture,
} from "./materials.mjs";
import {
  chamferedBox,
  gableRoof,
  hipRoof,
  lanternGlass,
  pegFigure,
  post,
  standProfile,
  treeCanopy,
  windowUnit,
} from "./geometry.mjs";
import { PALETTE, seeded } from "../state/village.mjs";
import {
  createOwnedGroupRegistry,
  disposeOwnedObject,
} from "./resources.mjs";

const EASE = (value) =>
  value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
export function createWorld({
  renderer,
  capabilities,
  palette = PALETTE,
  delay = (ms) => new Promise((resolve) => setTimeout(() => resolve(true), ms)),
} = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.5, 240);
  const tier = capabilities?.tier ?? "high";
  const detail = capabilities?.ambientDetail ?? 1;
  const aniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;
  const raycaster = new THREE.Raycaster();
  const pickables = [];
  const stationObjects = new Map();
  const roots = {
    stand: new THREE.Group(),
    ground: new THREE.Group(),
    paths: new THREE.Group(),
    stations: new THREE.Group(),
    figures: new THREE.Group(),
    ambient: new THREE.Group(),
    effects: new THREE.Group(),
  };
  for (const root of Object.values(roots)) scene.add(root);
  const transitionGroups = createOwnedGroupRegistry(roots.effects);

  let materials = null;
  let village = null;
  let dirty = true;
  let motion = true;
  let parallax = { x: 0, y: 0 };
  let viewport = { width: 1, height: 1, obscuredRight: 0, obscuredBottom: 0 };
  let framing = "green";
  let activityFigures = [];
  let smokePuffs = [];
  let fireflies = [];
  let birds = [];
  let transition = null;
  let signResources = [];
  let practicalLights = [];
  let statusLamps = [];
  let ambientResources = [];
  let disposed = false;
  let disposing = false;

  const skyCanvas = document.createElement("canvas");
  skyCanvas.width = 4;
  skyCanvas.height = 128;
  const skyContext = skyCanvas.getContext("2d");
  const skyTexture = new THREE.CanvasTexture(skyCanvas);
  skyTexture.colorSpace = THREE.SRGBColorSpace;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(120, 24, 16),
    new THREE.MeshBasicMaterial({
      map: skyTexture,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(
    capabilities?.shadowMapSize ?? 2048,
    capabilities?.shadowMapSize ?? 2048,
  );
  Object.assign(sun.shadow.camera, {
    left: -32,
    right: 32,
    top: 28,
    bottom: -28,
    near: 1,
    far: 120,
  });
  sun.shadow.bias = -0.0007;
  sun.shadow.normalBias = 0.08;
  sun.shadow.radius = 2.2;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xbcd6ea, 0x72875a, 0.72);
  const ambient = new THREE.AmbientLight(0xffffff, 0.28);
  const moon = new THREE.DirectionalLight(0xc9d9fa, 0);
  scene.add(hemi, ambient, moon, moon.target);
  scene.fog = new THREE.Fog(0xd9e1de, 86, 180);

  const glowTexture = createGlowTexture(96, 2.5);
  const moonDisc = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color("#eaf1ff"),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      depthTest: false,
      fog: false,
    }),
  );
  moonDisc.scale.set(3.2, 3.2, 1);
  scene.add(camera);
  camera.add(moonDisc);
  moonDisc.position.set(-18, 13, -65);

  function clear(group) {
    const failures = [];
    for (let index = group.children.length - 1; index >= 0; index -= 1) {
      const child = group.children[index];
      try {
        disposeOwnedObject(child);
      } catch (error) {
        failures.push(...(error.failures ?? [{ step: "object.dispose", error }]));
      }
      try {
        group.remove(child);
      } catch (error) {
        failures.push({ step: "object.remove", error });
      }
    }
    if (failures.length > 0) {
      const error = new AggregateError(
        failures.map((failure) => failure.error),
        "Cozy Village scene cleanup failed",
      );
      error.name = "CozyVillageResourceCleanupError";
      error.failures = failures;
      throw error;
    }
  }

  function mesh(geometry, material, {
    cast = true,
    receive = true,
    ownGeometry = true,
    ownMaterial = false,
  } = {}) {
    const object = new THREE.Mesh(geometry, material);
    object.castShadow = cast;
    object.receiveShadow = receive;
    object.userData.ownGeometry = ownGeometry;
    object.userData.ownMaterial = ownMaterial;
    return object;
  }

  function register(object, entity) {
    object.userData.entity = entity;
    pickables.push(object);
    return object;
  }

  function addBox(group, {
    width,
    height,
    depth,
    material,
    x = 0,
    y = 0,
    z = 0,
    radius = 0.08,
    bevel = 0.035,
    rotateY = 0,
    entity,
  }) {
    const object = mesh(
      chamferedBox(width, height, depth, { radius, bevel, segments: 2 }),
      material,
    );
    object.position.set(x, y, z);
    object.rotation.y = rotateY;
    if (entity) register(object, entity);
    group.add(object);
    return object;
  }

  function addGable(group, {
    width,
    height,
    depth,
    material,
    x = 0,
    y = 0,
    z = 0,
    rotateY = 0,
  }) {
    const roof = mesh(gableRoof(width, height, depth), material);
    roof.position.set(x, y, z);
    roof.rotation.y = rotateY;
    group.add(roof);
    return roof;
  }

  function addWindow(group, x, y, z, {
    width = 0.62,
    height = 0.72,
    rotateY = 0,
  } = {}) {
    const unit = windowUnit(width, height);
    const glass = mesh(unit.glass, materials.window);
    const frame = mesh(unit.frame, materials.beamDark);
    for (const object of [glass, frame]) {
      object.position.set(x, y, z);
      object.rotation.y = rotateY;
      group.add(object);
    }
  }

  function stationSign(group, station, {
    x = 0,
    y = 2.0,
    z = 1.4,
    width = 2.5,
    height = 0.7,
    line = station.name,
  } = {}) {
    const texture = createSignTexture({
      name: station.sign,
      ticket: "",
      line,
      palette,
      width: 512,
      height: 192,
    });
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: false,
      toneMapped: false,
    });
    signResources.push(texture, material);
    const backingHeight = height + 0.14;
    addBox(group, {
      width: width + 0.18,
      height: backingHeight,
      depth: 0.12,
      material: materials.beamDark,
      x,
      y: y - backingHeight / 2,
      z,
      radius: 0.045,
      bevel: 0.018,
      entity: { kind: "station", data: station },
    });
    const mountingPostHeight = Math.max(0.34, height * 0.62);
    for (const offset of [-width * 0.34, width * 0.34]) {
      const mountingPost = mesh(post(0.045, mountingPostHeight), materials.beamDark);
      mountingPost.position.set(
        x + offset,
        y - backingHeight / 2 - mountingPostHeight,
        z - 0.015,
      );
      group.add(mountingPost);
    }
    const board = mesh(
      new THREE.PlaneGeometry(width, height),
      material,
      { cast: false, receive: false, ownMaterial: false },
    );
    board.position.set(x, y, z + 0.095);
    register(board, { kind: "station", data: station });
    group.add(board);
    return board;
  }

  function practicalLamp(group, x, y, z, scale = 1) {
    const glass = mesh(lanternGlass(0.11 * scale, 0.28 * scale), materials.practical);
    glass.position.set(x, y, z);
    group.add(glass);
    const light = new THREE.PointLight("#ffad73", 0, 7 * scale, 2);
    light.position.set(x, y + 0.04, z);
    practicalLights.push(light);
    group.add(light);
  }

  function statusLamp(group, id, lit, x, y, z) {
    const glass = mesh(
      lanternGlass(0.13, 0.32),
      lit ? materials.lamp : materials.lampDark,
    );
    glass.position.set(x, y, z);
    group.add(glass);
    statusLamps.push({ id, lit, object: glass, baseY: y });
  }

  function buildStand() {
    clear(roots.stand);
    const { top, rim, foot } = standProfile(23.4, { thickness: 1.3, bevel: 0.6 });
    for (const [geometry, material] of [
      [top, materials.stand],
      [rim, materials.standBevel],
      [foot, materials.stand],
    ]) {
      const object = mesh(geometry, material, { cast: false });
      object.scale.z = 0.76;
      roots.stand.add(object);
    }
  }

  function buildGround() {
    clear(roots.ground);
    clear(roots.paths);
    const lawn = mesh(
      new THREE.CylinderGeometry(25.1, 25.7, 2.0, 96),
      materials.grass,
      { cast: false },
    );
    lawn.scale.z = 0.78;
    lawn.position.y = -0.5;
    roots.ground.add(lawn);

    const green = mesh(
      new THREE.CylinderGeometry(7.4, 7.7, 0.3, 48),
      materials.grass,
      { cast: false },
    );
    green.scale.z = 0.76;
    green.position.set(-1.5, 0.42, 0.3);
    roots.ground.add(green);

    const hillMaterial = materials.flat(village.season.grassDeep);
    for (const [x, z, sx, sz, y] of [
      [-15.8, -7.8, 4.8, 3.0, 0.42],
      [13.8, -8.4, 5.2, 3.2, 0.36],
      [14.8, 7.1, 4.6, 2.8, 0.3],
    ]) {
      const hill = mesh(
        new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        hillMaterial,
        { cast: false, ownGeometry: true },
      );
      hill.scale.set(sx, y, sz);
      hill.position.set(x, 0.39, z);
      roots.ground.add(hill);
    }

    for (const path of village.paths) buildPath(path);
    buildGardens();
  }

  function stationPosition(id) {
    if (id === "dock") {
      return new THREE.Vector3(village.layout.dock[0], 0.56, village.layout.dock[1]);
    }
    const station = village.stationById[id];
    return new THREE.Vector3(station.at[0], 0.56, station.at[1]);
  }

  function routeCurve(from, to, via) {
    const left = stationPosition(from);
    const right = stationPosition(to);
    const points = [left];
    if (via === "dock") {
      const dock = stationPosition(via);
      points.push(
        new THREE.Vector3(left.x - 3.0, 0.56, left.z - 1.2),
        dock,
        new THREE.Vector3(right.x - 2.8, 0.56, right.z + 2.2),
      );
    } else if (via) points.push(stationPosition(via));
    else {
      const middle = left.clone().lerp(right, 0.5);
      const dx = right.x - left.x;
      const dz = right.z - left.z;
      const length = Math.hypot(dx, dz) || 1;
      middle.x += (-dz / length) * 1.1;
      middle.z += (dx / length) * 1.1;
      points.push(middle);
    }
    points.push(right);
    return new THREE.CatmullRomCurve3(points);
  }

  function buildPath(path) {
    const curve = routeCurve(path.from, path.to, path.via);
    const count = Math.ceil(curve.getLength() / 0.56);
    for (let index = 0; index <= count; index += 1) {
      const amount = index / count;
      const point = curve.getPoint(amount);
      const tangent = curve.getTangent(amount);
      const stone = mesh(
        chamferedBox(
          0.76 + (index % 3) * 0.08,
          0.11,
          0.56 + ((index + 1) % 3) * 0.05,
          { radius: 0.08, bevel: 0.02, segments: 1 },
        ),
        index % 3 === 0
          ? materials.cobbleDeep
          : index % 2 ? materials.cobble : materials.plasterDim,
        { cast: false },
      );
      stone.position.set(point.x, 0.6 + Math.sin(index * 1.7) * 0.008, point.z);
      stone.rotation.y = Math.atan2(tangent.x, tangent.z) + Math.sin(index * 2.1) * 0.08;
      roots.paths.add(stone);
    }
  }

  function buildGardens() {
    const fenceMaterial = materials.beam;
    for (const [x, z, length, rotate] of [
      [-17.0, -4.2, 5.2, 0.05],
      [-16.8, -12.0, 4.4, -0.05],
      [14.0, 8.4, 5.4, 0.1],
      [16.8, -5.8, 4.2, Math.PI / 2],
    ]) {
      const rail = addBox(roots.ground, {
        width: length,
        height: 0.12,
        depth: 0.1,
        material: fenceMaterial,
        x,
        y: 0.92,
        z,
        rotateY: rotate,
        radius: 0.025,
        bevel: 0.01,
      });
      for (const offset of [-length / 2, 0, length / 2]) {
        const pole = mesh(post(0.08, 1.02), fenceMaterial);
        pole.position.set(
          x + Math.cos(rotate) * offset,
          0.48,
          z - Math.sin(rotate) * offset,
        );
        roots.ground.add(pole);
      }
      rail.receiveShadow = true;
    }

    const flowerColors = ["#e9b7ad", "#f4d18a", "#c2d0ee", "#f1e4d0"];
    for (const [x, z, count] of [
      [-4.0, -8.7, 8],
      [5.5, 7.9, 9],
      [15.7, 5.6, 7],
      [-17.6, 2.0, 6],
    ]) {
      for (let index = 0; index < count; index += 1) {
        const random = seeded(`${x}:${z}:${index}`);
        const stem = mesh(post(0.025, 0.35, { segments: 6 }), materials.flat("#53744a"));
        stem.position.set(x + (random() - 0.5) * 2.4, 0.48, z + (random() - 0.5) * 1.4);
        roots.ground.add(stem);
        const bloom = mesh(
          new THREE.DodecahedronGeometry(0.11 + random() * 0.04, 0),
          materials.flat(flowerColors[index % flowerColors.length]),
        );
        bloom.position.set(stem.position.x, 0.84, stem.position.z);
        roots.ground.add(bloom);
      }
    }
  }

  function buildingGroup(station) {
    const group = new THREE.Group();
    group.position.set(station.at[0], 0.49, station.at[1]);
    group.userData.stationId = station.id;
    stationObjects.set(station.id, group);
    roots.stations.add(group);
    return group;
  }

  function buildNotice(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    for (const x of [-1.35, 1.35]) {
      const pole = mesh(post(0.14, 2.9), materials.beamDark);
      pole.position.set(x, 0, 0);
      group.add(pole);
    }
    addBox(group, {
      width: 3.2,
      height: 1.7,
      depth: 0.2,
      material: materials.beam,
      y: 1.0,
      entity,
    });
    addGable(group, {
      width: 3.5,
      height: 0.58,
      depth: 0.65,
      material: materials.thatch,
      y: 2.72,
    });
    stationSign(group, station, {
      y: 2.34,
      z: 0.24,
      width: 2.65,
      height: 0.64,
      line: "ready work",
    });

    const papers = station.data.papers.slice(0, 6);
    for (let index = 0; index < papers.length; index += 1) {
      const paper = mesh(
        new THREE.PlaneGeometry(0.66, 0.48),
        materials.plaster,
        { cast: false },
      );
      paper.position.set(-0.92 + (index % 3) * 0.92, 1.75 - Math.floor(index / 3) * 0.62, 0.116);
      paper.rotation.z = ((index % 3) - 1) * 0.08;
      register(paper, { kind: "paper", data: papers[index] });
      group.add(paper);
    }
    if (station.data.warning) {
      const ribbon = addBox(group, {
        width: 3.45,
        height: 0.22,
        depth: 0.11,
        material: materials.tarp,
        y: 1.86,
        z: 0.18,
        rotateY: 0,
        entity,
      });
      ribbon.rotation.z = -0.13;
    }
    practicalLamp(group, -1.7, 2.5, 0.2, 0.82);
  }

  function buildWorkshop(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    const hutNames = station.data.huts;
    for (let index = 0; index < 3; index += 1) {
      const x = (index - 1) * 2.65;
      const depth = index === 1 ? 2.6 : 2.25;
      addBox(group, {
        width: 2.25,
        height: 1.62,
        depth,
        material: index === 1 ? materials.plaster : materials.plasterDim,
        x,
        entity,
      });
      addGable(group, {
        width: 2.25,
        height: 0.82,
        depth,
        material: index === 1 ? materials.roof : materials.thatch,
        x,
        y: 1.62,
      });
      const chimney = addBox(group, {
        width: 0.34,
        height: 1.18,
        depth: 0.38,
        material: materials.beamDark,
        x: x + 0.62,
        y: 1.56,
        z: -0.25,
        radius: 0.04,
      });
      smokePuffs.push({
        origin: new THREE.Vector3(
          station.at[0] + chimney.position.x,
          3.0,
          station.at[1] + chimney.position.z,
        ),
        phase: index * 1.7,
      });
      addBox(group, {
        width: 1.6,
        height: 0.16,
        depth: 0.72,
        material: materials.beam,
        x,
        y: 0.65,
        z: 1.5,
        radius: 0.04,
        entity,
      });
      const hutStation = {
        ...station,
        name: `${station.name} · ${hutNames[index]?.name ?? "Bench"}`,
      };
      stationSign(group, hutStation, {
        x,
        y: 1.36,
        z: depth / 2 + 0.18,
        width: 1.55,
        height: 0.46,
        line: hutNames[index]?.name ?? "bench",
      });
    }
    stationSign(group, station, {
      x: 0,
      y: 3.08,
      z: 2.0,
      width: 2.65,
      height: 0.66,
      line: "build & return",
    });
    practicalLamp(group, -3.75, 1.6, 1.45);
    practicalLamp(group, 3.75, 1.6, 1.45);
  }

  function buildAssay(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    addBox(group, {
      width: 5.1,
      height: 2.0,
      depth: 3.2,
      material: materials.plaster,
      entity,
    });
    addGable(group, {
      width: 5.1,
      height: 1.05,
      depth: 3.2,
      material: materials.roofDeep,
      y: 2.0,
    });
    addBox(group, {
      width: 5.5,
      height: 0.16,
      depth: 1.25,
      material: materials.beam,
      y: 0.18,
      z: 2.05,
      entity,
    });
    for (const x of [-1.28, 1.28]) {
      addWindow(group, x, 1.2, 1.625);
      const awning = addBox(group, {
        width: 2.0,
        height: 0.12,
        depth: 0.72,
        material: materials.thatch,
        x,
        y: 2.08,
        z: 1.83,
        radius: 0.035,
      });
      awning.rotation.x = -0.12;
    }
    const balancePole = mesh(post(0.07, 1.22), materials.beamDark);
    balancePole.position.set(0, 0.42, 2.2);
    group.add(balancePole);
    addBox(group, {
      width: 1.4,
      height: 0.08,
      depth: 0.1,
      material: materials.beamDark,
      y: 1.52,
      z: 2.2,
      radius: 0.02,
    });
    for (const x of [-0.55, 0.55]) {
      const pan = mesh(
        new THREE.CylinderGeometry(0.28, 0.36, 0.08, 14),
        materials.flat("#8b806b"),
      );
      pan.position.set(x, 1.25, 2.2);
      group.add(pan);
    }
    stationSign(group, station, {
      y: 2.74,
      z: 2.04,
      width: 2.65,
      height: 0.68,
      line: "verify · review",
    });
    practicalLamp(group, -2.7, 1.9, 1.75);
  }

  function buildCottage(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    addBox(group, {
      width: 3.5,
      height: 2.05,
      depth: 3.0,
      material: materials.plasterDim,
      entity,
    });
    addGable(group, {
      width: 3.5,
      height: 1.28,
      depth: 3.0,
      material: materials.thatch,
      y: 2.05,
    });
    addBox(group, {
      width: 4.2,
      height: 0.22,
      depth: 1.55,
      material: materials.beam,
      y: 0.16,
      z: 2.15,
      entity,
    });
    for (const x of [-1.65, 1.65]) {
      const postObject = mesh(post(0.1, 2.05), materials.beamDark);
      postObject.position.set(x, 0.28, 2.45);
      group.add(postObject);
    }
    const porchRoof = addBox(group, {
      width: 4.15,
      height: 0.16,
      depth: 1.65,
      material: materials.roof,
      y: 2.25,
      z: 2.14,
      radius: 0.04,
    });
    porchRoof.rotation.x = -0.11;
    addWindow(group, -0.9, 1.25, 1.515);
    addBox(group, {
      width: 0.9,
      height: 1.55,
      depth: 0.12,
      material: materials.beamDark,
      x: 0.9,
      z: 1.55,
      radius: 0.06,
      entity,
    });
    stationSign(group, station, {
      y: 2.82,
      z: 3.12,
      width: 2.7,
      height: 0.68,
      line: "questions & plans",
    });
    statusLamp(group, "porch", station.data.visitors.length > 0, 1.55, 1.65, 2.55);
    practicalLamp(group, -1.55, 1.65, 2.55);
  }

  function buildHall(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    addBox(group, {
      width: 5.5,
      height: 2.55,
      depth: 4.2,
      material: materials.plaster,
      entity,
    });
    const hallRoof = mesh(hipRoof(6.1, 1.4, 4.8), materials.roofDeep);
    hallRoof.position.y = 2.55;
    group.add(hallRoof);
    addBox(group, {
      width: 2.0,
      height: 3.15,
      depth: 1.8,
      material: materials.plasterDim,
      y: 2.05,
      z: -0.2,
      entity,
    });
    const towerRoof = mesh(hipRoof(2.45, 1.15, 2.25), materials.roof);
    towerRoof.position.set(0, 5.2, -0.2);
    group.add(towerRoof);
    const clockFace = mesh(
      new THREE.CylinderGeometry(0.48, 0.48, 0.09, 32),
      materials.plaster,
    );
    clockFace.rotation.x = Math.PI / 2;
    clockFace.position.set(0, 4.15, 0.735);
    group.add(clockFace);
    for (const x of [-1.9, -0.65, 0.65, 1.9]) {
      const column = mesh(post(0.12, 2.25), materials.beam);
      column.position.set(x, 0.12, 2.35);
      group.add(column);
    }
    addBox(group, {
      width: 5.4,
      height: 0.18,
      depth: 1.3,
      material: materials.beam,
      y: 0.18,
      z: 2.45,
      entity,
    });
    stationSign(group, station, {
      y: 3.08,
      z: 3.24,
      width: 2.9,
      height: 0.72,
      line: "human merge queue",
    });
    statusLamp(
      group,
      "hall",
      station.data.mergeQueue.length > 0,
      -2.45,
      2.48,
      2.45,
    );
    statusLamp(
      group,
      "main",
      station.data.dock.bellRinging,
      2.45,
      2.48,
      2.45,
    );

    const dock = new THREE.Group();
    dock.position.set(1.4, 0, -3.15);
    addBox(dock, {
      width: 4.2,
      height: 0.24,
      depth: 2.0,
      material: materials.beam,
      y: 0.14,
      entity: { kind: "dock", data: station.data.dock },
    });
    for (const x of [-1.7, 1.7]) {
      for (const z of [-0.72, 0.72]) {
        const support = mesh(post(0.09, 0.8), materials.beamDark);
        support.position.set(x, -0.4, z);
        dock.add(support);
      }
    }
    const dockSign = {
      ...station,
      sign: "✓ TEST DOCK",
      name: "Main test dock",
    };
    stationSign(dock, dockSign, {
      y: 1.3,
      z: 1.12,
      width: 2.25,
      height: 0.54,
      line: station.data.dock.state,
    });
    if (station.data.dock.failures.length > 0) {
      for (const x of [-1.35, 1.35]) {
        const scaffold = mesh(post(0.08, 2.25), materials.timber);
        scaffold.position.set(x, 0.25, 0);
        dock.add(scaffold);
      }
      addBox(dock, {
        width: 3.0,
        height: 0.1,
        depth: 0.1,
        material: materials.timber,
        y: 2.05,
        radius: 0.02,
      });
    }
    group.add(dock);
  }

  function buildGranary(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    const level = station.data.growth.level;
    const bodyHeight = 2.8 + level * 0.48;
    addBox(group, {
      width: 5.6,
      height: bodyHeight,
      depth: 4.2,
      material: materials.beam,
      entity,
    });
    addGable(group, {
      width: 5.6,
      height: 1.55,
      depth: 4.2,
      material: materials.thatch,
      y: bodyHeight,
    });
    addBox(group, {
      width: 2.1,
      height: 2.2,
      depth: 0.18,
      material: materials.beamDark,
      y: 0,
      z: 2.16,
      radius: 0.08,
      entity,
    });
    for (let index = 1; index <= level; index += 1) {
      const side = index % 2 ? -1 : 1;
      const storey = Math.ceil(index / 2);
      addBox(group, {
        width: 1.5,
        height: 1.65,
        depth: 3.1,
        material: materials.plasterDim,
        x: side * (3.1 + (storey - 1) * 1.2),
        y: 0,
        entity,
      });
      addGable(group, {
        width: 1.5,
        height: 0.62,
        depth: 3.1,
        material: materials.roof,
        x: side * (3.1 + (storey - 1) * 1.2),
        y: 1.65,
      });
    }
    stationSign(group, station, {
      y: bodyHeight - 0.32,
      z: 2.34,
      width: 2.75,
      height: 0.68,
      line: `${station.data.records.length} archived`,
    });
    const plaque = {
      ...station,
      sign: "▤ GROWTH",
      name: station.data.growth.plaque,
    };
    stationSign(group, plaque, {
      x: 2.05,
      y: 1.05,
      z: 2.34,
      width: 1.7,
      height: 0.46,
      line: station.data.growth.next ? `next ${station.data.growth.next}` : "full",
    });
    for (let index = 0; index < station.data.growth.decorations; index += 1) {
      const barrel = mesh(
        new THREE.CylinderGeometry(0.28, 0.32, 0.62, 12),
        materials.timber,
      );
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(-3.15 + index * 0.68, 0.38, 1.7);
      group.add(barrel);
    }
    if (station.data.banner) {
      const banner = mesh(new THREE.PlaneGeometry(0.75, 1.35), materials.roof);
      banner.position.set(0, bodyHeight + 1.25, 2.2);
      group.add(banner);
    }
    practicalLamp(group, -2.65, 2.0, 2.35);
  }

  function buildRnd(station) {
    const group = buildingGroup(station);
    const entity = { kind: "station", data: station };
    const tower = mesh(
      new THREE.CylinderGeometry(2.15, 2.55, 6.2, 12),
      materials.plasterDim,
    );
    tower.position.y = 3.1;
    register(tower, entity);
    group.add(tower);
    for (const y of [1.5, 3.2, 4.9]) {
      for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        const window = mesh(
          new THREE.BoxGeometry(0.58, 0.72, 0.09),
          materials.window,
        );
        window.position.set(Math.sin(angle) * 2.19, y, Math.cos(angle) * 2.19);
        window.rotation.y = angle;
        group.add(window);
      }
    }
    const roof = mesh(
      new THREE.ConeGeometry(2.85, 2.25, 12),
      materials.roofDeep,
    );
    roof.position.y = 7.32;
    group.add(roof);
    const observatory = mesh(
      new THREE.SphereGeometry(1.15, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      materials.tarp,
    );
    observatory.position.set(0.85, 6.3, 0);
    group.add(observatory);
    if (station.data.props.telescope) {
      const telescope = mesh(
        new THREE.CylinderGeometry(0.16, 0.22, 2.5, 12),
        materials.beamDark,
      );
      telescope.rotation.z = Math.PI / 3.2;
      telescope.position.set(1.5, 7.15, 0.1);
      group.add(telescope);
    }
    for (let index = 0; index < station.data.props.blueprints; index += 1) {
      const scroll = mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 0.9, 10),
        materials.plaster,
      );
      scroll.rotation.z = Math.PI / 2;
      scroll.position.set(-2.4 + index * 0.4, 0.75 + index * 0.1, 2.3);
      group.add(scroll);
    }
    if (station.data.props.globe) {
      const globe = mesh(
        new THREE.SphereGeometry(0.42, 16, 10),
        materials.flat("#718a93"),
      );
      globe.position.set(-1.5, 1.15, 2.0);
      group.add(globe);
    }
    stationSign(group, station, {
      y: 4.0,
      z: 2.72,
      width: 2.45,
      height: 0.66,
      line: `${station.data.counts.total} artifacts`,
    });
    practicalLamp(group, -1.8, 1.8, 2.2);
  }

  function addParcel(group, parcel, x, y, z, size = 0.56, { pickable = true } = {}) {
    const crate = addBox(group, {
      width: size,
      height: size * 0.58,
      depth: size * 0.74,
      material: parcel.marked ? materials.tarp : materials.timber,
      x,
      y,
      z,
      radius: 0.055,
      bevel: 0.022,
      entity: pickable ? { kind: parcel.kind ?? "parcel", data: parcel } : undefined,
    });
    const strap = addBox(group, {
      width: size * 1.04,
      height: 0.045,
      depth: size * 0.16,
      material: parcel.marked ? materials.roofDeep : materials.plasterDim,
      x,
      y: y + size * 0.58,
      z,
      radius: 0.01,
      bevel: 0.006,
    });
    strap.rotation.y = parcel.marked ? -0.45 : 0;
    return crate;
  }

  function addVillager(group, parcel, x, z, {
    facing = 0,
    atStation = parcel.stationId,
    pose = null,
    groundY = 0.49,
    pickable = true,
  } = {}) {
    const figure = new THREE.Group();
    const accent = materials.paintMaterial(
      atStation === "assay"
        ? palette.slateDeep
        : atStation === "cottage"
          ? palette.ochre
          : pose === "carrier" ? palette.madder : parcel.villager.paint,
    );
    const addArm = (side, {
      y = 0.68,
      z: armZ = 0.08,
      rotateX = 0,
      rotateZ = side * -0.42,
      material = accent,
    } = {}) => {
      const arm = mesh(
        new THREE.CylinderGeometry(0.045, 0.055, 0.52, 8),
        material,
      );
      arm.position.set(side * 0.2, y, armZ);
      arm.rotation.x = rotateX;
      arm.rotation.z = rotateZ;
      figure.add(arm);
      return arm;
    };
    const body = mesh(
      pegFigure(1.38, parcel.villager.build),
      materials.paintMaterial(parcel.villager.paint),
    );
    body.position.y = 0;
    if (pickable) register(body, { kind: "parcel", data: parcel });
    figure.add(body);

    const apron = addBox(figure, {
      width: 0.34,
      height: 0.46,
      depth: 0.06,
      material: materials.plasterDim,
      y: 0.35,
      z: 0.19,
      radius: 0.025,
      bevel: 0.01,
    });
    apron.rotation.x = -0.04;
    const toolMaterial = materials.beamDark;
    if (pose === "carrier") {
      addArm(-1, { y: 0.73, z: 0.17, rotateX: 0.92, rotateZ: 0.18 });
      addArm(1, { y: 0.73, z: 0.17, rotateX: 0.92, rotateZ: -0.18 });
      const cap = mesh(
        new THREE.CylinderGeometry(0.19, 0.22, 0.1, 12),
        accent,
      );
      cap.position.set(0, 1.34, 0);
      figure.add(cap);
    } else if (atStation === "assay") {
      addArm(1, { y: 0.72, z: 0.12, rotateX: 0.38, rotateZ: -0.72 });
      const glass = mesh(
        new THREE.TorusGeometry(0.15, 0.028, 8, 18),
        toolMaterial,
      );
      glass.position.set(0.31, 0.88, 0.17);
      glass.rotation.y = 0.35;
      figure.add(glass);
      const inspectorCap = mesh(
        new THREE.CylinderGeometry(0.2, 0.23, 0.09, 12),
        accent,
      );
      inspectorCap.position.set(0, 1.34, 0);
      figure.add(inspectorCap);
    } else if (atStation === "cottage") {
      addArm(-1, { y: 0.7, z: 0.14, rotateX: 0.72, rotateZ: 0.2 });
      addArm(1, { y: 0.7, z: 0.14, rotateX: 0.72, rotateZ: -0.2 });
      const letter = addBox(figure, {
        width: 0.38,
        height: 0.28,
        depth: 0.035,
        material: materials.plaster,
        y: 0.68,
        z: 0.29,
        radius: 0.015,
        bevel: 0.006,
      });
      letter.rotation.x = -0.18;
    } else if (atStation === "rnd") {
      const scroll = mesh(
        new THREE.CylinderGeometry(0.045, 0.045, 0.5, 8),
        materials.plaster,
      );
      scroll.rotation.z = Math.PI / 2;
      scroll.position.set(0.18, 0.65, 0.16);
      figure.add(scroll);
    } else {
      const tool = mesh(
        new THREE.BoxGeometry(0.06, 0.58, 0.06),
        toolMaterial,
      );
      tool.position.set(0.25, 0.58, 0.08);
      tool.rotation.z = -0.28;
      figure.add(tool);
      activityFigures.push({
        object: tool,
        baseRotation: tool.rotation.z,
        until: parcel.activity?.until ?? 0,
        phase: seeded(parcel.id)() * Math.PI * 2,
      });
    }
    figure.scale.setScalar(1.14);
    figure.position.set(x, groundY, z);
    figure.rotation.y = facing;
    group.add(figure);
    return figure;
  }

  function buildFigures() {
    clear(roots.figures);
    activityFigures = [];
    const slots = {
      workshop: [
        [-9.1, 4.25], [-6.2, 4.25], [-3.4, 4.25],
        [-8.5, 0.2], [-5.7, -0.1], [-3.0, 0.2],
      ],
      assay: [[0.7, 6.55], [3.3, 6.55], [0.2, 2.2], [3.8, 2.2]],
      cottage: [[-2.2, -4.6], [0.2, -4.6], [-3.0, -8.9]],
      hall: [[8.9, 4.9], [11.2, 5.2], [13.5, 4.9], [9.0, -0.2]],
    };
    const counters = new Map();
    for (const parcel of village.parcels) {
      const stationSlots = slots[parcel.stationId] ?? slots.workshop;
      const index = counters.get(parcel.stationId) ?? 0;
      counters.set(parcel.stationId, index + 1);
      const [x, z] = stationSlots[index % stationSlots.length];
      addVillager(roots.figures, parcel, x, z, {
        facing: parcel.stationId === "hall" ? -0.4 : 0.2,
      });
      addParcel(roots.figures, parcel, x + 0.55, 0.54, z + 0.2);
    }

    for (const [index, artifact] of village.rnd.artifacts.slice(0, 2).entries()) {
      const scientist = {
        kind: "artifact-presence",
        id: `scientist-${index}`,
        stationId: "rnd",
        title: artifact.title,
        villager: {
          name: index ? "Tobin" : "Juniper",
          paint: index ? "#567f92" : "#c37054",
          build: index ? "small" : "tall",
        },
        activity: null,
        artifact,
      };
      addVillager(roots.figures, scientist, -10.6 - index * 1.2, -6.7, {
        facing: Math.PI,
        atStation: "rnd",
      });
    }

    const dock = village.hall.dock;
    for (const [index, parcel] of [...dock.failures, ...dock.running].slice(0, 3).entries()) {
      addParcel(roots.figures, parcel, 12.1 + index * 0.68, 0.54, -4.7, 0.64);
    }
    for (const [index, parcel] of village.granary.vestibule.slice(0, 4).entries()) {
      addParcel(roots.figures, parcel, 7.0 + index * 0.72, 0.54, -7.3, 0.62);
    }
  }

  function buildStations() {
    clear(roots.stations);
    stationObjects.clear();
    practicalLights = [];
    statusLamps = [];
    smokePuffs = [];
    for (const station of village.stations) {
      if (station.id === "notice") buildNotice(station);
      if (station.id === "workshop") buildWorkshop(station);
      if (station.id === "assay") buildAssay(station);
      if (station.id === "cottage") buildCottage(station);
      if (station.id === "hall") buildHall(station);
      if (station.id === "granary") buildGranary(station);
      if (station.id === "rnd") buildRnd(station);
    }
  }

  function buildTree(x, z, scale, seed) {
    const group = new THREE.Group();
    const trunk = mesh(post(0.18 * scale, 1.65 * scale), materials.beamDark);
    group.add(trunk);
    for (const canopy of treeCanopy(0.95 * scale, 3)) {
      const leaves = mesh(canopy, materials.flat(village.season.canopy));
      leaves.position.y = 1.2 * scale;
      group.add(leaves);
    }
    group.position.set(x, 0.48, z);
    group.rotation.y = seeded(seed)() * Math.PI;
    roots.ambient.add(group);
  }

  function buildAmbient() {
    for (const resource of ambientResources) resource.dispose?.();
    ambientResources = [];
    clear(roots.ambient);
    fireflies = [];
    birds = [];
    const treeSites = [
      [-19, 4.2, 1.2], [-18.4, -2.0, 0.95], [-17.4, -13.0, 1.22],
      [-8.5, -13.2, 0.92], [0.7, -12.9, 0.9], [16.7, -12.4, 1.18],
      [19.0, -5.0, 1.0], [18.0, 6.8, 1.22], [8.7, 10.0, 0.92],
      [-6.5, 10.4, 1.08], [-13.0, 9.3, 0.92],
    ];
    for (const [index, [x, z, scale]] of treeSites.entries()) {
      buildTree(x, z, scale, `tree-${index}`);
    }

    const fireflyMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: new THREE.Color("#ffd88a"),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    ambientResources.push(fireflyMaterial);
    const count = Math.round(14 * detail);
    for (let index = 0; index < count; index += 1) {
      const random = seeded(`firefly-${index}`);
      const sprite = new THREE.Sprite(fireflyMaterial);
      sprite.scale.setScalar(0.18);
      sprite.position.set(
        (random() - 0.5) * 34,
        0.9 + random() * 1.8,
        (random() - 0.5) * 20,
      );
      roots.ambient.add(sprite);
      fireflies.push({ object: sprite, base: sprite.position.clone(), phase: random() * 10 });
    }

    for (let index = 0; index < Math.max(2, Math.round(4 * detail)); index += 1) {
      const bird = new THREE.Group();
      const wingMaterial = materials.flat(index % 2 ? "#6e665a" : "#857969");
      for (const side of [-1, 1]) {
        const wing = mesh(new THREE.BoxGeometry(0.38, 0.035, 0.12), wingMaterial);
        wing.position.x = side * 0.18;
        wing.rotation.z = side * 0.26;
        bird.add(wing);
      }
      bird.position.set(-14 + index * 1.7, 9 + index * 0.35, -9 - index * 0.8);
      roots.ambient.add(bird);
      birds.push({ object: bird, phase: index * 1.3 });
    }
  }

  function applyClock(clock) {
    const gradient = skyContext.createLinearGradient(0, 0, 0, skyCanvas.height);
    gradient.addColorStop(0, clock.skyTop);
    gradient.addColorStop(1, clock.skyBottom);
    skyContext.fillStyle = gradient;
    skyContext.fillRect(0, 0, skyCanvas.width, skyCanvas.height);
    skyTexture.needsUpdate = true;
    scene.background = new THREE.Color(clock.skyBottom);
    scene.fog.color.set(clock.fogColor);
    sun.color.set(clock.sunColor);
    sun.intensity = clock.sunIntensity;
    sun.position.set(
      clock.sunDir[0] * 45,
      clock.sunDir[1] * 45,
      clock.sunDir[2] * 45,
    );
    sun.target.position.set(0, 0, 0);
    hemi.intensity = clock.hemiIntensity;
    ambient.intensity = clock.ambIntensity;
    moon.intensity = clock.moonIntensity;
    moon.position.set(
      clock.moonDir[0] * 35,
      clock.moonDir[1] * 35,
      clock.moonDir[2] * 35,
    );
    moonDisc.material.opacity = clock.moonVisibility * 0.82;
    if (materials?.window) materials.window.emissiveIntensity = clock.hearthGlow * 1.15;
    if (materials?.practical) materials.practical.emissiveIntensity = clock.hearthGlow * 1.55;
    for (const light of practicalLights) light.intensity = clock.hearthGlow * 1.4;
    renderer.toneMappingExposure = 1.02 + clock.nightFloor * 0.28;
    dirty = true;
  }

  function applyLamps(nextVillage, time = 0) {
    for (const lamp of statusLamps) {
      const source = lamp.id === "porch"
        ? nextVillage.porch.visitors.length > 0
        : lamp.id === "hall"
          ? nextVillage.hall.mergeQueue.length > 0
          : nextVillage.hall.dock.bellRinging;
      lamp.lit = source;
      lamp.object.material = source ? materials.lamp : materials.lampDark;
      lamp.object.position.y = lamp.baseY + (
        source && motion ? Math.sin(time * 2.4) * 0.025 : 0
      );
    }
    dirty = true;
  }

  function applyNight(clock) {
    applyClock(clock);
  }

  const cameraState = {
    azimuth: 0.62,
    elevation: 0.58,
    distance: 48,
    target: new THREE.Vector3(-0.5, 1.6, -1.0),
  };
  let cameraMove = null;

  function targetFor(name) {
    return name === "village"
      ? {
          distance: 55,
          elevation: 0.7,
          azimuth: 0.62,
          target: new THREE.Vector3(0, 1.8, -0.6),
        }
      : {
          distance: 44,
          elevation: 0.56,
          azimuth: 0.62,
          target: new THREE.Vector3(-0.6, 1.6, -0.5),
        };
  }

  function placeCamera() {
    const horizontal = Math.cos(cameraState.elevation) * cameraState.distance;
    camera.position.set(
      cameraState.target.x + Math.sin(cameraState.azimuth) * horizontal,
      cameraState.target.y + Math.sin(cameraState.elevation) * cameraState.distance,
      cameraState.target.z + Math.cos(cameraState.azimuth) * horizontal,
    );
    camera.lookAt(cameraState.target);
    camera.position.x += parallax.x * 0.28;
    camera.position.y += parallax.y * 0.16;
    camera.updateMatrixWorld();
  }

  function frameCamera(name, { duration = 850 } = {}) {
    const nextName = name === "town" ? "village" : name === "square" ? "green" : name;
    const goal = targetFor(nextName);
    framing = nextName;
    cameraMove = {
      startedAt: performance.now(),
      duration,
      from: {
        distance: cameraState.distance,
        elevation: cameraState.elevation,
        azimuth: cameraState.azimuth,
        target: cameraState.target.clone(),
      },
      to: goal,
    };
    dirty = true;
  }

  function playOpening({ reduced = false } = {}) {
    if (reduced) {
      Object.assign(cameraState, targetFor("green"));
      cameraState.target.copy(targetFor("green").target);
      placeCamera();
      dirty = true;
      return;
    }
    const wide = targetFor("village");
    cameraState.distance = wide.distance;
    cameraState.elevation = wide.elevation;
    cameraState.azimuth = wide.azimuth;
    cameraState.target.copy(wide.target);
    frameCamera("green", { duration: 1_500 });
  }

  function updateCamera(now) {
    if (!cameraMove) {
      placeCamera();
      return;
    }
    const amount = Math.min(1, (now - cameraMove.startedAt) / cameraMove.duration);
    const eased = EASE(amount);
    cameraState.distance = THREE.MathUtils.lerp(
      cameraMove.from.distance,
      cameraMove.to.distance,
      eased,
    );
    cameraState.elevation = THREE.MathUtils.lerp(
      cameraMove.from.elevation,
      cameraMove.to.elevation,
      eased,
    );
    cameraState.azimuth = THREE.MathUtils.lerp(
      cameraMove.from.azimuth,
      cameraMove.to.azimuth,
      eased,
    );
    cameraState.target.lerpVectors(
      cameraMove.from.target,
      cameraMove.to.target,
      eased,
    );
    if (amount >= 1) cameraMove = null;
    placeCamera();
    dirty = true;
  }

  function zoomBy(delta) {
    cameraState.distance = THREE.MathUtils.clamp(
      cameraState.distance + delta * 0.018,
      31,
      68,
    );
    cameraMove = null;
    dirty = true;
  }

  function orbitBy(dx, dy) {
    cameraState.azimuth -= dx * 0.004;
    cameraState.elevation = THREE.MathUtils.clamp(
      cameraState.elevation + dy * 0.003,
      0.24,
      1.08,
    );
    cameraMove = null;
    dirty = true;
  }

  function transitionCurve(change) {
    const route = change?.route ?? [];
    if (route.length < 2) return null;
    const points = route.map((id) =>
      id === "dock"
        ? new THREE.Vector3(village.layout.dock[0], 0.72, village.layout.dock[1])
        : stationPosition(id).setY(0.72));
    const expanded = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      expanded.push(points[index]);
      const middle = points[index].clone().lerp(points[index + 1], 0.5);
      middle.x += index % 2 ? -0.8 : 0.8;
      expanded.push(middle);
    }
    expanded.push(points.at(-1));
    return new THREE.CatmullRomCurve3(expanded);
  }

  async function animateTransition(change, { reduced = false } = {}) {
    if (disposed) return;
    const curve = transitionCurve(change);
    if (!curve || reduced) {
      dirty = true;
      return;
    }
    if (transition?.group) transitionGroups.release(transition.group);
    const group = transitionGroups.track(new THREE.Group());
    const parcel = change.parcel ?? change.vestibule ?? {
      id: change.dispatchId,
      marked: false,
    };
    if (parcel.villager) {
      addVillager(group, parcel, 0, 0, {
        atStation: change.to,
        pose: "carrier",
        groundY: -0.23,
        pickable: false,
      });
      addParcel(group, parcel, 0.28, 0.35, 0.22, 0.52, { pickable: false });
    } else {
      addParcel(group, parcel, 0.48, 0, 0, 0.62, { pickable: false });
    }
    roots.effects.add(group);
    const current = {
      group,
      curve,
      startedAt: performance.now(),
      duration: change.kind === "merged" ? 1_900 : 1_350,
    };
    transition = current;
    dirty = true;
    const completed = await delay(current.duration);
    if (!completed || disposed) {
      transitionGroups.release(current.group);
      if (transition === current) transition = null;
    }
  }

  function updateTransition(now) {
    if (!transition) return;
    const current = transition;
    const amount = Math.min(1, (now - current.startedAt) / current.duration);
    const point = current.curve.getPoint(EASE(amount));
    const tangent = current.curve.getTangent(EASE(amount));
    current.group.position.copy(point);
    current.group.rotation.y = Math.atan2(tangent.x, tangent.z);
    current.group.position.y += Math.sin(amount * Math.PI) * 0.18;
    if (amount >= 1) {
      transitionGroups.release(current.group);
      if (transition === current) transition = null;
    }
    dirty = true;
  }

  function update(dt, now) {
    if (disposed) return;
    updateCamera(now);
    updateTransition(now);
    if (!motion) return;
    const seconds = now / 1000;
    for (const activity of activityFigures) {
      if (Date.now() > activity.until) {
        activity.object.rotation.z = activity.baseRotation;
        continue;
      }
      activity.object.rotation.z =
        activity.baseRotation + Math.sin(seconds * 8 + activity.phase) * 0.32;
      dirty = true;
    }
    for (const [index, smoke] of smokePuffs.entries()) {
      let sprite = smoke.object;
      if (!sprite) {
        const material = new THREE.SpriteMaterial({
          map: glowTexture,
          color: new THREE.Color("#d8d2c7"),
          transparent: true,
          opacity: 0.2,
          depthWrite: false,
        });
        ambientResources.push(material);
        sprite = new THREE.Sprite(material);
        sprite.scale.setScalar(0.65);
        sprite.position.copy(smoke.origin);
        roots.ambient.add(sprite);
        smoke.object = sprite;
      }
      const cycle = (seconds * 0.12 + smoke.phase) % 1;
      sprite.position.set(
        smoke.origin.x + Math.sin(seconds + index) * 0.16,
        smoke.origin.y + cycle * 2.6,
        smoke.origin.z,
      );
      sprite.scale.setScalar(0.5 + cycle * 0.8);
      sprite.material.opacity = (1 - cycle) * 0.2;
      dirty = true;
    }
    for (const firefly of fireflies) {
      firefly.object.position.x = firefly.base.x + Math.sin(seconds * 0.7 + firefly.phase) * 0.35;
      firefly.object.position.y = firefly.base.y + Math.sin(seconds * 1.1 + firefly.phase) * 0.2;
      firefly.object.material.opacity = village.clock.nightFloor * (
        0.18 + (Math.sin(seconds * 2 + firefly.phase) + 1) * 0.22
      );
      dirty = true;
    }
    for (const bird of birds) {
      bird.object.position.x += dt * 0.55;
      bird.object.position.z += dt * 0.12;
      if (bird.object.position.x > 20) bird.object.position.x = -20;
      for (const [index, wing] of bird.object.children.entries()) {
        wing.rotation.z = (index ? 1 : -1) * (
          0.2 + Math.sin(seconds * 5 + bird.phase) * 0.23
        );
      }
      dirty = true;
    }
  }

  function build(nextVillage) {
    if (disposed) return;
    village = nextVillage;
    pickables.length = 0;
    transition = null;
    transitionGroups.releaseAll();
    clear(roots.effects);
    for (const resource of signResources) resource.dispose?.();
    signResources = [];
    materials?.dispose?.();
    materials = createMaterialLibrary({
      palette,
      season: village.season,
      tier,
      aniso,
    });
    buildStand();
    buildGround();
    buildStations();
    buildFigures();
    buildAmbient();
    applyClock(village.clock);
    applyLamps(village, 0);
    placeCamera();
    dirty = true;
  }

  function pick(ndcX, ndcY) {
    raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);
    for (const hit of raycaster.intersectObjects(pickables, true)) {
      let object = hit.object;
      while (object) {
        if (object.userData.entity) return object.userData.entity;
        object = object.parent;
      }
    }
    return null;
  }

  function stats() {
    let objects = 0;
    let tris = 0;
    scene.traverse((object) => {
      objects += 1;
      const geometry = object.geometry;
      if (!geometry) return;
      const count = geometry.index
        ? geometry.index.count
        : geometry.attributes.position?.count ?? 0;
      tris += count / 3;
    });
    return {
      objects,
      tris: Math.round(tris),
      draws: renderer?.info?.render?.calls ?? 0,
      stations: village?.stations?.length ?? 0,
    };
  }

  return {
    scene,
    camera,
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
      viewport: { ...viewport },
      cameraDistance: cameraState.distance,
    }),
    resize(width, height, {
      obscuredRight = 0,
      obscuredBottom = 0,
    } = {}) {
      viewport = { width, height, obscuredRight, obscuredBottom };
      camera.aspect = width / Math.max(1, height);
      if (obscuredRight > 0 || obscuredBottom > 0) {
        camera.setViewOffset(
          width,
          height,
          obscuredRight / 2,
          obscuredBottom / 2,
          width,
          height,
        );
      } else {
        camera.clearViewOffset();
      }
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      dirty = true;
    },
    get needsRender() {
      return !disposed && dirty;
    },
    render() {
      if (disposed) return;
      renderer.render(scene, camera);
      dirty = false;
    },
    invalidate() {
      if (disposed) return;
      dirty = true;
    },
    dispose() {
      if (disposed || disposing) return;
      disposing = true;
      disposed = true;
      const failures = [];
      const attempt = (step, cleanup) => {
        try {
          cleanup();
        } catch (error) {
          failures.push(...(error.failures ?? [{ step, error }]));
        }
      };
      try {
        transition = null;
        attempt("transition-groups.release", () => transitionGroups.releaseAll());
        for (const root of Object.values(roots)) {
          attempt("scene-root.clear", () => clear(root));
        }
        for (const resource of ambientResources) {
          attempt("ambient-resource.dispose", () => resource.dispose?.());
        }
        ambientResources = [];
        for (const resource of signResources) {
          attempt("sign-resource.dispose", () => resource.dispose?.());
        }
        signResources = [];
        attempt("materials.dispose", () => materials?.dispose?.());
        materials = null;
        attempt("sky-texture.dispose", () => skyTexture.dispose());
        attempt("sky-material.dispose", () => sky.material.dispose());
        attempt("sky-geometry.dispose", () => sky.geometry.dispose());
        attempt("moon-material.dispose", () => moonDisc.material.dispose());
        attempt("glow-texture.dispose", () => glowTexture.dispose());
        attempt("shadow-map.dispose", () => sun.shadow.map?.dispose?.());
        pickables.length = 0;
        stationObjects.clear();
        activityFigures = [];
        smokePuffs = [];
        fireflies = [];
        birds = [];
        practicalLights = [];
        statusLamps = [];
        village = null;
        attempt("scene.clear", () => scene.clear());
        dirty = false;
        attempt("renderer.dispose", () => renderer?.dispose?.());
        attempt("renderer.force-context-loss", () => renderer?.forceContextLoss?.());
      } finally {
        disposing = false;
      }
      if (failures.length > 0) {
        const error = new AggregateError(
          failures.map((failure) => failure.error),
          "Cozy Village world cleanup failed",
        );
        error.name = "CozyVillageWorldCleanupError";
        error.failures = failures;
        throw error;
      }
    },
  };
}
