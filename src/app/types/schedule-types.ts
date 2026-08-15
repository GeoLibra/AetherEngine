import type { ComponentType, RelationType, ResourceToken } from '../../ecs/types';
import type { World } from '../../ecs/world';
import type { CoreSchedule } from '../constants';

export type { CoreSchedule } from '../constants';

export type ScheduleLabel = CoreSchedule | (string & {});

export type System = (world: World) => void | Promise<void>;

export type AccessToken = ComponentType<object> | RelationType | ResourceToken<unknown>;

export interface SystemDescriptor {
  readonly id: string;
  readonly run: System;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly optionalBefore?: readonly string[];
  readonly optionalAfter?: readonly string[];
  readonly reads?: readonly AccessToken[];
  readonly writes?: readonly AccessToken[];
  readonly runIf?: (world: World) => boolean;
}

export interface SystemRegistration {
  readonly schedule: ScheduleLabel;
  readonly id: string;
}

export interface CommandApplyPointDescriptor {
  readonly id: string;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly optionalBefore?: readonly string[];
  readonly optionalAfter?: readonly string[];
}
