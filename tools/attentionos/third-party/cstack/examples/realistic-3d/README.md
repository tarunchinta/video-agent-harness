# Realistic 3D example shot

A 2.5-second, 1280x720, 24 fps Remotion shot built entirely from the animated-video realism kit
(`skills/animated-video/templates/parts/src/kit/realism/`): a walking-pace dolly along a
flagstone path through a late-afternoon meadow, past a weathered cast-iron pump and stone trough,
toward a dry-stone wall and a line of trees in haze. Grass, flowers and leaves move in the wind,
and a drop falls from the spout every 1.3 s. Every value is seeded and every motion is driven by
the frame number, so a re-render is bit-identical.

It is a detailed procedural 3D starting point, not photographic quality, and not a recreation of
any creator's scene, code or assets. It reads as CGI; the realistic-3D style pack
(`skills/animated-video/styles/realistic-3d/README.md`, "What the kit does not do") lists the differences.

## Run it

From this folder in a cstack checkout (Node 22.6 or newer, FFmpeg on the path):

```bash
npm ci                 # pinned versions from package-lock.json
npm run kit            # copy the kit and the template's three-canvas/finish into src/kit/
npm run typecheck
npm run selftest       # CPU checks: seeded geometry, wind, shadow texel snapping, sun, camera
npm run still          # out/hero.png (frame 40)
npm run render         # out/shot.mp4
./check.sh out/check   # all of the above plus the temporal review; exits non-zero on failure
```

Outside a cstack checkout, point the copy step at one: `CSTACK=/path/to/cstack npm run kit`.
`src/kit/` is generated; edit the originals under the skill's `templates/`.

`check.sh` writes `shot.mp4`, `hero.png`, `motion.png` (one second of consecutive frames),
`sheet.png` (every tenth frame), `yavg.csv` (mean brightness per frame) and `report.txt`
(timings, frame-to-frame brightness change, re-render hashes). It fails if the type check or
self-test fails or if a re-rendered frame differs from the sequence. It cannot judge the look or
the motion: watch `shot.mp4` and read `motion.png`.

Props: `--props='{"lock":45}'` holds the camera at frame 45, so wind and water can be checked
alone (difference two frames with FFmpeg's `blend`); `--props='{"debug":true}'` prints the sky,
sun and instance counts into the frame.

## Files

- `src/set.ts` places everything: sky and sun settings (`LOOK`), instance counts (`DENSITY`,
  lower them for speed), terrain, path, wall, meadow, trees.
- `src/pump.ts` is the prop: a constructor from lathe profiles and tubes, weathered by cause.
- `src/Shot.tsx` wires the set into Remotion: one canvas, 2x supersampling, ACES exposure, the
  camera path, per-frame uniforms.
- `selftest.ts`, `check.sh` are the checks.
