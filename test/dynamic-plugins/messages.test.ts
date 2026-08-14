import { describe, expect, it } from 'vitest';
import {
  DynamicPluginMessageGuard,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  validateDynamicPluginMessageEnvelope,
  type DynamicPluginInventoryEntry,
  type DynamicPluginMessageEnvelope
} from '../../src/dynamic-plugins';

const pluginId = dynamicPluginId('com.example.messages');
const versionId = pluginVersionId('sha256:messages-v2');
const currentActivation = pluginActivationId('activation-current');

describe('dynamic plugin message admission', () => {
  it('rejects messages from a previous activation without invoking handlers', () => {
    const handled: string[] = [];
    const guard = new DynamicPluginMessageGuard(
      () => currentEntry(),
      (message) => handled.push(message.requestId),
      { maxPayloadBytes: 1_024, maxTrackedRequests: 10 }
    );

    const result = guard.accept(envelope({ activationId: pluginActivationId('activation-old') }));

    expect(result).toEqual({ accepted: false, reason: 'stale-activation' });
    expect(handled).toEqual([]);
    expect(guard.metrics().staleResults).toBe(1);
  });

  it('rejects invalid schema, oversized payload metadata, forged payloadBytes, and non-serializable payloads', () => {
    expect(() =>
      validateDynamicPluginMessageEnvelope(
        { ...envelope(), schemaVersion: 2 },
        { maxPayloadBytes: 1_024 }
      )
    ).toThrow(/message schema/i);

    expect(() =>
      validateDynamicPluginMessageEnvelope(
        { ...envelope(), payloadBytes: 1_025 },
        { maxPayloadBytes: 1_024 }
      )
    ).toThrow(/payload/i);

    // Forged payloadBytes: 0 with 10KB real payload must fail when maxPayloadBytes is small
    expect(() =>
      validateDynamicPluginMessageEnvelope(
        { ...envelope(), payloadBytes: 0, payload: { value: 'x'.repeat(100) } },
        { maxPayloadBytes: 10 }
      )
    ).toThrow(/budget/i);

    // Non-serializable payload (function) must fail
    expect(() =>
      validateDynamicPluginMessageEnvelope(
        { ...envelope(), payload: { fn: () => undefined } },
        { maxPayloadBytes: 1_024 }
      )
    ).toThrow(/non-serializable/i);
  });

  it('accepts one current terminal result and rejects its duplicate', () => {
    const handled: string[] = [];
    const guard = new DynamicPluginMessageGuard(
      () => currentEntry(),
      (message) => handled.push(message.requestId),
      { maxPayloadBytes: 1_024, maxTrackedRequests: 10 }
    );
    const message = envelope();

    expect(guard.accept(message)).toEqual({ accepted: true });
    expect(guard.accept(message)).toEqual({ accepted: false, reason: 'duplicate-terminal' });
    expect(handled).toEqual(['request-1']);
    expect(guard.metrics()).toMatchObject({ accepted: 1, duplicateTerminal: 1 });
  });
});

function envelope(
  overrides: Partial<DynamicPluginMessageEnvelope<Readonly<{ value: string }>>> = {}
): DynamicPluginMessageEnvelope<Readonly<{ value: string }>> {
  return Object.freeze({
    schemaVersion: 1,
    pluginId,
    versionId,
    activationId: currentActivation,
    requestId: 'request-1',
    payloadBytes: 16,
    payload: Object.freeze({ value: 'done' }),
    ...overrides
  });
}

function currentEntry(): DynamicPluginInventoryEntry {
  return Object.freeze({
    pluginId,
    versionId,
    activationId: currentActivation,
    hostKind: 'editor',
    phase: 'active',
    grantedCapabilities: Object.freeze([]),
    deniedOptionalCapabilities: Object.freeze([]),
    contributionCounts: Object.freeze({}),
    pendingWork: 0
  });
}
