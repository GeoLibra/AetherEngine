import { defineResource } from '../resource';
import { SpawnTicket } from './spawn-ticket';
import type {
  CommandApplyResult,
  CommandEntity,
  ComponentBundle,
  ComponentInput,
  ComponentType,
  Entity,
  RelationType,
  WorldCommand
} from '../types';
import type { World } from '../world';
import { assertOwnedTicket, validateCommandBuffer } from './command-validator';
import { cloneBundle, cloneInput, createApplyResult, remapEntity, resolveEntity } from './utils';

/**
 * Deferred command buffer for recording structural World mutations.
 *
 * All structural mutations (spawn, despawn, insert, remove, relation) are recorded in order,
 * statically validated across the whole batch, and committed atomically at designated apply points.
 */
export class CommandBuffer {
  private readonly owner = Symbol('CommandBuffer');
  private readonly commands: WorldCommand[] = [];
  private readonly lastResolved = new Map<SpawnTicket, Entity>();
  private nextTicket = 0;
  private lastBatchSize = 0;

  /**
   * The number of pending commands currently queued in the buffer.
   */
  get length(): number {
    return this.commands.length;
  }

  /**
   * The number of commands committed in the most recent apply batch.
   */
  get lastAppliedBatchSize(): number {
    return this.lastBatchSize;
  }

  /**
   * Records an entity spawn command with an optional initial component bundle.
   *
   * @returns A virtual SpawnTicket placeholder usable in subsequent commands.
   */
  spawn(bundle: ComponentBundle = []): SpawnTicket {
    const ticket = new SpawnTicket(this.owner, this.nextTicket++);
    this.commands.push({ kind: 'spawn', ticket, bundle: cloneBundle(bundle) });
    return ticket;
  }

  /**
   * Records an entity despawn command.
   */
  despawn(entity: CommandEntity): this {
    this.commands.push({ kind: 'despawn', entity });
    return this;
  }

  /**
   * Records a component insertion command.
   */
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

  /**
   * Records a component removal command.
   */
  remove<TView extends object>(entity: CommandEntity, component: ComponentType<TView>): this {
    this.commands.push({
      kind: 'remove',
      entity,
      component: component as ComponentType<object>
    });
    return this;
  }

  /**
   * Records a relation set or clear command.
   */
  setRelation(source: CommandEntity, relation: RelationType, target?: CommandEntity): this {
    this.commands.push(
      target === undefined
        ? { kind: 'relation', source, relation }
        : { kind: 'relation', source, relation, target }
    );
    return this;
  }

  /**
   * Clears all pending commands from the buffer.
   */
  clear(): void {
    this.commands.length = 0;
  }

  /**
   * Appends and merges another CommandBuffer into this buffer, remapping its SpawnTickets.
   *
   * @throws If the source buffer is this CommandBuffer instance.
   */
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
          this.insert(remapEntity(command.entity, tickets), command.component, command.data);
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

  /**
   * Resolves a SpawnTicket from the most recent apply batch to its concrete Entity handle.
   *
   * @throws If the ticket has not yet been applied or belongs to a different buffer.
   */
  resolve(ticket: SpawnTicket): Entity {
    assertOwnedTicket(ticket, this.owner);
    const entity = this.lastResolved.get(ticket);
    if (entity === undefined) {
      throw new Error(`SpawnTicket ${ticket.index} has not been applied.`);
    }
    return entity;
  }

  /**
   * Statically validates all queued commands and commits them atomically to the World.
   *
   * @param world The target World instance to apply commands to.
   * @param applyPoint The name of the apply point for diagnostic tracking.
   * @returns An immutable CommandApplyResult with ticket resolution capabilities.
   * @throws If any command in the batch violates invariants, leaving the World unchanged.
   */
  apply(world: World, applyPoint = 'manual'): CommandApplyResult {
    validateCommandBuffer(this.commands, this.owner, world);
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
            world.addRelation(source, command.relation, resolveEntity(command.target, resolved));
          }
          break;
        }
      }
    }

    this.commands.length = 0;
    this.lastBatchSize = commandCount;
    world.recordCommandBatch(commandCount);
    this.lastResolved.clear();
    for (const [ticket, entity] of resolved) {
      this.lastResolved.set(ticket, entity);
    }
    return createApplyResult(this.owner, applyPoint, commandCount, resolved);
  }
}

/**
 * World-level singleton resource token for dependency-injecting the primary CommandBuffer.
 */
export const CommandBufferResource = defineResource<CommandBuffer>('aether.command-buffer');
