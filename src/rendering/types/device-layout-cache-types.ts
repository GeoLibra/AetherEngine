import type { RHIBindGroupLayout, RHIPipelineLayout } from '../../rhi/contracts';
import type { BindingLayoutUnsupported } from './binding-layout-lowering-types';
import type { BindingLayoutId } from './binding-layout-types';

/** Device-owned RHI layouts realized from one exact specialization identity. */
export interface DeviceLayoutRealization {
  readonly bindingLayoutId: BindingLayoutId;
  readonly bindingLayoutHash: string;
  readonly bindGroupLayouts: readonly RHIBindGroupLayout[];
  readonly pipelineLayout: RHIPipelineLayout;
}

/** Result of resolving one CPU layout-cache entry against its owning device. */
export type DeviceLayoutCacheResolution =
  | {
      readonly status: 'hit' | 'miss';
      readonly layout: DeviceLayoutRealization;
    }
  | {
      readonly status: 'unsupported';
      readonly diagnostic: BindingLayoutUnsupported['diagnostic'];
    };
