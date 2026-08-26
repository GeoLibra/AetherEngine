import type { RHIDevice, RHISubmission } from '../../rhi/contracts';
import type { RHISurfaceFrame } from '../../rhi/contracts/surface';
import { TransientResourcePool, type TransientResource } from './transient-pool';

export interface EndableRenderPass {
  end(): void;
}

export function safelyEnd(pass: EndableRenderPass | undefined): void {
  try {
    pass?.end();
  } catch {
    /* preserve the primary execution failure */
  }
}

export function safelyFinish(encoder: ReturnType<RHIDevice['createCommandEncoder']>): void {
  try {
    encoder.finish({ label: 'render-graph-failed' });
  } catch {
    /* preserve the primary execution failure */
  }
}

export function safelyReleaseFrame(frame: RHISurfaceFrame): void {
  if (frame.state !== 'acquired') return;
  try {
    frame.release();
  } catch {
    /* another surface terminal error remains primary */
  }
}

export function safelyDispose(pool: TransientResourcePool): void {
  try {
    pool.dispose();
  } catch {
    /* preserve the primary execution failure */
  }
}

export function releaseTransients(
  pool: TransientResourcePool,
  resources: readonly TransientResource[],
  submission: RHISubmission
): void {
  for (const resource of resources) pool.release(resource, submission);
}

export function safelyReleaseTransients(
  pool: TransientResourcePool,
  resources: readonly TransientResource[]
): void {
  for (const resource of resources) {
    try {
      pool.release(resource);
    } catch {
      /* preserve the primary execution failure */
    }
  }
}
