/**
 * @file Vite plugin for cooking native WGSL modules and handling HMR.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Plugin, HmrContext, ModuleNode } from 'vite';
import { NativeWgslCooker } from '../shader-cooker/native-wgsl-cooker';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';

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
  const lastGoodCache = new Map<string, CookedShaderRuntimeArtifact>();
  const revisions = new Map<string, number>();

  function resolveSourceUri(filePath: string): string {
    if (options.sourceUriResolver) {
      return options.sourceUriResolver(filePath);
    }
    return `asset://shaders/${basename(filePath)}`;
  }

  function findMetadataPath(filePath: string): string | undefined {
    const metaJson = `${filePath}.meta.json`;
    if (existsSync(metaJson)) return metaJson;

    const shaderJson = filePath.replace(/\.wgsl$/u, '.shader.json');
    if (shaderJson !== filePath && existsSync(shaderJson)) return shaderJson;

    return undefined;
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

      try {
        const artifact = await cooker.cook({
          sourcePath: filePath,
          sourceUri,
          ...(metadataPath !== undefined ? { metadataPath } : {})
        });

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
      let wgslFilePath: string | undefined;

      if (file.endsWith('.wgsl')) {
        wgslFilePath = file;
      } else if (file.endsWith('.wgsl.meta.json')) {
        wgslFilePath = file.slice(0, -'.meta.json'.length);
      } else if (file.endsWith('.shader.json')) {
        const candidate = file.replace(/\.shader\.json$/u, '.wgsl');
        if (existsSync(candidate)) {
          wgslFilePath = candidate;
        }
      }

      if (!wgslFilePath) {
        return undefined;
      }

      const virtualId = `${VIRTUAL_PREFIX}${wgslFilePath}`;
      const sourceUri = resolveSourceUri(wgslFilePath);
      const metadataPath = findMetadataPath(wgslFilePath);
      const nextRev = (revisions.get(wgslFilePath) ?? 0) + 1;
      revisions.set(wgslFilePath, nextRev);

      try {
        const artifact = await cooker.cook({
          sourcePath: wgslFilePath,
          sourceUri,
          ...(metadataPath !== undefined ? { metadataPath } : {})
        });

        if (revisions.get(wgslFilePath) === nextRev) {
          lastGoodCache.set(wgslFilePath, artifact);
        }

        const mod = ctx.server.moduleGraph.getModuleById(virtualId);
        if (mod) {
          ctx.server.moduleGraph.invalidateModule(mod);
          return [mod];
        }
        return [];
      } catch (err: unknown) {
        ctx.server.config.logger.error(
          `[aether:native-wgsl] HMR cook failed for "${wgslFilePath}": ${err instanceof Error ? err.message : String(err)}`
        );
        // Retain last-known-good, do not crash Vite server
        return [];
      }
    }
  };
}
