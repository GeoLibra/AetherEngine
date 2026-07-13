import type {
  ChangeReaderOptions,
  ChangeWindow,
  ComponentType,
  Entity,
  RemovedComponent
} from './types';

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

  createReader(options: ChangeReaderOptions = {}): ChangeReader {
    const reader = new ChangeReader(options.from === 'beginning' ? 0 : this.tick);
    this.readers.add(reader);
    return reader;
  }

  createSystemReader(): ChangeReader {
    const reader = new ChangeReader(0);
    this.readers.add(reader);
    return reader;
  }

  releaseReader(reader: ChangeReader): boolean {
    const released = this.readers.delete(reader);
    if (released) {
      this.pruneRemoved();
    }
    return released;
  }

  windowFor(reader?: ChangeReader): ChangeWindow {
    const since = reader?.lastTick ?? this.defaultSince;
    const clampedSince = clampSince(since, this.tick);
    if (reader && clampedSince !== since) {
      reader.advance(clampedSince);
    } else if (!reader) {
      this.defaultSince = clampedSince;
    }
    return Object.freeze({
      sinceExclusive: clampedSince,
      untilInclusive: this.tick
    });
  }

  advanceReader(reader: ChangeReader, tick: number): void {
    if (!this.readers.has(reader)) {
      throw new Error('ChangeReader does not belong to this World.');
    }
    reader.advance(tick);
    this.pruneRemoved();
  }

  markChanged(entity: Entity, componentId: string): number {
    const tick = this.nextTick();
    getEntityTicks(this.changed, componentId).set(entity, tick);
    return tick;
  }

  markAdded(entity: Entity, componentId: string): number {
    const tick = this.nextTick();
    getEntityTicks(this.added, componentId).set(entity, tick);
    getEntityTicks(this.changed, componentId).set(entity, tick);
    return tick;
  }

  markRemoved(entity: Entity, componentIds: readonly string[]): number | undefined {
    if (componentIds.length === 0) {
      return undefined;
    }
    const tick = this.nextTick();
    for (const componentId of componentIds) {
      this.removed.push({ entity, componentId, tick });
      this.changed.get(componentId)?.delete(entity);
      this.added.get(componentId)?.delete(entity);
    }
    return tick;
  }

  hasChanged(
    entity: Entity,
    componentTypes: readonly ComponentType<object>[],
    window: ChangeWindow
  ): boolean {
    return componentTypes.some((componentType) => {
      const tick = this.changed.get(componentType.id)?.get(entity);
      return tick !== undefined && isTickInWindow(tick, window);
    });
  }

  wasAdded(
    entity: Entity,
    componentTypes: readonly ComponentType<object>[],
    window: ChangeWindow
  ): boolean {
    return componentTypes.some((componentType) => {
      const tick = this.added.get(componentType.id)?.get(entity);
      return tick !== undefined && isTickInWindow(tick, window);
    });
  }

  readRemoved<TView extends object>(
    component: ComponentType<TView>,
    window: ChangeWindow
  ): readonly RemovedComponent<TView>[] {
    return Object.freeze(
      this.removed
        .filter(
          (entry) => entry.componentId === component.id && isTickInWindow(entry.tick, window)
        )
        .map((entry) => Object.freeze({ entity: entry.entity, component, tick: entry.tick }))
    );
  }

  advanceDefault(): void {
    this.defaultSince = this.tick;
    this.pruneRemoved();
  }

  private nextTick(): number {
    this.tick = (this.tick + 1) >>> 0;
    return this.tick;
  }

  private pruneRemoved(): void {
    let oldestCursor = this.defaultSince;
    for (const reader of this.readers) {
      if (isEarlierTick(reader.lastTick, oldestCursor, this.tick)) {
        oldestCursor = reader.lastTick;
      }
    }
    let removeCount = 0;
    while (
      removeCount < this.removed.length &&
      !isTickInWindow(this.removed[removeCount]!.tick, {
        sinceExclusive: oldestCursor,
        untilInclusive: this.tick
      })
    ) {
      removeCount++;
    }
    if (removeCount > 0) {
      this.removed.splice(0, removeCount);
    }
  }
}

export function isTickInWindow(tick: number, window: ChangeWindow): boolean {
  const span = Math.min(
    (window.untilInclusive - window.sinceExclusive) >>> 0,
    MAX_CHANGE_AGE
  );
  const distance = (tick - window.sinceExclusive) >>> 0;
  return distance > 0 && distance <= span;
}

function clampSince(since: number, until: number): number {
  const age = (until - since) >>> 0;
  return age > MAX_CHANGE_AGE ? (until - MAX_CHANGE_AGE) >>> 0 : since;
}

function isEarlierTick(candidate: number, current: number, until: number): boolean {
  return ((until - candidate) >>> 0) > ((until - current) >>> 0);
}

function getEntityTicks(
  map: Map<string, Map<Entity, number>>,
  key: string
): Map<Entity, number> {
  let ticks = map.get(key);
  if (!ticks) {
    ticks = new Map<Entity, number>();
    map.set(key, ticks);
  }
  return ticks;
}
