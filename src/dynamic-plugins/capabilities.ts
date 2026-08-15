import { DynamicPluginScope } from './scope';
import type {
  DynamicCapabilityDescriptor,
  DynamicCapabilityLease,
  DynamicCapabilityOpenContext,
  DynamicCapabilityPlan,
  DynamicCapabilityProvider,
  DynamicCapabilityResolver,
  DynamicCapabilitySession,
  DynamicCapabilityToken,
  DynamicPluginHostKind
} from './types';

interface OpenedCapability {
  readonly token: DynamicCapabilityToken<unknown>;
  readonly lease: DynamicCapabilityLease<unknown>;
}

interface ErasedProvider {
  readonly token: DynamicCapabilityToken<unknown>;
  open(context: DynamicCapabilityOpenContext): Promise<DynamicCapabilityLease<unknown>>;
}

export function createDynamicCapabilityToken<T>(
  descriptor: DynamicCapabilityDescriptor
): DynamicCapabilityToken<T> {
  if (descriptor.id.trim().length === 0) {
    throw new Error('Dynamic capability token ID must not be empty.');
  }
  if (!Number.isInteger(descriptor.version) || descriptor.version <= 0) {
    throw new Error('Dynamic capability token version must be a positive integer.');
  }
  if (descriptor.hostKinds.length === 0) {
    throw new Error('Dynamic capability token must support at least one host.');
  }

  return Object.freeze({
    ...descriptor,
    hostKinds: Object.freeze([...descriptor.hostKinds]),
    key: Symbol(`${descriptor.id}@${descriptor.version}`)
  });
}

export class DynamicCapabilityBroker {
  private readonly providers = new Map<string, ErasedProvider>();

  constructor(private readonly hostKind: DynamicPluginHostKind) {}

  register<T>(provider: DynamicCapabilityProvider<T>): void {
    if (!provider.token.hostKinds.includes(this.hostKind)) {
      throw new Error(
        `Dynamic capability ${provider.token.id}@${provider.token.version} does not support host ${this.hostKind}.`
      );
    }
    const key = capabilityKey(provider.token);
    if (this.providers.has(key)) {
      throw new Error(`Duplicate dynamic capability provider ${key}.`);
    }
    this.providers.set(key, {
      token: provider.token,
      open: async (context) => provider.open(context)
    });
  }

  descriptors(): readonly DynamicCapabilityDescriptor[] {
    return Object.freeze([...this.providers.values()].map(({ token }) => token));
  }

  async open(
    plan: DynamicCapabilityPlan,
    scope: DynamicPluginScope
  ): Promise<DynamicCapabilitySession> {
    const opened: OpenedCapability[] = [];
    try {
      for (const request of plan.granted) {
        const provider = this.providers.get(capabilityKey(request));
        if (!provider) {
          throw new Error(
            `Granted dynamic capability ${request.id}@${request.version} has no provider.`
          );
        }
        const lease = await provider.open({
          pluginId: scope.pluginId,
          versionId: scope.versionId,
          activationId: scope.activationId,
          hostKind: scope.hostKind,
          signal: scope.signal
        });
        opened.push({ token: provider.token, lease });
        await lease.prepare();
      }
    } catch (cause) {
      await rollbackOpened(opened);
      throw cause;
    }

    return new CapabilitySession(opened, scope);
  }
}

class CapabilitySession implements DynamicCapabilitySession {
  readonly resolver: DynamicCapabilityResolver;

  private state: 'staging' | 'committed' | 'rolled-back' = 'staging';
  private readonly committedCleanups: Array<() => Promise<void>> = [];

  constructor(
    private readonly opened: readonly OpenedCapability[],
    private readonly scope: DynamicPluginScope
  ) {
    const facades = new Map<symbol, unknown>();
    for (const { token, lease } of opened) {
      facades.set(token.key, lease.facade);
    }
    this.resolver = Object.freeze({
      get: <T>(token: DynamicCapabilityToken<T>): T => {
        if (!facades.has(token.key)) {
          throw new Error(
            `DYNAMIC_CAPABILITY_NOT_GRANTED: ${token.id}@${token.version} was not granted.`
          );
        }
        return facades.get(token.key) as T;
      }
    });
  }

  commit(): void {
    if (this.state !== 'staging') {
      throw new Error(`Dynamic capability session cannot commit from ${this.state}.`);
    }
    for (const { lease } of this.opened) {
      lease.commit();
    }
    for (const { lease } of this.opened) {
      let cleanup: Promise<void> | undefined;
      const runOnce = () => (cleanup ??= Promise.resolve(lease.rollback()));
      this.committedCleanups.push(runOnce);
      this.scope.own(runOnce);
    }
    this.state = 'committed';
  }

  async rollback(): Promise<void> {
    if (this.state === 'rolled-back') return;
    if (this.state === 'committed') {
      throw new Error('Committed dynamic capability session is owned by its activation scope.');
    }
    this.state = 'rolled-back';
    await rollbackOpened(this.opened);
  }

  async retract(): Promise<void> {
    if (this.state === 'staging') {
      await this.rollback();
      return;
    }
    if (this.state === 'rolled-back') return;
    const failures: unknown[] = [];
    for (let index = this.committedCleanups.length - 1; index >= 0; index--) {
      try {
        await this.committedCleanups[index]?.();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Dynamic capability retraction failed.');
    }
  }
}

async function rollbackOpened(opened: readonly OpenedCapability[]): Promise<void> {
  const failures: unknown[] = [];
  for (let index = opened.length - 1; index >= 0; index--) {
    try {
      await opened[index]?.lease.rollback();
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Dynamic capability rollback failed.');
  }
}

function capabilityKey(value: { readonly id: string; readonly version: number }): string {
  return `${value.id}@${value.version}`;
}
