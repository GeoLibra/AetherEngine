export type CanonicalKeyHasher = (canonicalValue: string) => string;

declare const canonicalKeyBrand: unique symbol;
const CANONICAL_KEYS = new WeakMap<object, Readonly<{ canonicalValue: string; hash: string }>>();

export interface CanonicalKey<P> {
  readonly [canonicalKeyBrand]: true;
  readonly canonicalValue: string;
  readonly hash: string;
  readonly parts: Readonly<P>;
}

export interface PipelineKeyParts {
  readonly shaderModuleKey: string;
  readonly entryPoints: readonly Readonly<{
    stage: 'vertex' | 'fragment';
    name: string;
  }>[];
  readonly bindingLayoutHash: string;
  readonly vertexLayoutHash: string;
  readonly primitiveStateHash: string;
  readonly depthStencilStateHash: string;
  readonly blendStateHash: string;
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly featurePolicyHash: string;
  readonly deviceGeneration: number;
}

export interface BindingResourceKeyParts {
  readonly group: number;
  readonly binding: number;
  readonly assetId: string;
  readonly assetPayloadVersion: number;
  readonly resourceGeneration: number;
}

export interface BindingKeyParts {
  readonly bindingLayoutHash: string;
  readonly resources: readonly Readonly<BindingResourceKeyParts>[];
  readonly bufferAllocationGeneration: number;
  readonly ringGeneration: number;
  readonly dynamicOffsets: readonly number[];
  readonly deviceGeneration: number;
}

export function createPipelineKey(
  parts: PipelineKeyParts,
  hasher: CanonicalKeyHasher = hashCanonicalValue
): CanonicalKey<PipelineKeyParts> {
  validatePipelineKeyParts(parts);
  const entryPoints = [...parts.entryPoints].sort(
    (left, right) => stageOrder(left.stage) - stageOrder(right.stage)
  );
  for (let index = 1; index < entryPoints.length; index += 1) {
    if (entryPoints[index - 1]?.stage === entryPoints[index]?.stage) {
      throw new Error(`Duplicate ${entryPoints[index]?.stage ?? 'unknown'} entry point stage.`);
    }
  }
  const normalized: Readonly<PipelineKeyParts> = Object.freeze({
    shaderModuleKey: parts.shaderModuleKey,
    entryPoints: Object.freeze(entryPoints.map((entry) => Object.freeze({ ...entry }))),
    bindingLayoutHash: parts.bindingLayoutHash,
    vertexLayoutHash: parts.vertexLayoutHash,
    primitiveStateHash: parts.primitiveStateHash,
    depthStencilStateHash: parts.depthStencilStateHash,
    blendStateHash: parts.blendStateHash,
    attachmentFormats: Object.freeze([...parts.attachmentFormats]),
    ...(parts.depthStencilFormat === undefined
      ? {}
      : { depthStencilFormat: parts.depthStencilFormat }),
    sampleCount: parts.sampleCount,
    featurePolicyHash: parts.featurePolicyHash,
    deviceGeneration: parts.deviceGeneration
  });
  return createCanonicalKey(normalized, hasher);
}

export function createBindingKey(
  parts: BindingKeyParts,
  hasher: CanonicalKeyHasher = hashCanonicalValue
): CanonicalKey<BindingKeyParts> {
  validateBindingKeyParts(parts);
  const resources = [...parts.resources].sort(
    (left, right) =>
      left.group - right.group ||
      left.binding - right.binding ||
      compareCodeUnits(left.assetId, right.assetId)
  );
  for (let index = 1; index < resources.length; index += 1) {
    const previous = resources[index - 1];
    const current = resources[index];
    if (previous === undefined || current === undefined) continue;
    if (previous?.group === current?.group && previous.binding === current.binding) {
      throw new Error(`Duplicate binding resource at ${current.group}:${current.binding}.`);
    }
  }
  const normalized = Object.freeze({
    bindingLayoutHash: parts.bindingLayoutHash,
    resources: Object.freeze(resources.map((resource) => Object.freeze({ ...resource }))),
    bufferAllocationGeneration: parts.bufferAllocationGeneration,
    ringGeneration: parts.ringGeneration,
    dynamicOffsets: Object.freeze([...parts.dynamicOffsets]),
    deviceGeneration: parts.deviceGeneration
  });
  return createCanonicalKey(normalized, hasher);
}

/** Creates a guarded immutable canonical key from already normalized value facts. */
export function createCanonicalKey<P>(
  normalized: Readonly<P>,
  hasher: CanonicalKeyHasher = hashCanonicalValue
): CanonicalKey<P> {
  const canonicalValue = JSON.stringify(normalized);
  const hash = hasher(canonicalValue);
  if (typeof hash !== 'string' || hash.trim() === '')
    throw new Error('Invalid canonical key hash.');
  const key = Object.freeze({ canonicalValue, hash, parts: normalized }) as CanonicalKey<P>;
  CANONICAL_KEYS.set(key, Object.freeze({ canonicalValue, hash }));
  return key;
}

export function isFactoryCanonicalKey(value: unknown): value is CanonicalKey<unknown> {
  if (value === null || typeof value !== 'object') return false;
  const owned = CANONICAL_KEYS.get(value);
  if (owned === undefined) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return candidate.canonicalValue === owned.canonicalValue && candidate.hash === owned.hash;
}

function validatePipelineKeyParts(parts: PipelineKeyParts): void {
  for (const [name, value] of [
    ['shaderModuleKey', parts.shaderModuleKey],
    ['bindingLayoutHash', parts.bindingLayoutHash],
    ['vertexLayoutHash', parts.vertexLayoutHash],
    ['primitiveStateHash', parts.primitiveStateHash],
    ['depthStencilStateHash', parts.depthStencilStateHash],
    ['blendStateHash', parts.blendStateHash],
    ['featurePolicyHash', parts.featurePolicyHash]
  ] as const) {
    assertIdentity(value, `Invalid pipeline key ${name}.`);
  }
  for (const entry of parts.entryPoints)
    assertIdentity(entry.name, 'Invalid pipeline key entry point.');
  for (const format of parts.attachmentFormats)
    assertIdentity(format, 'Invalid pipeline key attachment format.');
  if (parts.depthStencilFormat !== undefined)
    assertIdentity(parts.depthStencilFormat, 'Invalid pipeline key depth format.');
  assertInteger(parts.sampleCount, 1, 'Invalid pipeline key sample count.');
  assertInteger(parts.deviceGeneration, 0, 'Invalid pipeline key device generation.');
}

function validateBindingKeyParts(parts: BindingKeyParts): void {
  assertIdentity(parts.bindingLayoutHash, 'Invalid binding key layout hash.');
  for (const resource of parts.resources) {
    assertInteger(resource.group, 0, 'Invalid binding key resource group.');
    assertInteger(resource.binding, 0, 'Invalid binding key resource binding.');
    assertIdentity(resource.assetId, 'Invalid binding key resource asset id.');
    assertInteger(resource.assetPayloadVersion, 0, 'Invalid binding key payload generation.');
    assertInteger(resource.resourceGeneration, 0, 'Invalid binding key resource generation.');
  }
  assertInteger(parts.bufferAllocationGeneration, 0, 'Invalid binding key allocation generation.');
  assertInteger(parts.ringGeneration, 0, 'Invalid binding key ring generation.');
  assertInteger(parts.deviceGeneration, 0, 'Invalid binding key device generation.');
  for (const offset of parts.dynamicOffsets)
    assertInteger(offset, 0, 'Invalid binding key dynamic offset.');
}

function assertIdentity(value: string, message: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
}

function assertInteger(value: number, minimum: number, message: string): void {
  if (!Number.isInteger(value) || value < minimum) throw new Error(message);
}

function hashCanonicalValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stageOrder(stage: 'vertex' | 'fragment'): number {
  return stage === 'vertex' ? 0 : 1;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
