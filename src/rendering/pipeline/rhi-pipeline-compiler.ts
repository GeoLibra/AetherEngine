import type { RHIDevice } from '../../rhi/contracts';
import type { PipelineCompileOutcome, PipelineCompileRequest, PipelineCompiler } from './types';
import type { PreparedRenderPipelineRegistry } from './prepared-render-pipeline-registry';

/** Renderer integration that creates RHI pipelines from previously prepared descriptors. */
export class RHIPipelineCompiler implements PipelineCompiler {
  constructor(
    private readonly device: RHIDevice,
    private readonly registry: PreparedRenderPipelineRegistry
  ) {}

  /**
   * Creates one pipeline for the asynchronous `PipelineCache` compile path.
   *
   * The method never performs shader reflection, layout selection, or descriptor preparation.
   */
  async compile(request: PipelineCompileRequest): Promise<PipelineCompileOutcome> {
    if (request.deviceGeneration !== this.device.generation)
      return failure(
        'pipeline-device-generation-mismatch',
        'Pipeline request device generation does not match the compiler device.'
      );
    let artifact;
    try {
      artifact = this.registry.resolve(request);
    } catch (error) {
      return failure('pipeline-artifact-identity-mismatch', boundedErrorMessage(error));
    }
    if (artifact === undefined)
      return failure(
        'pipeline-artifact-missing',
        `No prepared render-pipeline artifact exists for "${request.pipelineKey}".`
      );
    try {
      const pipeline = this.device.createRenderPipeline(artifact.descriptor);
      return {
        status: 'success',
        pipeline
      };
    } catch (error) {
      return failure('rhi-pipeline-creation-failed', boundedErrorMessage(error));
    }
  }
}

function failure(code: string, message: string): PipelineCompileOutcome {
  return Object.freeze({
    status: 'error',
    diagnostic: Object.freeze({ code, message: message.slice(0, 1024) })
  });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1024) || 'RHI pipeline creation failed.';
}
