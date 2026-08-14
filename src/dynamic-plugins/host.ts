import { DynamicCapabilityBroker } from './capabilities';
import { copyInventoryEntry, createDynamicPluginInventory } from './inventory';
import { planCapabilityAuthorization, validateDynamicPluginManifest } from './manifest';
import { DynamicPluginScope } from './scope';
import type {
  DynamicCapabilityPlan,
  DynamicCapabilitySession,
  DynamicPluginDefinition,
  DynamicPluginHostKind,
  DynamicPluginId,
  DynamicPluginInventoryEntry,
  DynamicPluginManifest,
  DynamicPluginPhase,
  DynamicPluginPolicy,
  DynamicPluginQuiescencePort,
  DynamicPluginVersionVerifier,
  PluginActivationId,
  PluginCleanupReport,
  PluginDiagnosticSnapshot,
  PluginRetractionReason,
  PluginVersionId
} from './types';

export interface DynamicPluginHostOptions {
  readonly hostKind: DynamicPluginHostKind;
  readonly broker: DynamicCapabilityBroker;
  readonly verifier: DynamicPluginVersionVerifier;
  readonly policy: DynamicPluginPolicy;
  readonly quiescence: DynamicPluginQuiescencePort;
  readonly quiescenceTimeoutMs: number;
  readonly mintActivationId: () => PluginActivationId;
}

interface ActivationRecord {
  readonly pluginId: DynamicPluginId;
  readonly versionId: PluginVersionId;
  readonly activationId: PluginActivationId;
  readonly hostKind: DynamicPluginHostKind;
  phase: DynamicPluginPhase;
  grantedCapabilities: readonly string[];
  deniedOptionalCapabilities: readonly string[];
  readonly contributionCounts: Readonly<Record<string, number>>;
  pendingWork: number;
  diagnostic?: PluginDiagnosticSnapshot;
  readonly scope: DynamicPluginScope;
  session?: DynamicCapabilitySession;
}

export class DynamicPluginHost {
  private readonly definitions = new Map<string, DynamicPluginDefinition>();
  private readonly definitionEntries = new Map<string, DynamicPluginInventoryEntry>();
  private readonly records: ActivationRecord[] = [];
  private readonly currentRecords = new Map<DynamicPluginId, ActivationRecord>();
  private readonly activating = new Set<DynamicPluginId>();
  private destroyed = false;
  private destruction: Promise<readonly PluginDiagnosticSnapshot[]> | undefined;

  constructor(private readonly options: DynamicPluginHostOptions) {}

  define(definition: DynamicPluginDefinition): void {
    this.assertAvailable();
    const stored = freezeDefinition(definition);
    const key = definitionKey(stored.manifest.pluginId, stored.manifest.versionId);
    if (this.definitions.has(key)) {
      throw new Error(`Dynamic plugin definition ${key} already exists.`);
    }
    this.definitions.set(key, stored);
    this.definitionEntries.set(
      key,
      Object.freeze({
        pluginId: stored.manifest.pluginId,
        versionId: stored.manifest.versionId,
        hostKind: this.options.hostKind,
        phase: 'defined',
        grantedCapabilities: Object.freeze([]),
        deniedOptionalCapabilities: Object.freeze([]),
        contributionCounts: Object.freeze({}),
        pendingWork: 0
      })
    );
  }

  activate(
    pluginId: DynamicPluginId,
    versionId: PluginVersionId
  ): Promise<DynamicPluginInventoryEntry> {
    try {
      this.assertAvailable();
      if (this.activating.has(pluginId)) {
        throw new Error(`Dynamic plugin ${pluginId} already has an activation in progress.`);
      }
      const definition = this.definitions.get(definitionKey(pluginId, versionId));
      if (!definition) {
        throw new Error(`Dynamic plugin definition ${pluginId}@${versionId} was not found.`);
      }
      this.activating.add(pluginId);
      this.definitionEntries.delete(definitionKey(pluginId, versionId));
      return this.performActivation(definition);
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  current(pluginId: DynamicPluginId): DynamicPluginInventoryEntry | undefined {
    const record = this.currentRecords.get(pluginId);
    return record ? copyInventoryEntry(record) : undefined;
  }

  inventory(): readonly DynamicPluginInventoryEntry[] {
    for (const record of this.records) {
      record.pendingWork = record.scope.pendingWork;
    }
    return createDynamicPluginInventory([...this.definitionEntries.values(), ...this.records]);
  }

  async retract(
    pluginId: DynamicPluginId,
    reason: PluginRetractionReason
  ): Promise<PluginCleanupReport | undefined> {
    const record = this.currentRecords.get(pluginId);
    if (!record) return undefined;
    this.currentRecords.delete(pluginId);
    return this.retractRecord(record, reason);
  }

  destroy(): Promise<readonly PluginDiagnosticSnapshot[]> {
    this.destroyed = true;
    this.destruction ??= this.performDestroy();
    return this.destruction;
  }

  private async performActivation(
    definition: DynamicPluginDefinition
  ): Promise<DynamicPluginInventoryEntry> {
    const { manifest } = definition;
    const activationId = this.options.mintActivationId();
    const scope = new DynamicPluginScope({
      pluginId: manifest.pluginId,
      versionId: manifest.versionId,
      activationId,
      hostKind: this.options.hostKind,
      quiescence: this.options.quiescence,
      quiescenceTimeoutMs: this.options.quiescenceTimeoutMs
    });
    const record: ActivationRecord = {
      pluginId: manifest.pluginId,
      versionId: manifest.versionId,
      activationId,
      hostKind: this.options.hostKind,
      phase: 'validating',
      grantedCapabilities: Object.freeze([]),
      deniedOptionalCapabilities: Object.freeze([]),
      contributionCounts: Object.freeze({}),
      pendingWork: 0,
      scope
    };
    this.records.push(record);

    try {
      validateDynamicPluginManifest(manifest, this.options.verifier);
      const plan = this.authorizationPlan(manifest);
      record.grantedCapabilities = Object.freeze(plan.granted.map(({ id }) => id));
      record.deniedOptionalCapabilities = Object.freeze(plan.deniedOptional.map(({ id }) => id));
      record.phase = 'activating';
      const session = await this.options.broker.open(plan, scope);
      record.session = session;
      await definition.activate({
        pluginId: manifest.pluginId,
        versionId: manifest.versionId,
        activationId,
        hostKind: this.options.hostKind,
        signal: scope.signal,
        capabilities: session.resolver,
        own: (cleanup) => scope.own(cleanup),
        track: (work) => scope.track(work)
      });

      session.commit();
      const previous = this.currentRecords.get(manifest.pluginId);
      this.currentRecords.set(manifest.pluginId, record);
      record.phase = 'active';
      if (previous) {
        await this.retractRecord(previous, 'version-update');
      }
      return copyInventoryEntry(record);
    } catch (cause) {
      await this.rollbackFailedActivation(record);
      record.phase = 'failed';
      record.diagnostic = diagnosticSnapshot('DYNAMIC_PLUGIN_ACTIVATION_FAILED', cause, record);
      throw cause;
    } finally {
      this.activating.delete(manifest.pluginId);
    }
  }

  private authorizationPlan(manifest: DynamicPluginManifest): DynamicCapabilityPlan {
    return planCapabilityAuthorization(
      manifest,
      this.options.hostKind,
      this.options.broker.descriptors(),
      this.options.policy
    );
  }

  private async rollbackFailedActivation(record: ActivationRecord): Promise<void> {
    try {
      if (record.session) {
        await record.session.rollback();
      }
      await record.scope.dispose('activation-rollback');
    } catch {
      // The activation error remains primary; cleanup detail is reported by the Scope.
    }
  }

  private async retractRecord(
    record: ActivationRecord,
    reason: PluginRetractionReason
  ): Promise<PluginCleanupReport> {
    record.phase = 'retracting';
    try {
      await record.session?.retract();
    } catch (cause) {
      record.diagnostic = diagnosticSnapshot('DYNAMIC_PLUGIN_RETRACTION_FAILED', cause, record);
    }
    const report = await record.scope.dispose(reason);
    record.phase = report.terminalPhase;
    record.pendingWork = 0;
    const lastFailure = report.failures.at(-1);
    if (!record.diagnostic && lastFailure) record.diagnostic = lastFailure;
    return report;
  }

  private async performDestroy(): Promise<readonly PluginDiagnosticSnapshot[]> {
    const diagnostics: PluginDiagnosticSnapshot[] = [];
    const active = [...this.currentRecords.values()].reverse();
    this.currentRecords.clear();
    for (const record of active) {
      const report = await this.retractRecord(record, 'host-shutdown');
      diagnostics.push(...report.failures);
      if (record.diagnostic) diagnostics.push(record.diagnostic);
    }
    return Object.freeze(diagnostics);
  }

  private assertAvailable(): void {
    if (this.destroyed) {
      throw new Error('Dynamic plugin host is destroyed.');
    }
  }
}

function definitionKey(pluginId: DynamicPluginId, versionId: PluginVersionId): string {
  return `${pluginId}@${versionId}`;
}

function freezeDefinition(definition: DynamicPluginDefinition): DynamicPluginDefinition {
  const manifest = Object.freeze({
    ...definition.manifest,
    hosts: Object.freeze(definition.manifest.hosts.map((host) => Object.freeze({ ...host }))),
    capabilities: Object.freeze(
      definition.manifest.capabilities.map((capability) => Object.freeze({ ...capability }))
    )
  });
  return Object.freeze({ manifest, activate: definition.activate });
}

function diagnosticSnapshot(
  code: string,
  cause: unknown,
  record: ActivationRecord
): PluginDiagnosticSnapshot {
  return Object.freeze({
    code,
    phase: record.phase,
    message: cause instanceof Error ? cause.message : String(cause),
    fields: Object.freeze({
      pluginId: record.pluginId,
      versionId: record.versionId,
      activationId: record.activationId ?? '',
      hostKind: record.hostKind
    })
  });
}
