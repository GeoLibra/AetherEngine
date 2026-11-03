import type { AssetPipelineUploadCandidate } from '../../assets/request-scheduler';
import type { RHISubmission } from '../../rhi';
import type { PreparedAsset, PreparedAssetLease, PreparedAssetRegistry } from '../world';
import { disposePreparedMesh } from './mesh-prepare';
import type { PreparedMesh } from './types';

/** Keeps a staged mesh set private until a validated scheduler commit publishes it together. */
export function createMeshUploadCandidate(
  assets: readonly PreparedAsset<PreparedMesh>[],
  submission: RHISubmission,
  registry: PreparedAssetRegistry,
  onCleanupError: (error: unknown) => void
): AssetPipelineUploadCandidate {
  let published = false;
  let discarded = false;
  return Object.freeze({
    status: 'staged' as const,
    commit() {
      if (discarded || published) throw new Error('Mesh upload candidate is no longer staged.');
      registry.publishBatch(assets, disposePreparedMesh);
      published = true;
      const leases: PreparedAssetLease<PreparedMesh>[] = [];
      try {
        for (const asset of assets) {
          const lease = registry.acquire<PreparedMesh>(asset.key);
          if (lease === undefined) throw new Error('Published mesh variant was not acquirable.');
          leases.push(lease);
        }
        for (const lease of leases) lease.retainUntil(submission);
      } finally {
        for (const lease of leases) lease.dispose();
      }
    },
    discard() {
      if (discarded) return;
      discarded = true;
      const cleanup = () => {
        const errors: unknown[] = [];
        for (const asset of assets) {
          try {
            if (published) registry.retire(asset.key);
            else disposePreparedMesh(asset.value);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, 'Mesh upload cleanup failed.');
      };
      // A stale candidate retains every physical buffer until its submission is terminal.
      void submission.done.then(cleanup, cleanup).catch(onCleanupError);
    }
  });
}
