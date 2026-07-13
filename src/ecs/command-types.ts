import type { ComponentInput, ComponentType, Entity, RelationType } from './types';

export class SpawnTicket {
  constructor(
    readonly owner: symbol,
    readonly index: number
  ) {}
}

export type CommandEntity = Entity | SpawnTicket;

export interface ComponentCommandValue<TView extends object = object> {
  readonly component: ComponentType<TView>;
  readonly data?: ComponentInput;
}

export type ComponentBundle = readonly ComponentCommandValue[];

export type WorldCommand =
  | { readonly kind: 'spawn'; readonly ticket: SpawnTicket; readonly bundle: ComponentBundle }
  | { readonly kind: 'despawn'; readonly entity: CommandEntity }
  | {
      readonly kind: 'insert';
      readonly entity: CommandEntity;
      readonly component: ComponentType<object>;
      readonly data: ComponentInput;
    }
  | {
      readonly kind: 'remove';
      readonly entity: CommandEntity;
      readonly component: ComponentType<object>;
    }
  | {
      readonly kind: 'relation';
      readonly source: CommandEntity;
      readonly relation: RelationType;
      readonly target?: CommandEntity;
    };

export interface CommandApplyResult {
  readonly applyPoint: string;
  readonly commandCount: number;
  resolve(ticket: SpawnTicket): Entity;
}
