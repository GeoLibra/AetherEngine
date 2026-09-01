import { cloneUnknown, freezeUnknown } from '../schema/utils';
import type { EventChannelDiagnostics, EventChannelOptions, EventReaderOptions } from './types';

interface EventEntry<T> {
  readonly sequence: number;
  readonly value: T;
  readonly frame: number;
  readonly fixedTick: number;
}

export class EventReader<T> {
  readonly __eventType?: T;
  private sequence: number;

  constructor(
    readonly owner: symbol,
    initialSequence: number
  ) {
    this.sequence = initialSequence;
  }

  get cursor(): number {
    return this.sequence;
  }

  advance(sequence: number): void {
    this.sequence = sequence;
  }
}

export class EventChannel<T> {
  private readonly owner = Symbol('EventChannel');
  private readonly entries: EventEntry<T>[] = [];
  private readonly readers = new Set<EventReader<T>>();
  private readonly writerStages: ReadonlySet<string>;
  private readonly readerStages: ReadonlySet<string>;
  private nextSequence = 1;
  private frame = 0;
  private fixedTick = 0;
  private publishedCount = 0;
  private droppedOldestCount = 0;
  private droppedNewestCount = 0;

  constructor(private readonly options: Readonly<EventChannelOptions>) {
    if (!Number.isInteger(options.capacity) || options.capacity <= 0) {
      throw new Error('EventChannel capacity must be a positive integer.');
    }
    this.writerStages = new Set(options.writerStages ?? []);
    this.readerStages = new Set(options.readerStages ?? []);
  }

  get size(): number {
    return this.entries.length;
  }

  get diagnostics(): EventChannelDiagnostics {
    return Object.freeze({
      published: this.publishedCount,
      droppedOldest: this.droppedOldestCount,
      droppedNewest: this.droppedNewestCount
    });
  }

  createReader(options: EventReaderOptions = {}): EventReader<T> {
    const initialSequence =
      options.from === 'beginning'
        ? (this.entries[0]?.sequence ?? this.nextSequence) - 1
        : this.nextSequence - 1;
    const reader = new EventReader<T>(this.owner, initialSequence);
    this.readers.add(reader);
    return reader;
  }

  releaseReader(reader: EventReader<T>): boolean {
    this.assertReader(reader);
    const released = this.readers.delete(reader);
    if (released) {
      this.pruneAllRead();
    }
    return released;
  }

  publish(event: T, stage?: string): boolean {
    this.assertStage('writer', stage, this.writerStages);
    if (this.entries.length >= this.options.capacity) {
      switch (this.options.overflow) {
        case 'drop-oldest':
          this.entries.shift();
          this.droppedOldestCount++;
          break;
        case 'drop-newest':
          this.droppedNewestCount++;
          return false;
        case 'error':
          throw new Error(`EventChannel overflowed its capacity of ${this.options.capacity}.`);
      }
    }

    const value = freezeUnknown(cloneUnknown(event)) as T;
    this.entries.push({
      sequence: this.nextSequence++,
      value,
      frame: this.frame,
      fixedTick: this.fixedTick
    });
    this.publishedCount++;
    return true;
  }

  read(reader: EventReader<T>, stage?: string): readonly T[] {
    this.assertReader(reader);
    this.assertStage('reader', stage, this.readerStages);
    const values = this.entries
      .filter((entry) => entry.sequence > reader.cursor)
      .map((entry) => entry.value);
    reader.advance(this.entries.at(-1)?.sequence ?? this.nextSequence - 1);
    this.pruneAllRead();
    return Object.freeze(values);
  }

  advanceFrame(): void {
    this.frame++;
    if (this.options.retention === 'one-frame') {
      this.removeExpired((entry) => entry.frame < this.frame);
    }
  }

  advanceFixedTick(): void {
    this.fixedTick++;
    if (this.options.retention === 'one-fixed-tick') {
      this.removeExpired((entry) => entry.fixedTick < this.fixedTick);
    }
  }

  private removeExpired(predicate: (entry: EventEntry<T>) => boolean): void {
    let count = 0;
    while (count < this.entries.length && predicate(this.entries[count]!)) {
      count++;
    }
    if (count > 0) {
      this.entries.splice(0, count);
    }
  }

  private pruneAllRead(): void {
    if (this.options.retention !== 'until-all-readers' || this.readers.size === 0) {
      return;
    }
    let count = 0;
    while (
      count < this.entries.length &&
      [...this.readers].every((reader) => reader.cursor >= this.entries[count]!.sequence)
    ) {
      count++;
    }
    if (count > 0) {
      this.entries.splice(0, count);
    }
  }

  private assertReader(reader: EventReader<T>): void {
    if (reader.owner !== this.owner || !this.readers.has(reader)) {
      throw new Error('EventReader does not belong to this EventChannel.');
    }
  }

  private assertStage(
    kind: 'writer' | 'reader',
    stage: string | undefined,
    allowed: ReadonlySet<string>
  ): void {
    if (allowed.size === 0) {
      return;
    }
    if (stage === undefined || !allowed.has(stage)) {
      throw new Error(`EventChannel ${kind} stage "${stage ?? '<unspecified>'}" is not allowed.`);
    }
  }
}
