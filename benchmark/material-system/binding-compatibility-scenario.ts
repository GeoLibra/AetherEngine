import {
  compileMaterialBindingLayout,
  compileBindingLayoutPlan,
  createMaterialParameterBlock,
  createShaderBindingManifest,
  defineMaterialSchema,
  resolveMaterialBindingCompatibility,
  type MaterialBindingCompatibilityRequest,
  type MaterialResourceResolver,
  type PhaseItem,
  type RenderEntityId,
  type ResolvedMaterialPipelineCandidate,
  type ResolvedMaterialResource,
  type ShaderModuleIR
} from '../../src';
import { observation } from './reference';
import type { MaterialScenarioCase } from './types';

const span = Object.freeze({
  uri: 'asset://benchmark/binding-compatibility',
  line: 1,
  column: 1,
  length: 1
});

export function createMaterialBindingCompatibilityCase(options: {
  readonly instanceCount: number;
}): MaterialScenarioCase {
  const requests = createRequests(options.instanceCount);
  const boundItems = options.instanceCount - Math.ceil(options.instanceCount / 10);
  const skippedItems = options.instanceCount - boundItems;
  const counters = Object.freeze({
    requests: options.instanceCount,
    boundItems,
    skippedItems,
    uniqueBindingKeys: 1,
    synchronousRhiCreates: 0,
    ownershipTransfers: 0,
    staleReuse: 0
  });
  const semantic = Object.freeze({ boundItems, skippedItems });
  return Object.freeze({
    scenarioId: 'binding-compatibility-resolution-v1',
    scenarioVersion: 1,
    caseId: `instances-${options.instanceCount}-invalid-10pct`,
    scale: Object.freeze({ instanceCount: options.instanceCount, invalidEvery: 10 }),
    expected: Object.freeze({ reference: counters, subject: counters }),
    runReference: () => observation(semantic, counters),
    runSubject: () => {
      const result = resolveMaterialBindingCompatibility('benchmark', 'opaque', requests);
      return observation(
        { boundItems: result.bound.length, skippedItems: result.skipped.length },
        {
          requests: requests.length,
          boundItems: result.bound.length,
          skippedItems: result.skipped.length,
          uniqueBindingKeys: new Set(result.bound.map(({ bindingKey }) => bindingKey.hash)).size,
          synchronousRhiCreates: 0,
          ownershipTransfers: 0,
          staleReuse: 0
        }
      );
    }
  });
}

function createRequests(count: number): readonly MaterialBindingCompatibilityRequest[] {
  const schema = defineMaterialSchema({
    id: 'benchmark.binding-compatibility',
    version: 1,
    fields: {
      texture: {
        fieldId: 'texture',
        name: 'texture',
        valueType: { kind: 'texture-reference' },
        defaultValue: { kind: 'texture', assetId: 'shared-texture' },
        bindingPath: 'surfaceTexture'
      }
    }
  });
  const supplied = createMaterialParameterBlock(schema);
  const shaderManifest = manifest();
  const layout = compileMaterialBindingLayout(schema, shaderManifest);
  const bindingPlanResult = compileBindingLayoutPlan(shaderManifest);
  if (bindingPlanResult.kind !== 'success') throw new Error(bindingPlanResult.diagnostic.message);
  const resource = texture();
  const resolver: MaterialResourceResolver = Object.freeze({
    deviceGeneration: 1,
    resolve: () => resource
  });
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const entity = (index + 1) as RenderEntityId;
      const item: PhaseItem = Object.freeze({
        entity,
        phase: 'opaque',
        pipelineKey: 'pipeline',
        materialKey: 'material',
        meshKey: 'mesh',
        drawKey: 'draw',
        distance: index,
        insertionOrder: index
      });
      return Object.freeze({
        item,
        candidate: Object.freeze({
          candidate: Object.freeze({ entity }),
          pipelineKey: Object.freeze({
            parts: Object.freeze({
              bindingLayoutHash: layout.shaderLayoutHash,
              deviceGeneration: 1
            })
          })
        }) as ResolvedMaterialPipelineCandidate,
        layout,
        bindingPlan: bindingPlanResult.plan,
        supplied,
        resolver,
        allocation: Object.freeze({
          bufferAllocationGeneration: 0,
          ringGeneration: 0,
          dynamicOffsets: Object.freeze(index % 10 === 0 ? [-1] : []),
          deviceGeneration: 1
        })
      });
    })
  );
}

function manifest() {
  const ir: ShaderModuleIR = {
    version: 1,
    types: [],
    globals: [
      {
        name: 'surfaceTexture',
        type: 'texture_2d<f32>',
        addressSpace: 'handle',
        access: 'read',
        group: 1,
        binding: 0,
        span
      }
    ],
    functions: [],
    entryPoints: [],
    variants: [],
    sourceMap: { spans: [] },
    sourceClosureHash: 'binding-compatibility'
  };
  return createShaderBindingManifest(ir, 1);
}

function texture(): Extract<ResolvedMaterialResource, { kind: 'texture' }> {
  return Object.freeze({
    kind: 'texture',
    id: 'shared-texture',
    payloadVersion: 1,
    resourceGeneration: 1,
    deviceGeneration: 1,
    ready: true,
    viewDimension: '2d',
    sampleType: 'float',
    multisampled: false
  });
}
