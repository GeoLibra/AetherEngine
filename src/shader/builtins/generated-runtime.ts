import type { ShaderModuleIR } from '../types';

/**
 * Publishes a generated shader artifact as an immutable runtime snapshot.
 * Generated modules contain plain literals so loading them never invokes the FluxSL frontend.
 */
export function freezeGeneratedShaderModule(module: ShaderModuleIR): ShaderModuleIR {
  return deepFreeze(module);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
