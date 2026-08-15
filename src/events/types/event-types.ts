export type EventRetention = 'one-frame' | 'one-fixed-tick' | 'until-all-readers' | 'bounded-log';

export type EventOverflowPolicy = 'drop-oldest' | 'drop-newest' | 'error';

export interface EventChannelOptions {
  readonly retention: EventRetention;
  readonly capacity: number;
  readonly overflow: EventOverflowPolicy;
  readonly writerStages?: readonly string[];
  readonly readerStages?: readonly string[];
}

export interface EventReaderOptions {
  readonly from?: 'current' | 'beginning';
}

export interface EventChannelDiagnostics {
  readonly published: number;
  readonly droppedOldest: number;
  readonly droppedNewest: number;
}
