import {
  fullBufferRange,
  fullTextureRange,
  normalizeBufferRange,
  normalizeTextureRange,
  rangesOverlap,
  type BufferGraphRange,
  type GraphRange,
  type TextureGraphRange
} from '../compiler/ranges';
import { assertGraphHandle, createGraphHandle } from './handles';
import type {
  BufferDescriptor,
  BufferHandle,
  GraphHandle,
  GraphResourceKind,
  GraphResourceOrigin,
  TextureDescriptor,
  TextureHandle
} from '../types';

export interface InitializationInterval {
  readonly range: GraphRange;
  readonly sourceVersion: number;
  readonly producerPassId: number | null;
}

const NO_INITIALIZATION_INTERVALS: readonly InitializationInterval[] = Object.freeze([]);

export interface ResourceVersionRecord {
  readonly version: number;
  readonly handle: GraphHandle;
  readonly parentVersion: number | null;
  readonly producerPassId: number | null;
  readonly writeRange?: GraphRange;
  readonly initialized: readonly InitializationInterval[];
}

interface GraphResourceRecordBase {
  readonly resourceId: number;
  readonly origin: GraphResourceOrigin;
  readonly historyValid: boolean;
  readonly currentVersion: number;
  readonly versions: readonly ResourceVersionRecord[];
}

export interface TextureResourceRecord extends GraphResourceRecordBase {
  readonly kind: 'texture';
  readonly descriptor: TextureDescriptor;
}

export interface BufferResourceRecord extends GraphResourceRecordBase {
  readonly kind: 'buffer';
  readonly descriptor: BufferDescriptor;
}

export type GraphResourceRecord = TextureResourceRecord | BufferResourceRecord;

export interface GraphResourceCreateOptions {
  readonly origin?: GraphResourceOrigin;
  readonly historyValid?: boolean;
}

interface MutableResource {
  readonly kind: GraphResourceKind;
  readonly resourceId: number;
  readonly descriptor: TextureDescriptor | BufferDescriptor;
  readonly origin: GraphResourceOrigin;
  readonly historyValid: boolean;
  readonly versions: ResourceVersionRecord[];
  currentVersion: number;
}

export interface ResourceVersionCheckpoint {
  readonly resourceCount: number;
  readonly currentVersions: readonly number[];
}

const TEXTURE_EXTERNAL_STATES = new Set<string>([
  'sampled',
  'copy-src',
  'storage-read',
  'color-attachment',
  'depth-stencil-attachment',
  'copy-dst',
  'storage-write'
]);
const BUFFER_EXTERNAL_STATES = new Set<string>([
  'uniform',
  'vertex',
  'index',
  'indirect',
  'copy-src',
  'storage-read',
  'copy-dst',
  'storage-write',
  'query-resolve'
]);

/** Mutable only while authoring; snapshots expose frozen resource declarations. */
export class ResourceVersionStore {
  private readonly resources: MutableResource[] = [];

  constructor(private readonly graphId: number) {}

  createTexture(
    descriptor: TextureDescriptor,
    options: GraphResourceCreateOptions = {}
  ): TextureHandle {
    const cloned = cloneTextureDescriptor(descriptor);
    return this.createResource('texture', cloned, fullTextureRange(cloned), options);
  }

  createBuffer(
    descriptor: BufferDescriptor,
    options: GraphResourceCreateOptions = {}
  ): BufferHandle {
    const cloned = cloneBufferDescriptor(descriptor);
    return this.createResource('buffer', cloned, fullBufferRange(cloned), options);
  }

  checkpoint(): ResourceVersionCheckpoint {
    return {
      resourceCount: this.resources.length,
      currentVersions: this.resources.map((resource) => resource.currentVersion)
    };
  }

  rollback(checkpoint: ResourceVersionCheckpoint): void {
    this.resources.length = checkpoint.resourceCount;
    checkpoint.currentVersions.forEach((version, index) => {
      const resource = this.resources[index];
      if (resource === undefined) return;
      resource.currentVersion = version;
      resource.versions.length = version + 1;
    });
  }

  normalizeRange(handle: GraphHandle, range?: unknown): GraphRange {
    const resource = this.resourceFor(handle);
    if (resource.kind === 'texture') {
      return normalizeTextureRange(resource.descriptor as TextureDescriptor, range as never);
    }
    return normalizeBufferRange(resource.descriptor as BufferDescriptor, range as never);
  }

  assertInitialized(handle: GraphHandle, range: GraphRange): void {
    const resource = this.resourceFor(handle);
    const version = this.versionFor(handle);
    if (!isCovered(range, version.initialized, resourceFormat(resource))) {
      throw new Error(
        `Render graph ${handle.kind} ${handle.resourceId} version ${handle.version} has an uninitialized read range.`
      );
    }
  }

  write(handle: GraphHandle, producerPassId: number, range: GraphRange): GraphHandle {
    const resource = this.resourceFor(handle);
    if (handle.version !== resource.currentVersion) {
      throw new Error(
        `Cannot create an implicit sibling version; writes must use the latest version ${resource.currentVersion}.`
      );
    }

    const parent = resource.versions[handle.version];
    if (parent === undefined) throw new Error('Render graph handle refers to an unknown version.');
    const version = resource.currentVersion + 1;
    const initialized = replaceInitialized(
      parent.initialized,
      range,
      version,
      producerPassId,
      resourceFormat(resource)
    );
    const nextHandle = createGraphHandle(resource.kind, this.graphId, resource.resourceId, version);
    resource.versions.push(
      Object.freeze({
        version,
        handle: nextHandle,
        parentVersion: handle.version,
        producerPassId,
        writeRange: range,
        initialized
      })
    );
    resource.currentVersion = version;
    return nextHandle;
  }

  currentVersion(handle: GraphHandle): number {
    return this.resourceFor(handle).currentVersion;
  }

  descriptorFor(handle: GraphHandle): TextureDescriptor | BufferDescriptor {
    return this.resourceFor(handle).descriptor;
  }

  originFor(handle: GraphHandle): GraphResourceOrigin {
    return this.resourceFor(handle).origin;
  }

  snapshot(): readonly GraphResourceRecord[] {
    return Object.freeze(
      this.resources.map((resource) => {
        const common = {
          kind: resource.kind,
          resourceId: resource.resourceId,
          descriptor: resource.descriptor,
          origin: resource.origin,
          historyValid: resource.historyValid,
          currentVersion: resource.currentVersion,
          versions: Object.freeze([...resource.versions])
        };
        return Object.freeze(common) as GraphResourceRecord;
      })
    );
  }

  private createResource<K extends GraphResourceKind>(
    kind: K,
    descriptor: K extends 'texture' ? TextureDescriptor : BufferDescriptor,
    fullRange: GraphRange,
    options: GraphResourceCreateOptions
  ): Extract<GraphHandle, { readonly kind: K }> {
    const origin = cloneAndValidateOrigin(options.origin ?? { kind: 'transient' });
    validateImportedInitialState(kind, origin);
    const historyValid = validateHistoryValidity(origin, options.historyValid);
    const resourceId = this.resources.length;
    const handle = createGraphHandle(kind, this.graphId, resourceId, 0);
    const initialized = initialIntervals(
      origin,
      historyValid,
      fullRange,
      resourceFormatFor(kind, descriptor)
    );
    const initialVersion: ResourceVersionRecord = Object.freeze({
      version: 0,
      handle,
      parentVersion: null,
      producerPassId: null,
      initialized
    });
    this.resources.push({
      kind,
      resourceId,
      descriptor,
      origin,
      historyValid,
      currentVersion: 0,
      versions: [initialVersion]
    });
    return handle;
  }

  private resourceFor(handle: GraphHandle): MutableResource {
    assertGraphHandle(handle, this.graphId);
    const resource = this.resources[handle.resourceId];
    if (resource === undefined || resource.kind !== handle.kind) {
      throw new Error('Render graph handle refers to an unknown resource.');
    }
    if (resource.versions[handle.version] === undefined) {
      throw new Error('Render graph handle refers to an unknown version.');
    }
    if (resource.versions[handle.version]?.handle !== handle) {
      throw new Error('Render graph handle is not the current stored handle identity.');
    }
    return resource;
  }

  private versionFor(handle: GraphHandle): ResourceVersionRecord {
    const resource = this.resourceFor(handle);
    return resource.versions[handle.version] as ResourceVersionRecord;
  }
}

function initialIntervals(
  origin: GraphResourceOrigin,
  historyValid: boolean,
  fullRange: GraphRange,
  format?: string
): readonly InitializationInterval[] {
  const initialized =
    (origin.kind === 'imported' && origin.initialState !== 'undefined') ||
    (origin.kind === 'history' && historyValid);
  if (!initialized) return NO_INITIALIZATION_INTERVALS;
  return Object.freeze(
    atomizeRange(fullRange, format).map((range) =>
      Object.freeze({ range, sourceVersion: 0, producerPassId: null })
    )
  );
}

function replaceInitialized(
  inherited: readonly InitializationInterval[],
  writeRange: GraphRange,
  sourceVersion: number,
  producerPassId: number,
  format?: string
): readonly InitializationInterval[] {
  const writeAtoms = atomizeRange(writeRange, format);
  const retained = inherited.flatMap((interval) =>
    writeAtoms.reduce<InitializationInterval[]>(
      (segments, write) =>
        segments.flatMap((segment) =>
          subtractRange(segment.range, write).map((range) =>
            Object.freeze({
              range,
              sourceVersion: segment.sourceVersion,
              producerPassId: segment.producerPassId
            })
          )
        ),
      [interval]
    )
  );
  const written = writeAtoms.map((range) =>
    Object.freeze({ range, sourceVersion, producerPassId })
  );
  return Object.freeze([...retained, ...written]);
}

function isCovered(
  target: GraphRange,
  initialized: readonly InitializationInterval[],
  format?: string
): boolean {
  return atomizeRange(target, format).every((targetAtom) => {
    let uncovered: GraphRange[] = [targetAtom];
    for (const interval of initialized) {
      uncovered = uncovered.flatMap((range) => subtractRange(range, interval.range));
      if (uncovered.length === 0) return true;
    }
    return false;
  });
}

function subtractRange(source: GraphRange, covered: GraphRange): GraphRange[] {
  if (!rangesOverlap(source, covered)) return [source];
  if (source.kind === 'buffer' && covered.kind === 'buffer') return subtractBuffer(source, covered);
  if (source.kind === 'texture' && covered.kind === 'texture') {
    return subtractTexture(source, covered);
  }
  return [source];
}

function subtractBuffer(source: BufferGraphRange, covered: BufferGraphRange): GraphRange[] {
  const start = Math.max(source.offset, covered.offset);
  const end = Math.min(source.end, covered.end);
  const result: BufferGraphRange[] = [];
  if (source.offset < start) result.push(bufferRange(source.offset, start));
  if (end < source.end) result.push(bufferRange(end, source.end));
  return result;
}

function subtractTexture(source: TextureGraphRange, covered: TextureGraphRange): GraphRange[] {
  const mipStart = Math.max(source.baseMipLevel, covered.baseMipLevel);
  const mipEnd = Math.min(source.mipLevelEnd, covered.mipLevelEnd);
  const layerStart = Math.max(source.baseArrayLayer, covered.baseArrayLayer);
  const layerEnd = Math.min(source.arrayLayerEnd, covered.arrayLayerEnd);
  const result: TextureGraphRange[] = [];
  if (source.baseMipLevel < mipStart) {
    result.push(
      textureRange(
        source.baseMipLevel,
        mipStart,
        source.baseArrayLayer,
        source.arrayLayerEnd,
        source.aspect
      )
    );
  }
  if (mipEnd < source.mipLevelEnd) {
    result.push(
      textureRange(
        mipEnd,
        source.mipLevelEnd,
        source.baseArrayLayer,
        source.arrayLayerEnd,
        source.aspect
      )
    );
  }
  if (source.baseArrayLayer < layerStart) {
    result.push(textureRange(mipStart, mipEnd, source.baseArrayLayer, layerStart, source.aspect));
  }
  if (layerEnd < source.arrayLayerEnd) {
    result.push(textureRange(mipStart, mipEnd, layerEnd, source.arrayLayerEnd, source.aspect));
  }
  return result;
}

function atomizeRange(range: GraphRange, format?: string): GraphRange[] {
  if (range.kind === 'buffer' || range.aspect !== 'all') return [range];
  if (format?.startsWith('depth')) {
    const depth = textureRange(
      range.baseMipLevel,
      range.mipLevelEnd,
      range.baseArrayLayer,
      range.arrayLayerEnd,
      'depth-only'
    );
    if (!format.includes('stencil')) return [depth];
    return [
      depth,
      textureRange(
        range.baseMipLevel,
        range.mipLevelEnd,
        range.baseArrayLayer,
        range.arrayLayerEnd,
        'stencil-only'
      )
    ];
  }
  return [range];
}

function bufferRange(offset: number, end: number): BufferGraphRange {
  return Object.freeze({ kind: 'buffer', offset, size: end - offset, end });
}

function textureRange(
  baseMipLevel: number,
  mipLevelEnd: number,
  baseArrayLayer: number,
  arrayLayerEnd: number,
  aspect: TextureGraphRange['aspect']
): TextureGraphRange {
  return Object.freeze({
    kind: 'texture',
    baseMipLevel,
    mipLevelCount: mipLevelEnd - baseMipLevel,
    baseArrayLayer,
    arrayLayerCount: arrayLayerEnd - baseArrayLayer,
    aspect,
    mipLevelEnd,
    arrayLayerEnd
  });
}

function cloneTextureDescriptor(descriptor: TextureDescriptor): TextureDescriptor {
  return Object.freeze({ ...descriptor, usage: Object.freeze([...descriptor.usage]) });
}

function cloneBufferDescriptor(descriptor: BufferDescriptor): BufferDescriptor {
  return Object.freeze({ ...descriptor, usage: Object.freeze([...descriptor.usage]) });
}

function cloneAndValidateOrigin(origin: GraphResourceOrigin): GraphResourceOrigin {
  if (origin.kind === 'transient') return Object.freeze({ kind: 'transient' });
  if (origin.kind === 'imported') {
    if (!origin.acquire.id)
      throw new Error('Imported render graph resources require an acquire id.');
    return Object.freeze({
      kind: 'imported',
      initialState: origin.initialState,
      acquire: Object.freeze({ ...origin.acquire })
    });
  }
  if (!origin.key) throw new Error('History render graph resources require a non-empty key.');
  if (!Number.isSafeInteger(origin.slots) || origin.slots < 2) {
    throw new Error('History render graph resources require at least two distinct slots.');
  }
  return Object.freeze({ ...origin });
}

function validateHistoryValidity(origin: GraphResourceOrigin, requested?: boolean): boolean {
  if (origin.kind !== 'history' && requested !== undefined) {
    throw new Error('historyValid is only valid for history render graph resources.');
  }
  return origin.kind === 'history' ? (requested ?? false) : false;
}

function resourceFormat(resource: MutableResource): string | undefined {
  return resource.kind === 'texture'
    ? (resource.descriptor as TextureDescriptor).format
    : undefined;
}

function resourceFormatFor<K extends GraphResourceKind>(
  kind: K,
  descriptor: K extends 'texture' ? TextureDescriptor : BufferDescriptor
): string | undefined {
  return kind === 'texture' ? (descriptor as TextureDescriptor).format : undefined;
}

function validateImportedInitialState(kind: GraphResourceKind, origin: GraphResourceOrigin): void {
  if (origin.kind !== 'imported' || origin.initialState === 'undefined') return;
  const states = kind === 'texture' ? TEXTURE_EXTERNAL_STATES : BUFFER_EXTERNAL_STATES;
  if (!states.has(origin.initialState)) {
    throw new Error(`Imported ${kind} initial state "${origin.initialState}" is invalid.`);
  }
}
