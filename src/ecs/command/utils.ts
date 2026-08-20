import { cloneUnknown } from '../../schema/migration';
import { SpawnTicket } from './spawn-ticket';
import type {
  CommandApplyResult,
  CommandEntity,
  ComponentBundle,
  ComponentInput,
  Entity
} from '../types';

/**
 * Target type for virtual entity resolution during validation and commit.
 */
export type VirtualTarget = Entity | SpawnTicket;

/**
 * Returns a deterministic key string for an Entity or SpawnTicket.
 */
export function entityKey(target: VirtualTarget): string {
  return target instanceof SpawnTicket ? `ticket:${target.index}` : `entity:${target}`;
}

/**
 * Deep clones a component bundle to establish an ownership trust boundary.
 */
export function cloneBundle(bundle: ComponentBundle): ComponentBundle {
  return bundle.map((value) => ({
    component: value.component,
    ...(value.data === undefined ? {} : { data: cloneInput(value.data) })
  }));
}

/**
 * Deep clones arbitrary component input data.
 */
export function cloneInput(data: ComponentInput): ComponentInput {
  return cloneUnknown(data) as ComponentInput;
}

/**
 * Resolves a CommandEntity (Entity | SpawnTicket) to its concrete Entity handle.
 *
 * @throws If a SpawnTicket was not resolved in the current apply batch.
 */
export function resolveEntity(
  target: CommandEntity,
  resolved: ReadonlyMap<SpawnTicket, Entity>
): Entity {
  if (!(target instanceof SpawnTicket)) {
    return target;
  }
  const entity = resolved.get(target);
  if (entity === undefined) {
    throw new Error(`SpawnTicket ${target.index} was not resolved during apply.`);
  }
  return entity;
}

/**
 * Remaps a CommandEntity's SpawnTicket to a new ticket during CommandBuffer append.
 *
 * @throws If a SpawnTicket is referenced before its spawn command in the source buffer.
 */
export function remapEntity(
  target: CommandEntity,
  tickets: ReadonlyMap<SpawnTicket, SpawnTicket>
): CommandEntity {
  if (!(target instanceof SpawnTicket)) {
    return target;
  }
  const remapped = tickets.get(target);
  if (!remapped) {
    throw new Error(`SpawnTicket ${target.index} is referenced before append remapping.`);
  }
  return remapped;
}

/**
 * Constructs a frozen CommandApplyResult snapshot.
 */
export function createApplyResult(
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
