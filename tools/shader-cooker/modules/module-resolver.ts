/**
 * @file Canonical URI resolution, dependency closure traversal, cycle detection,
 * and immutable source snapshot generation for shader modules.
 * Based on engine/design/v2/04-rendering/14-shader-modules.md.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { loadWgslMetadata } from '../metadata-loader';
import {
  createShaderModuleId,
  ShaderModuleResolutionError,
  type DependencyClosure,
  type ModuleSourceSnapshot,
  type ShaderModuleId,
  type ShaderModuleLoader,
  type ShaderModuleSource
} from './types';

const FORBIDDEN_URI_CHARACTERS = /[\x00-\x1F\x7F\\?#%]/u;

/**
 * Normalizes a canonical shader module URI (`asset://authority/path` or `package://authority/path`).
 * Resolves `.` and `..` strictly within the path without escaping the authority root.
 *
 * @param uri Raw URI candidate.
 * @returns Canonical branded ShaderModuleId.
 * @throws {ShaderModuleResolutionError} When URI contains forbidden characters or traverses above authority root.
 */
export function normalizeShaderModuleId(uri: string): ShaderModuleId {
  if (typeof uri !== 'string' || !uri.trim()) {
    throw new ShaderModuleResolutionError(
      'Shader module URI must be a non-empty string.',
      'ERR_INVALID_MODULE_URI'
    );
  }

  const trimmed = uri.trim();

  if (FORBIDDEN_URI_CHARACTERS.test(trimmed)) {
    throw new ShaderModuleResolutionError(
      `Shader module URI contains forbidden characters (backslashes, query, fragment, percent-encoding, or control chars): "${trimmed}"`,
      'ERR_INVALID_MODULE_URI'
    );
  }

  const match = trimmed.match(/^(asset|package):\/\/([^/\s]+)(\/.*)?$/);
  if (!match || !match[1] || !match[2]) {
    throw new ShaderModuleResolutionError(
      `Shader module URI must start with 'asset://' or 'package://' with a valid authority: "${trimmed}"`,
      'ERR_INVALID_MODULE_URI'
    );
  }

  const scheme = match[1];
  const authority = match[2];
  const rawPath = match[3] ?? '';

  if (authority === '.' || authority === '..') {
    throw new ShaderModuleResolutionError(
      `Invalid authority name in module URI: "${authority}"`,
      'ERR_INVALID_MODULE_URI'
    );
  }

  const rawSegments = rawPath.split('/');
  const normalizedSegments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (normalizedSegments.length === 0) {
        throw new ShaderModuleResolutionError(
          `Resolving module URI "${trimmed}" traverses above authority root "${scheme}://${authority}".`,
          'ERR_AUTHORITY_ESCAPE'
        );
      }
      normalizedSegments.pop();
    } else {
      normalizedSegments.push(seg);
    }
  }

  if (normalizedSegments.length === 0) {
    throw new ShaderModuleResolutionError(
      `Shader module URI path cannot be empty: "${trimmed}"`,
      'ERR_EMPTY_MODULE_PATH'
    );
  }

  return createShaderModuleId(`${scheme}://${authority}/${normalizedSegments.join('/')}`);
}

/**
 * Resolves an import specifier relative to the importing module's URI.
 * Handles `asset://` and `package://` absolute URIs as well as relative `./` and `../` paths.
 * Rejects bare specifiers and aliases.
 *
 * @param specifier Raw import specifier as declared in metadata.
 * @param baseModuleId Optional canonical ID of importing module (required for relative specifiers).
 * @returns Canonical branded ShaderModuleId.
 */
export function resolveShaderModuleSpecifier(
  specifier: string,
  baseModuleId?: ShaderModuleId
): ShaderModuleId {
  if (typeof specifier !== 'string' || !specifier.trim()) {
    throw new ShaderModuleResolutionError(
      'Import specifier must be a non-empty string.',
      'ERR_INVALID_SPECIFIER'
    );
  }

  const trimmed = specifier.trim();

  if (FORBIDDEN_URI_CHARACTERS.test(trimmed)) {
    throw new ShaderModuleResolutionError(
      `Import specifier contains forbidden characters (backslashes, query, fragment, percent-encoding, or control chars): "${trimmed}"`,
      'ERR_INVALID_SPECIFIER',
      baseModuleId
    );
  }

  if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
    if (!baseModuleId) {
      throw new ShaderModuleResolutionError(
        `Relative specifier "${trimmed}" requires a base module ID for resolution.`,
        'ERR_RELATIVE_SPECIFIER_NO_BASE'
      );
    }

    const baseUri = baseModuleId as string;
    const schemeMatch = baseUri.match(/^(asset|package):\/\/([^/\s]+)(\/.*)?$/);
    if (!schemeMatch || !schemeMatch[1] || !schemeMatch[2]) {
      throw new ShaderModuleResolutionError(
        `Base module ID "${baseUri}" is not a canonical URI.`,
        'ERR_INVALID_BASE_URI',
        baseModuleId
      );
    }

    const scheme = schemeMatch[1];
    const authority = schemeMatch[2];
    const basePath = schemeMatch[3] ?? '';
    const lastSlash = basePath.lastIndexOf('/');
    const baseDir = lastSlash > 0 ? basePath.slice(0, lastSlash) : '';

    const combined = `${scheme}://${authority}${baseDir}/${trimmed}`;
    return normalizeShaderModuleId(combined);
  }

  if (trimmed.startsWith('asset://') || trimmed.startsWith('package://')) {
    return normalizeShaderModuleId(trimmed);
  }

  throw new ShaderModuleResolutionError(
    `Bare import specifier "${trimmed}" is not allowed. Imports must be explicit canonical URIs ('asset://', 'package://') or relative paths ('./', '../').`,
    'ERR_BARE_SPECIFIER',
    baseModuleId
  );
}

/**
 * Options for configuring FileSystemShaderModuleLoader.
 */
export interface FileSystemShaderModuleLoaderOptions {
  readonly roots?: Readonly<Record<string, string>> | undefined;
  readonly projectRoot?: string | undefined;
  readonly fileOverrides?: Readonly<Record<string, string>> | undefined;
  readonly moduleOverrides?: Readonly<Record<string, ShaderModuleSource>> | undefined;
}

/**
 * Node-only file system shader module loader that maps canonical URIs to disk files,
 * validates directory containment, and loads `.wgsl.meta.json` sidecar files.
 */
export class FileSystemShaderModuleLoader implements ShaderModuleLoader {
  private readonly roots: Readonly<Record<string, string>>;
  private readonly projectRoot: string;
  private readonly fileOverrides: Readonly<Record<string, string>>;
  private readonly moduleOverrides: Readonly<Record<string, ShaderModuleSource>>;
  private readonly loadedFiles = new Set<string>();

  constructor(options: FileSystemShaderModuleLoaderOptions = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.roots = options.roots ?? {};
    this.fileOverrides = options.fileOverrides ?? {};
    this.moduleOverrides = options.moduleOverrides ?? {};
  }

  /**
   * Returns all file system paths loaded by this loader (including `.wgsl` and `.meta.json`).
   */
  public getLoadedFilePaths(): readonly string[] {
    return Object.freeze([...this.loadedFiles]);
  }

  public async loadModule(id: ShaderModuleId): Promise<ShaderModuleSource | undefined> {
    const canonicalId = normalizeShaderModuleId(id);

    // Check if an explicit module source override is provided (e.g. root module with caller metadata)
    const overriddenModule = this.moduleOverrides[canonicalId as string];
    if (overriddenModule) {
      return overriddenModule;
    }

    // Check if an explicit file override is registered for this module ID
    const overriddenPath = this.fileOverrides[canonicalId as string];
    let filePath: string;
    let baseDir: string;

    if (overriddenPath) {
      filePath = resolve(this.projectRoot, overriddenPath);
      baseDir = this.projectRoot;
    } else {
      const parsed = (canonicalId as string).match(/^(asset|package):\/\/([^/\s]+)\/(.+)$/);
      if (!parsed || !parsed[2] || !parsed[3]) {
        return undefined;
      }

      const authority = parsed[2];
      const moduleSubPath = parsed[3];

      let mappedDir = this.roots[authority];
      if (!mappedDir) {
        if (authority === 'aether') {
          mappedDir = resolve(this.projectRoot, 'src/shader');
        } else if (authority === 'test') {
          mappedDir = resolve(this.projectRoot, 'test/tooling/shader-modules/fixtures');
        } else {
          mappedDir = resolve(this.projectRoot, authority);
        }
      }

      filePath = resolve(mappedDir, moduleSubPath);
      baseDir = mappedDir;
    }

    const rel = relative(baseDir, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new ShaderModuleResolutionError(
        `Shader module "${canonicalId}" resolves to path "${filePath}" outside allowed base directory "${baseDir}".`,
        'ERR_PATH_ESCAPE',
        canonicalId
      );
    }

    if (!existsSync(filePath)) {
      return undefined;
    }

    this.loadedFiles.add(filePath);
    const source = await readFile(filePath, 'utf8');

    // Look for sidecar metadata
    let metaPath: string | undefined;
    const sidecarMeta = `${filePath}.meta.json`;
    const shaderJson = filePath.replace(/\.wgsl$/u, '.shader.json');

    if (existsSync(sidecarMeta)) {
      metaPath = sidecarMeta;
    } else if (shaderJson !== filePath && existsSync(shaderJson)) {
      metaPath = shaderJson;
    }

    let imports: ShaderModuleSource['imports'] = Object.freeze([]);
    if (metaPath) {
      this.loadedFiles.add(metaPath);
      const metadata = await loadWgslMetadata(metaPath);
      if (metadata.imports && metadata.imports.length > 0) {
        imports = metadata.imports;
      }
    }

    return Object.freeze({
      id: canonicalId,
      source,
      imports
    });
  }
}

/**
 * Traverses module dependencies starting from rootId, detects cycles,
 * and produces a topologically sorted DependencyClosure.
 *
 * @param rootUri Root module canonical URI or file path identifier.
 * @param loader Loader providing module sources and explicit metadata imports.
 * @returns Immutable, topologically sorted DependencyClosure.
 */
export async function resolveDependencyClosure(
  rootUri: string,
  loader: ShaderModuleLoader
): Promise<DependencyClosure> {
  const rootId = normalizeShaderModuleId(rootUri);
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
      throw new ShaderModuleResolutionError(
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

    const moduleSource = await loader.loadModule(currentId);
    if (moduleSource === undefined) {
      const referrer = activeStack.length > 1 ? activeStack[activeStack.length - 2] : undefined;
      throw new ShaderModuleResolutionError(
        `Failed to resolve shader module '${currentId}'${referrer ? ` imported by '${referrer}'` : ''}`,
        'ERR_MODULE_NOT_FOUND',
        currentId,
        referrer ? [referrer] : undefined
      );
    }

    // Check unsupported alias declarations in metadata imports
    for (const imp of moduleSource.imports) {
      if (imp.alias !== undefined) {
        throw new ShaderModuleResolutionError(
          'WGSL module import aliases are not supported by the current composition profile.',
          'ERR_IMPORT_ALIAS_UNSUPPORTED',
          currentId
        );
      }
    }

    const resolvedDepIds: ShaderModuleId[] = [];
    for (const imp of moduleSource.imports) {
      const resolvedDepId = resolveShaderModuleSpecifier(imp.path, currentId);
      resolvedDepIds.push(resolvedDepId);

      let rd = reverseDependencies.get(resolvedDepId);
      if (!rd) {
        rd = new Set<ShaderModuleId>();
        reverseDependencies.set(resolvedDepId, rd);
      }
      rd.add(currentId);

      await visit(resolvedDepId);
    }

    activeStack.pop();
    visited.add(currentId);

    const contentHash = createHash('sha256').update(moduleSource.source).digest('hex');
    const snapshot: ModuleSourceSnapshot = Object.freeze({
      id: currentId,
      content: moduleSource.source,
      contentHash,
      imports: moduleSource.imports,
      dependencies: Object.freeze(resolvedDepIds)
    });

    snapshots.set(currentId, snapshot);
    topologicalOrder.push(snapshot);
  }

  await visit(rootId);

  // Compute composite hash including module IDs, contents, and ordered resolved dependency edges
  const compositeHasher = createHash('sha256');
  for (const m of topologicalOrder) {
    compositeHasher
      .update(m.id)
      .update('\n')
      .update(m.contentHash)
      .update('\n')
      .update(m.dependencies.join(','))
      .update('\n;\n');
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
