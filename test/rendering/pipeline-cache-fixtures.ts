import { vi } from 'vitest';
import type { RHIRenderPipeline, RHISubmission, SubmissionResult } from '../../src/rhi/contracts';

export function disposablePipeline(
  id: number
): RHIRenderPipeline & { dispose: ReturnType<typeof vi.fn> } {
  return {
    id,
    generation: 4,
    kind: 'render-pipeline',
    state: 'valid',
    label: `pipeline:${id}`,
    dispose: vi.fn()
  } as unknown as RHIRenderPipeline & { dispose: ReturnType<typeof vi.fn> };
}

export function deferredSubmission(id: number) {
  let status: RHISubmission['status'] = 'pending';
  let resolvePromise!: (result: SubmissionResult) => void;
  const done = new Promise<SubmissionResult>((resolve) => {
    resolvePromise = resolve;
  });
  const value: RHISubmission = {
    id,
    get status() {
      return status;
    },
    done
  };
  return {
    value,
    resolve(result: SubmissionResult) {
      status = result.status;
      resolvePromise(result);
    }
  };
}
