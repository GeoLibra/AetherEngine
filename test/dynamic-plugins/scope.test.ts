import { describe, expect, it } from 'vitest';
import {
  DynamicPluginScope,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  type DynamicPluginQuiescencePort
} from '../../src/dynamic-plugins';

describe('DynamicPluginScope', () => {
  it('shares one disposal and cleans registrations in reverse order', async () => {
    const order: string[] = [];
    const scope = createScope(immediateQuiescence());
    scope.own(() => {
      order.push('first');
    });
    scope.own(() => {
      order.push('second');
    });

    const left = scope.dispose('user-request');
    const right = scope.dispose('host-shutdown');

    expect(left).toBe(right);
    const report = await left;
    expect(order).toEqual(['second', 'first']);
    expect(report.removedRegistrations).toBe(2);
    expect(scope.signal.aborted).toBe(true);
  });

  it('aggregates cleanup failures and reports failed-to-quiesce', async () => {
    const scope = createScope(neverQuiesces());
    scope.track(new Promise(() => undefined));
    scope.own(() => {
      throw new Error('cleanup failed');
    });

    const report = await scope.dispose('version-update');

    expect(report.terminalPhase).toBe('failed-to-quiesce');
    expect(report.cancelledWork).toBe(1);
    expect(report.failures.map((failure) => failure.code)).toContain(
      'DYNAMIC_PLUGIN_CLEANUP_FAILED'
    );
    expect(report.failures[0]?.message).toBe('cleanup failed');
  });

  it('rejects new ownership after retraction begins', async () => {
    const scope = createScope(immediateQuiescence());
    const disposal = scope.dispose('policy-revoked');

    expect(() => scope.own(() => undefined)).toThrow(/activation-retracted/i);
    expect(() => scope.track(Promise.resolve())).toThrow(/activation-retracted/i);
    await disposal;
  });
});

function createScope(quiescence: DynamicPluginQuiescencePort): DynamicPluginScope {
  return new DynamicPluginScope({
    pluginId: dynamicPluginId('com.example.scope'),
    versionId: pluginVersionId('sha256:scope-v1'),
    activationId: pluginActivationId('activation-1'),
    hostKind: 'editor',
    quiescence,
    quiescenceTimeoutMs: 50
  });
}

function immediateQuiescence(): DynamicPluginQuiescencePort {
  return { wait: async () => true };
}

function neverQuiesces(): DynamicPluginQuiescencePort {
  return { wait: async () => false };
}
