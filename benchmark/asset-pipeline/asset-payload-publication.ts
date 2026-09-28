import { createAssetHandle, defineAssetType } from '../../src/assets/asset-handle';
import { AssetPayloadRegistry } from '../../src/assets/runtime';

interface MeshCpuPayload {
  readonly positions: Float32Array;
}

const meshType = defineAssetType<MeshCpuPayload>('asset.benchmark-mesh-payload');

/** Creates deterministic CPU-payload copy and publication scenarios for one mesh scale. */
export function createAssetPayloadPublicationFixture(vertexCount: number): Readonly<{
  source: MeshCpuPayload;
  expectedChecksum: number;
  copyReference(): MeshCpuPayload;
  publish(): Readonly<{ bytes: number; checksum: number; owned: boolean }>;
}> {
  if (!Number.isSafeInteger(vertexCount) || vertexCount <= 0) {
    throw new Error('Asset payload benchmark vertex count must be a positive safe integer.');
  }
  const positions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < positions.length; index++) {
    positions[index] = ((index * 17) % 1021) / 1021;
  }
  const source = Object.freeze({ positions });
  const expectedChecksum = checksum(positions);
  return Object.freeze({
    source,
    expectedChecksum,
    copyReference() {
      const copy = Object.freeze({ positions: positions.slice() });
      return copy;
    },
    publish() {
      const registry = new AssetPayloadRegistry();
      const handle = createAssetHandle(meshType, `mesh:benchmark-payload-${vertexCount}`);
      registry.register(handle);
      const payload = registry.publish(
        handle,
        { version: 1, contentHash: 'sha256:benchmark-payload', value: source, dependencies: [] },
        (value) => Object.freeze({ positions: value.positions.slice() })
      );
      const resolved = registry.resolve(handle);
      if (resolved.kind !== 'available' || resolved.payload !== payload) {
        throw new Error('Asset payload benchmark publication was not resolvable.');
      }
      return Object.freeze({
        bytes: payload.value.positions.byteLength,
        checksum: checksum(payload.value.positions),
        owned: payload.value.positions.buffer !== source.positions.buffer
      });
    }
  });
}

function checksum(values: Float32Array): number {
  let result = 0;
  for (let index = 0; index < values.length; index++) {
    result = (result * 33 + Math.round(values[index]! * 1021)) >>> 0;
  }
  return result;
}
