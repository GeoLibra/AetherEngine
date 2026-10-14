import { expect, test } from 'vitest';
import { App, HeadlessRunner, MinimalPlugins, createResidencyPressurePlugin } from '../../src';
import { AssetPayloadRegistry } from '../../src/assets/runtime';
import { PreparedAssetRegistry } from '../../src/rendering/world';

test('runs residency budget enforcement once per completed App frame', async () => {
  let reads = 0;
  const results: unknown[] = [];
  const app = new App().addPlugins(new MinimalPlugins()).addPlugin(
    createResidencyPressurePlugin({
      payloads: new AssetPayloadRegistry(),
      prepared: new PreparedAssetRegistry(),
      frame() {
        reads += 1;
        return {
          cpuBudgetBytes: 0,
          gpuBudgets: [{ deviceGeneration: 1, budgetBytes: 0 }],
          subjects: []
        };
      },
      onResult(result) {
        results.push(result);
      }
    })
  );
  await app.run(new HeadlessRunner({ frames: 2 }));
  expect(reads).toBe(2);
  expect(results).toEqual(
    Array.from({ length: 2 }, () => ({
      cpu: { releasedBytes: 0, remainingPressureBytes: 0 },
      gpu: [{ deviceGeneration: 1, releasedBytes: 0, remainingPressureBytes: 0 }]
    }))
  );
});
