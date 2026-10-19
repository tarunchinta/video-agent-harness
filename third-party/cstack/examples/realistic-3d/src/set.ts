// The set: a flagstone path through a late-afternoon meadow, past a cast-iron pump and trough,
// toward a dry-stone wall and a line of trees in haze. Everything is built from the realism kit
// (src/kit/realism, copied from the cstack parts) with fixed seeds; this file only decides what
// goes where. Units are metres; the camera looks down -z.
import {Color, DoubleSide, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PlaneGeometry, Vector3, type BufferGeometry, type WebGLRenderer} from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {fbm2, rng} from './kit/realism/noise.ts';
import {air, depthFor, leaf, patch, time, translucent, weather, wind, windDir, windStrength} from './kit/realism/shade.ts';
import {skyLight} from './kit/realism/sky.ts';
import {makeSun} from './kit/realism/sun.ts';
import {flower, instances, leafCard, scatter, tree, tuft, type Spot} from './kit/realism/plants.ts';
import {paint, rock, slab} from './kit/realism/shapes.ts';
import {pump} from './pump.ts';

export const LOOK = {elevation: 13, azimuth: 125, turbidity: 3.2, rayleigh: 1.4, mie: 0.006, mieG: 0.82, clouds: 0.35, cloudTime: 40, ground: '#3d4422', visibility: 4000, hazeHeight: 35};
export const DENSITY = {near: 60000, far: 150000, flowers: 3500, pebbles: 2400}; // tufts etc.; scale for speed

const smooth = (a: number, b: number, x: number) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
export const pathX = (z: number) => 0.55 * Math.sin(z * 0.17) + 0.04 * z;
const PUMP = new Vector3(pathX(-4) - 1.45, 0, -4);
const rawY = (x: number, z: number) => 0.2 * fbm2(x * 0.05, z * 0.05, 3) + 0.05 * fbm2(x * 0.4, z * 0.4, 4) + Math.max(0, -z - 60) * 0.05;
PUMP.y = rawY(PUMP.x, PUMP.z);
export const groundY = (x: number, z: number) => { // levelled where the pump and trough stand
  const k = smooth(1.4, 0.6, Math.hypot(x - PUMP.x - 0.2, z - PUMP.z));
  return rawY(x, z) * (1 - k) + PUMP.y * k;
};
const wear = (x: number, z: number) => (z > 4 ? 0 : smooth(0.85, 0.35, Math.abs(x - pathX(z)) + 0.15 * fbm2(x * 2, z * 2, 9)));
const wallX = (z: number) => pathX(z) - 2.6; // left of the path, its face toward the sun
const onWall = (x: number, z: number) => z < -8.8 && z > -28.2 && Math.abs(x - wallX(z)) < 0.22;
const nearPump = (x: number, z: number) => Math.hypot(x - PUMP.x - 0.2, z - PUMP.z);
export const CAM0 = new Vector3(0.45, 1.08, 3.0);
// Visible wedge (with margin for the pan toward the pump); nothing is planted behind the camera.
const inView = (x: number, z: number) => { const d = CAM0.z + 0.5 - z; return d > 0 && x > CAM0.x - (d * 0.95 + 1.5) && x < CAM0.x + d * 0.6 + 1.5; };

export const buildSet = (gl: WebGLRenderer) => {
  windDir.value.set(-0.6, -0.8);
  windStrength.value = 0.12;
  const root = new Group();
  const s = skyLight(gl, LOOK);
  root.add(s.sky);
  const sun = makeSun({direction: s.sunDir, color: s.sunColor, intensity: s.sunIntensity, center: new Vector3(-1, 0, -6), radius: 13});
  root.add(sun, sun.target);

  // Ground: compacted light dirt where feet go, dark leaf litter and moss under the grass, damp
  // around the trough.
  // Two grids: 20 cm cells where the path and trough are seen, 2.5 m cells out to the horizon
  // (sunk a few centimetres so it never shows through the near one).
  // Soil and litter shadow their own micro-facets, so they don't mirror the bright horizon at
  // grazing angles the way three's default Fresnel would: cap the grazing reflectance.
  const groundMat = patch(new MeshPhysicalMaterial({specularIntensity: 0.25}), weather({
    base: '#7b6b4d', vary: 0.35, scale: 1.2, rough: [0.82, 0.98], bump: 0.006, bumpScale: 0.06, masks: true,
    moss: {color: '#353a1a', amount: 0.9},
  }), air());
  for (const [w, d, cell, z, sink] of [[44, 34, 0.2, -12, 0], [600, 500, 2.5, -200, 0.08]]) {
    const ground = new PlaneGeometry(w, d, Math.round(w / cell), Math.round(d / cell)).rotateX(-Math.PI / 2).translate(0, 0, z);
    const gp = ground.attributes.position;
    for (let i = 0; i < gp.count; i++) gp.setY(i, groundY(gp.getX(i), gp.getZ(i)) - sink);
    ground.computeVertexNormals();
    paint(ground, (p) => { const w = wear(p.x, p.z); return [w, smooth(0.5, 0.05, nearPump(p.x, p.z) - 0.25) * 0.8, 1 - w, 0]; });
    const mesh = new Mesh(ground, groundMat);
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Flagstones: worn smooth along the middle, moss in the joints.
  const r = rng(11), slabs: BufferGeometry[] = [];
  for (let z = 3.4; z > -15; z -= 0.5 + r() * 0.22) {
    const pair = r() < 0.25;
    for (let k = 0; k < (pair ? 2 : 1); k++) {
      const w = pair ? 0.36 + r() * 0.12 : 0.55 + r() * 0.3, d = 0.36 + r() * 0.16;
      const x = pathX(z) + (pair ? (k - 0.5) * 0.42 : (r() - 0.5) * 0.18);
      const g = slab({seed: Math.floor(r() * 1e6), w, d}).rotateY(Math.atan(0.17 * 0.55 * Math.cos(z * 0.17) + 0.04) + (r() - 0.5) * 0.3);
      g.translate(x, groundY(x, z) + 0.03 - r() * 0.015, z);
      const top = groundY(x, z) + 0.015;
      slabs.push(paint(g, (p) => [0.8 * smooth(0.45, 0.05, Math.abs(p.x - pathX(p.z))), 0, p.y < top ? 0.9 : 0, 0]));
    }
  }
  const stone = (moss: number, masks = false) => patch(new MeshStandardMaterial(), weather({
    base: '#8a8577', vary: 0.25, scale: 0.4, rough: [0.6, 0.86], bump: 0.0016, bumpScale: 0.02, masks,
    chip: {color: '#a8a295', amount: 0.6, rough: 0.78}, moss: {color: '#4e5a25', amount: moss},
  }), air());
  const flags = new Mesh(mergeGeometries(slabs), stone(0.25, true));
  flags.castShadow = flags.receiveShadow = true;
  root.add(flags);

  // Dry-stone wall: three courses of seeded fieldstones, moss on the top course.
  // Flat, fractured stones laid in courses, each course set back a little (a battered face).
  const variants = Array.from({length: 8}, (_, i) => rock({seed: 100 + i, size: [0.17 + 0.05 * (i % 3), 0.06, 0.12], detail: 3, rough: 0.08, cuts: 11}));
  const wallSpots: Spot[][] = variants.map(() => []);
  const wr = rng(23);
  for (let c = 0; c < 6; c++) for (let z = -9 - (c % 2) * 0.15; z > -28; z -= 0.3 + wr() * 0.1) {
    const sc = 0.85 + wr() * 0.3;
    wallSpots[Math.floor(wr() * 8)].push({x: wallX(z) + c * 0.025 + (wr() - 0.5) * 0.04, y: groundY(wallX(z), z) + 0.06 + c * 0.125, z, rot: Math.PI / 2 + (wr() - 0.5) * 0.3, scale: sc, r: wr(), rx: (wr() - 0.5) * 0.12, rz: (wr() - 0.5) * 0.12});
  }
  const wallMat = stone(0.65);
  variants.forEach((g, i) => root.add(instances(g, wallMat, wallSpots[i], {color: (p) => new Color(0.8 + 0.3 * p.r, 0.78 + 0.28 * p.r, 0.72 + 0.25 * p.r)})));

  // Pebbles kicked to the path edges.
  const pv = Array.from({length: 4}, (_, i) => rock({seed: 200 + i, size: [1, 0.6, 0.8], detail: 2}));
  const pebbleMat = stone(0);
  const pebbles = scatter({seed: 31, count: DENSITY.pebbles, bounds: [-6, -16, 4, 3.5], ground: groundY, scale: [0.012, 0.04],
    density: (x, z) => { const d = Math.abs(x - pathX(z)); return (d > 0.45 && d < 1.1 ? 1 - Math.abs(d - 0.75) / 0.35 : 0) * (onWall(x, z) ? 0 : 1); }});
  pv.forEach((g, i) => root.add(instances(g, pebbleMat, pebbles.filter((_, k) => k % 4 === i), {color: (p) => new Color(0.8 + 0.35 * p.r, 0.78 + 0.3 * p.r, 0.7 + 0.3 * p.r)})));

  // Meadow: dry patches and taller patches come from the same broad noise, so colour and height
  // agree; trampled short round the pump; two levels of detail by distance from the camera.
  const dry = (x: number, z: number) => smooth(0.0, 0.45, fbm2(x * 0.07, z * 0.07, 41));
  const tall = (x: number, z: number) => 0.75 + 0.35 * fbm2(x * 0.2, z * 0.2, 43) - 0.25 * dry(x, z);
  const meadow = (x: number, z: number) => inView(x, z) && !onWall(x, z) ? (1 - wear(x, z)) * smooth(0.25, 0.7, nearPump(x, z)) : 0;
  const green = new Color('#4a6b1f'), straw = new Color('#9a8a48');
  const grassColor = (p: Spot) => green.clone().lerp(straw, Math.min(1, dry(p.x, p.z) + (p.r - 0.5) * 0.35)).multiplyScalar(0.8 + 0.4 * p.r);
  const heightAt = (p: Spot) => { p.scale *= tall(p.x, p.z) * (0.4 + 0.6 * smooth(0.5, 1.6, nearPump(p.x, p.z))); return p; };
  const gw = wind({amp: 1.4, flutter: 0.004});
  const grassMat = patch(new MeshStandardMaterial({vertexColors: true, side: DoubleSide, roughness: 0.5}), gw, translucent(0.9), air());
  const grassDepth = depthFor(wind({amp: 1.4, flutter: 0.004}));
  const dist = (z: number) => CAM0.z - z;
  const near = scatter({seed: 51, count: DENSITY.near, bounds: [-15, -13, 11, 3.5], ground: groundY, scale: [0.45, 0.7],
    density: (x, z) => meadow(x, z) * smooth(16, 12, dist(z))}).map(heightAt);
  const far = scatter({seed: 52, count: DENSITY.far, bounds: [-160, -150, 100, -8], ground: groundY, scale: [0.5, 0.75],
    density: (x, z) => meadow(x, z) * smooth(11, 15, dist(z)) * Math.min(1, 22 / dist(z))}).map(heightAt).map((p) => ({...p, scale: p.scale * (1 + dist(p.z) / 80)})); // fewer, bigger clumps far away
  const nearTufts = [1, 2, 3].map((k) => tuft({seed: 60 + k, blades: 7, segments: 5, width: 0.011, curl: 0.5}));
  nearTufts.forEach((g, k) => root.add(instances(g, grassMat, near.filter((_, i) => i % 3 === k), {color: grassColor, depth: grassDepth})));
  root.add(instances(tuft({seed: 70, blades: 5, segments: 3, width: 0.02, curl: 0.4}), grassMat, far, {color: grassColor, shadows: false}));

  const fr = rng(81);
  const flowerMat = patch(new MeshStandardMaterial({vertexColors: true, side: DoubleSide, roughness: 0.7}), wind({amp: 1.2}), translucent(0.5), air());
  const flowers = scatter({seed: 82, count: DENSITY.flowers, bounds: [-20, -30, 14, 3.5], ground: groundY, scale: [0.6, 0.85],
    density: (x, z) => meadow(x, z) * (1 - dry(x, z) * 0.7) * smooth(0, 0.6, fbm2(x * 0.3, z * 0.3, 83) + 0.3)}).map(heightAt);
  const tint = [new Color('#f4f1e6'), new Color('#f2d04a'), new Color('#a46bc7')];
  root.add(instances(flower({seed: 84}), flowerMat, flowers, {shadows: false, color: () => tint[fr() < 0.6 ? 0 : fr() < 0.6 ? 1 : 2]}));

  // Trees: a mid line and a far line in the haze; leaves sway with the same wind as the grass.
  const bark = patch(new MeshStandardMaterial(), weather({base: '#544a3c', vary: 0.3, scale: 0.2, rough: [0.8, 0.95], bump: 0.008, bumpScale: 0.03, moss: {color: '#4d5a2a', amount: 0.4}}), air());
  const tr = rng(91), leaves: Spot[] = [];
  const plant = (x: number, z: number, h: number, n: number, card: number) => {
    const t = tree({seed: Math.floor(tr() * 1e6), height: h, leaves: n});
    const y = groundY(x, z);
    const wood = new Mesh(t.wood, bark);
    wood.position.set(x, y, z);
    wood.castShadow = true;
    root.add(wood);
    for (const l of t.leaves) leaves.push({...l, x: l.x + x, y: l.y + y, z: l.z + z, scale: l.scale * card});
  };
  for (const [x, z, h] of [[-17, -40, 11], [-29, -55, 13], [-9, -64, 9], [13, -47, 12], [26, -60, 14], [4, -78, 10]]) plant(x, z, h, 9000, 1.2);
  for (let i = 0; i < 30; i++) plant(-110 + i * 7.5 + (tr() - 0.5) * 5, -100 - tr() * 25, 8 + tr() * 9, 3200, 2.0);
  const leafW = wind({sway: 1.2, flutter: 0.03});
  const leafMat = patch(new MeshStandardMaterial({side: DoubleSide, alphaTest: 0.5, alphaToCoverage: true, roughness: 0.62}), leafW, leaf(), translucent(0.35), air());
  const lg = ['#24391a', '#2f4a1c', '#3b5520', '#1e3216'].map((c) => new Color(c));
  root.add(instances(leafCard(0.5), leafMat, leaves, {depth: depthFor(wind({sway: 1.2, flutter: 0.03}), leaf()), color: (p) => lg[Math.floor(p.r * 4)].clone().multiplyScalar(0.85 + 0.3 * tr())}));

  const p = pump(PUMP);
  root.add(p.group);

  const update = (frame: number, fps: number) => {
    time.value = frame / fps;
    p.update(frame / fps);
  };
  return {root, envMap: s.envMap, update, sky: s, info: '', counts: {near: near.length, far: far.length, flowers: flowers.length, leaves: leaves.length, pebbles: pebbles.length}};
};
