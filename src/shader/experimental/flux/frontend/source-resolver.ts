import { stableHash } from '../../../../core';
import type {
  ResolvedShaderSource,
  ShaderIncludeReference,
  ShaderSourceModule,
  ShaderSourceRef,
  ShaderSourceResolver,
  SourceSpan
} from '../../../types';

const ASSET_SCHEME = 'asset://';
const INCLUDE_PATTERN = /@(?:include|import)\s+"([^"]+)"\s*;/g;

export class InMemoryShaderSourceResolver implements ShaderSourceResolver {
  private readonly sources: ReadonlyMap<string, string>;
  constructor(sources: Readonly<Record<string, string>>) {
    this.sources = new Map(
      Object.entries(sources).map(([uri, content]) => [normalizeAssetUri(uri), content])
    );
  }
  async load(uri: string): Promise<string> {
    const normalized = normalizeAssetUri(uri);
    const content = this.sources.get(normalized);
    if (content === undefined) throw new Error(`Shader source not found: ${normalized}`);
    return content;
  }
}

export function normalizeAssetUri(uri: string, from?: string): string {
  let candidate: URL;
  try {
    if (uri.startsWith(ASSET_SCHEME)) candidate = new URL(uri);
    else {
      if (!from?.startsWith(ASSET_SCHEME)) throw new Error('relative URI has no asset base');
      candidate = new URL(uri, from);
    }
  } catch {
    throw new Error(`Shader include must use a normalized asset URI, received "${uri}".`);
  }
  if (candidate.protocol !== 'asset:')
    throw new Error(`Shader include must use an asset URI, received "${uri}".`);
  const segments: string[] = [];
  for (const segment of candidate.pathname.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `asset://${candidate.host}/${segments.join('/')}`;
}

export async function resolveShaderSource(
  root: ShaderSourceRef,
  resolver: ShaderSourceResolver
): Promise<ResolvedShaderSource> {
  const rootUri = normalizeAssetUri(root.uri);
  const modules = new Map<string, ShaderSourceModule>();
  const visited = new Set<string>();
  const references: ShaderIncludeReference[] = [];
  const stack: string[] = [];
  const visit = async (uri: string): Promise<void> => {
    const cycleIndex = stack.indexOf(uri);
    if (cycleIndex >= 0)
      throw new Error(`Shader include cycle: ${[...stack.slice(cycleIndex), uri].join(' -> ')}`);
    if (visited.has(uri)) return;
    visited.add(uri);
    stack.push(uri);
    const content = await resolver.load(uri);
    const module = Object.freeze({ uri, content, contentHash: stableHash(content) });
    if (!modules.has(module.contentHash)) modules.set(module.contentHash, module);
    INCLUDE_PATTERN.lastIndex = 0;
    const includes = [...content.matchAll(INCLUDE_PATTERN)];
    for (const match of includes) {
      const target = normalizeAssetUri(match[1]!, uri);
      const span = spanAt(uri, content, match.index, match[0].length);
      references.push(Object.freeze({ from: uri, to: target, span }));
      await visit(target);
    }
    stack.pop();
  };
  await visit(rootUri);
  const ordered = [...modules.values()].sort((a, b) => a.uri.localeCompare(b.uri));
  return Object.freeze({
    root: Object.freeze({ ...root, uri: rootUri }),
    modules: Object.freeze(ordered),
    references: Object.freeze(references),
    hash: stableHash({
      languageVersion: root.languageVersion,
      modules: ordered.map(({ uri, contentHash }) => ({ uri, contentHash }))
    })
  });
}

export function spanAt(uri: string, content: string, offset: number, length: number): SourceSpan {
  const prefix = content.slice(0, offset);
  const lines = prefix.split('\n');
  return Object.freeze({
    uri,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
    length
  });
}
