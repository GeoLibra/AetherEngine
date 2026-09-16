/**
 * @file Vite plugin for cooking native WGSL modules and handling HMR.
 * Watches transitive module dependencies and updates all affected roots on changes.
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin, HmrContext, ModuleNode } from 'vite';
import {
  assertValidCanonicalShaderSourceUri,
  defineShaderAuthoringSource
} from '../../src/shader/authoring';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';
import { cookAuthoredShader } from '../shader-cooker/authoring-dispatch';
import { NativeWgslCooker } from '../shader-cooker/native-wgsl-cooker';
import { FileSystemShaderModuleLoader } from '../shader-cooker/modules/module-resolver';

/**
 * Options for configuring nativeWgslPlugin.
 */
export interface NativeWgslPluginOptions {
  readonly cooker?: NativeWgslCooker | undefined;
  readonly sourceUriResolver?: ((filePath: string) => string) | undefined;
  readonly root?: string | undefined;
}

const VIRTUAL_PREFIX = '\0aether-shader-artifact:';
const QUERY_SUFFIX = '?shader-artifact';

/**
 * Creates a Vite plugin that compiles `.wgsl?shader-artifact` imports into virtual JS modules
 * exporting CookedShaderRuntimeArtifact JSON payloads.
 *
 * @param options Plugin configuration options.
 * @returns Vite Plugin instance.
 */
export function nativeWgslPlugin(options: NativeWgslPluginOptions = {}): Plugin {
  const cooker = options.cooker ?? new NativeWgslCooker();
  const rootDir = resolve(options.root ?? process.cwd());
  const lastGoodCache = new Map<string, CookedShaderRuntimeArtifact>();
  const revisions = new Map<string, number>();
  const dependencyToRoots = new Map<string, Set<string>>();

  function resolveSourceUri(filePath: string): string {
    if (options.sourceUriResolver) {
      const uri = options.sourceUriResolver(filePath);
      assertValidCanonicalShaderSourceUri(uri);
      return uri;
    }

    const absPath = resolve(filePath);
    const rel = relative(rootDir, absPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `[native-wgsl-plugin] Shader file "${filePath}" escapes root "${rootDir}". Provide a custom sourceUriResolver to map external files.`
      );
    }

    const posixRel = rel.split('\\').join('/').replace(/^\/+/u, '');
    const uri = posixRel.includes('/') ? `asset://${posixRel}` : `asset://project/${posixRel}`;
    assertValidCanonicalShaderSourceUri(uri);
    return uri;
  }

  function findMetadataPath(filePath: string): string | undefined {
    const metaJson = `${filePath}.meta.json`;
    if (existsSync(metaJson)) return metaJson;

    const shaderJson = filePath.replace(/\.wgsl$/u, '.shader.json');
    if (shaderJson !== filePath && existsSync(shaderJson)) return shaderJson;

    return undefined;
  }

  function registerDependency(depPath: string, rootFilePath: string): void {
    let set = dependencyToRoots.get(depPath);
    if (!set) {
      set = new Set<string>();
      dependencyToRoots.set(depPath, set);
    }
    set.add(rootFilePath);

    const meta = findMetadataPath(depPath);
    if (meta) {
      let metaSet = dependencyToRoots.get(meta);
      if (!metaSet) {
        metaSet = new Set<string>();
        dependencyToRoots.set(meta, metaSet);
      }
      metaSet.add(rootFilePath);
    }
  }

  return {
    name: 'aether:native-wgsl',
    enforce: 'pre',

    resolveId(id: string, importer?: string) {
      if (!id.includes(QUERY_SUFFIX) || !id.includes('.wgsl')) {
        return null;
      }

      const cleanPath = id.slice(0, id.indexOf(QUERY_SUFFIX));
      let resolvedPath: string;

      if (importer && (cleanPath.startsWith('./') || cleanPath.startsWith('../'))) {
        resolvedPath = resolve(dirname(importer), cleanPath);
      } else if (cleanPath.startsWith('/')) {
        resolvedPath = cleanPath;
      } else {
        resolvedPath = resolve(options.root ?? process.cwd(), cleanPath);
      }

      return `${VIRTUAL_PREFIX}${resolvedPath}`;
    },

    async load(id: string) {
      if (!id.startsWith(VIRTUAL_PREFIX)) {
        return null;
      }

      const filePath = id.slice(VIRTUAL_PREFIX.length);
      this.addWatchFile(filePath);

      const metadataPath = findMetadataPath(filePath);
      if (metadataPath) {
        this.addWatchFile(metadataPath);
      }

      const sourceUri = resolveSourceUri(filePath);
      const nextRev = (revisions.get(filePath) ?? 0) + 1;
      revisions.set(filePath, nextRev);

      const authoringSource = defineShaderAuthoringSource({
        kind: 'wgsl',
        uri: sourceUri
      });

      try {
        const artifact = await cookAuthoredShader(
          {
            source: authoringSource,
            sourcePath: filePath,
            ...(metadataPath !== undefined ? { metadataPath } : {})
          },
          {
            cooker,
            moduleLoader: new FileSystemShaderModuleLoader({
              roots: { project: rootDir },
              projectRoot: rootDir
            }),
            onDependencyResolved: (depPath) => {
              this.addWatchFile(depPath);
              registerDependency(depPath, filePath);
              const depMeta = findMetadataPath(depPath);
              if (depMeta) {
                this.addWatchFile(depMeta);
              }
            }
          }
        );

        // Only store if this is still the most recent revision completion
        if (revisions.get(filePath) === nextRev) {
          lastGoodCache.set(filePath, artifact);
        }

        const effectiveArtifact = lastGoodCache.get(filePath) ?? artifact;
        return `export const artifact = ${JSON.stringify(effectiveArtifact)};\nexport default artifact;\n`;
      } catch (err: unknown) {
        const cached = lastGoodCache.get(filePath);
        if (cached) {
          return `export const artifact = ${JSON.stringify(cached)};\nexport default artifact;\n`;
        }
        throw err;
      }
    },

    async handleHotUpdate(ctx: HmrContext): Promise<ModuleNode[] | void> {
      const file = ctx.file;
      let directWgslPath: string | undefined;

      if (file.endsWith('.wgsl')) {
        directWgslPath = file;
      } else if (file.endsWith('.wgsl.meta.json')) {
        directWgslPath = file.slice(0, -'.meta.json'.length);
      } else if (file.endsWith('.shader.json')) {
        const candidate = file.replace(/\.shader\.json$/u, '.wgsl');
        if (existsSync(candidate)) {
          directWgslPath = candidate;
        }
      }

      // Collect all affected root files: direct root or any root importing this file as a dependency
      const affectedRoots = new Set<string>();

      const rootsForFile = dependencyToRoots.get(file);
      if (rootsForFile) {
        for (const root of rootsForFile) {
          affectedRoots.add(root);
        }
      }
      if (directWgslPath) {
        const rootsForDirect = dependencyToRoots.get(directWgslPath);
        if (rootsForDirect) {
          for (const root of rootsForDirect) {
            affectedRoots.add(root);
          }
        }
      }

      // If no dependent roots were found, or if directWgslPath is loaded/known in Vite moduleGraph, include directWgslPath
      if (directWgslPath) {
        const virtualId = `${VIRTUAL_PREFIX}${directWgslPath}`;
        if (
          affectedRoots.size === 0 ||
          revisions.has(directWgslPath) ||
          ctx.server.moduleGraph.getModuleById(virtualId)
        ) {
          affectedRoots.add(directWgslPath);
        }
      }

      if (affectedRoots.size === 0) {
        return undefined;
      }

      const invalidatedModules: ModuleNode[] = [];

      for (const rootPath of affectedRoots) {
        const virtualId = `${VIRTUAL_PREFIX}${rootPath}`;
        let sourceUri: string;
        try {
          sourceUri = resolveSourceUri(rootPath);
        } catch (err: unknown) {
          ctx.server.config.logger.error(
            `[aether:native-wgsl] URI resolution failed for "${rootPath}": ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }

        const metadataPath = findMetadataPath(rootPath);
        const nextRev = (revisions.get(rootPath) ?? 0) + 1;
        revisions.set(rootPath, nextRev);

        const authoringSource = defineShaderAuthoringSource({
          kind: 'wgsl',
          uri: sourceUri
        });

        try {
          const artifact = await cookAuthoredShader(
            {
              source: authoringSource,
              sourcePath: rootPath,
              ...(metadataPath !== undefined ? { metadataPath } : {})
            },
            {
              cooker,
              moduleLoader: new FileSystemShaderModuleLoader({
                roots: { project: rootDir },
                projectRoot: rootDir
              }),
              onDependencyResolved: (depPath) => {
                registerDependency(depPath, rootPath);
              }
            }
          );

          if (revisions.get(rootPath) !== nextRev) continue;
          lastGoodCache.set(rootPath, artifact);

          const mod = ctx.server.moduleGraph.getModuleById(virtualId);
          if (mod) {
            ctx.server.moduleGraph.invalidateModule(mod);
            invalidatedModules.push(mod);
          }
        } catch (err: unknown) {
          if (revisions.get(rootPath) !== nextRev) continue;
          ctx.server.config.logger.error(
            `[aether:native-wgsl] HMR cook failed for "${rootPath}": ${err instanceof Error ? err.message : String(err)}`
          );
          // Retain last-known-good, do not crash Vite server
        }
      }

      return invalidatedModules;
    }
  };
}
