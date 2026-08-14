import { describe, expect, it } from 'vitest';
import {
  DynamicCapabilityBroker,
  DynamicPluginScope,
  createDynamicCapabilityToken,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  type DynamicCapabilityPlan,
  type DynamicCapabilityProvider,
  type DynamicCapabilityToken
} from '../../src/dynamic-plugins';

const PanelToken = createDynamicCapabilityToken<{ add(id: string): void }>({
  id: 'editor.panel.contribute',
  version: 1,
  hostKinds: ['editor'],
  inheritable: false
});

const WorkerToken = createDynamicCapabilityToken<{ run(id: string): void }>({
  id: 'asset.worker.run',
  version: 1,
  hostKinds: ['asset-worker'],
  inheritable: false
});

describe('DynamicCapabilityBroker', () => {
  it('opens only declared and granted typed capabilities', async () => {
    const panelFacade = { add: (_id: string) => undefined };
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(provider(PanelToken, panelFacade));
    const session = await broker.open(planGranting('editor.panel.contribute'), createScope());

    expect(session.resolver.get(PanelToken)).toBe(panelFacade);
    expect(() => session.resolver.get(WorkerToken)).toThrow(/not granted/i);
  });

  it('rolls back opened leases in reverse order and publishes only on commit', async () => {
    const published: string[] = [];
    const rolledBack: string[] = [];
    const FirstToken = createDynamicCapabilityToken<Readonly<{ id: string }>>({
      id: 'editor.first',
      version: 1,
      hostKinds: ['editor'],
      inheritable: false
    });
    const SecondToken = createDynamicCapabilityToken<Readonly<{ id: string }>>({
      id: 'editor.second',
      version: 1,
      hostKinds: ['editor'],
      inheritable: false
    });
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(recordingProvider(FirstToken, 'first', published, rolledBack));
    broker.register(recordingProvider(SecondToken, 'second', published, rolledBack));

    const session = await broker.open(
      Object.freeze({
        granted: Object.freeze([
          { id: 'editor.first', version: 1, required: true },
          { id: 'editor.second', version: 1, required: true }
        ]),
        deniedOptional: Object.freeze([])
      }),
      createScope()
    );

    expect(published).toEqual([]);
    await session.rollback();
    expect(rolledBack).toEqual(['second', 'first']);
  });

  it('publishes prepared leases only when the session commits', async () => {
    const published: string[] = [];
    const rolledBack: string[] = [];
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(recordingProvider(PanelToken, 'panel', published, rolledBack));
    const scope = createScope();
    const session = await broker.open(planGranting('editor.panel.contribute'), scope);

    session.commit();

    expect(published).toEqual(['panel']);
    await scope.dispose('user-request');
    expect(rolledBack).toEqual(['panel']);
  });

  it('rolls back a lease when its prepare step fails', async () => {
    const rolledBack: string[] = [];
    const broker = new DynamicCapabilityBroker('editor');
    broker.register({
      token: PanelToken,
      open: () => ({
        facade: { add: (_id: string) => undefined },
        prepare: () => {
          throw new Error('prepare failed');
        },
        commit: () => undefined,
        rollback: () => {
          rolledBack.push('panel');
        }
      })
    });

    await expect(
      broker.open(planGranting('editor.panel.contribute'), createScope())
    ).rejects.toThrow('prepare failed');
    expect(rolledBack).toEqual(['panel']);
  });
});

function provider<T>(token: DynamicCapabilityToken<T>, facade: T) {
  return {
    token,
    open: () => ({
      facade,
      prepare: () => undefined,
      commit: () => undefined,
      rollback: () => undefined
    })
  } satisfies DynamicCapabilityProvider<T>;
}

function recordingProvider<T>(
  token: DynamicCapabilityToken<T>,
  name: string,
  published: string[],
  rolledBack: string[]
): DynamicCapabilityProvider<T> {
  return {
    token,
    open: () => ({
      facade: Object.freeze({ id: name }) as T,
      prepare: () => undefined,
      commit: () => {
        published.push(name);
      },
      rollback: () => {
        rolledBack.push(name);
      }
    })
  };
}

function planGranting(id: string): DynamicCapabilityPlan {
  return Object.freeze({
    granted: Object.freeze([{ id, version: 1, required: true }]),
    deniedOptional: Object.freeze([])
  });
}

function createScope(): DynamicPluginScope {
  return new DynamicPluginScope({
    pluginId: dynamicPluginId('com.example.capabilities'),
    versionId: pluginVersionId('sha256:capabilities-v1'),
    activationId: pluginActivationId('activation-capabilities-1'),
    hostKind: 'editor',
    quiescence: { wait: async () => true },
    quiescenceTimeoutMs: 50
  });
}
