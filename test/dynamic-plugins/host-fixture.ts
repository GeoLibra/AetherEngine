import {
  DynamicCapabilityBroker,
  DynamicPluginHost,
  createDynamicCapabilityToken,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  type DynamicCapabilityProvider,
  type DynamicPluginDefinition,
  type DynamicPluginHostRequest,
  type DynamicPluginManifest,
  type PluginActivationId
} from '../../src/dynamic-plugins';

export const PanelToken = createDynamicCapabilityToken<{ add(id: string): void }>({
  id: 'editor.panel.contribute',
  version: 1,
  hostKinds: ['editor'],
  inheritable: false
});

export const pluginId = dynamicPluginId('com.example.host');

export function version(name: string) {
  return pluginVersionId(`sha256:${name}`);
}

export function definition(
  name: string,
  activate: DynamicPluginDefinition['activate']
): DynamicPluginDefinition {
  const manifest: DynamicPluginManifest = Object.freeze({
    schemaVersion: 1,
    pluginId,
    versionId: version(name),
    hosts: Object.freeze([{ kind: 'editor', required: true }] satisfies DynamicPluginHostRequest[]),
    capabilities: Object.freeze([
      { id: PanelToken.id, version: PanelToken.version, required: true }
    ])
  });
  return Object.freeze({ manifest, activate });
}

export function createHost(provider: DynamicCapabilityProvider<unknown>): DynamicPluginHost {
  const broker = new DynamicCapabilityBroker('editor');
  broker.register(provider);
  let activation = 0;
  return new DynamicPluginHost({
    hostKind: 'editor',
    broker,
    verifier: { verify: () => true },
    policy: { authorize: () => 'granted' },
    quiescence: { wait: async () => true },
    quiescenceTimeoutMs: 50,
    mintActivationId: () => pluginActivationId(`activation-${++activation}`)
  });
}

export function panelRegistry() {
  const current = new Map<string, { activationId: PluginActivationId; panels: string[] }>();
  const observations: string[][] = [];
  const provider: DynamicCapabilityProvider<{ add(id: string): void }> = {
    token: PanelToken,
    open: (context) => {
      const staged: string[] = [];
      return {
        facade: { add: (id) => staged.push(id) },
        prepare: () => undefined,
        commit: () => {
          current.set(context.pluginId, {
            activationId: context.activationId,
            panels: [...staged]
          });
          observations.push([...staged]);
        },
        rollback: () => {
          if (current.get(context.pluginId)?.activationId === context.activationId) {
            current.delete(context.pluginId);
            observations.push([]);
          }
        }
      };
    }
  };
  return {
    provider,
    visible: () => [...current.values()].flatMap(({ panels }) => panels),
    observations: () => observations.map((entry) => [...entry])
  };
}
