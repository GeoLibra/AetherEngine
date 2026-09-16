import type {
  ComputePassBuilder,
  ComputePassContext,
  CopyPassBuilder,
  CopyPassContext,
  RasterPassBuilder,
  RasterPassContext,
  RenderGraphExecutionPlan,
  RenderGraphExecutionStep,
  RenderGraphBuilder,
  RenderGraphDebugIR,
  ExecutionPlanOptions
} from '../../../render-graph';
import type { RenderPhaseSnapshot } from '../../phase';
import type { RenderQuerySnapshot, RenderQuerySpec } from '../../world';
import type { RenderView } from '../../visibility/types';

export type RenderSystemScope = 'global' | 'per-view';

export interface RenderSystemToken {
  readonly kind: 'render-system';
  readonly id: string;
}

export interface RenderSystemConditionContext {
  readonly systemId: string;
  readonly scope: RenderSystemScope;
  readonly instanceId: string;
  readonly view?: RenderView;
}

export type RenderSystemCondition = (context: RenderSystemConditionContext) => boolean;

export interface RenderSystemSetupContext<TItem> extends RenderSystemConditionContext {
  readonly query: RenderQuerySnapshot<TItem>;
  readonly phases: readonly RenderPhaseSnapshot[];
}

export interface BaseRenderSystemDescriptor<TItem = never> {
  readonly id: string;
  readonly scope: RenderSystemScope;
  readonly query?: RenderQuerySpec<TItem>;
  readonly before?: readonly RenderSystemToken[];
  readonly after?: readonly RenderSystemToken[];
  readonly runIf?: RenderSystemCondition;
}

export interface RasterRenderSystemDescriptor<
  TResources,
  TItem = never
> extends BaseRenderSystemDescriptor<TItem> {
  readonly kind: 'raster';
  setup(builder: RasterPassBuilder, context: RenderSystemSetupContext<TItem>): TResources;
  run(context: RasterPassContext, resources: TResources, query: RenderQuerySnapshot<TItem>): void;
}

export interface ComputeRenderSystemDescriptor<
  TResources,
  TItem = never
> extends BaseRenderSystemDescriptor<TItem> {
  readonly kind: 'compute';
  setup(builder: ComputePassBuilder, context: RenderSystemSetupContext<TItem>): TResources;
  run(context: ComputePassContext, resources: TResources, query: RenderQuerySnapshot<TItem>): void;
}

export interface CopyRenderSystemDescriptor<
  TResources,
  TItem = never
> extends BaseRenderSystemDescriptor<TItem> {
  readonly kind: 'copy';
  setup(builder: CopyPassBuilder, context: RenderSystemSetupContext<TItem>): TResources;
  run(context: CopyPassContext, resources: TResources, query: RenderQuerySnapshot<TItem>): void;
}

export type RenderSystemDescriptor<TResources, TItem = never> =
  | RasterRenderSystemDescriptor<TResources, TItem>
  | ComputeRenderSystemDescriptor<TResources, TItem>
  | CopyRenderSystemDescriptor<TResources, TItem>;

export interface RenderSystemSnapshotSource {
  query(spec: RenderQuerySpec<unknown>): RenderQuerySnapshot<unknown>;
}

export interface RenderSystemCompileOptions {
  readonly views: readonly RenderView[];
  readonly snapshots?: RenderSystemSnapshotSource;
  readonly phaseSnapshots?: readonly RenderPhaseSnapshot[];
  /** Existing graph containing feature passes that the systems consume. */
  readonly graph?: RenderGraphBuilder;
  /** Optional execution plan options, including fusion configuration. */
  readonly executionPlanOptions?: ExecutionPlanOptions;
}

export interface CompiledRenderSystemInstance<TItem = unknown> {
  readonly id: string;
  readonly systemId: string;
  readonly scope: RenderSystemScope;
  readonly viewId?: string;
  readonly query: RenderQuerySnapshot<TItem>;
}

export type RenderSystemInternalNode = Extract<
  RenderGraphExecutionStep,
  { readonly kind: 'prelude' | 'submission' }
>;

export interface CompiledRenderSystems {
  readonly plan: RenderGraphExecutionPlan;
  readonly debug: RenderGraphDebugIR;
  readonly instances: readonly CompiledRenderSystemInstance[];
  /** Meta boundaries are part of this compiled renderer plan, never App schedule nodes. */
  readonly internalNodes: readonly RenderSystemInternalNode[];
}

export interface RegisteredRenderSystem {
  readonly descriptor: RenderSystemDescriptor<unknown, unknown>;
  readonly registrationIndex: number;
}

export interface ActiveRenderSystemInstance {
  readonly descriptor: RenderSystemDescriptor<unknown, unknown>;
  readonly registrationIndex: number;
  readonly instanceId: string;
  readonly view?: RenderView;
  readonly query: RenderQuerySnapshot<unknown>;
  readonly phases: readonly RenderPhaseSnapshot[];
}
