import type { NativeNegotiatedHandshake } from '../native-runtime/abi-types';
import type {
  NativeServiceModule,
  NativeServiceUnavailableDiagnostic
} from '../native-runtime/module-types';
import { createPlatformServiceToken, MutablePlatformServiceRegistry } from './services';
import type {
  NativeAudioService,
  NativeClipboardService,
  NativeFilesystemPort,
  NativeFilesystemService,
  NativeNetworkService,
  NativePermissionsService,
  NativeSensorEvent,
  NativeSensorKind,
  NativeSensorPort,
  NativeSensorsService,
  NativeXrService
} from './native-service-types';

export const NativeFilesystemServiceToken = createPlatformServiceToken<NativeFilesystemService>('native.filesystem');
export const NativePermissionsServiceToken = createPlatformServiceToken<NativePermissionsService>('native.permissions');
export const NativeClipboardServiceToken = createPlatformServiceToken<NativeClipboardService>('native.clipboard');
export const NativeSensorsServiceToken = createPlatformServiceToken<NativeSensorsService>('native.sensors');
export const NativeAudioServiceToken = createPlatformServiceToken<NativeAudioService>('native.audio');
export const NativeNetworkServiceToken = createPlatformServiceToken<NativeNetworkService>('native.network');
export const NativeXrServiceToken = createPlatformServiceToken<NativeXrService>('native.xr');

export function defineNativeServiceModule<T>(module: NativeServiceModule<T>): NativeServiceModule<T> {
  if (!/^[a-z][a-z0-9-]*$/.test(module.name) || module.name === 'rhi') {
    throw new Error('Native service module name is invalid or reserved.');
  }
  if (!Number.isSafeInteger(module.version) || module.version <= 0) {
    throw new Error('Native service module version must be a positive safe integer.');
  }
  return Object.freeze({ ...module });
}

export function registerNativeServiceModules(
  registry: MutablePlatformServiceRegistry,
  handshake: NativeNegotiatedHandshake,
  modules: readonly NativeServiceModule<unknown>[]
): readonly NativeServiceUnavailableDiagnostic[] {
  const negotiated = new Map(handshake.modules.map((module) => [module.name, module.version]));
  const diagnostics: NativeServiceUnavailableDiagnostic[] = [];
  for (const module of modules) {
    const actualVersion = negotiated.get(module.name);
    if (actualVersion === undefined || actualVersion < module.version) {
      if (module.required) {
        throw new Error(`Native service module "${module.name}" version requirement was not met.`);
      }
      diagnostics.push(Object.freeze({
        kind: 'optional-module-unavailable',
        module: module.name,
        requiredVersion: module.version,
        actualVersion
      }));
      continue;
    }
    registry.provide(module.token, module.create());
  }
  return Object.freeze(diagnostics);
}

export function normalizeNativeMountUri(uri: string): string {
  if (uri.includes('?') || uri.includes('#') || uri.includes('\\') || uri.includes('%')) throw invalidUri();
  const match = /^([a-z][a-z0-9-]*):\/\/(.*)$/.exec(uri);
  if (match === null) throw invalidUri();
  const segments = match[2]!.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    throw invalidUri();
  }
  return `${match[1]}://${segments.join('/')}`;
}

export function createNativeFilesystemService(port: NativeFilesystemPort): NativeFilesystemService {
  return Object.freeze({
    async read(input: string): Promise<Uint8Array> {
      const uri = normalizeNativeMountUri(input);
      const mount = uri.slice(0, uri.indexOf('://'));
      if (!port.canRead(mount)) throw new Error('Native filesystem permission denied.');
      try {
        const result = await port.read(uri);
        return result instanceof Uint8Array
          ? new Uint8Array(result)
          : new Uint8Array(result.slice(0));
      } catch {
        // Port errors may contain user paths or URI queries and must not cross the service boundary.
        throw new Error('Native filesystem read failed.');
      }
    }
  });
}

export function createNativeSensorService(port: NativeSensorPort): NativeSensorsService {
  return Object.freeze({
    subscribe(kind: NativeSensorKind, listener: (event: NativeSensorEvent) => void): () => boolean {
      let active = true;
      const cleanup = port.subscribe(kind, (event) => listener(snapshotSensorEvent(event)));
      return () => {
        if (!active) return false;
        active = false;
        cleanup();
        return true;
      };
    }
  });
}

function snapshotSensorEvent(event: NativeSensorEvent): NativeSensorEvent {
  if (!Number.isFinite(event.timestamp) || event.values.some((value) => !Number.isFinite(value))) {
    throw new Error('Native sensor event is invalid.');
  }
  return Object.freeze({ timestamp: event.timestamp, values: Object.freeze([...event.values]) });
}

function invalidUri(): Error { return new Error('Native filesystem URI is invalid.'); }
