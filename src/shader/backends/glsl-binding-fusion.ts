import type {
  ShaderBindingEntryManifest,
  ShaderExpressionIR,
  ShaderModuleIR,
  ShaderStatementIR
} from '../types';

export interface GlslTextureSamplerUse {
  readonly texture: Readonly<{ group: number; binding: number }>;
  readonly sampler: Readonly<{ group: number; binding: number }>;
  readonly stages: readonly ('vertex' | 'fragment')[];
}

export interface GlslCombinedSamplerBinding {
  readonly textureGroup: number;
  readonly textureBinding: number;
  readonly samplerGroup: number;
  readonly samplerBinding: number;
  readonly name: string;
  readonly slot: number;
  readonly samplerType: 'sampler2D' | 'samplerCube' | 'sampler2DShadow';
  readonly stages: readonly ('vertex' | 'fragment')[];
}

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
    if (texture?.kind !== 'texture')
      throw new Error('GLSL fusion use does not reference a texture.');
    if (sampler?.kind !== 'sampler')
      throw new Error('GLSL fusion use does not reference a sampler.');
    if (texture.multisampled) throw new Error('Multisampled textures cannot use a GLSL sampler.');
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
  const ordered = [...fused.values()].sort((left, right) =>
    bindingTuple(left).localeCompare(bindingTuple(right))
  );
  if (ordered.length > maxTextureUnits)
    throw new Error(
      `GLSL combined samplers require ${ordered.length} texture units, limit is ${maxTextureUnits}.`
    );
  return ordered.map((entry, slot) => ({ ...entry, slot }));
}

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
    for (const child of expressionChildren(expression)) visitExpression(child, stages);
  };
  const visitStatements = (
    statements: readonly ShaderStatementIR[],
    stages: readonly ('vertex' | 'fragment')[]
  ): void => {
    for (const statement of statements) {
      for (const expression of statementExpressions(statement)) visitExpression(expression, stages);
      if (statement.kind === 'if') {
        visitStatements(statement.then, stages);
        visitStatements(statement.otherwise ?? [], stages);
      } else if (statement.kind === 'while' || statement.kind === 'loop') {
        visitStatements(statement.body, stages);
        if (statement.kind === 'loop') visitStatements(statement.continuing, stages);
      } else if (statement.kind === 'switch') {
        for (const case_ of statement.cases) visitStatements(case_.body, stages);
      }
    }
  };
  for (const entry of ir.entryPoints) {
    if (entry.stage !== 'compute') visitStatements(entry.body, [entry.stage]);
  }
  // Helpers can be shared across stages; assigning both stages is conservative and deterministic.
  for (const function_ of ir.functions) visitStatements(function_.body, ['vertex', 'fragment']);
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
