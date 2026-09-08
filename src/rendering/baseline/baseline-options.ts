import { MaterialAssetType, MeshAssetType, validateAssetHandle } from '../../assets';
import { validateMeshData, type MeshData } from '../../geometry';
import type { ExtractedView } from '../camera';
import { sharedEnvironmentTextureCache } from '../lighting';
import { prepareBackground, type PreparedBackgroundFrame } from '../background';
import type { ViewBackground } from '../background/types';
import type { RHIDevice } from '../../rhi/contracts';
import type {
  BaselineEnvironmentLighting,
  BaselineRenderingOptions,
  NormalizedBaselineEnvironmentLighting
} from './types';
import type { EnvironmentAsset } from '../../assets';

const DEFAULT_ENVIRONMENT_RADIANCE_TINT = Object.freeze([100, 120, 180] as [
  number,
  number,
  number
]);
const DEFAULT_ENVIRONMENT_DIFFUSE_IRRADIANCE = Object.freeze([300, 350, 500] as [
  number,
  number,
  number
]);

export type NormalizedBaselineRenderingOptions = Omit<BaselineRenderingOptions, 'environment'> &
  Readonly<{
    viewId: string;
    featurePolicyKey: string;
    environment: EnvironmentAsset | undefined;
    environmentLighting: NormalizedBaselineEnvironmentLighting;
  }>;

export function validateOptions(
  options: BaselineRenderingOptions
): NormalizedBaselineRenderingOptions {
  const viewId = options.viewId ?? 'main';
  const featurePolicyKey = options.featurePolicyKey ?? 'baseline';
  if (!viewId.trim()) throw new Error('Baseline rendering viewId must be non-empty.');
  if (!featurePolicyKey.trim()) {
    throw new Error('Baseline rendering featurePolicyKey must be non-empty.');
  }
  if ((options.mesh === undefined) !== (options.material === undefined)) {
    throw new Error(
      'Baseline rendering mesh and material registrations must be provided together.'
    );
  }
  const mesh =
    options.mesh === undefined
      ? undefined
      : Object.freeze({
          handle: validateAssetHandle(options.mesh.handle, MeshAssetType, 'Baseline mesh'),
          payloadVersion: payloadVersion(options.mesh.payloadVersion, 'mesh'),
          data: validateMeshData(meshInputWithoutBounds(options.mesh.data))
        });
  const material =
    options.material === undefined
      ? undefined
      : Object.freeze({
          handle: validateAssetHandle(
            options.material.handle,
            MaterialAssetType,
            'Baseline material'
          ),
          payloadVersion: payloadVersion(options.material.payloadVersion, 'material'),
          material: options.material.material
        });
  const background = validateBackgroundOption(options.background);
  const { environment, environmentLighting } = normalizeEnvironment(
    options.environment,
    options.environmentLighting
  );
  return Object.freeze({
    graphics: options.graphics,
    viewId,
    featurePolicyKey,
    ...(mesh === undefined ? {} : { mesh }),
    ...(material === undefined ? {} : { material }),
    environment,
    environmentLighting,
    ...(background === undefined ? {} : { background }),
    ...(options.forceSeparatePasses === undefined
      ? {}
      : { forceSeparatePasses: options.forceSeparatePasses })
  });
}

function normalizeEnvironment(
  rawEnv: BaselineRenderingOptions['environment'],
  rawLighting: BaselineEnvironmentLighting | undefined
): Readonly<{
  environment: EnvironmentAsset | undefined;
  environmentLighting: NormalizedBaselineEnvironmentLighting;
}> {
  const asset: EnvironmentAsset | undefined =
    rawEnv !== undefined && 'asset' in rawEnv ? rawEnv.asset : rawEnv;
  const envLighting = rawEnv !== undefined && 'lighting' in rawEnv ? rawEnv.lighting : undefined;
  const lighting = rawLighting ?? envLighting;
  if (lighting !== undefined) {
    if (
      lighting.intensity !== undefined &&
      (!Number.isFinite(lighting.intensity) || lighting.intensity < 0)
    ) {
      throw new TypeError('Environment intensity must be a non-negative finite number.');
    }
    for (const tint of [lighting.radianceTint, lighting.diffuseIrradiance]) {
      if (
        tint !== undefined &&
        (!Array.isArray(tint) ||
          tint.length !== 3 ||
          tint.some((channel) => !Number.isFinite(channel) || channel < 0))
      ) {
        throw new TypeError('Environment tint must contain three non-negative finite numbers.');
      }
    }
  }

  if (asset !== undefined) {
    const intensity = lighting?.intensity ?? 1.0;
    const radianceTint = lighting?.radianceTint
      ? Object.freeze([...lighting.radianceTint] as [number, number, number])
      : DEFAULT_ENVIRONMENT_RADIANCE_TINT;
    const diffuseIrradiance = lighting?.diffuseIrradiance
      ? Object.freeze([...lighting.diffuseIrradiance] as [number, number, number])
      : DEFAULT_ENVIRONMENT_DIFFUSE_IRRADIANCE;

    return Object.freeze({
      environment: asset,
      environmentLighting: Object.freeze({
        intensity,
        radianceTint,
        diffuseIrradiance
      })
    });
  }

  const intensity = lighting?.intensity ?? 1.0;
  const radianceTint = lighting?.radianceTint
    ? Object.freeze([...lighting.radianceTint] as [number, number, number])
    : DEFAULT_ENVIRONMENT_RADIANCE_TINT;
  const diffuseIrradiance = lighting?.diffuseIrradiance
    ? Object.freeze([...lighting.diffuseIrradiance] as [number, number, number])
    : DEFAULT_ENVIRONMENT_DIFFUSE_IRRADIANCE;

  return Object.freeze({
    environment: undefined,
    environmentLighting: Object.freeze({
      intensity,
      radianceTint,
      diffuseIrradiance
    })
  });
}

export function createBaselineBackgroundFrame(
  device: RHIDevice,
  view: ExtractedView,
  options: NormalizedBaselineRenderingOptions,
  backgroundOverride?: ViewBackground
): PreparedBackgroundFrame | undefined {
  const bg = backgroundOverride ?? options.background;
  if (bg === undefined || bg.kind === 'none') return undefined;
  return prepareBackground({
    device,
    view,
    background: bg,
    colorFormat: 'rgba16float',
    depthFormat: 'depth24plus',
    ...(options.environment === undefined ? {} : { environmentAsset: options.environment }),
    environmentCache: sharedEnvironmentTextureCache,
    environmentIntensity: options.environmentLighting.intensity,
    environmentRadianceTint: options.environmentLighting.radianceTint,
    depthMode: 'standard',
    reconstructionMode: 'vertex'
  });
}

export function validateBackgroundOption(
  bg: ViewBackground | undefined
): ViewBackground | undefined {
  if (bg === undefined) return undefined;
  if (bg.kind === 'none') return Object.freeze({ kind: 'none' });
  if (bg.kind === 'inherit') return Object.freeze({ kind: 'inherit' });
  if (bg.kind === 'solid') {
    if (!Array.isArray(bg.colorLinear) || bg.colorLinear.length !== 3) {
      throw new TypeError(
        'Baseline rendering solid background colorLinear must be a 3-element tuple.'
      );
    }
    const [r, g, b] = bg.colorLinear;
    if (
      !Number.isFinite(r) ||
      !Number.isFinite(g) ||
      !Number.isFinite(b) ||
      r < 0 ||
      g < 0 ||
      b < 0
    ) {
      throw new TypeError(
        'Baseline rendering solid background colorLinear components must be non-negative finite numbers.'
      );
    }
    return Object.freeze({
      kind: 'solid',
      colorLinear: Object.freeze([r, g, b] as [number, number, number])
    });
  }
  if (bg.kind === 'environment') {
    if (bg.source !== 'view-environment') {
      throw new TypeError(
        'Baseline rendering environment background source must be "view-environment".'
      );
    }
    if (bg.representation !== 'panorama' && bg.representation !== 'radiance-level-zero') {
      throw new TypeError(
        'Baseline rendering environment background representation must be "panorama" or "radiance-level-zero".'
      );
    }
    const multiplier = bg.multiplier;
    if (!Number.isFinite(multiplier) || multiplier < 0) {
      throw new TypeError(
        'Baseline rendering background multiplier must be a non-negative finite number.'
      );
    }
    return Object.freeze({
      kind: 'environment',
      source: 'view-environment',
      representation: bg.representation,
      multiplier
    });
  }
  throw new TypeError(
    `Baseline rendering background kind "${(bg as any).kind}" is not recognized.`
  );
}

function meshInputWithoutBounds(data: MeshData) {
  const { bounds: _derivedBounds, ...input } = data;
  return input;
}

function payloadVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Baseline rendering ${label} payloadVersion must be non-negative.`);
  }
  return value;
}

export function assertGraphicsReady(graphics: BaselineRenderingOptions['graphics']): void {
  if (graphics.device.state !== 'live') {
    throw new Error('Baseline rendering startup requires a live graphics device.');
  }
  if (graphics.surface.state !== 'configured' || graphics.surface.configuration === undefined) {
    throw new Error('Baseline rendering startup requires a configured graphics surface.');
  }
}
