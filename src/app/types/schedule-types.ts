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
  readonly inSet?: string | undefined;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
  readonly optionalBefore?: readonly string[] | undefined;
  readonly optionalAfter?: readonly string[] | undefined;
  readonly reads?: readonly AccessToken[] | undefined;
  readonly writes?: readonly AccessToken[] | undefined;
  readonly runIf?: ((world: World) => boolean) | undefined;
}

export interface SystemSetDescriptor {
  readonly id: string;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
  readonly runIf?: ((world: World) => boolean) | undefined;
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
