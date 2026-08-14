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
  options: DynamicPluginMessageValidationOptions
): DynamicPluginMessageEnvelope<T> {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Dynamic plugin message schema version is unsupported.');
  }
  if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0) {
    throw new Error('Dynamic plugin message schema requires a non-empty request ID.');
  }
  if (
    typeof value.payloadBytes !== 'number' ||
    !Number.isFinite(value.payloadBytes) ||
    !Number.isInteger(value.payloadBytes) ||
    value.payloadBytes < 0 ||
    value.payloadBytes > options.maxPayloadBytes
  ) {
    throw new Error('Dynamic plugin message payload metadata exceeds its size budget.');
  }
  if (
    typeof value.pluginId !== 'string' ||
    typeof value.versionId !== 'string' ||
    typeof value.activationId !== 'string' ||
    !('payload' in value)
  ) {
    throw new Error('Dynamic plugin message schema has invalid identity or payload fields.');
  }

  return Object.freeze({
    schemaVersion: 1,
    pluginId: dynamicPluginId(value.pluginId),
    versionId: pluginVersionId(value.versionId),
    activationId: pluginActivationId(value.activationId),
    requestId: value.requestId.trim(),
    payloadBytes: value.payloadBytes,
    payload: value.payload as T
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
    private readonly options: DynamicPluginMessageGuardOptions
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
