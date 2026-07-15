export interface NativeFilesystemPort {
  canRead(mount: string): boolean;
  read(uri: string): Promise<ArrayBuffer | Uint8Array>;
}

export interface NativeFilesystemService {
  read(uri: string): Promise<Uint8Array>;
}

export type NativeSensorKind = 'accelerometer' | 'gyroscope' | 'magnetometer' | 'orientation';

export interface NativeSensorEvent {
  readonly timestamp: number;
  readonly values: readonly number[];
}

export interface NativeSensorPort {
  subscribe(kind: NativeSensorKind, listener: (event: NativeSensorEvent) => void): () => void;
}

export interface NativeSensorsService {
  subscribe(kind: NativeSensorKind, listener: (event: NativeSensorEvent) => void): () => boolean;
}

export interface NativePermissionsService {
  query(permission: string): Promise<'granted' | 'denied' | 'prompt'>;
  request(permission: string): Promise<'granted' | 'denied'>;
}

export interface NativeClipboardService {
  readText(): Promise<string>;
  writeText(value: string): Promise<void>;
}

export interface NativeAudioService {
  setSuspended(suspended: boolean): Promise<void>;
}

export interface NativeNetworkService {
  request(endpoint: string, payload: Uint8Array): Promise<Uint8Array>;
}

export interface NativeXrService {
  isAvailable(): Promise<boolean>;
}
