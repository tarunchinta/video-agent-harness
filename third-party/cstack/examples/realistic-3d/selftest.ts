// Self-check of the realism kit's CPU side: seeded geometry and placement, frame-driven wind,
// texel-snapped shadows, the sun model and the camera ease. `npm run selftest` (Node 22.6+).
// GPU behaviour (shaders, PMREM, determinism of rendered frames) is checked by check.sh.
import {PerspectiveCamera, Vector3} from 'three';
import {fbm2, rng} from './src/kit/realism/noise.ts';
import {scatter, tree, tuft} from './src/kit/realism/plants.ts';
import {rock, slab} from './src/kit/realism/shapes.ts';
import {windAt} from './src/kit/realism/shade.ts';
import {followSun, makeSun} from './src/kit/realism/sun.ts';
import {sunColor} from './src/kit/realism/sky.ts';
import {move, track} from './src/kit/realism/camera.ts';

// Tiny assert so the check needs no Node type definitions.
const assert = Object.assign((c: unknown, m = 'check failed') => { if (!c) throw new Error(m); }, {
  ok: (c: unknown, m = 'check failed') => { if (!c) throw new Error(m); },
  equal: (a: unknown, b: unknown) => { if (a !== b) throw new Error(`${a} !== ${b}`); },
  notEqual: (a: unknown, b: unknown) => { if (a === b) throw new Error(`${a} === ${b}`); },
  deepEqual: (a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('not deep-equal'); },
  notDeepEqual: (a: unknown, b: unknown) => { if (JSON.stringify(a) === JSON.stringify(b)) throw new Error('deep-equal'); },
});
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

// Seeds: same seed, same result; different seed, different result.
assert.equal(rng(5)(), rng(5)());
assert.notEqual(rng(5)(), rng(6)());
assert.equal(fbm2(1.3, 2.7, 4), fbm2(1.3, 2.7, 4));
const box: [number, number, number, number] = [-5, -5, 5, 5];
const half = (x: number) => (x < 0 ? 1 : 0);
const a = scatter({seed: 1, count: 500, bounds: box, density: half}), b = scatter({seed: 1, count: 500, bounds: box, density: half});
assert.deepEqual(a, b);
assert.notDeepEqual(a, scatter({seed: 2, count: 500, bounds: box, density: half}));
assert.equal(a.length, 500);
assert.ok(a.every((s) => s.x < 0), 'density 0 keeps nothing');

// Plants: deterministic, roots fixed (bend 0 at y 0), tips free (bend 1).
const t1 = tuft({seed: 3}), t2 = tuft({seed: 3});
assert.ok(same(t1.attributes.position.array, t2.attributes.position.array));
const pos = t1.attributes.position, bend = t1.attributes.bend;
for (let i = 0; i < pos.count; i++) {
  assert.ok(bend.getX(i) >= 0 && bend.getX(i) <= 1);
  if (bend.getX(i) === 0) assert.ok(Math.abs(pos.getY(i)) < 0.01, 'roots sit on the ground');
}
const tr = tree({seed: 4, leaves: 300});
assert.equal(tr.leaves.length, 300);
assert.ok(same(tr.wood.attributes.position.array, tree({seed: 4, leaves: 300}).wood.attributes.position.array));

// Shapes: deterministic, and the edge mask finds edges but not everywhere.
const r1 = rock({seed: 9}), e = r1.attributes.edge.array as Float32Array;
assert.ok(same(r1.attributes.position.array, rock({seed: 9}).attributes.position.array));
assert.ok(!same(r1.attributes.position.array, rock({seed: 10}).attributes.position.array));
const sharp = Array.from(e).filter((v) => v > 0.5).length / e.length;
assert.ok(sharp > 0.02 && sharp < 0.6, `rock edge fraction ${sharp}`);
const s1 = slab({seed: 2, w: 0.6, d: 0.4});
const se = Array.from(s1.attributes.edge.array as Float32Array);
assert.ok(se.some((v) => v > 0.8) && se.some((v) => v < 0.1), 'slab has edges and flat faces');

// Wind: a pure function of position and time; moves, but never jumps between 24 fps frames.
assert.deepEqual(windAt(3, -2, 1.25), windAt(3, -2, 1.25));
let maxStep = 0, lo = Infinity, hi = -Infinity;
for (let f = 0; f < 240; f++) for (const [x, z] of [[0, 0], [5, -9], [-12, 3]]) {
  const [ax, az] = windAt(x, z, f / 24), [bx, bz] = windAt(x, z, (f + 1) / 24);
  maxStep = Math.max(maxStep, Math.hypot(bx - ax, bz - az));
  lo = Math.min(lo, Math.hypot(ax, az)); hi = Math.max(hi, Math.hypot(ax, az));
}
assert.ok(hi - lo > 0.03, 'gusts vary');
assert.ok(maxStep < 0.25 * hi, `per-frame wind step ${maxStep} vs peak ${hi}`);

// Shadows: a moving centre lands the shadow camera on the texel grid, so edges don't crawl.
const sun = makeSun({direction: new Vector3(0.8, 0.25, -0.5).normalize(), color: sunColor({elevation: 13, azimuth: 125}).color, intensity: 1, center: new Vector3(), radius: 10, mapSize: 1024});
const texel = 20 / 1024, d = new Vector3(0.8, 0.25, -0.5).normalize();
const x = new Vector3(0, 1, 0).cross(d).normalize(), y = d.clone().cross(x);
for (const c of [new Vector3(0.013, 0, 0.21), new Vector3(1.7, 0.1, -3.33)]) {
  const p = followSun(sun, c);
  for (const axis of [x, y]) { const k = p.dot(axis) / texel; assert.ok(Math.abs(k - Math.round(k)) < 1e-6, 'snapped to texel'); }
  assert.ok(p.distanceTo(c) < texel * 2, 'snap moves less than a texel or so');
}

// Sun: redder and weaker as it sinks; camera ease starts and stops at rest.
const hi13 = sunColor({elevation: 40, azimuth: 0}), lo13 = sunColor({elevation: 8, azimuth: 0});
assert.ok(lo13.color.b / lo13.color.r < hi13.color.b / hi13.color.r && lo13.intensity < hi13.intensity);
assert.equal(move(0, 0, 10), 0); assert.equal(move(10, 0, 10), 1);
assert.ok(move(1, 0, 10) - move(0, 0, 10) < move(5, 0, 10) - move(4, 0, 10), 'eases in');
const cam = new PerspectiveCamera(50, 16 / 9);
track(cam, 0.5, {path: [new Vector3(0, 1, 0), new Vector3(0, 1, -2)], look: [new Vector3(0, 1, -5)], mm: 35});
assert.ok(Math.abs(cam.position.z + 1) < 1e-6 && Math.abs(cam.getFocalLength() - 35) < 1e-6);

console.log('selftest ok');
