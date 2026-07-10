export type FixedOverrunPolicy = 'discard' | 'retain';

export interface TimePolicyOptions {
  readonly fixedStep?: number;
  readonly maxSubsteps?: number;
  readonly maxFrameDelta?: number;
  readonly overrun?: FixedOverrunPolicy;
}
