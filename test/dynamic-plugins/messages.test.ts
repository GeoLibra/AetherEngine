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

  it('validates specific payload schema when validator is provided', () => {
    interface CustomPayload {
      readonly count: number;
    }
    const validator = (payload: unknown): CustomPayload => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { count?: unknown }).count !== 'number'
      ) {
        throw new Error('Payload must contain numeric count.');
      }
      return payload as CustomPayload;
    };

    const validEnvelope = validateDynamicPluginMessageEnvelope<CustomPayload>(
      { ...envelope(), payload: { count: 42 } },
      { maxPayloadBytes: 1_024, validatePayload: validator }
    );
    expect(validEnvelope.payload.count).toBe(42);

    expect(() =>
      validateDynamicPluginMessageEnvelope<CustomPayload>(
        { ...envelope(), payload: { count: 'not-a-number' } },
        { maxPayloadBytes: 1_024, validatePayload: validator }
      )
    ).toThrow(/payload schema validation failed/i);

    // Validator returning non-serializable object (function) must be caught by boundary re-check
    expect(() =>
      validateDynamicPluginMessageEnvelope<CustomPayload>(
        { ...envelope(), payload: { count: 1 } },
        {
          maxPayloadBytes: 1_024,
          validatePayload: () => ({ count: 1, fn: () => undefined }) as unknown as CustomPayload
        }
      )
    ).toThrow(/non-serializable/i);
  });

  it('keeps caller-owned payload graphs extensible while publishing a detached frozen clone', () => {
    const nested = { items: ['original'] };
    const payload = Object.assign(Object.create(null), { nested });
    const input = {
      schemaVersion: 1,
      pluginId: String(pluginId),
      versionId: String(versionId),
      activationId: String(currentActivation),
      requestId: 'ownership-check',
      payload
    };

    const normalized = validateDynamicPluginMessageEnvelope<typeof payload>(input, {
      maxPayloadBytes: 1_024
    });

    expect(Object.isExtensible(input)).toBe(true);
    expect(Object.isExtensible(payload)).toBe(true);
    expect(Object.getPrototypeOf(normalized.payload)).toBeNull();
    payload.nested.items.push('caller-still-owns-this');
    expect(normalized.payload.nested.items).toEqual(['original']);
    expect(Object.isFrozen(normalized.payload)).toBe(true);
    expect(Object.isFrozen(normalized.payload.nested)).toBe(true);
    expect(Object.isFrozen(normalized.payload.nested.items)).toBe(true);
  });

  it('preserves JSON transport normalization while cloning payloads', () => {
    const normalized = validateDynamicPluginMessageEnvelope(
      {
        ...envelope(),
        payload: [undefined, Number.NaN, -0]
      },
      { maxPayloadBytes: 1_024 }
    );

    expect(normalized.payload).toEqual([null, null, 0]);
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
