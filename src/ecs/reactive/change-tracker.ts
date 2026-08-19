import type {
  ChangeReaderOptions,
  ChangeWindow,
  ComponentType,
  Entity,
  RemovedComponent
} from '../types';

interface RemovedTick {
  readonly entity: Entity;
  readonly componentId: string;
  readonly tick: number;
}

// Unsigned tick order is unambiguous only within half the u32 range.
const MAX_CHANGE_AGE = 0x7fffffff;

export class ChangeReader {
  private cursor: number;

  constructor(initialTick: number) {
    this.cursor = initialTick;
  }

  get lastTick(): number {
    return this.cursor;
  }

  advance(tick: number): void {
    this.cursor = tick >>> 0;
  }
}

export class ChangeTracker {
  private readonly changed = new Map<string, Map<Entity, number>>();
  private readonly added = new Map<string, Map<Entity, number>>();
  private readonly removed: RemovedTick[] = [];
  private readonly readers = new Set<ChangeReader>();
  private tick = 0;
  private defaultSince = 0;

  get currentTick(): number {
    return this.tick;
  }

  get removedLogAge(): number {
    const oldest = this.getOldestRetainedTick();
    return Math.min(this.tick - oldest, MAX_CHANGE_AGE);
  }

  markChanged(entity: Entity, componentId: string): void {
    this.tick = (this.tick + 1) >>> 0;
    getOrCreateEntityMap(this.changed, componentId).set(entity, this.tick);
  }

  markAdded(entity: Entity, componentId: string): void {
    this.tick = (this.tick + 1) >>> 0;
    getOrCreateEntityMap(this.added, componentId).set(entity, this.tick);
  }

  markRemoved(entity: Entity, componentIds: readonly string[]): void {
    if (componentIds.length === 0) {
      return;
    }
    this.tick = (this.tick + 1) >>> 0;
    for (const componentId of componentIds) {
      this.removed.push({ entity, componentId, tick: this.tick });
      this.added.get(componentId)?.delete(entity);
      this.changed.get(componentId)?.delete(entity);
    }
    this.pruneRemoved();
  }

  hasChanged(
    entity: Entity,
    componentTypes: readonly ComponentType<object>[],
    window: ChangeWindow
  ): boolean {
    for (const component of componentTypes) {
      const changedTick = this.changed.get(component.id)?.get(entity);
      if (changedTick !== undefined && isTickInWindow(changedTick, window)) {
        return true;
      }
      const addedTick = this.added.get(component.id)?.get(entity);
      if (addedTick !== undefined && isTickInWindow(addedTick, window)) {
        return true;
      }
    }
    return false;
  }

  wasAdded(
    entity: Entity,
    componentTypes: readonly ComponentType<object>[],
    window: ChangeWindow
  ): boolean {
    for (const component of componentTypes) {
      const entityMap = this.added.get(component.id);
      const entityTick = entityMap?.get(entity);
      if (entityTick !== undefined && isTickInWindow(entityTick, window)) {
        return true;
      }
    }
    return false;
  }

  readRemoved<TView extends object>(
    component: ComponentType<TView>,
    window: ChangeWindow
  ): readonly RemovedComponent<TView>[] {
    const result: RemovedComponent<TView>[] = [];
    for (const entry of this.removed) {
      if (entry.componentId === component.id && isTickInWindow(entry.tick, window)) {
        result.push(
          Object.freeze({
            entity: entry.entity,
            component,
            tick: entry.tick
          })
        );
      }
    }
    return Object.freeze(result);
  }

  createReader(options: ChangeReaderOptions = {}): ChangeReader {
    const initialTick =
      options.from === 'current' ? this.tick : options.from === 'beginning' ? 0 : this.defaultSince;
    const reader = new ChangeReader(initialTick);
    this.readers.add(reader);
    return reader;
  }

  createSystemReader(): ChangeReader {
    return this.createReader();
  }

  releaseReader(reader: ChangeReader): boolean {
    const removed = this.readers.delete(reader);
    if (removed) {
      this.pruneRemoved();
    }
    return removed;
  }

  windowFor(reader?: ChangeReader): ChangeWindow {
    const sinceExclusive = reader ? reader.lastTick : this.defaultSince;
    return Object.freeze({
      sinceExclusive,
      untilInclusive: this.tick
    });
  }

  advanceReader(reader: ChangeReader, tick: number): void {
    reader.advance(tick);
    this.pruneRemoved();
  }

  advanceDefault(): void {
    this.defaultSince = this.tick;
    this.pruneRemoved();
  }

  clear(): void {
    this.changed.clear();
    this.added.clear();
    this.removed.length = 0;
    this.readers.clear();
    this.tick = 0;
    this.defaultSince = 0;
  }

  private pruneRemoved(): void {
    const oldestRetained = this.getOldestRetainedTick();
    while (this.removed.length > 0) {
      const candidate = this.removed[0]!;
      const age = (this.tick - candidate.tick) >>> 0;
      const isRetained = isTickNewer(candidate.tick, oldestRetained);
      if (isRetained && age <= MAX_CHANGE_AGE) {
        break;
      }
      this.removed.shift();
    }
  }

  private getOldestRetainedTick(): number {
    let oldest = this.defaultSince;
    for (const reader of this.readers) {
      if (isTickOlder(reader.lastTick, oldest)) {
        oldest = reader.lastTick;
      }
    }
    return oldest;
  }
}

function getOrCreateEntityMap(
  map: Map<string, Map<Entity, number>>,
  key: string
): Map<Entity, number> {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

function isTickInWindow(tick: number, window: ChangeWindow): boolean {
  return isTickNewer(tick, window.sinceExclusive) && !isTickNewer(tick, window.untilInclusive);
}

function isTickNewer(candidate: number, baseline: number): boolean {
  const diff = (candidate - baseline) >>> 0;
  return diff > 0 && diff <= MAX_CHANGE_AGE;
}

function isTickOlder(candidate: number, baseline: number): boolean {
  const diff = (baseline - candidate) >>> 0;
  return diff > 0 && diff <= MAX_CHANGE_AGE;
}
