import { validateComponentInput } from '../component/component-schema';
import { SpawnTicket } from '../entity/spawn-ticket';
import type {
  CommandEntity,
  ComponentInput,
  ComponentType,
  RelationType,
  WorldCommand
} from '../types';
import type { World } from '../world';
import { entityKey, type VirtualTarget } from './utils';

/**
 * Validates the full batch of commands against the current World state before committing.
 *
 * Performs simulation checks for:
 * - Entity liveness and stale handle usage
 * - Component schema registration and data validity
 * - Component presence for removal operations
 * - Acyclic relation cycle detection across both World and pending commands
 *
 * @throws If any command in the batch is invalid.
 */
export function validateCommandBuffer(
  commands: readonly WorldCommand[],
  owner: symbol,
  world: World
): void {
  const availableTickets = new Set<SpawnTicket>();
  const dead = new Set<string>();
  const relationOverrides = new Map<symbol, Map<string, VirtualTarget | null>>();
  const componentOverrides = new Map<string, Map<string, boolean>>();

  for (const command of commands) {
    switch (command.kind) {
      case 'spawn':
        assertOwnedTicket(command.ticket, owner);
        availableTickets.add(command.ticket);
        for (const value of command.bundle) {
          setVirtualComponent(componentOverrides, command.ticket, value.component, true);
        }
        for (const value of command.bundle) {
          validateComponent(world, value.component, value.data ?? {});
        }
        break;
      case 'despawn': {
        const target = validateEntity(command.entity, world, owner, availableTickets, dead);
        dead.add(entityKey(target));
        break;
      }
      case 'insert': {
        const target = validateEntity(command.entity, world, owner, availableTickets, dead);
        validateComponent(world, command.component, command.data);
        setVirtualComponent(componentOverrides, target, command.component, true);
        break;
      }
      case 'remove': {
        const target = validateEntity(command.entity, world, owner, availableTickets, dead);
        if (!world.isComponentRegistered(command.component)) {
          throw new Error(`Component "${command.component.id}" is not registered.`);
        }
        if (!hasVirtualComponent(componentOverrides, world, target, command.component)) {
          throw new Error(
            `Entity "${entityKey(target)}" does not have component "${command.component.id}" to remove.`
          );
        }
        setVirtualComponent(componentOverrides, target, command.component, false);
        break;
      }
      case 'relation': {
        const source = validateEntity(command.source, world, owner, availableTickets, dead);
        const relationMap = getRelationMap(relationOverrides, command.relation);
        if (command.target === undefined) {
          relationMap.set(entityKey(source), null);
          break;
        }
        const target = validateEntity(command.target, world, owner, availableTickets, dead);
        relationMap.set(entityKey(source), target);
        if (
          command.relation.acyclic &&
          createsCycle(world, command.relation, source, target, relationMap)
        ) {
          throw new Error(
            `Relation "${command.relation.name}" would create a cycle at "${entityKey(source)}".`
          );
        }
        break;
      }
    }
  }
}

export function assertOwnedTicket(ticket: SpawnTicket, owner: symbol): void {
  if (ticket.owner !== owner) {
    throw new Error('SpawnTicket belongs to a different CommandBuffer.');
  }
}

function hasVirtualComponent(
  overrides: ReadonlyMap<string, ReadonlyMap<string, boolean>>,
  world: World,
  target: VirtualTarget,
  component: ComponentType<object>
): boolean {
  const value = overrides.get(entityKey(target))?.get(component.id);
  if (value !== undefined) {
    return value;
  }
  return target instanceof SpawnTicket ? false : world.hasComponent(target, component);
}

function setVirtualComponent(
  overrides: Map<string, Map<string, boolean>>,
  target: VirtualTarget,
  component: ComponentType<object>,
  present: boolean
): void {
  const key = entityKey(target);
  let components = overrides.get(key);
  if (!components) {
    components = new Map();
    overrides.set(key, components);
  }
  components.set(component.id, present);
}

function validateComponent(
  world: World,
  component: ComponentType<object>,
  data: ComponentInput
): void {
  if (!world.isComponentRegistered(component)) {
    throw new Error(`Component "${component.id}" is not registered.`);
  }
  validateComponentInput(component, data);
}

function validateEntity(
  target: CommandEntity,
  world: World,
  owner: symbol,
  availableTickets: ReadonlySet<SpawnTicket>,
  dead: ReadonlySet<string>
): VirtualTarget {
  if (target instanceof SpawnTicket) {
    if (target.owner !== owner) {
      throw new Error('SpawnTicket belongs to a different CommandBuffer.');
    }
    if (!availableTickets.has(target)) {
      throw new Error(`SpawnTicket ${target.index} is referenced before its spawn command.`);
    }
  } else if (!world.isAlive(target)) {
    throw new Error(`Command references stale entity "${target}".`);
  }
  if (dead.has(entityKey(target))) {
    throw new Error(`Command references entity "${entityKey(target)}" after despawn.`);
  }
  return target;
}

function createsCycle(
  world: World,
  relation: RelationType,
  source: VirtualTarget,
  target: VirtualTarget,
  overrides: ReadonlyMap<string, VirtualTarget | null>
): boolean {
  const sourceKey = entityKey(source);
  const visited = new Set<string>();
  let current: VirtualTarget | null = target;
  while (current !== null) {
    const key = entityKey(current);
    if (key === sourceKey) {
      return true;
    }
    if (visited.has(key)) {
      return true;
    }
    visited.add(key);
    if (overrides.has(key)) {
      current = overrides.get(key) ?? null;
    } else if (current instanceof SpawnTicket) {
      current = null;
    } else {
      current = world.getRelation(current, relation)?.target ?? null;
    }
  }
  return false;
}

function getRelationMap(
  maps: Map<symbol, Map<string, VirtualTarget | null>>,
  relation: RelationType
): Map<string, VirtualTarget | null> {
  let map = maps.get(relation.id);
  if (!map) {
    map = new Map();
    maps.set(relation.id, map);
  }
  return map;
}
