import { dynamicPluginId, pluginActivationId, pluginVersionId } from './ids';
import type {
  DynamicPluginId,
  DynamicPluginInventoryEntry,
  DynamicPluginMessageAdmission,
  DynamicPluginMessageEnvelope,
  DynamicPluginMessageGuardOptions,
  DynamicPluginMessageMetrics,
  DynamicPluginMessageValidationOptions
} from './types';

export function validateDynamicPluginMessageEnvelope<T = unknown>(
  value: unknown,
  options: DynamicPluginMessageValidationOptions<T>
): DynamicPluginMessageEnvelope<T> {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Dynamic plugin message schema version is unsupported.');
  }
  if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0) {
    throw new Error('Dynamic plugin message schema requires a non-empty request ID.');
  }
  if (
    typeof value.pluginId !== 'string' ||
    typeof value.versionId !== 'string' ||
    typeof value.activationId !== 'string' ||
    !('payload' in value)
  ) {
    throw new Error('Dynamic plugin message schema has invalid identity or payload fields.');
  }

  const { bytes, payload: rawPayload } = validateAndComputePayload<unknown>(
    value.payload,
    options.maxPayloadBytes
  );

  let finalPayload: T;
  if (options.validatePayload) {
    try {
      finalPayload = options.validatePayload(rawPayload);
    } catch (cause) {
      throw new Error(
        `Dynamic plugin message payload schema validation failed: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  } else {
    finalPayload = rawPayload as T;
  }

  if (
    typeof value.payloadBytes === 'number' &&
    (!Number.isFinite(value.payloadBytes) ||
      !Number.isInteger(value.payloadBytes) ||
      value.payloadBytes < 0 ||
      value.payloadBytes > options.maxPayloadBytes)
  ) {
    throw new Error('Dynamic plugin message payload metadata exceeds its size budget.');
  }

  return Object.freeze({
    schemaVersion: 1,
    pluginId: dynamicPluginId(value.pluginId),
    versionId: pluginVersionId(value.versionId),
    activationId: pluginActivationId(value.activationId),
    requestId: value.requestId.trim(),
    payloadBytes: bytes,
    payload: finalPayload
  });
}

export class DynamicPluginMessageGuard<T> {
  private acceptedCount = 0;
  private staleResults = 0;
  private invalid = 0;
  private duplicateTerminal = 0;
  private readonly terminalRequests = new Set<string>();

  constructor(
    private readonly current: (
      pluginId: DynamicPluginId
    ) => DynamicPluginInventoryEntry | undefined,
    private readonly handle: (envelope: DynamicPluginMessageEnvelope<T>) => void,
    private readonly options: DynamicPluginMessageGuardOptions<T>
  ) {
    if (!Number.isInteger(options.maxTrackedRequests) || options.maxTrackedRequests <= 0) {
      throw new Error('Dynamic plugin message guard requires a positive request bound.');
    }
  }

  accept(value: unknown): DynamicPluginMessageAdmission {
    let envelope: DynamicPluginMessageEnvelope<T>;
    try {
      envelope = validateDynamicPluginMessageEnvelope<T>(value, this.options);
    } catch {
      this.invalid += 1;
      return Object.freeze({ accepted: false, reason: 'invalid-message' });
    }

    const current = this.current(envelope.pluginId);
    if (
      current?.phase !== 'active' ||
      current.pluginId !== envelope.pluginId ||
      current.versionId !== envelope.versionId ||
      current.activationId !== envelope.activationId
    ) {
      this.staleResults += 1;
      return Object.freeze({ accepted: false, reason: 'stale-activation' });
    }

    const terminalKey = `${envelope.activationId}\u0000${envelope.requestId}`;
    if (this.terminalRequests.has(terminalKey)) {
      this.duplicateTerminal += 1;
      return Object.freeze({ accepted: false, reason: 'duplicate-terminal' });
    }
    this.rememberTerminal(terminalKey);
    this.handle(envelope);
    this.acceptedCount += 1;
    return Object.freeze({ accepted: true });
  }

  metrics(): DynamicPluginMessageMetrics {
    return Object.freeze({
      accepted: this.acceptedCount,
      staleResults: this.staleResults,
      invalid: this.invalid,
      duplicateTerminal: this.duplicateTerminal
    });
  }

  private rememberTerminal(key: string): void {
    if (this.terminalRequests.size === this.options.maxTrackedRequests) {
      const oldest = this.terminalRequests.values().next().value as string | undefined;
      if (oldest) this.terminalRequests.delete(oldest);
    }
    this.terminalRequests.add(key);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateAndComputePayload<T>(
  payload: unknown,
  maxBytes: number
): { bytes: number; payload: T } {
  assertSerializable(payload);
  let serialized: string;
  try {
    const json = JSON.stringify(payload);
    if (json === undefined && payload !== undefined) {
      throw new Error('Dynamic plugin message payload is not serializable.');
    }
    serialized = json ?? 'null';
  } catch {
    throw new Error('Dynamic plugin message payload is not serializable.');
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maxBytes) {
    throw new Error(
      `Dynamic plugin message payload size ${bytes} exceeds budget of ${maxBytes} bytes.`
    );
  }

  const parsed = JSON.parse(serialized) as T;
  deepFreeze(parsed);
  return { bytes, payload: parsed };
}

function assertSerializable(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || value === undefined) {
    return;
  }
  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'bigint') {
    throw new Error('Dynamic plugin message payload contains non-serializable type.');
  }
  if (type === 'object') {
    if (seen.has(value)) {
      throw new Error('Dynamic plugin message payload contains circular reference.');
    }
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        assertSerializable(item, seen);
      }
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        throw new Error('Dynamic plugin message payload contains non-serializable class instance.');
      }
      for (const key of Object.keys(value)) {
        const val = (value as Record<string, unknown>)[key];
        if (
          typeof val === 'function' ||
          typeof val === 'symbol' ||
          typeof val === 'bigint' ||
          typeof val === 'undefined'
        ) {
          throw new Error('Dynamic plugin message payload contains non-serializable type.');
        }
        assertSerializable(val, seen);
      }
    }
  }
}

function deepFreeze<U>(value: U): U {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
