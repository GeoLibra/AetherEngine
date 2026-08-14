import type {
  DynamicPluginCleanup,
  DynamicPluginScopeOptions,
  PluginCleanupReport,
  PluginDiagnosticSnapshot,
  PluginRetractionReason
} from './types';

export class DynamicPluginScope {
  readonly signal: AbortSignal;
  readonly pluginId;
  readonly versionId;
  readonly activationId;
  readonly hostKind;

  private readonly controller = new AbortController();
  private readonly cleanups: DynamicPluginCleanup[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private disposal: Promise<PluginCleanupReport> | undefined;

  constructor(private readonly options: DynamicPluginScopeOptions) {
    this.signal = this.controller.signal;
    this.pluginId = options.pluginId;
    this.versionId = options.versionId;
    this.activationId = options.activationId;
    this.hostKind = options.hostKind;
  }

  get pendingWork(): number {
    return this.pending.size;
  }

  own(cleanup: DynamicPluginCleanup): void {
    this.assertActive();
    this.cleanups.push(cleanup);
  }

  track(work: Promise<unknown>): void {
    this.assertActive();
    this.pending.add(work);
    const remove = () => {
      this.pending.delete(work);
    };
    void work.then(remove, remove);
  }

  abort(reason?: unknown): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  dispose(reason: PluginRetractionReason): Promise<PluginCleanupReport> {
    this.disposal ??= this.performDisposal(reason);
    return this.disposal;
  }

  private async performDisposal(reason: PluginRetractionReason): Promise<PluginCleanupReport> {
    this.abort(reason);
    const start = Date.now();
    const remainingMs = () => Math.max(0, this.options.quiescenceTimeoutMs - (Date.now() - start));
    const pending = Object.freeze([...this.pending]);
    let quiesced = false;
    const failures: PluginDiagnosticSnapshot[] = [];
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remainingMs());
      });
      quiesced = await Promise.race([
        this.options.quiescence.wait(pending, this.options.quiescenceTimeoutMs),
        timeout
      ]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    } catch (cause) {
      quiesced = false;
      failures.push(this.quiescenceFailure(cause));
    }

    const TIMEOUT_TOKEN = Symbol('cleanup-timeout');
    let removedRegistrations = 0;
    let allCleanupsSucceeded = true;

    for (let index = this.cleanups.length - 1; index >= 0; index--) {
      try {
        const cleanupResult = this.cleanups[index]?.();
        if (
          cleanupResult instanceof Promise ||
          (cleanupResult !== null &&
            typeof cleanupResult === 'object' &&
            typeof (cleanupResult as Promise<unknown>).then === 'function')
        ) {
          const msLeft = remainingMs();
          if (msLeft <= 0) {
            allCleanupsSucceeded = false;
            failures.push(this.cleanupTimeoutFailure(index));
            void (cleanupResult as Promise<unknown>).catch(() => undefined);
          } else {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<typeof TIMEOUT_TOKEN>((resolve) => {
              timer = setTimeout(() => resolve(TIMEOUT_TOKEN), msLeft);
            });
            const result = await Promise.race([
              (cleanupResult as Promise<unknown>).then(() => 'success' as const),
              timeout
            ]);
            if (timer !== undefined) {
              clearTimeout(timer);
            }
            if (result === TIMEOUT_TOKEN) {
              allCleanupsSucceeded = false;
              failures.push(this.cleanupTimeoutFailure(index));
              void (cleanupResult as Promise<unknown>).catch(() => undefined);
            } else {
              removedRegistrations++;
            }
          }
        } else {
          removedRegistrations++;
        }
      } catch (cause) {
        allCleanupsSucceeded = false;
        failures.push(this.cleanupFailure(cause));
      }
    }

    return Object.freeze({
      activationId: this.options.activationId,
      terminalPhase: quiesced && allCleanupsSucceeded ? 'inactive' : 'failed-to-quiesce',
      removedRegistrations,
      cancelledWork: pending.length,
      failures: Object.freeze(failures)
    });
  }

  private quiescenceFailure(cause: unknown): PluginDiagnosticSnapshot {
    return Object.freeze({
      code: 'DYNAMIC_PLUGIN_QUIESCENCE_FAILED',
      phase: 'retracting',
      message: cause instanceof Error ? cause.message : String(cause),
      fields: Object.freeze({
        pluginId: this.options.pluginId,
        versionId: this.options.versionId,
        activationId: this.options.activationId,
        hostKind: this.options.hostKind
      })
    });
  }

  private cleanupFailure(cause: unknown): PluginDiagnosticSnapshot {
    return Object.freeze({
      code: 'DYNAMIC_PLUGIN_CLEANUP_FAILED',
      phase: 'retracting',
      message: cause instanceof Error ? cause.message : String(cause),
      fields: Object.freeze({
        pluginId: this.options.pluginId,
        versionId: this.options.versionId,
        activationId: this.options.activationId,
        hostKind: this.options.hostKind
      })
    });
  }

  private cleanupTimeoutFailure(index: number): PluginDiagnosticSnapshot {
    return Object.freeze({
      code: 'DYNAMIC_PLUGIN_CLEANUP_TIMEOUT',
      phase: 'retracting',
      message: `Dynamic plugin cleanup callback at index ${index} timed out.`,
      fields: Object.freeze({
        pluginId: this.options.pluginId,
        versionId: this.options.versionId,
        activationId: this.options.activationId,
        hostKind: this.options.hostKind,
        cleanupIndex: index
      })
    });
  }

  private assertActive(): void {
    if (this.disposal) {
      throw new Error('activation-retracted: dynamic plugin scope is disposing.');
    }
  }
}
