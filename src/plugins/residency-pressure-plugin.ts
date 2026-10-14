import { definePlugin } from '../app/utils';
import { AssetPayloadRegistry } from '../assets/runtime';
import {
  enforceCpuResidencyBudget,
  enforceGpuResidencyBudget,
  PreparedAssetRegistry
} from '../rendering/world';
import type { ResidencyPressureSubject } from '../rendering/world';

/** Composition-owned budget facts read once at the end of each rendered frame. */
export interface ResidencyPressureFrame {
  readonly cpuBudgetBytes: number;
  readonly gpuBudgets: readonly Readonly<{ deviceGeneration: number; budgetBytes: number }>[];
  /** Complete owned residency inventory with current priority and last-use signals. */
  readonly subjects: readonly ResidencyPressureSubject[];
}

/** Observed physical reclamation and unmet pressure for each independently owned pool. */
export interface ResidencyPressureFrameResult {
  readonly cpu: Readonly<{ releasedBytes: number; remainingPressureBytes: number }>;
  readonly gpu: readonly Readonly<{
    deviceGeneration: number;
    releasedBytes: number;
    remainingPressureBytes: number;
  }>[];
}

/**
 * Creates an opt-in PostRender budget system using composition-owned residency authorities.
 * Each frame reads a fresh inventory; registry lease/submission checks guard reclamation.
 * Invalid budgets fail through the App system error boundary.
 */
export function createResidencyPressurePlugin(options: {
  readonly payloads: AssetPayloadRegistry;
  readonly prepared: PreparedAssetRegistry;
  readonly frame: () => ResidencyPressureFrame;
  readonly onResult: (result: ResidencyPressureFrameResult) => void;
}) {
  return definePlugin({
    id: 'aether.residency-pressure',
    build(builder) {
      builder.addSystem('PostRender', {
        id: 'aether.residency-pressure.enforce',
        run() {
          const frame = options.frame();
          const gpu = frame.gpuBudgets.map((budget) =>
            Object.freeze({
              deviceGeneration: budget.deviceGeneration,
              ...enforceGpuResidencyBudget(
                options.prepared,
                budget.deviceGeneration,
                budget.budgetBytes,
                frame.subjects
              )
            })
          );
          const cpu = enforceCpuResidencyBudget(
            options.payloads,
            frame.cpuBudgetBytes,
            frame.subjects
          );
          options.onResult(Object.freeze({ cpu, gpu: Object.freeze(gpu) }));
        }
      });
    }
  });
}
