import { DynamicCapabilityBroker } from './capabilities';
import { copyInventoryEntry, createDynamicPluginInventory } from './inventory';
import { planCapabilityAuthorization, validateDynamicPluginManifest } from './manifest';
import { DynamicPluginScope } from './scope';
import type {
  DynamicCapabilityPlan,
  DynamicCapabilitySession,
  DynamicPluginDefinition,
  DynamicPluginHostKind,
  DynamicPluginHostMetrics,
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
  private readonly inFlightActivations = new Set<Promise<DynamicPluginInventoryEntry>>();
  private readonly inFlightScopes = new Set<DynamicPluginScope>();
  private readonly inFlightRecords = new Set<ActivationRecord>();
  private snapshotCopyCount = 0;
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
      const activationPromise = this.performActivation(definition);
      this.inFlightActivations.add(activationPromise);
      void activationPromise
        .catch(() => undefined)
        .finally(() => {
          this.inFlightActivations.delete(activationPromise);
        });
      return activationPromise;
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  current(pluginId: DynamicPluginId): DynamicPluginInventoryEntry | undefined {
    const record = this.currentRecords.get(pluginId);
    if (!record) return undefined;
    record.pendingWork = record.scope.pendingWork;
    this.snapshotCopyCount += 1;
    return copyInventoryEntry(record);
  }

  inventory(): readonly DynamicPluginInventoryEntry[] {
    const entries: DynamicPluginInventoryEntry[] = [];
    const emitted = new Set<string>();

    for (const record of this.records) {
      record.pendingWork = record.scope.pendingWork;
      entries.push(copyInventoryEntry(record));
      emitted.add(definitionKey(record.pluginId, record.versionId));
    }
    for (const [key, entry] of this.definitionEntries) {
      if (!emitted.has(key)) {
        entries.push(entry);
      }
    }

    this.snapshotCopyCount += entries.length;
    return createDynamicPluginInventory(entries);
  }

  metrics(): DynamicPluginHostMetrics {
    return Object.freeze({
      snapshotCopies: this.snapshotCopyCount
    });
  }

  retract(
    pluginId: DynamicPluginId,
    reason: PluginRetractionReason
  ): Promise<PluginCleanupReport | undefined> {
    try {
      this.assertAvailable();
      const current = this.currentRecords.get(pluginId);
      if (!current) return Promise.resolve(undefined);
      this.currentRecords.delete(pluginId);
      return this.retractRecord(current, reason);
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  destroy(): Promise<readonly PluginDiagnosticSnapshot[]> {
    if (this.destroyed) {
      return this.destruction ?? Promise.resolve(Object.freeze([]));
    }
    this.destroyed = true;
    for (const scope of this.inFlightScopes) {
      scope.abort('host-shutdown');
    }
    const destruction = this.performDestroy();
    this.destruction = destruction;
    return destruction;
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
    this.inFlightScopes.add(scope);
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
    this.inFlightRecords.add(record);

    try {
      validateDynamicPluginManifest(manifest, this.options.verifier);
      const plan = this.authorizationPlan(manifest);
      record.grantedCapabilities = Object.freeze(plan.granted.map(({ id }) => id));
      record.deniedOptionalCapabilities = Object.freeze(plan.deniedOptional.map(({ id }) => id));
      record.phase = 'activating';
      const session = await this.options.broker.open(plan, scope);
      record.session = session;

      if (this.destroyed || (record.phase as DynamicPluginPhase) === 'failed') {
        throw new Error('Dynamic plugin host is destroyed.');
      }

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

      if (this.destroyed || (record.phase as DynamicPluginPhase) === 'failed') {
        throw new Error('Dynamic plugin host is destroyed.');
      }

      session.commit();
      const previous = this.currentRecords.get(manifest.pluginId);
      this.currentRecords.set(manifest.pluginId, record);
      record.phase = 'active';

      if (previous) {
        try {
          await this.retractRecord(previous, 'version-update');
        } catch (cause) {
          if (!previous.diagnostic) {
            previous.diagnostic = diagnosticSnapshot(
              'DYNAMIC_PLUGIN_RETRACTION_FAILED',
              cause,
              previous
            );
          }
        }
      }
      this.snapshotCopyCount += 1;
      return copyInventoryEntry(record);
    } catch (cause) {
      if ((record.phase as DynamicPluginPhase) !== 'failed') {
        await this.rollbackFailedActivation(record);
        record.phase = 'failed';
        record.diagnostic = diagnosticSnapshot('DYNAMIC_PLUGIN_ACTIVATION_FAILED', cause, record);
      }
      throw cause;
    } finally {
      this.inFlightRecords.delete(record);
      this.inFlightScopes.delete(scope);
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
    const timeoutMs = this.options.quiescenceTimeoutMs;
    const sessionRollback = record.session
      ? withTimeout(Promise.resolve(record.session.rollback()), timeoutMs, 'timeout').catch(
          () => 'error' as const
        )
      : Promise.resolve('none' as const);
    const scopeDispose = record.scope.dispose('activation-rollback').catch(() => undefined);
    await Promise.allSettled([sessionRollback, scopeDispose]);
  }

  private async retractRecord(
    record: ActivationRecord,
    reason: PluginRetractionReason
  ): Promise<PluginCleanupReport> {
    record.phase = 'retracting';
    const timeoutMs = this.options.quiescenceTimeoutMs;

    const sessionRetract = record.session
      ? withTimeout(Promise.resolve(record.session.retract()), timeoutMs, 'timeout')
      : Promise.resolve('none' as const);
    const scopeDispose = record.scope.dispose(reason);

    const [sessionOutcome, reportOutcome] = await Promise.allSettled([
      sessionRetract,
      scopeDispose
    ]);

    if (sessionOutcome.status === 'rejected') {
      record.diagnostic = diagnosticSnapshot(
        'DYNAMIC_PLUGIN_RETRACTION_FAILED',
        sessionOutcome.reason,
        record
      );
    } else if (sessionOutcome.status === 'fulfilled' && sessionOutcome.value === 'timeout') {
      record.diagnostic = diagnosticSnapshot(
        'DYNAMIC_PLUGIN_RETRACTION_TIMEOUT',
        new Error('Dynamic capability session retraction timed out.'),
        record
      );
    }

    if (reportOutcome.status === 'fulfilled') {
      const report = reportOutcome.value;
      record.phase = report.terminalPhase;
      record.pendingWork = 0;
      const lastFailure = report.failures.at(-1);
      if (!record.diagnostic && lastFailure) {
        record.diagnostic = lastFailure;
      }
      return report;
    } else {
      record.phase = 'failed-to-quiesce';
      record.pendingWork = 0;
      const failure = diagnosticSnapshot(
        'DYNAMIC_PLUGIN_CLEANUP_FAILED',
        reportOutcome.reason,
        record
      );
      if (!record.diagnostic) {
        record.diagnostic = failure;
      }
      return Object.freeze({
        activationId: record.activationId,
        terminalPhase: 'failed-to-quiesce',
        removedRegistrations: 0,
        cancelledWork: record.scope.pendingWork,
        failures: Object.freeze([failure])
      });
    }
  }

  private async performDestroy(): Promise<readonly PluginDiagnosticSnapshot[]> {
    // 1. Abort all in-flight scopes immediately
    for (const scope of this.inFlightScopes) {
      scope.abort('host-shutdown');
    }

    // 2. Identify active and in-flight records
    const active = [...this.currentRecords.values()].reverse();
    this.currentRecords.clear();
    const inFlight = [...this.inFlightRecords];
    this.inFlightRecords.clear();

    // 3. Concurrently kick off in-flight activations, in-flight rollbacks, and active retractions
    const inFlightTasks = inFlight.map(async (record) => {
      try {
        await this.rollbackFailedActivation(record);
      } finally {
        record.phase = 'failed';
        this.inFlightScopes.delete(record.scope);
        this.activating.delete(record.pluginId);
      }
    });

    const cleanupReports: PluginCleanupReport[] = [];
    const activeTasks = active.map(async (record) => {
      const report = await this.retractRecord(record, 'host-shutdown');
      cleanupReports.push(report);
      return report;
    });

    const allOperations = Promise.allSettled([
      ...this.inFlightActivations,
      ...inFlightTasks,
      ...activeTasks
    ]);

    // 4. Race ALL operations against a SINGLE shared master timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.options.quiescenceTimeoutMs);
    });

    const outcome = await Promise.race([allOperations.then(() => 'completed' as const), timeout]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    // 5. If master timeout fired, finalize any unfinished records synchronously without additional waiting
    if (outcome === 'timeout') {
      for (const record of inFlight) {
        record.phase = 'failed';
        if (!record.diagnostic) {
          record.diagnostic = diagnosticSnapshot(
            'DYNAMIC_PLUGIN_ACTIVATION_TIMEOUT',
            new Error('Dynamic plugin activation timed out during host destruction.'),
            record
          );
        }
        this.inFlightScopes.delete(record.scope);
        this.activating.delete(record.pluginId);
      }

      for (const record of active) {
        if (record.phase !== 'inactive' && record.phase !== 'failed-to-quiesce') {
          record.phase = 'failed-to-quiesce';
          record.pendingWork = 0;
          if (!record.diagnostic) {
            record.diagnostic = diagnosticSnapshot(
              'DYNAMIC_PLUGIN_RETRACTION_TIMEOUT',
              new Error('Dynamic plugin retraction timed out during host destruction.'),
              record
            );
          }
        }
      }
    }

    // 6. Collect all diagnostics (aggregating all cleanup report failures and record diagnostics)
    const diagnostics: PluginDiagnosticSnapshot[] = [];
    const seen = new Set<PluginDiagnosticSnapshot>();

    const addDiagnostic = (diagnostic: PluginDiagnosticSnapshot | undefined) => {
      if (diagnostic && !seen.has(diagnostic)) {
        seen.add(diagnostic);
        diagnostics.push(diagnostic);
      }
    };

    for (const report of cleanupReports) {
      for (const failure of report.failures) {
        addDiagnostic(failure);
      }
    }

    for (const record of active) {
      addDiagnostic(record.diagnostic);
    }

    for (const record of this.records) {
      if (record.phase === 'failed' || record.phase === 'failed-to-quiesce') {
        addDiagnostic(record.diagnostic);
      }
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
    ),
    artifactHashes: Object.freeze({ ...definition.manifest.artifactHashes })
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

function withTimeout<T, U>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutValue: U
): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<U>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
  });
  return Promise.race([
    promise.then((value) => {
      if (timer !== undefined) clearTimeout(timer);
      return value;
    }),
    timeout
  ]);
}
