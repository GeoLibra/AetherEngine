import type { RenderGraphDebugIR } from './debug-ir';

export function toRenderGraphDebugJSON(plan: RenderGraphDebugIR): string {
  return JSON.stringify(plan);
}
