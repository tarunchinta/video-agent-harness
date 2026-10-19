import React from 'react';
import {Composition} from 'remotion';
import {Shot} from './Shot';

export const Root: React.FC = () => (
  <Composition id="Shot" component={Shot} durationInFrames={60} fps={24} width={1280} height={720} />
);
