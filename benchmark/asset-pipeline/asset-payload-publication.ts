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
  cycleLeases(count: number): Readonly<{ acquisitions: number; releases: number; bytes: number }>;
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
  const leaseRegistry = new AssetPayloadRegistry({
    cpuResidentByteBudget: source.positions.byteLength
  });
  const leaseHandle = createAssetHandle(meshType, `mesh:benchmark-lease-${vertexCount}`);
  leaseRegistry.register(leaseHandle);
  leaseRegistry.publish(
    leaseHandle,
    {
      version: 1,
      contentHash: 'sha256:benchmark-lease',
      byteLength: source.positions.byteLength,
      value: source,
      dependencies: []
    },
    (value) => Object.freeze({ positions: value.positions.slice() })
  );
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
        {
          version: 1,
          contentHash: 'sha256:benchmark-payload',
          byteLength: source.positions.byteLength,
          value: source,
          dependencies: []
        },
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
    },
    cycleLeases(count) {
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error('Asset payload lease benchmark count must be a positive safe integer.');
      }
      for (let index = 0; index < count; index++) {
        const lease = leaseRegistry.acquire(leaseHandle);
        if (lease === undefined || lease.payload.version !== 1) {
          throw new Error('Asset payload lease benchmark failed to pin the current revision.');
        }
        lease.dispose();
      }
      if (leaseRegistry.residentBytes !== source.positions.byteLength) {
        throw new Error('Asset payload lease benchmark changed resident-byte accounting.');
      }
      return Object.freeze({
        acquisitions: count,
        releases: count,
        bytes: leaseRegistry.residentBytes
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
