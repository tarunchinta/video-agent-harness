import React, {useEffect, useMemo, useState} from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {useThree} from '@react-three/fiber';
import {ACESFilmicToneMapping, type PerspectiveCamera} from 'three';
import {ThreeCanvas} from './kit/three-canvas';
import {Finish} from './kit/finish';
import {move, track} from './kit/realism/camera.ts';
import {buildSet, CAM0} from './set.ts';
import {Vector3} from 'three';

export const EXPOSURE = 0.24;
// A walking-pace dolly past the pump: the clip is the middle of a longer eased move, so the
// camera is already travelling at frame 0 and still travelling at the last frame.
const CAM = {
  path: [CAM0, new Vector3(0.25, 1.1, 1.0), new Vector3(-0.15, 1.02, -1.2)],
  look: [new Vector3(-1.2, 0.7, -6.0), new Vector3(-1.6, 0.74, -5.0), new Vector3(-1.95, 0.8, -4.1)],
  mm: 30,
};

const World: React.FC<{onInfo?: (s: string) => void; lock?: number}> = ({onInfo, lock}) => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const set = useMemo(() => {
    const t0 = performance.now(), s = buildSet(gl);
    const c = (x: {r: number; g: number; b: number}) => [x.r, x.g, x.b].map((v) => +v.toFixed(3));
    s.info = JSON.stringify(({buildMs: Math.round(performance.now() - t0), ...s.counts, sun: s.sky.sunIntensity, sunColor: c(s.sky.sunColor), horizon: c(s.sky.horizon), horizonSun: c(s.sky.horizonSun), skyIrradiance: c(s.sky.skyIrradiance)}));
    return s;
  }, [gl]);
  useEffect(() => onInfo?.(set.info), [set, onInfo]);
  // Per frame: uniforms and transforms only, all from the frame number.
  scene.environment = set.envMap;
  set.update(frame, fps);
  // `lock` holds the camera at that frame, so wind and water can be checked without the dolly.
  track(camera, move(lock ?? frame, -durationInFrames * 0.6, durationInFrames * 1.6), CAM);
  return <primitive object={set.root} />;
};

export const Shot: React.FC<{debug?: boolean; lock?: number}> = ({debug, lock}) => {
  const frame = useCurrentFrame();
  const [info, setInfo] = useState('');
  const {width, height} = useVideoConfig();
  return (
    <AbsoluteFill style={{background: '#000'}}>
      {/* Tone mapping happens once, in three (ACES); Finish adds only vignette and grain. */}
      <Finish fr={frame} bloom={0}>
        <ThreeCanvas width={width} height={height} dpr={2} shadows="percentage" gl={{antialias: true}}
          camera={{near: 0.05, far: 3000}}
          onCreated={({gl}) => { gl.toneMapping = ACESFilmicToneMapping; gl.toneMappingExposure = EXPOSURE; }}>
          <World onInfo={debug ? setInfo : undefined} lock={lock} />
        </ThreeCanvas>
      </Finish>
      {debug && <pre style={{position: 'absolute', left: 16, bottom: 16, margin: 0, color: '#fff', font: '14px monospace', whiteSpace: 'pre-wrap', width: 900}}>{info}</pre>}
    </AbsoluteFill>
  );
};
