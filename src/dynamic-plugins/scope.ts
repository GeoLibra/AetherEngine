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
    const pending = Object.freeze([...this.pending]);
    let quiesced = false;
    const failures: PluginDiagnosticSnapshot[] = [];
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.options.quiescenceTimeoutMs);
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

    for (let index = this.cleanups.length - 1; index >= 0; index--) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.quiescenceTimeoutMs);
        });
        await Promise.race([Promise.resolve(this.cleanups[index]?.()), timeout]);
        if (timer !== undefined) {
          clearTimeout(timer);
        }
      } catch (cause) {
        failures.push(this.cleanupFailure(cause));
      }
    }

    return Object.freeze({
      activationId: this.options.activationId,
      terminalPhase: quiesced ? 'inactive' : 'failed-to-quiesce',
      removedRegistrations: this.cleanups.length,
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

  private assertActive(): void {
    if (this.disposal) {
      throw new Error('activation-retracted: dynamic plugin scope is disposing.');
    }
  }
}
