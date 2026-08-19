import type { RelationType } from '../types';
import { defineRelation } from './relation';

/**
 * Built-in parent-child relation token (`ChildOf`).
 * Marked as `acyclic: true` to enforce a Directed Acyclic Graph (DAG) hierarchy.
 */
export const ChildOf: RelationType = defineRelation('ChildOf', { acyclic: true });

/**
 * Built-in archetype / trait inheritance relation token (`IsA`).
 * Marked as `acyclic: true` to prevent cyclic inheritance loops.
 */
export const IsA: RelationType = defineRelation('IsA', { acyclic: true });
