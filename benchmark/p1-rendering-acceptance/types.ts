/** Deterministic semantics and structural counters accompanying CPU benchmark samples. */
export interface AcceptanceObservation {
  readonly checksum: string;
  readonly counters: Readonly<Record<string, number>>;
}
