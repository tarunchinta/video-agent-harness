import {Config} from '@remotion/cli/config';
// GPU WebGL in headless Chrome (ANGLE). Without it three.js falls back to a software renderer.
Config.setChromiumOpenGlRenderer('angle');
Config.setConcurrency(1);
