import type { WebGL2ClipDepthMode } from './clip-depth';

export type WebGL2ShaderStage = 'vertex' | 'fragment';
export type WebGL2BindingKind = 'uniform-buffer' | 'texture' | 'sampler';

export interface WebGL2BindingManifestEntry {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: WebGL2BindingKind;
}

export interface WebGL2PhysicalBinding {
  readonly group: number;
  readonly binding: number;
  readonly kind: WebGL2BindingKind;
  readonly slot: number;
}

export interface WebGL2ProgramBinding {
  readonly kind: 'uniform-buffer' | 'combined-sampler';
  readonly name: string;
  readonly slot: number;
}

export interface WebGL2TranslatedShader {
  readonly source: string;
  readonly bindings: readonly WebGL2BindingManifestEntry[];
  readonly targetAbiFingerprint: string;
  readonly physicalBindings: readonly WebGL2PhysicalBinding[];
  readonly programBindings: readonly WebGL2ProgramBinding[];
  readonly requiredExtensions: readonly string[];
  readonly sourceMap: readonly Readonly<{ generatedLine: number; authoredLine: number }>[];
  readonly translatorFingerprint: string;
}

export interface WebGL2ShaderTranslationPort {
  readonly translatorId: string;
  readonly version: number;
  translate(
    input: Readonly<{
      wgsl: string;
      stage: WebGL2ShaderStage;
      entryPoint: string;
      constants: Readonly<Record<string, number>>;
      capabilities: readonly string[];
      approvedExtensions: readonly string[];
      clipDepthMode: WebGL2ClipDepthMode;
    }>
  ): WebGL2TranslatedShader;
}

export interface FinalizedWebGL2Shader extends WebGL2TranslatedShader {
  readonly source: string;
  readonly finalFingerprint: string;
}

export function finalizeWebGL2Shader(
  translator: WebGL2ShaderTranslationPort,
  translated: WebGL2TranslatedShader,
  input: Readonly<{
    constants: Readonly<Record<string, number>>;
    approvedExtensions: readonly string[];
  }>
): FinalizedWebGL2Shader {
  if (/^\s*#version\b/m.test(translated.source)) {
    throw new Error(
      'Translated GLSL must not contain a #version directive; the shared finalizer owns directives.'
    );
  }
  const approved = new Set(input.approvedExtensions);
  for (const extension of translated.requiredExtensions) {
    if (!approved.has(extension))
      throw new Error(`WebGL2 extension "${extension}" is not approved.`);
  }
  validatePhysicalBindings(translated.bindings, translated.physicalBindings);
  validateProgramBindings(translated.programBindings);
  const defines = Object.entries(input.constants)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !Number.isFinite(value)) {
        throw new Error(`Invalid WebGL2 shader constant "${name}".`);
      }
      return `#define ${name} ${value}`;
    });
  const directives = [
    '#version 300 es',
    ...translated.requiredExtensions.map((extension) => `#extension ${extension} : require`),
    ...defines
  ];
  const source = `${directives.join('\n')}\n${translated.source}`;
  const fingerprintInput = [
    translator.translatorId,
    translator.version,
    translated.translatorFingerprint,
    translated.targetAbiFingerprint,
    source,
    canonicalBindings(translated.bindings),
    canonicalPhysicalBindings(translated.physicalBindings),
    canonicalProgramBindings(translated.programBindings)
  ].join('\n');
  return Object.freeze({
    ...translated,
    source,
    sourceMap: Object.freeze(
      translated.sourceMap.map((entry) =>
        Object.freeze({
          generatedLine: entry.generatedLine + directives.length,
          authoredLine: entry.authoredLine
        })
      )
    ),
    finalFingerprint: hashText(fingerprintInput)
  });
}

function validateProgramBindings(bindings: readonly WebGL2ProgramBinding[]): void {
  const interfaces = new Set<string>();
  for (const binding of bindings) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.name))
      throw new Error(`Invalid WebGL2 program binding name "${binding.name}".`);
    if (!Number.isSafeInteger(binding.slot) || binding.slot < 0)
      throw new Error(`Invalid WebGL2 program binding slot ${binding.slot}.`);
    const key = `${binding.kind}:${binding.name}`;
    if (interfaces.has(key)) throw new Error(`Duplicate WebGL2 program binding ${key}.`);
    interfaces.add(key);
  }
}

function validatePhysicalBindings(
  logical: readonly WebGL2BindingManifestEntry[],
  physical: readonly WebGL2PhysicalBinding[]
): void {
  const keys = new Set<string>();
  const slots = new Set<string>();
  for (const binding of physical) {
    const key = `${binding.group}:${binding.binding}:${binding.kind}:${binding.slot}`;
    if (keys.has(key)) throw new Error(`Duplicate WebGL2 physical binding ${key}.`);
    keys.add(key);
    const slot = `${binding.kind}:${binding.slot}`;
    if (slots.has(slot)) throw new Error(`Duplicate WebGL2 physical slot ${slot}.`);
    slots.add(slot);
  }
  for (const binding of logical) {
    const prefix = `${binding.group}:${binding.binding}:${binding.kind}:`;
    if (![...keys].some((key) => key.startsWith(prefix)))
      throw new Error(`WebGL2 logical binding ${prefix.slice(0, -1)} has no physical slot.`);
  }
  const logicalKeys = new Set(
    logical.map((binding) => `${binding.group}:${binding.binding}:${binding.kind}`)
  );
  for (const binding of physical) {
    const key = `${binding.group}:${binding.binding}:${binding.kind}`;
    if (!logicalKeys.has(key))
      throw new Error(
        'WebGL2 physical binding manifest contains entries absent from the logical manifest.'
      );
  }
}

function canonicalBindings(bindings: readonly WebGL2BindingManifestEntry[]): string {
  return bindings
    .map((entry) => `${entry.group}:${entry.binding}:${entry.kind}:${entry.name}`)
    .sort()
    .join(',');
}

function canonicalPhysicalBindings(bindings: readonly WebGL2PhysicalBinding[]): string {
  return bindings
    .map((entry) => `${entry.group}:${entry.binding}:${entry.kind}:${entry.slot}`)
    .sort()
    .join(',');
}

function canonicalProgramBindings(bindings: readonly WebGL2ProgramBinding[]): string {
  return bindings
    .map((entry) => `${entry.kind}:${entry.name}:${entry.slot}`)
    .sort()
    .join(',');
}

function hashText(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
