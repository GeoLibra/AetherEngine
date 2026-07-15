import { describe, expect, test } from 'vitest';
import {
  App,
  EventChannel,
  HeadlessRunner,
  definePlugin
} from '../../src';

describe('EventChannel', () => {
  test('retains events until every independent reader consumes them', () => {
    const channel = new EventChannel<{ value: number }>({
      retention: 'until-all-readers',
      capacity: 8,
      overflow: 'error'
    });
    const first = channel.createReader({ from: 'current' });
    const second = channel.createReader({ from: 'current' });

    channel.publish({ value: 1 });
    channel.publish({ value: 2 });

    expect(channel.read(first)).toEqual([{ value: 1 }, { value: 2 }]);
    expect(channel.read(first)).toEqual([]);
    expect(channel.size).toBe(2);
    expect(channel.read(second)).toEqual([{ value: 1 }, { value: 2 }]);
    expect(channel.size).toBe(0);
  });

  test('copies published values and applies bounded overflow policies', () => {
    const channel = new EventChannel<{ value: number }>({
      retention: 'bounded-log',
      capacity: 2,
      overflow: 'drop-oldest'
    });
    const reader = channel.createReader({ from: 'beginning' });
    const source = { value: 1 };

    channel.publish(source);
    source.value = 99;
    channel.publish({ value: 2 });
    channel.publish({ value: 3 });

    expect(channel.read(reader)).toEqual([{ value: 2 }, { value: 3 }]);
    expect(channel.diagnostics).toMatchObject({ droppedOldest: 1, droppedNewest: 0 });

    const dropNewest = new EventChannel<number>({
      retention: 'bounded-log',
      capacity: 1,
      overflow: 'drop-newest'
    });
    dropNewest.publish(1);
    expect(dropNewest.publish(2)).toBe(false);
    expect(dropNewest.diagnostics.droppedNewest).toBe(1);
  });

  test('enforces declared writer and reader stages', () => {
    const channel = new EventChannel<string>({
      retention: 'one-frame',
      capacity: 4,
      overflow: 'error',
      writerStages: ['Update'],
      readerStages: ['PostUpdate']
    });
    const reader = channel.createReader({ from: 'current' });

    expect(() => channel.publish('invalid', 'PreUpdate')).toThrow('writer stage');
    channel.publish('valid', 'Update');
    expect(() => channel.read(reader, 'Update')).toThrow('reader stage');
    expect(channel.read(reader, 'PostUpdate')).toEqual(['valid']);
  });

  test('expires one-frame and one-fixed-tick events only at their matching boundary', () => {
    const frame = new EventChannel<number>({
      retention: 'one-frame',
      capacity: 4,
      overflow: 'error'
    });
    const fixed = new EventChannel<number>({
      retention: 'one-fixed-tick',
      capacity: 4,
      overflow: 'error'
    });
    const frameReader = frame.createReader({ from: 'beginning' });
    const fixedReader = fixed.createReader({ from: 'beginning' });
    frame.publish(1);
    fixed.publish(2);

    fixed.advanceFrame();
    frame.advanceFixedTick();
    expect(frame.read(frameReader)).toEqual([1]);
    expect(fixed.read(fixedReader)).toEqual([2]);

    frame.advanceFrame();
    fixed.advanceFixedTick();
    const lateFrameReader = frame.createReader({ from: 'beginning' });
    const lateFixedReader = fixed.createReader({ from: 'beginning' });
    expect(frame.read(lateFrameReader)).toEqual([]);
    expect(fixed.read(lateFixedReader)).toEqual([]);
  });

  test('AppBuilder registers channels and App advances one-frame retention', async () => {
    const channel = new EventChannel<number>({
      retention: 'one-frame',
      capacity: 4,
      overflow: 'error',
      writerStages: ['Update'],
      readerStages: ['Last']
    });
    const reader = channel.createReader({ from: 'current' });
    const received: number[][] = [];
    let frame = 0;
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.event-plugin',
        build(builder) {
          builder.addEventChannel('test.frame-events', channel);
          builder.addSystem('Update', {
            id: 'publish-frame-event',
            run() {
              channel.publish(++frame, 'Update');
            }
          });
          builder.addSystem('Last', {
            id: 'read-frame-event',
            run() {
              received.push([...channel.read(reader, 'Last')]);
            }
          });
        }
      })
    );

    await app.run(new HeadlessRunner({ frames: 2 }));

    expect(received).toEqual([[1], [2]]);
    expect(channel.size).toBe(0);
  });
});
