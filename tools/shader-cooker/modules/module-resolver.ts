/**
 * @file Canonical URI resolution, dependency closure traversal, cycle detection,
 * and immutable source snapshot generation for shader modules.
 */

import { createHash } from 'node:crypto';
import {
  createShaderModuleId,
  type DependencyClosure,
  type ModuleImportDeclaration,
  type ModuleSourceLoader,
  type ModuleSourceSnapshot,
  type ShaderModuleId
} from './types';

export class ModuleResolutionError extends Error {
  readonly code: string;
  readonly moduleId: ShaderModuleId;
  readonly relatedModuleIds?: readonly ShaderModuleId[] | undefined;

  constructor(
    message: string,
    code: string,
    moduleId: ShaderModuleId,
    relatedModuleIds?: readonly ShaderModuleId[]
  ) {
    super(message);
    this.name = 'ModuleResolutionError';
    this.code = code;
    this.moduleId = moduleId;
    this.relatedModuleIds = relatedModuleIds;
  }
}

/**
 * Resolves an import specifier relative to the importing module's URI.
 * Handles `asset://` URIs as well as relative `./` and `../` paths.
 */
export function resolveModuleSpecifier(
  specifier: string,
  importingModuleId: ShaderModuleId
): ShaderModuleId {
  const trimmed = specifier.trim();
  if (trimmed.startsWith('asset://')) {
    return createShaderModuleId(normalizeUriPath(trimmed));
  }

  // Relative path resolution
  const importingUri = importingModuleId as string;
  const lastSlash = importingUri.lastIndexOf('/');
  if (lastSlash === -1) {
    return createShaderModuleId(trimmed);
  }

  const baseDir = importingUri.slice(0, lastSlash);
  const combined = `${baseDir}/${trimmed}`;
  return createShaderModuleId(normalizeUriPath(combined));
}

function normalizeUriPath(uri: string): string {
  const schemeMatch = uri.match(/^([a-z0-9+.-]+:\/\/)(.*)$/i);
  let scheme = '';
  let path = uri;
  const isAbsolute = uri.startsWith('/');

  if (schemeMatch && schemeMatch[1] && schemeMatch[2] !== undefined) {
    scheme = schemeMatch[1];
    path = schemeMatch[2];
  }

  const parts = path.split('/');
  const normalizedParts: string[] = [];

  for (const part of parts) {
    if (part === '.' || part === '') {
      continue;
    }
    if (part === '..') {
      if (normalizedParts.length > 0 && normalizedParts[normalizedParts.length - 1] !== '..') {
        normalizedParts.pop();
      } else {
        normalizedParts.push('..');
      }
    } else {
      normalizedParts.push(part);
    }
  }

  const normalizedPath = (isAbsolute && !scheme ? '/' : '') + normalizedParts.join('/');
  return scheme + normalizedPath;
}

/**
 * Parses raw module content to extract import statements and module-level directives.
 * Supported syntax:
 *   #import "specifier"
 *   #import <specifier>
 *   import "specifier";
 * Directives:
 *   enable ...;
 *   diagnostic(...);
 */
export function parseModuleDeclarations(
  content: string,
  moduleId: ShaderModuleId
): {
  readonly imports: readonly ModuleImportDeclaration[];
  readonly directives: readonly string[];
} {
  const lines = content.split('\n');
  const imports: ModuleImportDeclaration[] = [];
  const directives: string[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx]!;
    const trimmed = rawLine.trim();

    // Skip empty lines or full line comments
    if (!trimmed || trimmed.startsWith('//')) {
      continue;
    }

    // Match import declarations:
    // #import "./foo.wgsl"
    // #import <asset://aether/bar.wgsl>
    // import "./foo.wgsl";
    const importMatch =
      trimmed.match(/^#import\s+["<]([^">]+)[">]/) ||
      trimmed.match(/^import\s+["']([^"']+)["']\s*;/);

    if (importMatch && importMatch[1]) {
      const rawSpecifier = importMatch[1];
      const resolvedId = resolveModuleSpecifier(rawSpecifier, moduleId);
      const col = rawLine.indexOf(rawSpecifier);
      imports.push({
        rawSpecifier,
        resolvedId,
        span: {
          line: lineIdx + 1,
          column: col >= 0 ? col + 1 : 1,
          length: rawSpecifier.length
        }
      });
      continue;
    }

    // Directives
    if (trimmed.startsWith('enable ') || trimmed.startsWith('diagnostic(')) {
      if (trimmed.endsWith(';')) {
        directives.push(trimmed);
      }
    }
  }

  return { imports: Object.freeze(imports), directives: Object.freeze(directives) };
}

/**
 * Traverses module dependencies starting from rootId, detects cycles,
 * and produces a topologically sorted DependencyClosure.
 */
export async function resolveDependencyClosure(
  rootUri: string,
  loader: ModuleSourceLoader
): Promise<DependencyClosure> {
  const rootId = createShaderModuleId(rootUri);
  const snapshots = new Map<ShaderModuleId, ModuleSourceSnapshot>();
  const reverseDependencies = new Map<ShaderModuleId, Set<ShaderModuleId>>();

  // Active stack for cycle detection
  const activeStack: ShaderModuleId[] = [];
  const visited = new Set<ShaderModuleId>();
  const topologicalOrder: ModuleSourceSnapshot[] = [];

  async function visit(currentId: ShaderModuleId): Promise<void> {
    const cycleIndex = activeStack.indexOf(currentId);
    if (cycleIndex !== -1) {
      const cyclePath = [...activeStack.slice(cycleIndex), currentId];
      throw new ModuleResolutionError(
        `Cyclic module dependency detected: ${cyclePath.join(' -> ')}`,
        'ERR_MODULE_CYCLE',
        currentId,
        cyclePath
      );
    }

    if (visited.has(currentId)) {
      return;
    }

    activeStack.push(currentId);

    // Load source
    const rawContent = await loader.loadSource(currentId);
    if (rawContent === undefined) {
      const referrer = activeStack.length > 1 ? activeStack[activeStack.length - 2] : undefined;
      throw new ModuleResolutionError(
        `Failed to resolve shader module '${currentId}'${referrer ? ` imported by '${referrer}'` : ''}`,
        'ERR_MODULE_NOT_FOUND',
        currentId,
        referrer ? [referrer] : undefined
      );
    }

    const { imports, directives } = parseModuleDeclarations(rawContent, currentId);
    const contentHash = createHash('sha256').update(rawContent).digest('hex');

    const snapshot: ModuleSourceSnapshot = Object.freeze({
      id: currentId,
      content: rawContent,
      contentHash,
      imports,
      directives
    });
    snapshots.set(currentId, snapshot);

    for (const imp of imports) {
      // Register reverse dependency: imp.resolvedId -> currentId
      let rd = reverseDependencies.get(imp.resolvedId);
      if (!rd) {
        rd = new Set<ShaderModuleId>();
        reverseDependencies.set(imp.resolvedId, rd);
      }
      rd.add(currentId);

      await visit(imp.resolvedId);
    }

    activeStack.pop();
    visited.add(currentId);
    topologicalOrder.push(snapshot);
  }

  await visit(rootId);

  // Compute composite hash
  const compositeHasher = createHash('sha256');
  for (const m of topologicalOrder) {
    compositeHasher.update(m.id).update(':').update(m.contentHash).update(';');
  }
  const compositeHash = compositeHasher.digest('hex');

  const immutableReverseDeps = new Map<ShaderModuleId, readonly ShaderModuleId[]>();
  for (const [id, set] of reverseDependencies.entries()) {
    immutableReverseDeps.set(id, Object.freeze([...set]));
  }

  return Object.freeze({
    rootId,
    modules: Object.freeze(topologicalOrder),
    reverseDependencies: Object.freeze(immutableReverseDeps),
    compositeHash
  });
}
