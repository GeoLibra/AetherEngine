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

  it('handles quiescence rejection, marks failed-to-quiesce, and still runs cleanups', async () => {
    const order: string[] = [];
    const scope = createScope({
      wait: async () => {
        throw new Error('quiescence network error');
      }
    });
    scope.own(() => {
      order.push('cleanup-1');
    });

    const report = await scope.dispose('version-update');

    expect(report.terminalPhase).toBe('failed-to-quiesce');
    expect(order).toEqual(['cleanup-1']);
    expect(report.failures.map((f) => f.code)).toContain('DYNAMIC_PLUGIN_QUIESCENCE_FAILED');
    expect(report.failures[0]?.message).toBe('quiescence network error');
  });

  it('reports failed-to-quiesce and DYNAMIC_PLUGIN_CLEANUP_TIMEOUT when a cleanup hangs', async () => {
    const scope = createScope(immediateQuiescence());
    scope.own(() => new Promise(() => undefined)); // hanging cleanup

    const report = await scope.dispose('user-request');

    expect(report.terminalPhase).toBe('failed-to-quiesce');
    expect(report.removedRegistrations).toBe(0);
    expect(report.failures.map((f) => f.code)).toContain('DYNAMIC_PLUGIN_CLEANUP_TIMEOUT');
  });

  it('still executes cleanups even when quiescence.wait times out', async () => {
    let cleanupRan = false;
    const scope = createScope({
      wait: () => new Promise(() => undefined) // never resolves
    });
    scope.own(() => {
      cleanupRan = true;
    });

    const report = await scope.dispose('host-shutdown');

    expect(cleanupRan).toBe(true);
    expect(report.terminalPhase).toBe('failed-to-quiesce');
    expect(report.removedRegistrations).toBe(1);
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
