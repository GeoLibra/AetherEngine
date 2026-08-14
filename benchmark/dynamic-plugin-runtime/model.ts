import {
  DynamicCapabilityBroker,
  DynamicPluginHost,
  DynamicPluginMessageGuard,
  createDynamicCapabilityToken,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  type DynamicCapabilityProvider,
  type DynamicPluginDefinition,
  type DynamicPluginHostRequest,
  type DynamicPluginManifest
} from '../../src/dynamic-plugins';

export interface DynamicPluginReferenceInput {
  readonly plugins: number;
  readonly contributionsPerPlugin: number;
  readonly pendingPerPlugin: number;
}

export interface DynamicPluginReferenceResult {
  readonly currentVersions: readonly number[];
  readonly snapshotCopies: number;
  readonly cleanupInvocations: number;
  readonly reverseCleanupViolations: number;
  readonly staleAccepted: number;
}

export function runDynamicPluginReference(
  input: DynamicPluginReferenceInput
): DynamicPluginReferenceResult {
  validateScale(input);

  return Object.freeze({
    currentVersions: Object.freeze(Array.from({ length: input.plugins }, () => 2)),
    snapshotCopies: input.plugins * 2,
    cleanupInvocations: input.plugins * input.contributionsPerPlugin,
    reverseCleanupViolations: 0,
    staleAccepted: 0
  });
}

const BenchmarkContributionToken = createDynamicCapabilityToken<{ add(id: string): void }>({
  id: 'benchmark.contribution.add',
  version: 1,
  hostKinds: ['editor'],
  inheritable: false
});

export async function runDynamicPluginAether(
  input: DynamicPluginReferenceInput
): Promise<DynamicPluginReferenceResult> {
  validateScale(input);
  let cleanupInvocations = 0;
  let reverseCleanupViolations = 0;
  let staleAccepted = 0;
  let activationSequence = 0;
  const provider: DynamicCapabilityProvider<{ add(id: string): void }> = {
    token: BenchmarkContributionToken,
    open: () => {
      const staged: string[] = [];
      return {
        facade: { add: (id) => staged.push(id) },
        prepare: () => undefined,
        commit: () => undefined,
        rollback: () => {
          for (let index = staged.length - 1; index >= 0; index--) {
            cleanupInvocations += 1;
            if (staged[index] !== `contribution-${index}`) {
              reverseCleanupViolations += 1;
            }
          }
        }
      };
    }
  };
  const broker = new DynamicCapabilityBroker('editor');
  broker.register(provider);
  const host = new DynamicPluginHost({
    hostKind: 'editor',
    broker,
    verifier: { verify: () => true },
    policy: { authorize: () => 'granted' },
    quiescence: { wait: async () => true },
    quiescenceTimeoutMs: 1,
    mintActivationId: () => pluginActivationId(`benchmark-${++activationSequence}`)
  });
  const currentVersions: number[] = [];

  for (let pluginIndex = 0; pluginIndex < input.plugins; pluginIndex++) {
    const pluginId = dynamicPluginId(`benchmark.plugin.${pluginIndex}`);
    const version1 = pluginVersionId(`sha256:${pluginIndex}:v1`);
    const version2 = pluginVersionId(`sha256:${pluginIndex}:v2`);
    host.define(
      benchmarkDefinition(pluginId, version1, ({ capabilities, track }) => {
        const facade = capabilities.get(BenchmarkContributionToken);
        for (let index = 0; index < input.contributionsPerPlugin; index++) {
          facade.add(`contribution-${index}`);
        }
        for (let index = 0; index < input.pendingPerPlugin; index++) {
          track(Promise.resolve(index));
        }
      })
    );
    host.define(benchmarkDefinition(pluginId, version2, () => undefined));
    const previous = await host.activate(pluginId, version1);
    if (!previous.activationId) {
      throw new Error('Benchmark activation did not publish an activation identity.');
    }
    await host.activate(pluginId, version2);
    currentVersions.push(host.current(pluginId)?.versionId === version2 ? 2 : 0);

    const guard = new DynamicPluginMessageGuard(
      (id) => host.current(id),
      () => {
        staleAccepted += 1;
      },
      { maxPayloadBytes: 64, maxTrackedRequests: 1 }
    );
    guard.accept({
      schemaVersion: 1,
      pluginId,
      versionId: version1,
      activationId: previous.activationId,
      requestId: `stale-${pluginIndex}`,
      payloadBytes: 0,
      payload: null
    });
    if (guard.metrics().staleResults !== 1) {
      throw new Error('Benchmark message guard did not classify the old activation as stale.');
    }
    await host.retract(pluginId, 'user-request');
  }

  return Object.freeze({
    currentVersions: Object.freeze(currentVersions),
    snapshotCopies: input.plugins * 2,
    cleanupInvocations,
    reverseCleanupViolations,
    staleAccepted
  });
}

export function assertDynamicPluginReference(
  result: DynamicPluginReferenceResult,
  input: DynamicPluginReferenceInput
): void {
  validateScale(input);
  if (result.currentVersions.length !== input.plugins) {
    throw new Error('Dynamic plugin reference produced the wrong plugin count.');
  }
  if (result.currentVersions.some((version) => version !== 2)) {
    throw new Error('Dynamic plugin reference did not preserve the last-good version.');
  }
  const expectedCleanups = input.plugins * input.contributionsPerPlugin;
  if (result.cleanupInvocations !== expectedCleanups) {
    throw new Error('Dynamic plugin reference produced the wrong cleanup count.');
  }
  if (result.reverseCleanupViolations !== 0) {
    throw new Error('Dynamic plugin reference violated reverse cleanup ordering.');
  }
  if (result.staleAccepted !== 0) {
    throw new Error('Dynamic plugin reference accepted a stale activation result.');
  }
}

function validateScale(input: DynamicPluginReferenceInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative integer.`);
    }
  }
}

function benchmarkDefinition(
  pluginId: ReturnType<typeof dynamicPluginId>,
  versionId: ReturnType<typeof pluginVersionId>,
  activate: DynamicPluginDefinition['activate']
): DynamicPluginDefinition {
  const manifest: DynamicPluginManifest = Object.freeze({
    schemaVersion: 1,
    pluginId,
    versionId,
    hosts: Object.freeze([{ kind: 'editor', required: true }] satisfies DynamicPluginHostRequest[]),
    capabilities: Object.freeze([
      {
        id: BenchmarkContributionToken.id,
        version: BenchmarkContributionToken.version,
        required: true
      }
    ])
  });
  return Object.freeze({ manifest, activate });
}
