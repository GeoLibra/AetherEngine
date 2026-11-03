/** Owner-reported residency facts; GPU pools identify one device generation. */
export interface AssetResidencyCandidate {
  readonly key: string;
  readonly pool: string;
  readonly bytes: number;
  readonly activeLeases: number;
  readonly activeSubmissions: number;
  readonly priority: number;
  readonly lastUseTick: number;
  readonly rebuildCost: number;
}

/** Immutable eviction proposal; resource owners revalidate eligibility before applying it. */
export interface AssetResidencyPressurePlan {
  readonly candidates: readonly AssetResidencyCandidate[];
  readonly proposedBytes: number;
  readonly unmetBytes: number;
}

/** Authority port that revalidates identity and ownership before releasing CPU or GPU residency. */
export interface AssetResidencyEvictionOwner {
  /** Returns actual released bytes, or null when the current residency cannot be evicted. */
  evict(candidate: AssetResidencyCandidate): number | null;
}
