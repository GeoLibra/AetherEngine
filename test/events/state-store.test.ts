import { describe, expect, test } from 'vitest';
import {
  App,
  HeadlessRunner,
  StateStore,
  definePlugin,
  type Entity
} from '../../src';

type GameState = 'menu' | 'playing' | 'paused';

describe('StateStore', () => {
  test('applies transitions in Exit-cleanup-Enter order and publishes history', () => {
    const events: string[] = [];
    let state!: StateStore<GameState>;
    state = new StateStore<GameState>('menu', {
      onExit(transition) {
        events.push(`exit:${transition.from}`);
      },
      onCleanup(transition) {
        events.push(`cleanup:${transition.from}`);
      },
      onEnter(transition) {
        events.push(`enter:${transition.to}:current=${state.current}`);
      }
    });
    state.request('playing', 'start-game');

    const transition = state.applyNext();

    expect(transition).toEqual({ from: 'menu', to: 'playing', reason: 'start-game' });
    expect(state.current).toBe('playing');
    expect(events).toEqual([
      'exit:menu',
      'cleanup:menu',
      'enter:playing:current=playing'
    ]);
    expect(state.history).toEqual([transition]);
  });

  test('keeps last-good state and queued transition when a hook fails', () => {
    let fail = true;
    const state = new StateStore<GameState>('menu', {
      onEnter() {
        if (fail) {
          throw new Error('enter failed');
        }
      }
    });
    state.request('playing', 'start-game');

    expect(() => state.applyNext()).toThrow('enter failed');
    expect(state.current).toBe('menu');
    expect(state.pending).toBe(1);

    fail = false;
    state.applyNext();
    expect(state.current).toBe('playing');
  });

  test('deduplicates no-op transitions and rejects recursive requests from hooks', () => {
    let state!: StateStore<GameState>;
    state = new StateStore<GameState>('menu', {
      onExit() {
        state.request('paused', 'recursive');
      }
    });

    expect(state.request('menu', 'no-op')).toBe(false);
    expect(state.request('playing', 'start')).toBe(true);
    expect(state.request('playing', 'duplicate')).toBe(false);
    expect(() => state.applyNext()).toThrow('during transition hooks');
    expect(state.current).toBe('menu');
    expect(state.pending).toBe(1);
  });

  test('App applies registered transitions and scoped cleanup commands at PostUpdate', async () => {
    let scopedEntity!: Entity;
    const state = new StateStore<GameState>('menu', {
      onCleanup(_transition, context) {
        context.commands?.despawn(scopedEntity);
      }
    });
    const observations: Array<{ state: GameState; alive: boolean }> = [];
    const app = new App().addPlugin(
      definePlugin({
        id: 'test.state-plugin',
        build(builder) {
          builder.addStateStore('game', state);
          builder.addSystem('Update', {
            id: 'request-playing',
            run(world) {
              scopedEntity = world.spawn().build();
              state.request('playing', 'start');
            }
          });
          builder.addSystem('Last', {
            id: 'observe-playing',
            run(world) {
              observations.push({ state: state.current, alive: world.isAlive(scopedEntity) });
            }
          });
        }
      })
    );

    await app.run(new HeadlessRunner({ frames: 1 }));

    expect(observations).toEqual([{ state: 'playing', alive: false }]);
  });
});
