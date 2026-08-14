import type {
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHIShaderModule
} from '../contracts/resource';
import { WebGL2ResourceBase, assertWebGL2Resource } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';
import type {
  WebGL2BindingManifestEntry,
  WebGL2ProgramBinding,
  WebGL2ShaderStage,
  WebGL2ShaderTranslationPort
} from './shader-types';
import { finalizeWebGL2Shader, type WebGL2PhysicalBinding } from './shader-types';
import { WebGL2ProgramCreationError } from './errors';
import type { WebGL2ClipDepthMode } from './clip-depth';

export class WebGL2RenderPipeline extends WebGL2ResourceBase implements RHIRenderPipeline {
  readonly kind = 'render-pipeline';
  readonly descriptor: Readonly<RHIRenderPipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;
  readonly topology;
  readonly bindings: readonly WebGL2BindingManifestEntry[];
  readonly physicalBindings: readonly WebGL2PhysicalBinding[];
  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    handle: object,
    descriptor: RHIRenderPipelineDescriptor,
    bindings: readonly WebGL2BindingManifestEntry[],
    physicalBindings: readonly WebGL2PhysicalBinding[]
  ) {
    super(id, owner, handle, descriptor.label);
    this.layout = descriptor.layout;
    this.topology = descriptor.primitive?.topology;
    this.bindings = Object.freeze(bindings.map((entry) => Object.freeze({ ...entry })));
    this.physicalBindings = Object.freeze(
      physicalBindings.map((entry) => Object.freeze({ ...entry }))
    );
    this.descriptor = snapshotPipelineDescriptor(descriptor);
  }
}

export function createWebGL2RenderPipeline(
  id: number,
  owner: WebGL2DeviceOwner,
  translator: WebGL2ShaderTranslationPort | undefined,
  clipDepthMode: WebGL2ClipDepthMode,
  descriptor: RHIRenderPipelineDescriptor,
  invalidateNativeState: () => void
): WebGL2RenderPipeline {
  if (translator === undefined)
    throw new Error('WebGL2 render pipeline creation requires a shader translation port.');
  if (descriptor.layout !== undefined) assertWebGL2Resource(descriptor.layout, owner);
  if (descriptor.vertex === undefined)
    throw new Error('WebGL2 render pipeline requires a vertex stage.');
  const vertex = translateStage(
    owner,
    translator,
    descriptor.vertex.module,
    'vertex',
    clipDepthMode,
    descriptor.vertex.entryPoint,
    descriptor.vertex.constants
  );
  const fragment =
    descriptor.fragment === undefined
      ? undefined
      : translateStage(
          owner,
          translator,
          descriptor.fragment.module,
          'fragment',
          clipDepthMode,
          descriptor.fragment.entryPoint,
          descriptor.fragment.constants
        );
  const bindings = mergeBindings(vertex.bindings, fragment?.bindings ?? []);
  const physicalBindings = mergePhysicalBindings(
    vertex.physicalBindings,
    fragment?.physicalBindings ?? []
  );
  const programBindings = mergeProgramBindings(
    vertex.programBindings,
    fragment?.programBindings ?? []
  );
  validateBindingLimits(owner, bindings, physicalBindings);
  const create = owner.native.createProgram;
  if (create === undefined)
    throw new Error('Native WebGL2 context does not support program creation.');
  let program: object;
  try {
    program = create.call(
      owner.native,
      Object.freeze({
        label: descriptor.label,
        vertexSource: vertex.source,
        fragmentSource: fragment?.source,
        bindings,
        programBindings
      })
    );
  } catch (cause) {
    throw new WebGL2ProgramCreationError(descriptor.label, cause);
  } finally {
    // Sampler initialization temporarily calls useProgram; an earlier replay cache may now be stale.
    if (programBindings.some((binding) => binding.kind === 'combined-sampler'))
      invalidateNativeState();
  }
  const reflect = owner.native.getProgramReflection;
  if (reflect === undefined)
    throw new Error('Native WebGL2 context does not expose program reflection.');
  const reflection = reflect.call(owner.native, program);
  if (!sameManifest(bindings, reflection)) {
    owner.native.deleteProgram?.(program);
    throw new Error(
      `WebGL2 program "${descriptor.label ?? 'unlabeled'}" reflection does not match its binding manifest.`
    );
  }
  return new WebGL2RenderPipeline(id, owner, program, descriptor, bindings, physicalBindings);
}

function mergeProgramBindings(
  first: readonly WebGL2ProgramBinding[],
  second: readonly WebGL2ProgramBinding[]
): readonly WebGL2ProgramBinding[] {
  const merged = new Map<string, WebGL2ProgramBinding>();
  for (const entry of [...first, ...second]) {
    const key = `${entry.kind}:${entry.name}`;
    const previous = merged.get(key);
    if (previous !== undefined && previous.slot !== entry.slot)
      throw new Error(`WebGL2 program binding conflicts at ${key}.`);
    merged.set(key, Object.freeze({ ...entry }));
  }
  return Object.freeze(
    [...merged.values()].sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)
    )
  );
}

function translateStage(
  owner: WebGL2DeviceOwner,
  translator: WebGL2ShaderTranslationPort,
  module: RHIShaderModule,
  stage: WebGL2ShaderStage,
  clipDepthMode: WebGL2ClipDepthMode,
  entryPoint = 'main',
  constants: Readonly<Record<string, number>> = {}
) {
  assertWebGL2Resource(module, owner);
  const frozenConstants = Object.freeze({ ...constants });
  const approvedExtensions = Object.freeze([...owner.native.extensions].sort());
  const result = translator.translate({
    wgsl: module.descriptor.code,
    stage,
    entryPoint,
    constants: frozenConstants,
    capabilities: Object.freeze(
      [...owner.capabilities.features.entries()]
        .filter(([, support]) => support.status !== 'unsupported')
        .map(([feature]) => feature)
        .sort()
    ),
    approvedExtensions,
    clipDepthMode
  });
  return finalizeWebGL2Shader(translator, result, {
    constants: frozenConstants,
    approvedExtensions
  });
}

function mergePhysicalBindings(
  first: readonly WebGL2PhysicalBinding[],
  second: readonly WebGL2PhysicalBinding[]
): readonly WebGL2PhysicalBinding[] {
  const merged = new Map<string, WebGL2PhysicalBinding>();
  for (const entry of [...first, ...second]) {
    const key = `${entry.group}:${entry.binding}:${entry.kind}:${entry.slot}`;
    merged.set(key, Object.freeze({ ...entry }));
  }
  return Object.freeze([...merged.values()]);
}

function mergeBindings(
  first: readonly WebGL2BindingManifestEntry[],
  second: readonly WebGL2BindingManifestEntry[]
): readonly WebGL2BindingManifestEntry[] {
  const merged = new Map<string, WebGL2BindingManifestEntry>();
  for (const entry of [...first, ...second]) {
    const key = `${entry.group}:${entry.binding}`;
    const previous = merged.get(key);
    if (previous !== undefined && (previous.kind !== entry.kind || previous.name !== entry.name)) {
      throw new Error(
        `WebGL2 binding manifest conflicts at group ${entry.group} binding ${entry.binding}.`
      );
    }
    merged.set(key, Object.freeze({ ...entry }));
  }
  return Object.freeze(
    [...merged.values()].sort((a, b) => a.group - b.group || a.binding - b.binding)
  );
}

function validateBindingLimits(
  owner: WebGL2DeviceOwner,
  bindings: readonly WebGL2BindingManifestEntry[],
  physicalBindings: readonly WebGL2PhysicalBinding[]
): void {
  const uniformCount = bindings.filter((entry) => entry.kind === 'uniform-buffer').length;
  const textureCount = bindings.filter((entry) => entry.kind === 'texture').length;
  if (uniformCount > (owner.native.limits.maxUniformBufferBindings ?? 0)) {
    throw new Error(
      `WebGL2 pipeline requires ${uniformCount} uniform buffers, limit is ${owner.native.limits.maxUniformBufferBindings ?? 0}.`
    );
  }
  if (textureCount > (owner.native.limits.maxTextureUnits ?? 0)) {
    throw new Error(
      `WebGL2 pipeline requires ${textureCount} textures, limit is ${owner.native.limits.maxTextureUnits ?? 0}.`
    );
  }
  for (const binding of physicalBindings) {
    const limit =
      binding.kind === 'uniform-buffer'
        ? (owner.native.limits.maxUniformBufferBindings ?? 0)
        : (owner.native.limits.maxTextureUnits ?? 0);
    if (binding.slot >= limit) {
      const resource = binding.kind === 'uniform-buffer' ? 'uniform-buffer' : 'texture';
      throw new Error(`WebGL2 physical ${resource} slot ${binding.slot} exceeds limit ${limit}.`);
    }
  }
}

function sameManifest(
  expected: readonly WebGL2BindingManifestEntry[],
  actual: readonly WebGL2BindingManifestEntry[]
): boolean {
  if (expected.length !== actual.length) return false;
  const normalize = (entry: WebGL2BindingManifestEntry) =>
    `${entry.group}:${entry.binding}:${entry.kind}:${entry.name}`;
  const expectedKeys = expected.map(normalize).sort();
  const actualKeys = actual.map(normalize).sort();
  return expectedKeys.every((value, index) => value === actualKeys[index]);
}

function snapshotPipelineDescriptor(
  descriptor: RHIRenderPipelineDescriptor
): Readonly<RHIRenderPipelineDescriptor> {
  return Object.freeze({
    ...descriptor,
    ...(descriptor.vertex === undefined
      ? {}
      : {
          vertex: Object.freeze({
            ...descriptor.vertex,
            ...(descriptor.vertex.constants === undefined
              ? {}
              : {
                  constants: Object.freeze({ ...descriptor.vertex.constants })
                }),
            ...(descriptor.vertex.buffers === undefined
              ? {}
              : {
                  buffers: Object.freeze(
                    descriptor.vertex.buffers.map((buffer) =>
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
          })
        }),
    ...(descriptor.fragment === undefined
      ? {}
      : {
          fragment: Object.freeze({
            ...descriptor.fragment,
            ...(descriptor.fragment.constants === undefined
              ? {}
              : {
                  constants: Object.freeze({ ...descriptor.fragment.constants })
                }),
            targets: Object.freeze(
              descriptor.fragment.targets.map((target) =>
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
          })
        }),
    ...(descriptor.primitive === undefined
      ? {}
      : { primitive: Object.freeze({ ...descriptor.primitive }) }),
    ...(descriptor.depthStencil === undefined
      ? {}
      : { depthStencil: Object.freeze({ ...descriptor.depthStencil }) }),
    ...(descriptor.multisample === undefined
      ? {}
      : { multisample: Object.freeze({ ...descriptor.multisample }) })
  });
}
