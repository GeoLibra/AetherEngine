import { cloneUnknown } from '../schema/migration';
import { defineResource } from './resource';
import { validateComponentInput } from './component';
import type {
  CommandApplyResult,
  CommandEntity,
  ComponentBundle,
  SpawnTicket,
  WorldCommand
} from './command-types';
import { SpawnTicket as SpawnTicketValue } from './command-types';
import type { ComponentInput, ComponentType, Entity, RelationType } from './types';
import type { World } from './world';

type VirtualTarget = Entity | SpawnTicket;

export class CommandBuffer {
  private readonly owner = Symbol('CommandBuffer');
  private readonly commands: WorldCommand[] = [];
  private readonly lastResolved = new Map<SpawnTicket, Entity>();
  private nextTicket = 0;

  get length(): number {
    return this.commands.length;
  }

  spawn(bundle: ComponentBundle = []): SpawnTicket {
    const ticket = new SpawnTicketValue(this.owner, this.nextTicket++);
    this.commands.push({ kind: 'spawn', ticket, bundle: cloneBundle(bundle) });
    return ticket;
  }

  despawn(entity: CommandEntity): this {
    this.commands.push({ kind: 'despawn', entity });
    return this;
  }

  insert<TView extends object>(
    entity: CommandEntity,
    component: ComponentType<TView>,
    data: ComponentInput = {}
  ): this {
    this.commands.push({
      kind: 'insert',
      entity,
      component: component as ComponentType<object>,
      data: cloneInput(data)
    });
    return this;
  }

  remove<TView extends object>(entity: CommandEntity, component: ComponentType<TView>): this {
    this.commands.push({
      kind: 'remove',
      entity,
      component: component as ComponentType<object>
    });
    return this;
  }

  setRelation(
    source: CommandEntity,
    relation: RelationType,
    target?: CommandEntity
  ): this {
    this.commands.push(
      target === undefined
        ? { kind: 'relation', source, relation }
        : { kind: 'relation', source, relation, target }
    );
    return this;
  }

  clear(): void {
    this.commands.length = 0;
  }

  append(source: CommandBuffer): void {
    if (source === this) {
      throw new Error('CommandBuffer cannot append itself.');
    }
    const tickets = new Map<SpawnTicket, SpawnTicket>();
    for (const command of source.commands) {
      switch (command.kind) {
        case 'spawn': {
          const ticket = this.spawn(command.bundle);
          tickets.set(command.ticket, ticket);
          break;
        }
        case 'despawn':
          this.despawn(remapEntity(command.entity, tickets));
          break;
        case 'insert':
          this.insert(
            remapEntity(command.entity, tickets),
            command.component,
            command.data
          );
          break;
        case 'remove':
          this.remove(remapEntity(command.entity, tickets), command.component);
          break;
        case 'relation':
          this.setRelation(
            remapEntity(command.source, tickets),
            command.relation,
            command.target === undefined ? undefined : remapEntity(command.target, tickets)
          );
          break;
      }
    }
    source.clear();
  }

  resolve(ticket: SpawnTicket): Entity {
    this.assertOwnedTicket(ticket);
    const entity = this.lastResolved.get(ticket);
    if (entity === undefined) {
      throw new Error(`SpawnTicket ${ticket.index} has not been applied.`);
    }
    return entity;
  }

  apply(world: World, applyPoint = 'manual'): CommandApplyResult {
    this.validate(world);
    const resolved = new Map<SpawnTicket, Entity>();
    const commandCount = this.commands.length;

    for (const command of this.commands) {
      switch (command.kind) {
        case 'spawn': {
          const entity = world.spawn().build();
          resolved.set(command.ticket, entity);
          for (const value of command.bundle) {
            world.insertComponent(entity, value.component, value.data ?? {});
          }
          break;
        }
        case 'despawn':
          world.despawn(resolveEntity(command.entity, resolved));
          break;
        case 'insert':
          world.insertComponent(
            resolveEntity(command.entity, resolved),
            command.component,
            command.data
          );
          break;
        case 'remove':
          world.removeComponent(resolveEntity(command.entity, resolved), command.component);
          break;
        case 'relation': {
          const source = resolveEntity(command.source, resolved);
          if (command.target === undefined) {
            world.removeRelation(source, command.relation);
          } else {
            world.addRelation(
              source,
              command.relation,
              resolveEntity(command.target, resolved)
            );
          }
          break;
        }
      }
    }

    this.commands.length = 0;
    this.lastResolved.clear();
    for (const [ticket, entity] of resolved) {
      this.lastResolved.set(ticket, entity);
    }
    return createApplyResult(this.owner, applyPoint, commandCount, resolved);
  }

  private validate(world: World): void {
    const availableTickets = new Set<SpawnTicket>();
    const dead = new Set<string>();
    const relationOverrides = new Map<symbol, Map<string, VirtualTarget | null>>();
    const componentOverrides = new Map<string, Map<string, boolean>>();

    for (const command of this.commands) {
      switch (command.kind) {
        case 'spawn':
          this.assertOwnedTicket(command.ticket);
          availableTickets.add(command.ticket);
          for (const value of command.bundle) {
            setVirtualComponent(componentOverrides, command.ticket, value.component, true);
          }
          for (const value of command.bundle) {
            validateComponent(world, value.component, value.data ?? {});
          }
          break;
        case 'despawn': {
          const target = validateEntity(command.entity, world, this.owner, availableTickets, dead);
          dead.add(entityKey(target));
          break;
        }
        case 'insert': {
          const target = validateEntity(
            command.entity,
            world,
            this.owner,
            availableTickets,
            dead
          );
          validateComponent(world, command.component, command.data);
          setVirtualComponent(componentOverrides, target, command.component, true);
          break;
        }
        case 'remove': {
          const target = validateEntity(command.entity, world, this.owner, availableTickets, dead);
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
          const source = validateEntity(
            command.source,
            world,
            this.owner,
            availableTickets,
            dead
          );
          const relationMap = getRelationMap(relationOverrides, command.relation);
          if (command.target === undefined) {
            relationMap.set(entityKey(source), null);
            break;
          }
          const target = validateEntity(
            command.target,
            world,
            this.owner,
            availableTickets,
            dead
          );
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

  private assertOwnedTicket(ticket: SpawnTicket): void {
    if (ticket.owner !== this.owner) {
      throw new Error('SpawnTicket belongs to a different CommandBuffer.');
    }
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
  return target instanceof SpawnTicketValue
    ? false
    : world.hasComponent(target, component);
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
  if (target instanceof SpawnTicketValue) {
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
    } else if (current instanceof SpawnTicketValue) {
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

function resolveEntity(target: CommandEntity, resolved: ReadonlyMap<SpawnTicket, Entity>): Entity {
  if (!(target instanceof SpawnTicketValue)) {
    return target;
  }
  const entity = resolved.get(target);
  if (entity === undefined) {
    throw new Error(`SpawnTicket ${target.index} was not resolved during apply.`);
  }
  return entity;
}

function remapEntity(
  target: CommandEntity,
  tickets: ReadonlyMap<SpawnTicket, SpawnTicket>
): CommandEntity {
  if (!(target instanceof SpawnTicketValue)) {
    return target;
  }
  const remapped = tickets.get(target);
  if (!remapped) {
    throw new Error(`SpawnTicket ${target.index} is referenced before append remapping.`);
  }
  return remapped;
}

function entityKey(target: VirtualTarget): string {
  return target instanceof SpawnTicketValue ? `ticket:${target.index}` : `entity:${target}`;
}

function cloneBundle(bundle: ComponentBundle): ComponentBundle {
  return Object.freeze(
    bundle.map((value) =>
      Object.freeze({
        component: value.component,
        ...(value.data === undefined ? {} : { data: cloneInput(value.data) })
      })
    )
  );
}

function cloneInput(data: ComponentInput): ComponentInput {
  return cloneUnknown(data) as ComponentInput;
}

function createApplyResult(
  owner: symbol,
  applyPoint: string,
  commandCount: number,
  resolved: ReadonlyMap<SpawnTicket, Entity>
): CommandApplyResult {
  return Object.freeze({
    applyPoint,
    commandCount,
    resolve(ticket: SpawnTicket): Entity {
      if (ticket.owner !== owner) {
        throw new Error('SpawnTicket belongs to a different CommandBuffer.');
      }
      const entity = resolved.get(ticket);
      if (entity === undefined) {
        throw new Error(`SpawnTicket ${ticket.index} was not part of this apply batch.`);
      }
      return entity;
    }
  });
}

export const CommandBufferResource = defineResource<CommandBuffer>('aether.command-buffer');
