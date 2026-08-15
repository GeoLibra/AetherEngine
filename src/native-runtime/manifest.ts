import type {
  NativeAbiExpectation,
  NativeBuildManifest,
  NativeModuleRequirement,
  NativePlatform,
  NativeTargetConfiguration,
  NativeTargetPolicy
} from './types';

const NATIVE_PLATFORMS: readonly NativePlatform[] = Object.freeze([
  'macos',
  'ios',
  'windows',
  'linux',
  'android'
]);

export function validateNativeBuildManifest(
  manifest: NativeBuildManifest,
  policy: NativeTargetPolicy
): NativeBuildManifest {
  requireText(manifest.buildId, 'Native build id');
  requireVersion(manifest.engineAbiVersion, 'Engine ABI version');
  requireVersion(manifest.rhiContractVersion, 'RHI contract version');
  const target = validateTarget(manifest.target, policy);
  const modules = validateModules(manifest.modules);
  const abi = validateAbi(manifest.abi);
  const sourceFiles = validateSourceFiles(manifest.sourceFiles);
  return Object.freeze({
    buildId: manifest.buildId,
    engineAbiVersion: manifest.engineAbiVersion,
    rhiContractVersion: manifest.rhiContractVersion,
    target,
    modules,
    abi,
    sourceFiles
  });
}

function validateTarget(
  target: NativeTargetConfiguration,
  policy: NativeTargetPolicy
): NativeTargetConfiguration {
  if (!NATIVE_PLATFORMS.includes(target.platform)) {
    throw new Error(`Target platform "${target.platform}" is not a native platform.`);
  }
  if (target.ownership === 'embedded' && target.bridge !== 'jsi') {
    throw new Error('Embedded native runtimes require the JSI bridge.');
  }
  if (target.ownership === 'dedicated' && target.bridge === 'jsi') {
    throw new Error('Dedicated native runtimes cannot use the JSI bridge.');
  }
  const approved = policy.approvedTargets.some((candidate) => sameTarget(candidate, target));
  if (!approved) {
    throw new Error(
      `Native target ${target.platform}/${target.runtime}/${target.ownership}/${target.bridge}/jit=${target.jitEnabled} ` +
        'is not approved by the target policy.'
    );
  }
  return Object.freeze({ ...target });
}

function validateModules(
  modules: readonly NativeModuleRequirement[]
): readonly NativeModuleRequirement[] {
  const names = new Set<string>();
  const result = modules.map((module) => {
    requireText(module.name, 'Native module name');
    requireVersion(module.version, `Native module "${module.name}" version`);
    if (names.has(module.name))
      throw new Error(`Native manifest contains duplicate module "${module.name}".`);
    names.add(module.name);
    return Object.freeze({ ...module });
  });
  return Object.freeze(result);
}

function validateAbi(abi: NativeAbiExpectation): NativeAbiExpectation {
  if (abi.endianness !== 'little' && abi.endianness !== 'big') {
    throw new Error(`Native ABI endianness "${abi.endianness}" is invalid.`);
  }
  if (abi.pointerBits !== 32 && abi.pointerBits !== 64) {
    throw new Error(`Native ABI pointer width ${abi.pointerBits} is invalid.`);
  }
  return Object.freeze({
    endianness: abi.endianness,
    pointerBits: abi.pointerBits,
    arrayBuffer: Object.freeze({ ...abi.arrayBuffer })
  });
}

function validateSourceFiles(sourceFiles: readonly string[]): readonly string[] {
  if (sourceFiles.length === 0)
    throw new Error('Native manifest requires at least one explicit source file.');
  const seen = new Set<string>();
  const result = sourceFiles.map((source) => {
    requireText(source, 'Native source file');
    if (/[*?\[\]{}]/.test(source))
      throw new Error(`Native source file "${source}" cannot contain a glob.`);
    const slashed = source.replaceAll('\\', '/');
    if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
      throw new Error(`Native source file "${source}" must be relative.`);
    }
    const segments = slashed.split('/');
    if (segments.includes('..'))
      throw new Error(`Native source file "${source}" cannot contain traversal.`);
    const normalized = segments.filter((segment) => segment !== '' && segment !== '.').join('/');
    if (normalized === '') throw new Error('Native source file must not be empty.');
    if (seen.has(normalized))
      throw new Error(`Native manifest contains duplicate source file "${normalized}".`);
    seen.add(normalized);
    return normalized;
  });
  return Object.freeze(result);
}

function sameTarget(left: NativeTargetConfiguration, right: NativeTargetConfiguration): boolean {
  return (
    left.platform === right.platform &&
    left.runtime === right.runtime &&
    left.ownership === right.ownership &&
    left.bridge === right.bridge &&
    left.jitEnabled === right.jitEnabled
  );
}

function requireText(value: string, label: string): void {
  if (value.trim() === '') throw new Error(`${label} must not be empty.`);
}

function requireVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${label} must be a positive safe integer.`);
}
