import type { RelationOptions, RelationType } from '../types';

let nextRelationId = 0;

/**
 * Defines a new strongly-typed relation token for the ECS relationship graph.
 *
 * @param name - The debug / display name of the relation. Must not be empty.
 * @param options - Additional configuration options, such as acyclic constraints.
 * @returns A unique relation type descriptor.
 * @throws If `name` is empty or only whitespace.
 */
export function defineRelation(name: string, options: RelationOptions = {}): RelationType {
  if (name.trim() === '') {
    throw new Error('Relation name must not be empty.');
  }
  // `key` is stable for table tags even if two relation tokens share the same debug name.
  return {
    name,
    id: Symbol(name),
    key: `${name}:${nextRelationId++}`,
    acyclic: options.acyclic ?? false
  };
}
