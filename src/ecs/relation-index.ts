import type { Entity, Relation, RelationType } from './types';

export interface IncomingRelation {
  readonly source: Entity;
  readonly relation: Relation;
}

export class RelationIndex {
  private readonly outgoingBySource = new Map<Entity, Map<symbol, Relation>>();
  private readonly sourcesByType = new Map<symbol, Set<Entity>>();
  private readonly incomingByType = new Map<symbol, Map<Entity, Set<Entity>>>();
  private readonly incomingByTarget = new Map<Entity, Map<symbol, Set<Entity>>>();
  private readonly types = new Map<symbol, RelationType>();
  private count = 0;

  get edgeCount(): number {
    return this.count;
  }

  set(source: Entity, relation: Relation): Relation | undefined {
    const previous = this.outgoingBySource.get(source)?.get(relation.relation.id);
    if (previous?.target === relation.target) {
      return previous;
    }
    if (previous) {
      this.remove(source, previous.relation);
    }

    let outgoing = this.outgoingBySource.get(source);
    if (!outgoing) {
      outgoing = new Map();
      this.outgoingBySource.set(source, outgoing);
    }
    outgoing.set(relation.relation.id, relation);
    this.types.set(relation.relation.id, relation.relation);
    getOrCreateSet(this.sourcesByType, relation.relation.id).add(source);
    getOrCreateNestedSet(this.incomingByType, relation.relation.id, relation.target).add(source);
    getOrCreateNestedSet(this.incomingByTarget, relation.target, relation.relation.id).add(source);
    this.count++;
    return previous;
  }

  remove(source: Entity, relationType: RelationType): Relation | undefined {
    const outgoing = this.outgoingBySource.get(source);
    const relation = outgoing?.get(relationType.id);
    if (!outgoing || !relation) {
      return undefined;
    }

    outgoing.delete(relationType.id);
    if (outgoing.size === 0) {
      this.outgoingBySource.delete(source);
    }
    deleteFromSet(this.sourcesByType, relationType.id, source);
    deleteFromNestedSet(this.incomingByType, relationType.id, relation.target, source);
    deleteFromNestedSet(this.incomingByTarget, relation.target, relationType.id, source);
    if (!this.sourcesByType.has(relationType.id)) {
      this.types.delete(relationType.id);
    }
    this.count--;
    return relation;
  }

  removeSource(source: Entity): readonly Relation[] {
    const relations = this.outgoing(source);
    for (const relation of relations) {
      this.remove(source, relation.relation);
    }
    return relations;
  }

  get(source: Entity, relationType: RelationType): Relation | null {
    return this.outgoingBySource.get(source)?.get(relationType.id) ?? null;
  }

  outgoing(source: Entity): readonly Relation[] {
    return [...(this.outgoingBySource.get(source)?.values() ?? [])];
  }

  sources(relationType: RelationType): ReadonlySet<Entity> {
    return this.sourcesByType.get(relationType.id) ?? new Set<Entity>();
  }

  incoming(relationType: RelationType, target: Entity): ReadonlySet<Entity> {
    return this.incomingByType.get(relationType.id)?.get(target) ?? new Set<Entity>();
  }

  incomingTo(target: Entity): readonly IncomingRelation[] {
    const result: IncomingRelation[] = [];
    for (const [relationId, sources] of this.incomingByTarget.get(target) ?? []) {
      const relationType = this.types.get(relationId);
      if (!relationType) {
        continue;
      }
      for (const source of sources) {
        const relation = this.outgoingBySource.get(source)?.get(relationId);
        if (relation) {
          result.push({ source, relation });
        }
      }
    }
    return result;
  }

  clear(): void {
    this.outgoingBySource.clear();
    this.sourcesByType.clear();
    this.incomingByType.clear();
    this.incomingByTarget.clear();
    this.types.clear();
    this.count = 0;
  }
}

function getOrCreateSet<K>(map: Map<K, Set<Entity>>, key: K): Set<Entity> {
  let values = map.get(key);
  if (!values) {
    values = new Set();
    map.set(key, values);
  }
  return values;
}

function getOrCreateNestedSet<Outer, Inner>(
  map: Map<Outer, Map<Inner, Set<Entity>>>,
  outer: Outer,
  inner: Inner
): Set<Entity> {
  let nested = map.get(outer);
  if (!nested) {
    nested = new Map();
    map.set(outer, nested);
  }
  return getOrCreateSet(nested, inner);
}

function deleteFromSet<K>(map: Map<K, Set<Entity>>, key: K, entity: Entity): void {
  const values = map.get(key);
  values?.delete(entity);
  if (values?.size === 0) {
    map.delete(key);
  }
}

function deleteFromNestedSet<Outer, Inner>(
  map: Map<Outer, Map<Inner, Set<Entity>>>,
  outer: Outer,
  inner: Inner,
  entity: Entity
): void {
  const nested = map.get(outer);
  if (!nested) {
    return;
  }
  deleteFromSet(nested, inner, entity);
  if (nested.size === 0) {
    map.delete(outer);
  }
}
