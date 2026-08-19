import { describe, expect, test } from 'vitest';
import {
  ChildOf,
  ChildOfIndex,
  IsA,
  createRelationAnyTag,
  createRelationTargetTag,
  defineRelation,
  deleteFromNestedSet,
  deleteFromSet,
  getOrCreateNestedSet,
  getOrCreateSet,
  sameStringSet,
  traverseDescendants,
  wouldCreateRelationCycle
} from '../../src/ecs/relation';
import type { Entity, Relation } from '../../src/ecs/types';

function entity(id: number): Entity {
  return id as Entity;
}

describe('Relation Utilities and Constants', () => {
  test('defineRelation validates input and creates unique tokens', () => {
    expect(() => defineRelation('')).toThrow('Relation name must not be empty.');
    expect(() => defineRelation('   ')).toThrow('Relation name must not be empty.');

    const relA = defineRelation('CustomRel');
    const relB = defineRelation('CustomRel');
    expect(relA.name).toBe('CustomRel');
    expect(relB.name).toBe('CustomRel');
    expect(relA.id).not.toBe(relB.id);
    expect(relA.key).not.toBe(relB.key);
    expect(relA.acyclic).toBe(false);
  });

  test('built-in relations ChildOf and IsA are acyclic', () => {
    expect(ChildOf.name).toBe('ChildOf');
    expect(ChildOf.acyclic).toBe(true);
    expect(IsA.name).toBe('IsA');
    expect(IsA.acyclic).toBe(true);
  });

  test('createRelationAnyTag and createRelationTargetTag generate expected formats', () => {
    const rel = defineRelation('TestTagRel');
    const target = entity(42);

    expect(createRelationAnyTag(rel)).toBe(`relation:${rel.key}`);
    expect(createRelationTargetTag(rel, target)).toBe(`relation:${rel.key}:target:42`);
  });

  test('sameStringSet accurately compares ReadonlySet instances', () => {
    const setA = new Set(['a', 'b', 'c']);
    const setB = new Set(['c', 'b', 'a']);
    const setC = new Set(['a', 'b']);
    const setD = new Set(['a', 'b', 'd']);

    expect(sameStringSet(setA, setB)).toBe(true);
    expect(sameStringSet(setA, setC)).toBe(false);
    expect(sameStringSet(setA, setD)).toBe(false);
  });

  test('wouldCreateRelationCycle detects cycles in relation graphs', () => {
    const parentRel = defineRelation('Parent', { acyclic: true });
    const relations = new Map<Entity, Entity>();

    const getRelation = (e: Entity) => {
      const target = relations.get(e);
      return target !== undefined ? ({ relation: parentRel, target } as Relation) : null;
    };

    const e1 = entity(1);
    const e2 = entity(2);
    const e3 = entity(3);

    // e1 -> e2 -> e3
    relations.set(e1, e2);
    relations.set(e2, e3);

    // Adding e3 -> e1 would create a cycle
    expect(wouldCreateRelationCycle(e3, parentRel, e1, getRelation)).toBe(true);
    // Adding e3 -> e2 would create a cycle
    expect(wouldCreateRelationCycle(e3, parentRel, e2, getRelation)).toBe(true);
    // Adding e4 -> e1 would NOT create a cycle
    const e4 = entity(4);
    expect(wouldCreateRelationCycle(e4, parentRel, e1, getRelation)).toBe(false);
  });

  test('traverseDescendants visits nodes in depth-first order', () => {
    const tree: Record<number, number[]> = {
      1: [2, 3],
      2: [4, 5],
      3: [],
      4: [],
      5: []
    };

    const visited: [Entity, number][] = [];
    traverseDescendants(
      entity(1),
      (parent) => (tree[parent as number] ?? []).map(entity),
      (node, depth) => visited.push([node, depth])
    );

    expect(visited).toEqual([
      [entity(1), 0],
      [entity(2), 1],
      [entity(4), 2],
      [entity(5), 2],
      [entity(3), 1]
    ]);
  });

  test('ChildOfIndex tracks, queries, and filters children', () => {
    const index = new ChildOfIndex();
    const parent = entity(10);
    const child1 = entity(101);
    const child2 = entity(102);
    const deadChild = entity(103);
    const foreignRel = defineRelation('Foreign');

    // Adding non-ChildOf relation should be ignored
    index.add(child1, { relation: foreignRel, target: parent });
    expect(index.getChildren(parent, () => true)).toEqual([]);

    index.add(child1, { relation: ChildOf, target: parent });
    index.add(child2, { relation: ChildOf, target: parent });
    index.add(deadChild, { relation: ChildOf, target: parent });

    const isAlive = (e: Entity) => e !== deadChild;
    expect(index.getChildren(parent, isAlive)).toEqual([child1, child2]);

    // Remove child1
    index.remove(child1, { relation: ChildOf, target: parent });
    expect(index.getChildren(parent, isAlive)).toEqual([child2]);

    // Clear
    index.clear();
    expect(index.getChildren(parent, () => true)).toEqual([]);
  });

  test('Map and Set helpers manage single and nested sets correctly', () => {
    const singleMap = new Map<string, Set<number>>();
    const s1 = getOrCreateSet(singleMap, 'key1');
    s1.add(1);
    s1.add(2);
    expect(getOrCreateSet(singleMap, 'key1').size).toBe(2);

    deleteFromSet(singleMap, 'key1', 1);
    expect(singleMap.get('key1')?.size).toBe(1);
    deleteFromSet(singleMap, 'key1', 2);
    expect(singleMap.has('key1')).toBe(false);

    const nestedMap = new Map<string, Map<string, Set<number>>>();
    const n1 = getOrCreateNestedSet(nestedMap, 'outer', 'inner');
    n1.add(100);
    expect(nestedMap.get('outer')?.get('inner')?.has(100)).toBe(true);

    deleteFromNestedSet(nestedMap, 'outer', 'inner', 100);
    expect(nestedMap.has('outer')).toBe(false);
  });
});
