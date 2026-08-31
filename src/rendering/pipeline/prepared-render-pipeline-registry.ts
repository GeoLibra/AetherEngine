import type {
  GPUFragmentState,
  GPUVertexState,
  RHIRenderPipelineDescriptor
} from '../../rhi/contracts';
import { createPipelineCompileRequest } from './pipeline-cache';
import type { PipelineCompileRequest, PreparedRenderPipelineArtifact } from './types';

/** Preparation-owned registry joining canonical pipeline identities to RHI creation inputs. */
export class PreparedRenderPipelineRegistry {
  private readonly artifacts = new Map<string, PreparedRenderPipelineArtifact>();

  /**
   * Retains a defensive descriptor snapshot for one exact compile identity.
   *
   * @throws When a canonical key is already associated with different identity facts.
   */
  register(
    input: PipelineCompileRequest,
    descriptor: RHIRenderPipelineDescriptor
  ): PreparedRenderPipelineArtifact {
    const request = createPipelineCompileRequest(input);
    const existing = this.artifacts.get(request.pipelineKey);
    if (existing !== undefined) {
      assertSameIdentity(existing.request, request);
      return existing;
    }
    const artifact = Object.freeze({
      request,
      descriptor: snapshotDescriptor(descriptor)
    });
    this.artifacts.set(request.pipelineKey, artifact);
    return artifact;
  }

  /** Returns the prepared input for an exact request, or undefined when preparation has not run. */
  resolve(input: PipelineCompileRequest): PreparedRenderPipelineArtifact | undefined {
    const request = createPipelineCompileRequest(input);
    const artifact = this.artifacts.get(request.pipelineKey);
    if (artifact !== undefined) assertSameIdentity(artifact.request, request);
    return artifact;
  }

  /** Removes preparation artifacts owned by a lost device generation. */
  invalidateDeviceGeneration(deviceGeneration: number): number {
    let invalidated = 0;
    for (const [pipelineKey, artifact] of this.artifacts) {
      if (artifact.request.deviceGeneration !== deviceGeneration) continue;
      this.artifacts.delete(pipelineKey);
      invalidated += 1;
    }
    return invalidated;
  }
}

function assertSameIdentity(left: PipelineCompileRequest, right: PipelineCompileRequest): void {
  if (
    left.pipelineKey !== right.pipelineKey ||
    left.requestRevision !== right.requestRevision ||
    left.shaderRevision !== right.shaderRevision ||
    left.layoutRevision !== right.layoutRevision ||
    left.featurePolicyHash !== right.featurePolicyHash ||
    left.deviceGeneration !== right.deviceGeneration
  )
    throw new Error('Prepared render pipeline key has different identity facts.');
}

function snapshotDescriptor(
  descriptor: RHIRenderPipelineDescriptor
): Readonly<RHIRenderPipelineDescriptor> {
  return Object.freeze({
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    ...(descriptor.layout === undefined ? {} : { layout: descriptor.layout }),
    ...(descriptor.vertex === undefined ? {} : { vertex: snapshotVertex(descriptor.vertex) }),
    ...(descriptor.primitive === undefined
      ? {}
      : { primitive: Object.freeze({ ...descriptor.primitive }) }),
    ...(descriptor.depthStencil === undefined
      ? {}
      : { depthStencil: Object.freeze({ ...descriptor.depthStencil }) }),
    ...(descriptor.multisample === undefined
      ? {}
      : { multisample: Object.freeze({ ...descriptor.multisample }) }),
    ...(descriptor.fragment === undefined
      ? {}
      : { fragment: snapshotFragment(descriptor.fragment) })
  });
}

function snapshotVertex(vertex: GPUVertexState): GPUVertexState {
  return Object.freeze({
    module: vertex.module,
    ...(vertex.entryPoint === undefined ? {} : { entryPoint: vertex.entryPoint }),
    ...(vertex.constants === undefined
      ? {}
      : { constants: Object.freeze({ ...vertex.constants }) }),
    ...(vertex.buffers === undefined
      ? {}
      : {
          buffers: Object.freeze(
            vertex.buffers.map((buffer) =>
              buffer === null
                ? null
                : Object.freeze({
                    ...buffer,
                    attributes: Object.freeze(
                      buffer.attributes.map((attribute) => Object.freeze({ ...attribute }))
                    )
                  })
            )
          )
        })
  });
}

function snapshotFragment(fragment: GPUFragmentState): GPUFragmentState {
  return Object.freeze({
    module: fragment.module,
    ...(fragment.entryPoint === undefined ? {} : { entryPoint: fragment.entryPoint }),
    ...(fragment.constants === undefined
      ? {}
      : { constants: Object.freeze({ ...fragment.constants }) }),
    targets: Object.freeze(
      fragment.targets.map((target) =>
        target === null
          ? null
          : Object.freeze({
              ...target,
              ...(target.blend === undefined
                ? {}
                : {
                    blend: Object.freeze({
                      color: Object.freeze({ ...target.blend.color }),
                      alpha: Object.freeze({ ...target.blend.alpha })
                    })
                  })
            })
      )
    )
  });
}
