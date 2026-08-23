import {
  MaterialBindGroupCache,
  NullDevice,
  createBindingKey,
  type PreparedMaterialBindGroups
} from '../../src';
import { observation } from './reference';
import type { MaterialScenarioCase, MaterialScenarioObservation } from './types';

const BUFFER_USAGE_UNIFORM = 8;

export function createMaterialBindGroupCacheCase(options: {
  readonly lookupCount: number;
  readonly uniqueKeys: number;
}): MaterialScenarioCase {
  const fixture = createFixture(options.uniqueKeys);
  const misses = Math.min(options.lookupCount, options.uniqueKeys);
  const hits = options.lookupCount - misses;
  const semantic = Object.freeze({ lookups: options.lookupCount, misses, hits });
  return Object.freeze({
    scenarioId: 'bind-group-cache-resolution-v1',
    scenarioVersion: 1,
    caseId: `lookups-${options.lookupCount}-keys-${options.uniqueKeys}`,
    scale: Object.freeze({ lookupCount: options.lookupCount, uniqueKeys: options.uniqueKeys }),
    expected: Object.freeze({
      reference: Object.freeze({
        lookups: options.lookupCount,
        descriptorRebuilds: options.lookupCount,
        staleReuse: 0
      }),
      subject: Object.freeze({
        lookups: options.lookupCount,
        cacheHits: hits,
        cacheMisses: misses,
        rhiBindGroupCreates: misses,
        staleReuse: 0
      })
    }),
    runReference: () =>
      observation(semantic, {
        lookups: options.lookupCount,
        descriptorRebuilds: options.lookupCount,
        staleReuse: 0
      }),
    runSubject: () => runSubject(fixture, options.lookupCount)
  });
}

function runSubject(
  fixture: ReturnType<typeof createFixture>,
  lookupCount: number
): MaterialScenarioObservation {
  const cache = new MaterialBindGroupCache();
  let cacheHits = 0;
  let cacheMisses = 0;
  for (let index = 0; index < lookupCount; index += 1) {
    const prepared = fixture.prepared[index % fixture.prepared.length];
    if (prepared === undefined) throw new Error('Bind-group benchmark fixture is incomplete.');
    const resolution = cache.resolve(prepared, fixture.device);
    if (resolution.status === 'hit') cacheHits += 1;
    else cacheMisses += 1;
  }
  cache.invalidateDeviceGeneration(fixture.device.generation);
  return observation(
    { lookups: lookupCount, misses: cacheMisses, hits: cacheHits },
    {
      lookups: lookupCount,
      cacheHits,
      cacheMisses,
      rhiBindGroupCreates: cacheMisses,
      staleReuse: 0
    }
  );
}

function createFixture(uniqueKeys: number) {
  const device = new NullDevice();
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 1, buffer: { type: 'uniform', minBindingSize: 64 } }]
  });
  const buffer = device.createBuffer({ size: 64, usage: BUFFER_USAGE_UNIFORM });
  const prepared = Object.freeze(
    Array.from({ length: uniqueKeys }, (_, index): PreparedMaterialBindGroups => {
      const bindingKey = createBindingKey({
        bindingLayoutHash: 'benchmark:bind-group-layout',
        resources: [],
        bufferAllocationGeneration: index,
        ringGeneration: 1,
        dynamicOffsets: [],
        deviceGeneration: device.generation
      });
      return Object.freeze({
        bindingKey,
        groups: Object.freeze([
          Object.freeze({
            group: 0,
            descriptor: Object.freeze({
              layout,
              entries: Object.freeze([
                Object.freeze({
                  binding: 0,
                  resource: Object.freeze({ buffer, offset: 0, size: 64 })
                })
              ])
            })
          })
        ]),
        dynamicOffsets: Object.freeze([])
      });
    })
  );
  return Object.freeze({ device, prepared });
}
