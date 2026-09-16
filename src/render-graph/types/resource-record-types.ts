import type { GraphRange } from '../ranges';
import type {
  BufferDescriptor,
  GraphHandle,
  GraphResourceOrigin,
  TextureDescriptor
} from './render-graph-types';

export interface InitializationInterval {
  readonly range: GraphRange;
  readonly sourceVersion: number;
  readonly producerPassId: number | null;
}

export interface ResourceVersionRecord {
  readonly version: number;
  readonly handle: GraphHandle;
  readonly parentVersion: number | null;
  readonly producerPassId: number | null;
  readonly writeRange?: GraphRange;
  readonly initialized: readonly InitializationInterval[];
}

export interface GraphResourceRecordBase {
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

export interface ResourceVersionCheckpoint {
  readonly resourceCount: number;
  readonly currentVersions: readonly number[];
}
