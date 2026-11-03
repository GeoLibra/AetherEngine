import { expect, test } from 'vitest';
import { baselineLightingFixture } from '../../benchmark/render-world/baseline-lighting-scenario';

for (const depthMode of ['standard', 'reverse'] as const) {
  test(`prepares clustered lighting for an infinite-far ${depthMode} camera`, async () => {
    const { runtime, world } = baselineLightingFixture({
      far: 'infinite',
      depthMode,
      clustered: true
    });
    try {
      runtime.prepare(world);
      expect(runtime.frame()).toMatchObject({ status: 'rendered', indexedDrawCalls: 1 });
    } finally {
      await runtime.dispose();
    }
  });
}

test('retains off-camera spot casters while excluding disabled, masked, and out-of-light meshes', async () => {
  const { runtime, world, addMesh } = baselineLightingFixture({
    light: 'spot',
    cameraLayerMask: 3
  });
  addMesh(3, 0, -2, 2);
  addMesh(3, 0, -2, 1, false);
  addMesh(3, 0, 4);
  try {
    runtime.prepare(world);
    // One camera-visible draw plus two light-visible casters, including the off-camera box.
    expect(runtime.frame()).toMatchObject({
      status: 'rendered',
      indexedDrawCalls: 3,
      indexCount: 108
    });
  } finally {
    await runtime.dispose();
  }
});

test('selects off-camera point casters independently for each cube face', async () => {
  const { runtime, world } = baselineLightingFixture({ light: 'point' });
  try {
    runtime.prepare(world);
    // The visible box straddles -X/-Z; the off-camera box occupies only -Z.
    expect(runtime.frame()).toMatchObject({
      status: 'rendered',
      indexedDrawCalls: 4,
      indexCount: 144
    });
  } finally {
    await runtime.dispose();
  }
});
