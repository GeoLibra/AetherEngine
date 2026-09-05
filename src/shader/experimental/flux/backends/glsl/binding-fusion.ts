import type {
  ShaderBindingEntryManifest,
  ShaderExpressionIR,
  ShaderModuleIR,
  ShaderStatementIR
} from '../../../../types';

/**
 * Represents a concrete pairing of a separate texture and sampler in the authored shader code.
 *
 * In WebGPU / WGSL, textures and samplers are decoupled independent bind group entries.
 * In WebGL2 / GLSL ES 3.00, textures and samplers must be combined into a single unified
 * `sampler2D` / `samplerCube` / `sampler2DShadow` uniform object.
 */
export interface GlslTextureSamplerUse {
  /** Texture bind group and slot coordinates. */
  readonly texture: Readonly<{ group: number; binding: number }>;
  /** Sampler bind group and slot coordinates. */
  readonly sampler: Readonly<{ group: number; binding: number }>;
  /** Shader pipeline stages (vertex / fragment) where this combination is active. */
  readonly stages: readonly ('vertex' | 'fragment')[];
}

/**
 * Represents a finalized fused WebGL2 combined texture-sampler uniform binding.
 */
export interface GlslCombinedSamplerBinding {
  readonly textureGroup: number;
  readonly textureBinding: number;
  readonly samplerGroup: number;
  readonly samplerBinding: number;
  /** Generated unique identifier for the combined GLSL sampler uniform (e.g. `aether_t0_1_s0_2`). */
  readonly name: string;
  /** Physical WebGL2 texture unit slot index (maps to `gl.activeTexture(gl.TEXTURE0 + slot)`). */
  readonly slot: number;
  /** Target GLSL combined sampler uniform type. */
  readonly samplerType: 'sampler2D' | 'samplerCube' | 'sampler2DShadow';
  /** Shader stages where this combined sampler uniform is declared. */
  readonly stages: readonly ('vertex' | 'fragment')[];
}

/**
 * Fuses WebGPU-style decoupled texture and sampler bindings into combined WebGL2 samplers.
 *
 * Design Rationale:
 * 1. WebGPU allows `texture_2d<f32>` at `@group(A) @binding(B)` to be sampled by multiple
 *    independent `sampler` instances at `@group(C) @binding(D)`.
 * 2. WebGL2 / GLSL ES 3.00 does not have separate sampler objects; it requires combined
 *    `uniform sampler2D/samplerCube/sampler2DShadow` variables.
 * 3. This function computes the Cartesian product of active `(Texture, Sampler)` pairs, assigns
 *    deterministic names (`aether_t{g}_{b}_s{g}_{b}`), and allocates dedicated texture unit slots.
 * 4. Fails fast if the total number of fused samplers exceeds `maxTextureUnits` (hardware limit
 *    specified by `gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS`, baseline minimum 16).
 *
 * @param bindings Reflected shader bind group manifest entries.
 * @param uses Extracted usage instances from AST/IR `textureSample` call sites.
 * @param maxTextureUnits Maximum available GPU texture image units (typically 16 on baseline WebGL2).
 * @returns Sorted, deduplicated list of fused combined sampler bindings with assigned slots.
 * @throws If an entry does not reference a valid texture/sampler or if texture unit limit is exceeded.
 */
export function fuseGlslTextureSamplerBindings(
  bindings: readonly ShaderBindingEntryManifest[],
  uses: readonly GlslTextureSamplerUse[],
  maxTextureUnits: number
): readonly GlslCombinedSamplerBinding[] {
  const indexed = new Map(bindings.map((entry) => [`${entry.group}:${entry.binding}`, entry]));
  const fused = new Map<string, Omit<GlslCombinedSamplerBinding, 'slot'>>();

  for (const use of uses) {
    const texture = indexed.get(`${use.texture.group}:${use.texture.binding}`);
    const sampler = indexed.get(`${use.sampler.group}:${use.sampler.binding}`);
    if (texture?.kind !== 'texture') {
      throw new Error('GLSL fusion use does not reference a texture.');
    }
    if (sampler?.kind !== 'sampler') {
      throw new Error('GLSL fusion use does not reference a sampler.');
    }
    if (texture.multisampled) {
      throw new Error('Multisampled textures cannot use a GLSL sampler.');
    }

    const key = `${texture.group}:${texture.binding}:${sampler.group}:${sampler.binding}`;
    const prior = fused.get(key);
    const stages = orderedStages([...(prior?.stages ?? []), ...use.stages]);

    fused.set(key, {
      textureGroup: texture.group,
      textureBinding: texture.binding,
      samplerGroup: sampler.group,
      samplerBinding: sampler.binding,
      name: `aether_t${texture.group}_${texture.binding}_s${sampler.group}_${sampler.binding}`,
      samplerType:
        sampler.samplerType === 'comparison'
          ? 'sampler2DShadow'
          : texture.viewDimension === 'cube'
            ? 'samplerCube'
            : 'sampler2D',
      stages
    });
  }

  // Sort deterministically by (textureGroup, textureBinding, samplerGroup, samplerBinding)
  const ordered = [...fused.values()].sort((left, right) =>
    bindingTuple(left).localeCompare(bindingTuple(right))
  );

  // Invariant check: WebGL2 texture unit count cannot exceed hardware limit
  if (ordered.length > maxTextureUnits) {
    throw new Error(
      `GLSL combined samplers require ${ordered.length} texture units, limit is ${maxTextureUnits}.`
    );
  }

  return ordered.map((entry, slot) => ({ ...entry, slot }));
}

/**
 * Traverses a ShaderModuleIR AST to collect all active `textureSample` intrinsic calls.
 *
 * Inspects all statements and expressions in entry points and helper functions to discover
 * which texture and sampler symbols are paired together during shader execution.
 *
 * @param ir The intermediate representation of the shader module.
 * @returns Array of unique texture-sampler usage pairings with their active stages.
 */
export function collectGlslTextureSamplerUses(
  ir: ShaderModuleIR
): readonly GlslTextureSamplerUse[] {
  const uses: GlslTextureSamplerUse[] = [];

  const visitExpression = (
    expression: ShaderExpressionIR,
    stages: readonly ('vertex' | 'fragment')[]
  ): void => {
    if (expression.kind === 'intrinsic' && expression.intrinsic === 'textureSample') {
      const [texture, sampler] = expression.arguments;
      if (texture?.kind === 'symbol' && sampler?.kind === 'symbol') {
        const textureGlobal = ir.globals.find((global) => global.id === texture.symbol);
        const samplerGlobal = ir.globals.find((global) => global.id === sampler.symbol);
        if (
          textureGlobal?.group !== undefined &&
          textureGlobal.binding !== undefined &&
          samplerGlobal?.group !== undefined &&
          samplerGlobal.binding !== undefined
        ) {
          uses.push({
            texture: { group: textureGlobal.group, binding: textureGlobal.binding },
            sampler: { group: samplerGlobal.group, binding: samplerGlobal.binding },
            stages
          });
        }
      }
    }
    for (const child of expressionChildren(expression)) {
      visitExpression(child, stages);
    }
  };

  const visitStatements = (
    statements: readonly ShaderStatementIR[],
    stages: readonly ('vertex' | 'fragment')[]
  ): void => {
    for (const statement of statements) {
      for (const expression of statementExpressions(statement)) {
        visitExpression(expression, stages);
      }
      if (statement.kind === 'if') {
        visitStatements(statement.then, stages);
        visitStatements(statement.otherwise ?? [], stages);
      } else if (statement.kind === 'while' || statement.kind === 'loop') {
        visitStatements(statement.body, stages);
        if (statement.kind === 'loop') {
          visitStatements(statement.continuing, stages);
        }
      } else if (statement.kind === 'switch') {
        for (const case_ of statement.cases) {
          visitStatements(case_.body, stages);
        }
      }
    }
  };

  for (const entry of ir.entryPoints) {
    if (entry.stage !== 'compute') {
      visitStatements(entry.body, [entry.stage]);
    }
  }

  // Helpers can be shared across stages; assigning both stages is conservative and deterministic.
  for (const function_ of ir.functions) {
    visitStatements(function_.body, ['vertex', 'fragment']);
  }

  return uses;
}

function expressionChildren(expression: ShaderExpressionIR): readonly ShaderExpressionIR[] {
  switch (expression.kind) {
    case 'literal':
    case 'symbol':
      return [];
    case 'unary':
      return [expression.operand];
    case 'binary':
      return [expression.left, expression.right];
    case 'construct':
    case 'call':
    case 'intrinsic':
      return expression.arguments;
    case 'field':
      return [expression.base];
    case 'index':
      return [expression.base, expression.index];
  }
}

function statementExpressions(statement: ShaderStatementIR): readonly ShaderExpressionIR[] {
  switch (statement.kind) {
    case 'declare':
      return statement.value === undefined ? [] : [statement.value];
    case 'assign':
      return [statement.target, statement.value];
    case 'if':
      return [statement.condition];
    case 'switch':
      return [statement.selector, ...statement.cases.flatMap((case_) => case_.selectors)];
    case 'while':
      return [statement.condition];
    case 'return':
      return statement.value === undefined ? [] : [statement.value];
    case 'expression':
      return [statement.expression];
    case 'loop':
    case 'break':
    case 'continue':
    case 'discard':
      return [];
  }
}

function bindingTuple(value: Omit<GlslCombinedSamplerBinding, 'slot'>): string {
  return [value.textureGroup, value.textureBinding, value.samplerGroup, value.samplerBinding]
    .map((part) => String(part).padStart(10, '0'))
    .join(':');
}

function orderedStages(
  stages: readonly ('vertex' | 'fragment')[]
): readonly ('vertex' | 'fragment')[] {
  return (['vertex', 'fragment'] as const).filter((stage) => stages.includes(stage));
}
