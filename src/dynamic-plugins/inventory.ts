import type { DynamicPluginInventoryEntry } from './types';

export function createDynamicPluginInventory(
  entries: Iterable<DynamicPluginInventoryEntry>
): readonly DynamicPluginInventoryEntry[] {
  return Object.freeze(
    [...entries].map(copyInventoryEntry).sort((left, right) => {
      const a = inventoryKey(left);
      const b = inventoryKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    })
  );
}

export function copyInventoryEntry(
  entry: DynamicPluginInventoryEntry
): DynamicPluginInventoryEntry {
  return Object.freeze({
    pluginId: entry.pluginId,
    versionId: entry.versionId,
    ...(entry.activationId ? { activationId: entry.activationId } : {}),
    hostKind: entry.hostKind,
    phase: entry.phase,
    grantedCapabilities: Object.freeze([...entry.grantedCapabilities]),
    deniedOptionalCapabilities: Object.freeze([...entry.deniedOptionalCapabilities]),
    contributionCounts: Object.freeze({ ...entry.contributionCounts }),
    pendingWork: entry.pendingWork,
    ...(entry.diagnostic ? { diagnostic: entry.diagnostic } : {})
  });
}

function inventoryKey(entry: DynamicPluginInventoryEntry): string {
  return `${entry.pluginId}\u0000${entry.versionId}\u0000${entry.activationId ?? ''}`;
}
