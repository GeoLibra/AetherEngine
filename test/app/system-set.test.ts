import { describe, expect, test } from 'vitest';
import { App, definePlugin, type World } from '../../src';

describe('Schedule SystemSet contract', () => {
  test('orders all members of earlier set before any member of later set', async () => {
    const trace: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'sets-test',
        build(builder) {
          builder.addSystemSet('Update', {
            id: 'animation-set'
          });
          builder.addSystemSet('Update', {
            id: 'transform-set',
            after: ['animation-set']
          });

          // Register in interleaved order
          builder.addSystem('Update', {
            id: 'transform-child',
            inSet: 'transform-set',
            run: () => void trace.push('transform-child')
          });
          builder.addSystem('Update', {
            id: 'animation-clip',
            inSet: 'animation-set',
            run: () => void trace.push('animation-clip')
          });
          builder.addSystem('Update', {
            id: 'transform-root',
            inSet: 'transform-set',
            run: () => void trace.push('transform-root')
          });
          builder.addSystem('Update', {
            id: 'animation-blend',
            inSet: 'animation-set',
            run: () => void trace.push('animation-blend')
          });
        }
      })
    );

    await app.startup();
    // Headless run or manual step
    const runner = {
      run: async (ctx: any) => {
        ctx.frame(0.016);
        return { reason: 'stop', frames: 1 };
      },
      requestStop: () => undefined
    };
    await app.run(runner);

    expect(trace).toEqual([
      'animation-clip',
      'animation-blend',
      'transform-child',
      'transform-root'
    ]);
  });

  test('empty declared sets retain ordering boundaries', async () => {
    const trace: string[] = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'empty-set-test',
        build(builder) {
          builder.addSystemSet('Update', {
            id: 'empty-middle-set'
          });
          builder.addSystem('Update', {
            id: 'early-system',
            before: ['empty-middle-set'],
            run: () => void trace.push('early')
          });
          builder.addSystem('Update', {
            id: 'late-system',
            after: ['empty-middle-set'],
            run: () => void trace.push('late')
          });
        }
      })
    );

    await app.startup();
    await app.run({
      run: async (ctx: any) => {
        ctx.frame(0.016);
        return { reason: 'stop', frames: 1 };
      },
      requestStop: () => undefined
    });

    expect(trace).toEqual(['early', 'late']);
  });

  test('fails eager compilation when system references undeclared set', async () => {
    const app = new App().addPlugin(
      definePlugin({
        id: 'undeclared-set-test',
        build(builder) {
          builder.addSystem('Update', {
            id: 'orphan-system',
            inSet: 'missing-set',
            run: () => undefined
          });
        }
      })
    );

    await expect(app.startup()).rejects.toThrow('references undeclared set "missing-set"');
  });

  test('detects cycles created by mixing set and system constraints', async () => {
    const app = new App().addPlugin(
      definePlugin({
        id: 'cycle-set-test',
        build(builder) {
          builder.addSystemSet('Update', {
            id: 'set-a'
          });
          builder.addSystem('Update', {
            id: 'system-inside-a',
            inSet: 'set-a',
            run: () => undefined
          });
          builder.addSystem('Update', {
            id: 'external-system',
            after: ['set-a'],
            before: ['system-inside-a'],
            run: () => undefined
          });
        }
      })
    );

    await expect(app.startup()).rejects.toThrow('contains a cycle');
  });

  test('evaluates set run condition once per invocation and gates all members', async () => {
    let setEvalCount = 0;
    let systemEvalCount = 0;
    let systemRanCount = 0;
    let setConditionValue = false;

    const app = new App().addPlugin(
      definePlugin({
        id: 'set-condition-test',
        build(builder) {
          builder.addSystemSet('Update', {
            id: 'conditional-set',
            runIf: () => {
              setEvalCount++;
              return setConditionValue;
            }
          });
          builder.addSystem('Update', {
            id: 'member-1',
            inSet: 'conditional-set',
            runIf: () => {
              systemEvalCount++;
              return true;
            },
            run: () => {
              systemRanCount++;
            }
          });
          builder.addSystem('Update', {
            id: 'member-2',
            inSet: 'conditional-set',
            runIf: () => {
              systemEvalCount++;
              return true;
            },
            run: () => {
              systemRanCount++;
            }
          });
        }
      })
    );

    await app.startup();

    await app.run({
      run: async (ctx: any) => {
        // Frame 1: condition is false
        ctx.frame(0.016);
        expect(setEvalCount).toBe(1);
        expect(systemEvalCount).toBe(0); // System condition must not even be evaluated if set condition fails
        expect(systemRanCount).toBe(0);

        // Frame 2: condition is true
        setConditionValue = true;
        ctx.frame(0.032);
        expect(setEvalCount).toBe(2);
        expect(systemEvalCount).toBe(2);
        expect(systemRanCount).toBe(2);

        return { reason: 'stop', frames: 2 };
      },
      requestStop: () => undefined
    });
  });
});
