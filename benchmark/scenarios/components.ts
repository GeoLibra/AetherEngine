import { defineComponent, defineTagComponent } from '../../src';

export interface BenchmarkVectorView {
  x: number;
  y: number;
}

export const BenchmarkPosition = defineComponent<BenchmarkVectorView>({
  id: 'benchmark.position',
  version: 1,
  name: 'BenchmarkPosition',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

export const BenchmarkVelocity = defineComponent<BenchmarkVectorView>({
  id: 'benchmark.velocity',
  version: 1,
  name: 'BenchmarkVelocity',
  fields: [
    { id: 'x', name: 'x', type: 'f32' },
    { id: 'y', name: 'y', type: 'f32' }
  ]
});

export const BenchmarkSelected = defineTagComponent({
  id: 'benchmark.selected',
  version: 1,
  name: 'BenchmarkSelected'
});
