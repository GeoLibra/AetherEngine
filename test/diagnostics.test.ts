import { describe, expect, test } from 'vitest';
import {
  App,
  DiagnosticStore,
  HeadlessRunner,
  definePlugin
} from '../src';

describe('DiagnosticStore', () => {
  test('keeps bounded immutable snapshots without retaining raw Error objects', () => {
    const store = new DiagnosticStore(1);
    const context = { quality: 'fallback' };
    store.emit({
      code: 'feature/fallback',
      severity: 'warning',
      message: 'Using the approved fallback.',
      subsystem: 'feature-policy',
      context,
      cause: new Error('unsupported')
    });
    context.quality = 'mutated';
    expect(store.list()[0]).toMatchObject({
      context: { quality: 'fallback' },
      cause: { name: 'Error', message: 'unsupported' }
    });
    expect(store.list()[0]?.cause).not.toBeInstanceOf(Error);
    store.emit({
      code: 'feature/second',
      severity: 'info',
      message: 'Second record.',
      subsystem: 'feature-policy'
    });

    expect(store.dropped).toBe(1);
    expect(store.list()).toEqual([
      {
        code: 'feature/second',
        severity: 'info',
        message: 'Second record.',
        subsystem: 'feature-policy'
      }
    ]);
  });

  test('makes App lifecycle failures queryable through the shared store', async () => {
    const app = new App().addPlugin(
      definePlugin({
        id: 'diagnostic-failure',
        build(builder) {
          builder.addSystem('Update', {
            id: 'fail',
            run: () => {
              throw new Error('runtime failure');
            }
          });
        }
      })
    );

    await expect(app.run(new HeadlessRunner({ frames: 1 }))).rejects.toThrow(
      'runtime failure'
    );

    expect(app.getResource(DiagnosticStore)?.list({ code: 'APP_RUNTIME_FAILED' }))
      .toHaveLength(1);
    expect(
      app.getResource(DiagnosticStore)?.list()[0]?.cause
    ).toEqual({ name: 'Error', message: 'runtime failure' });
  });
});
