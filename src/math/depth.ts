import type { DepthConvention } from './types';

export const STANDARD_DEPTH: DepthConvention = Object.freeze({
  mode: 'standard',
  clear: 1,
  compare: 'less'
});

export const REVERSE_DEPTH: DepthConvention = Object.freeze({
  mode: 'reverse',
  clear: 0,
  compare: 'greater'
});
