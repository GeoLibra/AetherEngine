import type { CompiledRenderGraphEdge, RenderGraphSemanticEdge } from '../../types';

export class RenderGraphSemanticHazardError extends Error {
  readonly semanticEdge: RenderGraphSemanticEdge;

  constructor(edge: RenderGraphSemanticEdge, fromName: string, toName: string) {
    super(
      `Semantic edge ${fromName} -> ${toName} reverses a required resource hazard path ${toName} -> ${fromName}.`
    );
    this.name = 'RenderGraphSemanticHazardError';
    this.semanticEdge = edge;
  }
}

export class RenderGraphCycleError extends Error {
  readonly passIds: readonly number[];
  readonly passChain: readonly string[];
  readonly edges: readonly CompiledRenderGraphEdge[];

  constructor(
    passIds: readonly number[],
    passChain: readonly string[],
    edges: readonly CompiledRenderGraphEdge[]
  ) {
    super(`Render graph cycle: ${formatCycle(passChain, edges)}`);
    this.name = 'RenderGraphCycleError';
    this.passIds = Object.freeze([...passIds]);
    this.passChain = Object.freeze([...passChain]);
    this.edges = Object.freeze([...edges]);
  }
}

function formatCycle(
  passChain: readonly string[],
  edges: readonly CompiledRenderGraphEdge[]
): string {
  return (
    edges.map((edge, index) => `${passChain[index]} -[${describeEdge(edge)}]-> `).join('') +
    (passChain[passChain.length - 1] ?? 'unknown')
  );
}

function describeEdge(edge: CompiledRenderGraphEdge): string {
  if (edge.kind === 'semantic') return 'SEMANTIC';
  return `${edge.kind.toUpperCase()} resource ${edge.resourceId} v${edge.version}`;
}
