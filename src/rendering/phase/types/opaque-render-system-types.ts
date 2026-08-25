import type {
  PreparedDrawResourceBindings,
  RenderSystemDescriptor,
  SurfaceFrameToken,
  TextureDescriptor
} from '../../../render-graph';
import type { PreparedDrawPhaseSnapshot } from './prepared-draw-phase-types';

/** Static graph and prepared-resource inputs for one opaque view system. */
export interface OpaqueRenderSystemInput {
  readonly id?: string;
  readonly phase: PreparedDrawPhaseSnapshot;
  readonly surfaceFrame: SurfaceFrameToken;
  readonly color: TextureDescriptor;
  readonly depth: TextureDescriptor;
}

/** RenderSystem contribution plus the exact packet bindings required at execution. */
export interface OpaqueRenderSystemPreparation {
  readonly descriptor: RenderSystemDescriptor<unknown>;
  readonly preparedDrawResources: PreparedDrawResourceBindings;
}
