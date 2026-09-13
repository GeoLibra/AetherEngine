/** Material surface classification for pipeline rasterization and blend states. */
export type MaterialSurfaceKind = 'opaque' | 'alpha-mask' | 'transparent';

/** Polygon culling mode specified by material render state. */
export type MaterialCullMode = 'none' | 'front' | 'back';

/** Explicit color and alpha blending configuration intent. */
export interface MaterialBlendIntent {
  readonly color: string;
  readonly alpha: string;
}

/** Render state intent declared at the material asset level. */
export interface MaterialRenderStateIntent {
  readonly surface?: MaterialSurfaceKind;
  readonly depthTest?: boolean;
  readonly depthWrite?: boolean;
  readonly colorWrite?: boolean;
  readonly cullMode?: MaterialCullMode;
  readonly blend?: MaterialBlendIntent;
}

/** Technique-specific overrides applied on top of asset render state. */
export interface MaterialRenderStateOverride {
  readonly depthTest?: boolean;
  readonly depthWrite?: boolean;
  readonly colorWrite?: boolean;
  readonly cullMode?: MaterialCullMode;
  readonly blend?: MaterialBlendIntent;
}
