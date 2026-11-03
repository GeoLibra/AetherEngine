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
      pressure: 'normal',
      cpu: { releasedBytes: 0, remainingPressureBytes: 0 },
      gpu: [{ deviceGeneration: 1, releasedBytes: 0, remainingPressureBytes: 0 }]
    }))
  );
});

test('automatically drives scheduler pressure through pinned, reclaimed and recovered frames', async () => {
  const prepared = new PreparedAssetRegistry();
  const key = {
    assetId: 'asset:pressure',
    payloadVersion: 1,
    deviceGeneration: 1,
    featurePolicyKey: 'default',
    abiVersion: 'v1'
  };
  prepared.publish({ key, value: { byteLength: 16 } });
  const lease = prepared.acquire(key)!;
  const levels: string[] = [];
  const app = new App().addPlugins(new MinimalPlugins()).addPlugin(
    createResidencyPressurePlugin({
      payloads: new AssetPayloadRegistry(),
      prepared,
      scheduler: {
        setPressure(level) {
          levels.push(level);
        }
      },
      frame: () => ({
        cpuBudgetBytes: 0,
        gpuBudgets: [{ deviceGeneration: 1, budgetBytes: 0 }],
        subjects: [
          {
          handle: { assetId: 'asset:pressure', type: 'asset.pressure' } as never,
            gpuVariants: [key],
            priority: 0,
            lastUseTick: 1,
            rebuildCost: 1
          }
        ]
      }),
      onResult() {
        lease.dispose();
      }
    })
  );
  await app.run(new HeadlessRunner({ frames: 3 }));
  expect(levels).toEqual(['critical', 'constrained', 'normal']);
});
