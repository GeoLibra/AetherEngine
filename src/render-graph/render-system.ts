import { RenderGraphBuilder, type PassBuilder } from './builder';
import { compileRenderGraph } from './compiler';
import { createRenderGraphDebugIR, type RenderGraphDebugIR } from './debug-ir';
import {
  createRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan,
  type RenderGraphExecutionStep,
  type RestrictedPassContext
} from './executor';
import type { RenderPhaseSnapshot } from '../rendering/render-phase';
import type { RenderQuerySnapshot, RenderQuerySpec } from '../rendering/render-world';
import type { RenderView } from '../rendering/visibility';

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

export interface RenderSystemDescriptor<TResources, TItem = never> {
  readonly id: string;
  readonly scope: RenderSystemScope;
  readonly query?: RenderQuerySpec<TItem>;
  readonly before?: readonly RenderSystemToken[];
  readonly after?: readonly RenderSystemToken[];
  readonly runIf?: RenderSystemCondition;
  setup(builder: PassBuilder, context: RenderSystemSetupContext<TItem>): TResources;
  run(
    context: RestrictedPassContext,
    resources: TResources,
    query: RenderQuerySnapshot<TItem>
  ): void;
}

export interface RenderSystemSnapshotSource {
  query(spec: RenderQuerySpec<unknown>): RenderQuerySnapshot<unknown>;
}

export interface RenderSystemCompileOptions {
  readonly views: readonly RenderView[];
  readonly snapshots?: RenderSystemSnapshotSource;
  readonly phaseSnapshots?: readonly RenderPhaseSnapshot[];
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

interface RegisteredRenderSystem {
  readonly descriptor: RenderSystemDescriptor<unknown, unknown>;
  readonly registrationIndex: number;
}

interface ActiveRenderSystemInstance {
  readonly descriptor: RenderSystemDescriptor<unknown, unknown>;
  readonly registrationIndex: number;
  readonly instanceId: string;
  readonly view?: RenderView;
  readonly query: RenderQuerySnapshot<unknown>;
  readonly phases: readonly RenderPhaseSnapshot[];
}

const EMPTY_QUERY: RenderQuerySnapshot<never> = Object.freeze({
  queryId: 'render-system/empty',
  renderRevision: 0,
  items: Object.freeze([])
});

/** Creates a stable semantic token without creating a second scheduling domain. */
export function renderSystemToken(id: string): RenderSystemToken {
  assertId(id, 'Render system token');
  return Object.freeze({ kind: 'render-system', id });
}

/** Ordered authoring registry; compilation lowers every contribution into one RenderGraph. */
export class RenderSystemRegistry {
  private readonly systems: RegisteredRenderSystem[] = [];
  private readonly ids = new Set<string>();

  add<TResources, TItem>(descriptor: RenderSystemDescriptor<TResources, TItem>): RenderSystemToken {
    validateDescriptor(descriptor);
    if (this.ids.has(descriptor.id)) {
      throw new Error(`Render system id "${descriptor.id}" is already registered.`);
    }
    this.ids.add(descriptor.id);
    this.systems.push({
      descriptor: descriptor as unknown as RenderSystemDescriptor<unknown, unknown>,
      registrationIndex: this.systems.length
    });
    return renderSystemToken(descriptor.id);
  }

  /** Alias kept for render-plugin authoring that reads naturally as a registration action. */
  register<TResources, TItem>(
    descriptor: RenderSystemDescriptor<TResources, TItem>
  ): RenderSystemToken {
    return this.add(descriptor);
  }

  entries(): readonly RegisteredRenderSystem[] {
    return Object.freeze([...this.systems]);
  }
}

/**
 * Lowers facade declarations to direct graph passes, then delegates all ordering and culling to
 * the existing RenderGraph compiler. No App or ECS scheduler participates in this operation.
 */
export function compileRenderSystems(
  registry: RenderSystemRegistry,
  options: RenderSystemCompileOptions
): CompiledRenderSystems {
  const entries = registry.entries();
  const knownIds = new Set(entries.map(({ descriptor }) => descriptor.id));
  const active = instantiate(entries, options, knownIds);
  const graph = new RenderGraphBuilder();
  const incoming = semanticIncoming(active, knownIds);
  const ordered = stableSemanticOrder(active, incoming);
  const passTokens = new Map<string, ReturnType<RenderGraphBuilder['addPass']>>();

  for (const instance of ordered) {
    const setupContext = setupContextFor(instance);
    const token = graph.addPass<unknown, RestrictedPassContext>({
      id: instance.instanceId,
      setup(pass) {
        for (const predecessor of incoming.get(instance.instanceId) ?? []) {
          const passToken = passTokens.get(predecessor);
          if (passToken === undefined)
            throw new Error('Render system semantic order is incomplete.');
          pass.after(passToken);
        }
        return instance.descriptor.setup(pass, setupContext);
      },
      run(context, resources) {
        instance.descriptor.run(context, resources, instance.query);
      }
    });
    passTokens.set(instance.instanceId, token);
  }

  const snapshot = graph.build();
  const compiled = compileRenderGraph(snapshot);
  const plan = createRenderGraphExecutionPlan(snapshot, compiled);
  const instances = Object.freeze(
    active.map((instance) =>
      Object.freeze({
        id: instance.instanceId,
        systemId: instance.descriptor.id,
        scope: instance.descriptor.scope,
        ...(instance.view === undefined ? {} : { viewId: instance.view.id }),
        query: instance.query
      })
    )
  );
  return Object.freeze({
    plan,
    debug: createRenderGraphDebugIR(snapshot, compiled, { schedule: plan.schedule }),
    instances,
    internalNodes: Object.freeze(
      plan.schedule.filter(
        (step): step is RenderSystemInternalNode =>
          step.kind === 'prelude' || step.kind === 'submission'
      )
    )
  });
}

function instantiate(
  entries: readonly RegisteredRenderSystem[],
  options: RenderSystemCompileOptions,
  knownIds: ReadonlySet<string>
): ActiveRenderSystemInstance[] {
  const viewIds = new Set<string>();
  for (const view of options.views) {
    if (viewIds.has(view.id)) throw new Error(`Render system view id "${view.id}" is duplicated.`);
    viewIds.add(view.id);
  }
  validateSemanticTokens(entries, knownIds);
  const queryCache = new Map<string, RenderQuerySnapshot<unknown>>();
  const active: ActiveRenderSystemInstance[] = [];
  for (const entry of entries) {
    const views = entry.descriptor.scope === 'global' ? [undefined] : options.views;
    for (const view of views) {
      const instanceId = instanceIdFor(entry.descriptor.id, entry.descriptor.scope, view);
      const conditionContext = Object.freeze({
        systemId: entry.descriptor.id,
        scope: entry.descriptor.scope,
        instanceId,
        ...(view === undefined ? {} : { view })
      });
      if (entry.descriptor.runIf?.(conditionContext) === false) continue;
      const query = queryFor(entry.descriptor, options.snapshots, queryCache);
      const phases = Object.freeze(
        (view === undefined
          ? []
          : (options.phaseSnapshots?.filter((phase) => phase.viewId === view.id) ?? [])
        ).slice()
      );
      active.push({
        descriptor: entry.descriptor,
        registrationIndex: entry.registrationIndex,
        instanceId,
        ...(view === undefined ? {} : { view }),
        query,
        phases
      });
    }
  }
  return active;
}

function queryFor(
  descriptor: RenderSystemDescriptor<unknown, unknown>,
  source: RenderSystemSnapshotSource | undefined,
  cache: Map<string, RenderQuerySnapshot<unknown>>
): RenderQuerySnapshot<unknown> {
  if (descriptor.query === undefined) return EMPTY_QUERY;
  const cached = cache.get(descriptor.query.id);
  if (cached !== undefined) return cached;
  if (source === undefined) {
    throw new Error(
      `Render system "${descriptor.id}" requires an immutable query snapshot source.`
    );
  }
  const snapshot = source.query(descriptor.query);
  assertFrozenSnapshot(snapshot, descriptor.id);
  cache.set(descriptor.query.id, snapshot);
  return snapshot;
}

function semanticIncoming(
  active: readonly ActiveRenderSystemInstance[],
  knownIds: ReadonlySet<string>
): ReadonlyMap<string, readonly string[]> {
  const incoming = new Map<string, string[]>();
  for (const instance of active) incoming.set(instance.instanceId, []);
  for (const instance of active) {
    for (const token of instance.descriptor.after ?? []) {
      assertKnownToken(token, knownIds);
      for (const predecessor of active.filter((candidate) =>
        matchesToken(candidate, token, instance)
      )) {
        incoming.get(instance.instanceId)?.push(predecessor.instanceId);
      }
    }
    for (const token of instance.descriptor.before ?? []) {
      assertKnownToken(token, knownIds);
      for (const successor of active.filter((candidate) =>
        matchesToken(candidate, token, instance)
      )) {
        incoming.get(successor.instanceId)?.push(instance.instanceId);
      }
    }
  }
  return new Map(
    [...incoming].map(([id, predecessors]) => [id, Object.freeze(unique(predecessors))])
  );
}

function stableSemanticOrder(
  instances: readonly ActiveRenderSystemInstance[],
  incoming: ReadonlyMap<string, readonly string[]>
): readonly ActiveRenderSystemInstance[] {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const indegree = new Map(instances.map((instance) => [instance.instanceId, 0]));
  const outgoing = new Map<string, string[]>();
  for (const [id, predecessors] of incoming) {
    indegree.set(id, predecessors.length);
    for (const predecessor of predecessors) {
      const targets = outgoing.get(predecessor) ?? [];
      targets.push(id);
      outgoing.set(predecessor, targets);
    }
  }
  const ready = instances
    .filter((instance) => indegree.get(instance.instanceId) === 0)
    .sort(compareInstances);
  const order: ActiveRenderSystemInstance[] = [];
  while (ready.length > 0) {
    const current = ready.shift() as ActiveRenderSystemInstance;
    order.push(current);
    for (const target of outgoing.get(current.instanceId) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) {
        const instance = byId.get(target);
        if (instance === undefined)
          throw new Error('Render system semantic edge references an unknown instance.');
        ready.push(instance);
        ready.sort(compareInstances);
      }
    }
  }
  if (order.length !== instances.length)
    throw new Error('Render system semantic constraints contain a cycle.');
  return order;
}

function setupContextFor(instance: ActiveRenderSystemInstance): RenderSystemSetupContext<unknown> {
  return Object.freeze({
    systemId: instance.descriptor.id,
    scope: instance.descriptor.scope,
    instanceId: instance.instanceId,
    ...(instance.view === undefined ? {} : { view: instance.view }),
    query: instance.query,
    phases: instance.phases
  });
}

function matchesToken(
  source: ActiveRenderSystemInstance,
  token: RenderSystemToken,
  target: ActiveRenderSystemInstance
): boolean {
  if (source.descriptor.id !== token.id) return false;
  if (source.descriptor.scope !== 'per-view' || target.descriptor.scope !== 'per-view') return true;
  return source.view?.id === target.view?.id;
}

function instanceIdFor(id: string, scope: RenderSystemScope, view: RenderView | undefined): string {
  const safeId = encodeURIComponent(id);
  return scope === 'global' ? `${safeId}@global` : `${safeId}@view:${encodeURIComponent(view!.id)}`;
}

function validateDescriptor<TResources, TItem>(
  descriptor: RenderSystemDescriptor<TResources, TItem>
): void {
  assertId(descriptor.id, 'Render system');
  if (descriptor.scope !== 'global' && descriptor.scope !== 'per-view') {
    throw new Error(`Render system "${descriptor.id}" has an invalid scope.`);
  }
}

function validateSemanticTokens(
  entries: readonly RegisteredRenderSystem[],
  knownIds: ReadonlySet<string>
): void {
  for (const { descriptor } of entries) {
    for (const token of [...(descriptor.before ?? []), ...(descriptor.after ?? [])]) {
      assertKnownToken(token, knownIds);
    }
  }
}

function assertKnownToken(token: RenderSystemToken, knownIds: ReadonlySet<string>): void {
  if (token.kind !== 'render-system' || !knownIds.has(token.id)) {
    throw new Error(`Render system semantic token "${token.id}" is not registered.`);
  }
}

function assertFrozenSnapshot(snapshot: RenderQuerySnapshot<unknown>, systemId: string): void {
  if (!Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.items)) {
    throw new Error(`Render system "${systemId}" received a mutable query snapshot.`);
  }
}

function assertId(id: string, name: string): void {
  if (id.trim().length === 0) throw new Error(`${name} id must not be empty.`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareInstances(
  first: ActiveRenderSystemInstance,
  second: ActiveRenderSystemInstance
): number {
  return (
    first.registrationIndex - second.registrationIndex ||
    first.instanceId.localeCompare(second.instanceId)
  );
}
