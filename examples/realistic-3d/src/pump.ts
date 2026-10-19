// A cast-iron hand pump on a stone plinth with a stone trough: the shot's manufactured foreground
// prop. Built from lathe profiles and tubes in real units, then weathered from its causes: paint
// chips on the edges hands and weather hit, rust bleeding down from bolts and nuts onto the iron
// and the stone, grime splashed up from the ground, dust on top faces, a hand-polished handle
// grip, and a wet, mossy trough under the spout.
import {CatmullRomCurve3, Color, CylinderGeometry, Group, LatheGeometry, Mesh, MeshStandardMaterial, SphereGeometry, TorusGeometry, TubeGeometry, Vector2, Vector3, type BufferGeometry} from 'three';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {RoundedBoxGeometry} from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import {air, patch, weather} from './kit/realism/shade.ts';
import {edges, paint} from './kit/realism/shapes.ts';

const PLINTH = 0.36; // plinth height (m); the pump stands on it
const BODY: [number, number][] = [ // (radius, height) profile of the column, bottom to top
  [0, 0], [0.155, 0], [0.155, 0.022], [0.145, 0.03], [0.118, 0.04], [0.104, 0.065], [0.094, 0.1], [0.09, 0.28],
  [0.1, 0.29], [0.1, 0.32], [0.09, 0.33], [0.086, 0.5], [0.09, 0.66], [0.098, 0.74], [0.108, 0.75], [0.108, 0.79],
  [0.096, 0.8], [0.088, 0.84], [0.112, 0.85], [0.112, 0.885], [0.092, 0.91], [0.062, 0.96], [0.032, 0.99], [0.022, 1.02],
  [0.036, 1.045], [0.034, 1.065], [0.018, 1.08], [0, 1.085],
];

export const pump = (at: Vector3) => {
  const g = new Group();
  g.position.copy(at);
  const top = PLINTH;
  const w = (v: Vector3) => v.clone().add(at); // local -> world, for streak sources

  // Where rust and water run from: four flange bolts, three nuts on the upper ring, the spout lip.
  const bolts = [0, 1, 2, 3].map((i) => new Vector3(Math.cos(i * Math.PI / 2 + 0.785) * 0.132, top + 0.03, Math.sin(i * Math.PI / 2 + 0.785) * 0.132));
  const nuts = [0, 1, 2].map((i) => new Vector3(Math.cos(i * 2.094 + 0.4) * 0.11, top + 0.77, Math.sin(i * 2.094 + 0.4) * 0.11));
  const lip = new Vector3(0.37, top + 0.5, 0);

  const iron = patch(new MeshStandardMaterial({metalness: 0.05}), weather({
    base: '#2f4a37', vary: 0.2, scale: 0.18, rough: [0.4, 0.68], bump: 0.0005, bumpScale: 0.008,
    chip: {color: '#6b3418', rough: 0.95, amount: 0.75}, dust: {color: '#9a8a68', amount: 0.7},
    grime: {color: '#2a2219', height: 0.18, ground: at.y + top, amount: 0.8},
    streaks: {color: '#6a3519', sources: [...bolts, ...nuts, lip].map(w), width: 0.016, length: 0.32, amount: 1},
  }), air());

  const body = edges(new LatheGeometry(BODY.map(([r, y]) => new Vector2(r, y + top)), 64), 0.012);
  const boltG = mergeGeometries([...bolts, ...nuts].map((p, i) => {
    const b = new CylinderGeometry(0.013, 0.013, i < 4 ? 0.014 : 0.018, 6);
    if (i >= 4) b.rotateZ(Math.PI / 2).rotateY(-Math.atan2(p.z, p.x));
    return b.translate(p.x, p.y, p.z);
  }));
  edges(boltG, 0.004);
  const spoutPath = new CatmullRomCurve3([new Vector3(0.05, top + 0.63, 0), new Vector3(0.2, top + 0.62, 0), new Vector3(0.32, top + 0.57, 0), new Vector3(0.37, top + 0.51, 0)]);
  const spout = edges(mergeGeometries([new TubeGeometry(spoutPath, 32, 0.026, 16), new TorusGeometry(0.028, 0.007, 8, 24).rotateX(Math.PI / 2).translate(lip.x, lip.y + 0.004, 0)]), 0.01);
  const yoke = edges(mergeGeometries([-1, 1].map((s) => new RoundedBoxGeometry(0.11, 0.13, 0.014, 2, 0.004).translate(-0.02, top + 1.0, s * 0.03))), 0.002);
  g.add(new Mesh(body, iron), new Mesh(boltG, iron), new Mesh(spout, iron), new Mesh(yoke, iron));

  // The handle: painted iron, rubbed to bare metal toward the grip (wear mask from the grip end).
  const arm = new CatmullRomCurve3([new Vector3(0.02, top + 1.02, 0), new Vector3(-0.22, top + 1.06, 0), new Vector3(-0.46, top + 0.98, 0), new Vector3(-0.6, top + 0.84, 0)]);
  const grip = new Vector3(-0.6, top + 0.84, 0);
  const handle = paint(edges(new TubeGeometry(arm, 48, 0.015, 12), 0.01), (p) => {
    const k = Math.max(0, 1 - p.distanceTo(grip) / 0.28);
    return [k, 0, 0, 0];
  });
  const handleMat = patch(new MeshStandardMaterial({metalness: 0.05}), weather({
    base: '#2c4634', vary: 0.12, scale: 0.25, rough: [0.42, 0.62], bump: 0.0004, bumpScale: 0.008, masks: true,
    chip: {color: '#6b3418', rough: 0.9, amount: 0.7}, dust: {color: '#9a8a68', amount: 0.5},
  }), air());
  const knob = new Mesh(new SphereGeometry(0.032, 24, 16).translate(grip.x - 0.01, grip.y - 0.02, 0), patch(new MeshStandardMaterial({metalness: 1, color: '#6a645c'}), weather({base: '#ffffff', vary: 0.1, scale: 0.05, rough: [0.28, 0.4], bump: 0.0002, bumpScale: 0.004}), air()));
  const pin = new Mesh(new CylinderGeometry(0.009, 0.009, 0.09, 12).rotateX(Math.PI / 2).translate(0.02, top + 1.02, 0), iron);
  g.add(new Mesh(handle, handleMat), knob, pin);

  // Stone: a plinth with rust run down from the bolts and a moss line; a trough kept wet by the spout.
  const stone = (wet: number, extra: Vector3[] = []) => patch(new MeshStandardMaterial(), weather({
    base: '#8d877a', vary: 0.18, scale: 0.6, rough: [0.6, 0.9], bump: 0.003, bumpScale: 0.02, wet,
    chip: {color: '#b3ad9f', amount: 0.6, rough: 0.8}, moss: {color: '#4c5a24', amount: 0.8},
    grime: {color: '#3b3326', height: 0.14, ground: at.y, amount: 0.75},
    streaks: {color: '#6e3c1d', sources: [...bolts.map((b) => w(new Vector3(Math.sign(b.x) * 0.222, top, Math.sign(b.z) * 0.222))), ...extra], width: 0.035, length: 0.25, amount: 0.9},
  }), air());
  const plinth = new Mesh(edges(new RoundedBoxGeometry(0.46, PLINTH, 0.46, 3, 0.02).translate(0, PLINTH / 2, 0), 0.02), stone(0));

  const T = {x: 0.42, w: 0.72, d: 0.42, h: 0.34, wall: 0.06}; // trough under the spout
  const parts: BufferGeometry[] = [
    new RoundedBoxGeometry(T.w, 0.08, T.d, 2, 0.015).translate(T.x, 0.04, 0),
    new RoundedBoxGeometry(T.w, T.h, T.wall, 2, 0.015).translate(T.x, T.h / 2, T.d / 2 - T.wall / 2),
    new RoundedBoxGeometry(T.w, T.h, T.wall, 2, 0.015).translate(T.x, T.h / 2, -T.d / 2 + T.wall / 2),
    new RoundedBoxGeometry(T.wall, T.h, T.d, 2, 0.015).translate(T.x - T.w / 2 + T.wall / 2, T.h / 2, 0),
    new RoundedBoxGeometry(T.wall, T.h, T.d, 2, 0.015).translate(T.x + T.w / 2 - T.wall / 2, T.h / 2, 0),
  ];
  const trough = new Mesh(edges(mergeGeometries(parts), 0.015), stone(0.35, [w(new Vector3(T.x + 0.3, T.h, 0.15)), w(new Vector3(T.x - 0.1, T.h, -0.2))]));
  const water = new Mesh(new RoundedBoxGeometry(T.w - 2 * T.wall + 0.01, 0.01, T.d - 2 * T.wall + 0.01, 1, 0.004).translate(T.x, T.h - 0.04, 0),
    patch(new MeshStandardMaterial({color: new Color(0.012, 0.016, 0.014), roughness: 0.04, metalness: 0}), air()));
  for (const m of [plinth, trough, water]) g.add(m);
  g.traverse((o) => { if ((o as Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  water.castShadow = false;

  // A drop falls from the lip about every 1.3 s and rings out on the water: motion from a cause,
  // played from the frame number.
  const drop = new Mesh(new SphereGeometry(0.006, 12, 8), patch(new MeshStandardMaterial({color: '#9ab0b0', roughness: 0.05}), air()));
  const ring = new Mesh(new TorusGeometry(1, 0.08, 6, 48).rotateX(Math.PI / 2), new MeshStandardMaterial({color: '#c9d6d6', roughness: 0.1, transparent: true, opacity: 0}));
  g.add(drop, ring);
  const surface = T.h - 0.034, fall = Math.sqrt((2 * (lip.y - surface)) / 9.81), period = 1.3;
  const update = (t: number) => {
    const c = (t + 0.55) % period, hang = 0.6; // the drop swells on the lip, then falls
    drop.visible = c < hang + fall;
    const ft = Math.max(0, c - hang);
    drop.position.set(lip.x, lip.y - 0.008 - 0.5 * 9.81 * ft * ft, 0);
    drop.scale.setScalar(c < hang ? 0.4 + 0.6 * (c / hang) : 1);
    const rt = c - hang - fall;
    ring.visible = rt > 0;
    ring.position.set(lip.x, surface + 0.006, 0);
    ring.scale.set(0.004 + rt * 0.14, 1, 0.004 + rt * 0.14).multiply(new Vector3(1, 0.05, 1));
    (ring.material as MeshStandardMaterial).opacity = Math.max(0, 0.5 * (1 - rt / 0.6));
  };
  return {group: g, update, lip: w(lip)};
};
