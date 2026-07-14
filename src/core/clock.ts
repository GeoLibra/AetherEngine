/** Monotonic time source used at deterministic runtime and platform boundaries. */
export interface MonotonicClock {
  now(): number;
}
