import type { RHISubmission, RHITexture } from '../../../rhi/contracts';

/** Selects the content behind world geometry in a View's scene-linear target. */
export type ViewBackground =
  | Readonly<{ kind: 'inherit' }>
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'solid'; colorLinear: readonly [number, number, number] }>
  | Readonly<{
      kind: 'environment';
      source: 'view-environment';
      representation: 'panorama' | 'radiance-level-zero';
      multiplier: number;
    }>;

export type BackgroundDiagnosticCode =
  | 'background-environment-missing'
  | 'background-panorama-unavailable'
  | 'background-schema-unsupported'
  | 'background-capability-unsupported'
  | 'background-projection-invalid'
  | 'background-composition-invalid'
  | 'background-upload-failed'
  | 'background-stale-result';

/** Prepared GPU background bundle ready for shader binding. */
export interface PreparedBackgroundBundle {
  readonly texture: RHITexture;
  readonly maxLod: number;
  readonly representation: 'panorama' | 'radiance-level-zero';
  readonly blobHash: string;
  retain(submission?: RHISubmission): void;
  release(): void;
}
