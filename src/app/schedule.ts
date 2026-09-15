import type { World } from '../ecs/world';
import type {
  ScheduleLabel,
  SystemDescriptor,
  SystemRegistration,
  SystemSetDescriptor
} from './types';
import { isPromiseLike } from '../core';
import {
  type CompiledSetNode,
  type CompiledSystemNode,
  compileScheduleOrder
} from './schedule-compiler';

export type { CompiledSetNode, CompiledSystemNode } from './schedule-compiler';

export interface ScheduleTelemetrySpanRecorder {
  recordSpan(schedule: string, systemId: string, durationMs: number): void;
  now(): number;
}

/**
 * Stage scheduler that organizes systems into an execution sequence.
 * Computes execution ordering topologically using virtual SystemSet nodes and deterministic tie-breaking.
 */
export class Schedule {
  readonly label: ScheduleLabel;

  private readonly systems: CompiledSystemNode[] = [];
  private readonly sets: CompiledSetNode[] = [];
  private executionOrder: readonly CompiledSystemNode[] = [];
  private isDirty = true;
  private nextRegistrationIndex = 0;

  constructor(label: ScheduleLabel) {
    this.label = label;
  }

  addSystem(descriptor: SystemDescriptor, ownerPlugin?: string): SystemRegistration {
    if (descriptor.id.trim() === '') {
      throw new Error(`Schedule "${this.label}" requires a non-empty system id.`);
    }

    const node: CompiledSystemNode = {
      id: descriptor.id,
      run: descriptor.run,
      inSet: descriptor.inSet,
      before: Object.freeze([...(descriptor.before ?? [])]),
      after: Object.freeze([...(descriptor.after ?? [])]),
      optionalBefore: Object.freeze([...(descriptor.optionalBefore ?? [])]),
      optionalAfter: Object.freeze([...(descriptor.optionalAfter ?? [])]),
      reads: Object.freeze([...(descriptor.reads ?? [])]),
      writes: Object.freeze([...(descriptor.writes ?? [])]),
      runIf: descriptor.runIf,
      ownerPlugin,
      registrationIndex: this.nextRegistrationIndex++
    };

    this.systems.push(node);
    this.isDirty = true;
    return { schedule: this.label, id: node.id };
  }

  addSystemSet(descriptor: SystemSetDescriptor, ownerPlugin?: string): void {
    if (descriptor.id.trim() === '') {
      throw new Error(`Schedule "${this.label}" requires a non-empty system set id.`);
    }

    const setNode: CompiledSetNode = {
      id: descriptor.id,
      before: Object.freeze([...(descriptor.before ?? [])]),
      after: Object.freeze([...(descriptor.after ?? [])]),
      runIf: descriptor.runIf,
      ownerPlugin,
      registrationIndex: this.nextRegistrationIndex++
    };

    this.sets.push(setNode);
    this.isDirty = true;
  }

  removeSystem(registration: SystemRegistration): boolean {
    if (registration.schedule !== this.label) {
      return false;
    }
    const index = this.systems.findIndex((system) => system.id === registration.id);
    if (index < 0) {
      return false;
    }
    this.systems.splice(index, 1);
    this.isDirty = true;
    return true;
  }

  removeSystemSet(id: string): boolean {
    const index = this.sets.findIndex((s) => s.id === id);
    if (index < 0) {
      return false;
    }
    this.sets.splice(index, 1);
    this.isDirty = true;
    return true;
  }

  /**
   * Compiles the schedule DAG eagerly before startup.
   * Throws immediately on missing targets or cycles.
   */
  compile(): readonly CompiledSystemNode[] {
    if (this.isDirty) {
      this.executionOrder = compileScheduleOrder(this.label, this.systems, this.sets);
      this.isDirty = false;
    }
    return this.executionOrder;
  }

  /**
   * Executes all systems sequentially in topological order.
   * Awaits any asynchronous systems. Used for startup phases.
   */
  async run(world: World, telemetry?: ScheduleTelemetrySpanRecorder): Promise<void> {
    const executionOrder = this.compile();
    const setConditionCache = this.evaluateSetConditions(world);

    for (const node of executionOrder) {
      if (node.inSet !== undefined && setConditionCache?.get(node.inSet) === false) {
        continue;
      }
      if (node.runIf && !node.runIf(world)) {
        continue;
      }

      if (telemetry) {
        const start = telemetry.now();
        await world.runTrackedSystemAsync(`${this.label}:${node.id}`, async () => {
          await node.run(world);
        });
        telemetry.recordSpan(this.label, node.id, telemetry.now() - start);
      } else {
        await world.runTrackedSystemAsync(`${this.label}:${node.id}`, async () => {
          await node.run(world);
        });
      }
    }
  }

  /**
   * Executes all systems synchronously. Throws if any system returns a Promise.
   * Used for high-frequency frame loops to guarantee zero promise/microtask allocations.
   */
  runSync(
    world: World,
    kind: 'startup' | 'frame' = 'frame',
    telemetry?: ScheduleTelemetrySpanRecorder
  ): void {
    const executionOrder = this.compile();
    const setConditionCache = this.evaluateSetConditions(world);

    for (const node of executionOrder) {
      if (node.inSet !== undefined && setConditionCache?.get(node.inSet) === false) {
        continue;
      }
      if (node.runIf && !node.runIf(world)) {
        continue;
      }

      if (telemetry) {
        const start = telemetry.now();
        const result = world.runTrackedSystem(`${this.label}:${node.id}`, () => node.run(world));
        if (isPromiseLike(result)) {
          throw new Error(
            `Async system "${node.id}" cannot run in ${kind} schedule "${this.label}".`
          );
        }
        telemetry.recordSpan(this.label, node.id, telemetry.now() - start);
      } else {
        const result = world.runTrackedSystem(`${this.label}:${node.id}`, () => node.run(world));
        if (isPromiseLike(result)) {
          throw new Error(
            `Async system "${node.id}" cannot run in ${kind} schedule "${this.label}".`
          );
        }
      }
    }
  }

  private evaluateSetConditions(world: World): Map<string, boolean> | undefined {
    let map: Map<string, boolean> | undefined;
    for (const s of this.sets) {
      if (s.runIf) {
        map ??= new Map();
        map.set(s.id, s.runIf(world));
      }
    }
    return map;
  }
}
