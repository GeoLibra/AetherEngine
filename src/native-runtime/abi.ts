import type {
  NativeHandshake,
  NativeHandshakeDifference,
  NativeHandshakeModule,
  NativeNegotiatedHandshake
} from './types';
import { NativeHandshakeError } from './errors';
import type { NativeBuildManifest } from './types';

const ARRAY_BUFFER_CAPABILITIES = Object.freeze(['transfer', 'mapped', 'shared'] as const);

export function negotiateNativeHandshake(
  manifest: NativeBuildManifest,
  actual: NativeHandshake
): NativeNegotiatedHandshake {
  const actualModules = indexModules(actual.modules);
  const differences: NativeHandshakeDifference[] = [];
  compareScalar(differences, 'build-id', manifest.buildId, actual.buildId);
  compareScalar(differences, 'engine-abi', manifest.engineAbiVersion, actual.engineAbiVersion);
  compareScalar(
    differences,
    'rhi-contract',
    manifest.rhiContractVersion,
    actual.rhiContractVersion
  );
  compareScalar(differences, 'endianness', manifest.abi.endianness, actual.abi.endianness);
  compareScalar(differences, 'pointer-bits', manifest.abi.pointerBits, actual.abi.pointerBits);
  for (const capability of ARRAY_BUFFER_CAPABILITIES) {
    if (manifest.abi.arrayBuffer[capability] && !actual.abi.arrayBuffer[capability]) {
      differences.push({
        kind: 'array-buffer',
        capability,
        required: true,
        actual: actual.abi.arrayBuffer[capability]
      });
    }
  }
  const modules: NativeHandshakeModule[] = [];
  for (const requirement of manifest.modules) {
    const available = actualModules.get(requirement.name);
    if (available === undefined || available.version < requirement.version) {
      if (requirement.required) {
        differences.push({
          kind: 'module',
          module: requirement.name,
          required: requirement.version,
          actual: available?.version
        });
      }
      continue;
    }
    modules.push(Object.freeze({ ...available }));
  }
  if (differences.length > 0) throw new NativeHandshakeError(differences);
  return Object.freeze({
    buildId: actual.buildId,
    engineAbiVersion: actual.engineAbiVersion,
    rhiContractVersion: actual.rhiContractVersion,
    modules: Object.freeze(modules),
    abi: Object.freeze({
      endianness: actual.abi.endianness,
      pointerBits: actual.abi.pointerBits,
      arrayBuffer: Object.freeze({ ...actual.abi.arrayBuffer })
    })
  });
}

function indexModules(
  modules: readonly NativeHandshakeModule[]
): ReadonlyMap<string, NativeHandshakeModule> {
  const result = new Map<string, NativeHandshakeModule>();
  for (const module of modules) {
    if (module.name.trim() === '')
      throw new Error('Native handshake module name must not be empty.');
    if (!Number.isSafeInteger(module.version) || module.version <= 0) {
      throw new Error(
        `Native handshake module "${module.name}" version must be a positive safe integer.`
      );
    }
    if (result.has(module.name))
      throw new Error(`Native handshake contains duplicate module "${module.name}".`);
    result.set(module.name, module);
  }
  return result;
}

function compareScalar<
  K extends 'build-id' | 'engine-abi' | 'rhi-contract' | 'endianness' | 'pointer-bits'
>(
  differences: NativeHandshakeDifference[],
  kind: K,
  required: Extract<NativeHandshakeDifference, { kind: K }>['required'],
  actual: Extract<NativeHandshakeDifference, { kind: K }>['actual']
): void {
  if (required !== actual) {
    differences.push({ kind, required, actual } as Extract<NativeHandshakeDifference, { kind: K }>);
  }
}
