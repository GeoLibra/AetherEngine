export type AssetPriorityClass = 'interactive' | 'visible' | 'prefetch' | 'background';

export interface AssetRequestDemandFixture {
  readonly key: string;
  readonly consumerId: string;
  readonly priorityClass: AssetPriorityClass;
  readonly explicitPriority: number;
  readonly screenContribution: number;
  readonly age: number;
  readonly estimatedBytes: number;
}

export interface AssetScheduleBudget {
  readonly maxRequests: number;
  readonly maxBytes: number;
}

export interface AdmittedAssetRequest {
  readonly key: string;
  readonly consumerCount: number;
  readonly priorityClass: AssetPriorityClass;
  readonly explicitPriority: number;
  readonly screenContribution: number;
  readonly age: number;
  readonly estimatedBytes: number;
}

export interface AssetScheduleResult {
  readonly admitted: readonly AdmittedAssetRequest[];
  readonly oracleHash: string;
  readonly counters: Readonly<{
    inputDemands: number;
    uniqueRequests: number;
    duplicateConsumers: number;
    admittedRequests: number;
    admittedBytes: number;
    rejectedByBudget: number;
  }>;
}

const PRIORITY_CLASSES: readonly AssetPriorityClass[] = Object.freeze([
  'interactive',
  'visible',
  'prefetch',
  'background'
]);

const PRIORITY_RANK: Readonly<Record<AssetPriorityClass, number>> = Object.freeze({
  interactive: 3,
  visible: 2,
  prefetch: 1,
  background: 0
});

interface MutableMergedDemand {
  key: string;
  consumers: Set<string>;
  priorityClass: AssetPriorityClass;
  explicitPriority: number;
  screenContribution: number;
  age: number;
  estimatedBytes: number;
}

export function createAssetRequestFixture(
  count: number,
  seed: number
): AssetRequestDemandFixture[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };

  return Array.from({ length: count }, (_, index) => ({
    key: `asset/${index.toString().padStart(8, '0')}`,
    consumerId: `consumer/${index % 31}`,
    priorityClass: PRIORITY_CLASSES[next() % PRIORITY_CLASSES.length]!,
    explicitPriority: next() % 101,
    screenContribution: (next() % 10_000) / 10_000,
    age: next() % 1_000,
    estimatedBytes: 1_024 + (next() % 262_144)
  }));
}

export function scheduleAssetRequestsReference(
  demands: readonly AssetRequestDemandFixture[],
  budget: AssetScheduleBudget
): AssetScheduleResult {
  return admit(mergeDemands(demands).sort(compareDemand), demands.length, budget);
}

export function scheduleAssetRequestsBucketed(
  demands: readonly AssetRequestDemandFixture[],
  budget: AssetScheduleBudget
): AssetScheduleResult {
  const buckets = new Map<AssetPriorityClass, MutableMergedDemand[]>(
    PRIORITY_CLASSES.map((priorityClass) => [priorityClass, []])
  );
  for (const demand of mergeDemands(demands)) {
    buckets.get(demand.priorityClass)!.push(demand);
  }

  const ordered: MutableMergedDemand[] = [];
  for (const priorityClass of PRIORITY_CLASSES) {
    const bucket = buckets.get(priorityClass)!;
    bucket.sort(compareDemand);
    ordered.push(...bucket);
  }
  return admit(ordered, demands.length, budget);
}

function mergeDemands(demands: readonly AssetRequestDemandFixture[]): MutableMergedDemand[] {
  const merged = new Map<string, MutableMergedDemand>();
  for (const demand of demands) {
    const current = merged.get(demand.key);
    if (!current) {
      merged.set(demand.key, {
        key: demand.key,
        consumers: new Set([demand.consumerId]),
        priorityClass: demand.priorityClass,
        explicitPriority: demand.explicitPriority,
        screenContribution: demand.screenContribution,
        age: demand.age,
        estimatedBytes: demand.estimatedBytes
      });
      continue;
    }
    current.consumers.add(demand.consumerId);
    if (PRIORITY_RANK[demand.priorityClass] > PRIORITY_RANK[current.priorityClass]) {
      current.priorityClass = demand.priorityClass;
    }
    current.explicitPriority = Math.max(current.explicitPriority, demand.explicitPriority);
    current.screenContribution = Math.max(current.screenContribution, demand.screenContribution);
    current.age = Math.max(current.age, demand.age);
    current.estimatedBytes = Math.max(current.estimatedBytes, demand.estimatedBytes);
  }
  return [...merged.values()];
}

function compareDemand(a: MutableMergedDemand, b: MutableMergedDemand): number {
  return (
    PRIORITY_RANK[b.priorityClass] - PRIORITY_RANK[a.priorityClass] ||
    b.explicitPriority - a.explicitPriority ||
    b.screenContribution - a.screenContribution ||
    b.age - a.age ||
    a.key.localeCompare(b.key)
  );
}

function admit(
  ordered: readonly MutableMergedDemand[],
  inputDemands: number,
  budget: AssetScheduleBudget
): AssetScheduleResult {
  const admitted: AdmittedAssetRequest[] = [];
  let admittedBytes = 0;
  let rejectedByBudget = 0;

  for (const demand of ordered) {
    if (
      admitted.length >= budget.maxRequests ||
      admittedBytes + demand.estimatedBytes > budget.maxBytes
    ) {
      rejectedByBudget++;
      continue;
    }
    admitted.push({
      key: demand.key,
      consumerCount: demand.consumers.size,
      priorityClass: demand.priorityClass,
      explicitPriority: demand.explicitPriority,
      screenContribution: demand.screenContribution,
      age: demand.age,
      estimatedBytes: demand.estimatedBytes
    });
    admittedBytes += demand.estimatedBytes;
  }

  const uniqueRequests = ordered.length;
  const uniqueConsumers = ordered.reduce((sum, demand) => sum + demand.consumers.size, 0);
  return Object.freeze({
    admitted: Object.freeze(admitted),
    oracleHash: hashOracle(admitted),
    counters: Object.freeze({
      inputDemands,
      uniqueRequests,
      duplicateConsumers: uniqueConsumers - uniqueRequests,
      admittedRequests: admitted.length,
      admittedBytes,
      rejectedByBudget
    })
  });
}

function hashOracle(admitted: readonly AdmittedAssetRequest[]): string {
  let hash = 0x811c9dc5;
  const text = JSON.stringify(admitted);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
