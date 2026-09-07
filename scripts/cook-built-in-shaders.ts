import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { format } from 'prettier';

import { defineShaderAuthoringSource } from '../src/shader/authoring';
import { cookAuthoredShader } from '../tools/shader-cooker/authoring-dispatch';
import {
  type ComposedSourceSegment,
  composeWgslFragments,
  remapCookerError
} from '../tools/shader-cooker';

export interface BuiltInShaderRecipe {
  readonly id: string;
  readonly exportName: string;
  readonly exportAliases?: readonly string[];
  readonly sourcePath?: string;
  readonly sourcePaths?: readonly string[];
  readonly composedOutputPath?: string;
  readonly metadataPath: string;
  readonly outputPath: string;
  readonly sourceUri: string;
  readonly targetBackend?: 'both' | 'webgpu' | 'webgl2';
}

const ROOT = resolve(import.meta.dirname, '..');

export const BUILT_IN_RECIPES: readonly BuiltInShaderRecipe[] = Object.freeze([
  {
    id: 'standard-lit',
    exportName: 'STANDARD_LIT_SHADER_ARTIFACT',
    exportAliases: ['STANDARD_LIT_SHADER_GENERATED_ARTIFACT'],
    sourcePath: 'src/shader/builtins/standard-lit/standard-lit.wgsl',
    metadataPath: 'src/shader/builtins/standard-lit/standard-lit.wgsl.meta.json',
    outputPath: 'src/shader/builtins/standard-lit/standard-lit.generated.ts',
    sourceUri: 'asset://aether/builtins/standard-lit.wgsl',
    targetBackend: 'both'
  },
  {
    id: 'post-color',
    exportName: 'POST_COLOR_SHADER_ARTIFACT',
    exportAliases: ['POST_COLOR_SHADER_GENERATED_ARTIFACT'],
    sourcePath: 'src/shader/builtins/post-color/post-color.wgsl',
    metadataPath: 'src/shader/builtins/post-color/post-color.wgsl.meta.json',
    outputPath: 'src/shader/builtins/post-color/post-color.generated.ts',
    sourceUri: 'asset://aether/builtins/post-color.wgsl',
    targetBackend: 'both'
  },
  {
    id: 'light-list-webgpu',
    exportName: 'LIGHT_LIST_SHADER_ARTIFACT',
    exportAliases: ['LIGHT_LIST_SHADER_GENERATED_ARTIFACT'],
    sourcePath: 'src/shader/builtins/light-list/webgpu/light-list.wgsl',
    metadataPath: 'src/shader/builtins/light-list/webgpu/light-list.wgsl.meta.json',
    outputPath: 'src/shader/builtins/light-list/webgpu/light-list.generated.ts',
    sourceUri: 'asset://aether/builtins/light-list.wgsl',
    targetBackend: 'webgpu'
  },
  {
    id: 'light-list-webgl2',
    exportName: 'LIGHT_LIST_WEBGL2_SHADER_ARTIFACT',
    exportAliases: [
      'LIGHT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT',
      'LIGHT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT',
      'LIGHT_LIST_WEBGL_SHADER_ARTIFACT'
    ],
    sourcePath: 'src/shader/builtins/light-list/webgl2/light-list.wgsl',
    metadataPath: 'src/shader/builtins/light-list/webgl2/light-list.wgsl.meta.json',
    outputPath: 'src/shader/builtins/light-list/webgl2/light-list.generated.ts',
    sourceUri: 'asset://aether/builtins/light-list-webgl.wgsl',
    targetBackend: 'webgl2'
  },
  {
    id: 'standard-lit-list-webgpu',
    exportName: 'STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT',
    exportAliases: ['STANDARD_LIT_LIST_WEBGPU_SHADER_GENERATED_ARTIFACT'],
    sourcePaths: [
      'src/shader/builtins/standard-lit-list/webgpu/light-access.wgsl',
      'src/shader/builtins/standard-lit-list/shading.wgsl'
    ],
    composedOutputPath: 'src/shader/builtins/standard-lit-list/webgpu/standard-lit-list.wgsl',
    metadataPath: 'src/shader/builtins/standard-lit-list/standard-lit-list.wgsl.meta.json',
    outputPath: 'src/shader/builtins/standard-lit-list/webgpu/standard-lit-list.generated.ts',
    sourceUri: 'asset://aether/builtins/standard-lit-list-webgpu.wgsl',
    targetBackend: 'webgpu'
  },
  {
    id: 'standard-lit-list-webgl2',
    exportName: 'STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT',
    exportAliases: [
      'STANDARD_LIT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT',
      'STANDARD_LIT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT',
      'STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT'
    ],
    sourcePaths: [
      'src/shader/builtins/standard-lit-list/webgl2/light-access.wgsl',
      'src/shader/builtins/standard-lit-list/shading.wgsl'
    ],
    composedOutputPath: 'src/shader/builtins/standard-lit-list/webgl2/standard-lit-list.wgsl',
    metadataPath: 'src/shader/builtins/standard-lit-list/standard-lit-list.wgsl.meta.json',
    outputPath: 'src/shader/builtins/standard-lit-list/webgl2/standard-lit-list.generated.ts',
    sourceUri: 'asset://aether/builtins/standard-lit-list-webgl.wgsl',
    targetBackend: 'webgl2'
  }
]);

function escapeTemplateLiteral(source: string): string {
  return source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function formatArtifactSource(
  artifact: Awaited<ReturnType<typeof cookAuthoredShader>>,
  targetBackend: 'both' | 'webgpu' | 'webgl2' = 'both'
): string {
  const { modules, ...rawMetadata } = artifact;
  const metadata = {
    ...rawMetadata,
    ...(targetBackend === 'both' ? {} : { targetBackend })
  };
  const metadataJson = JSON.stringify(metadata, null, 2);
  const metadataBody = metadataJson.slice(0, metadataJson.lastIndexOf('}')).trimEnd();

  const emitGlsl = targetBackend !== 'webgpu';
  const emitFullWgsl = targetBackend !== 'webgl2';

  const glslEntries = emitGlsl
    ? Object.entries(modules.glslEs300)
        .map(([key, mod]) => {
          const bindingsJson = JSON.stringify(mod.bindings, null, 2);
          return `      ${JSON.stringify(key)}: {
        source: \`${escapeTemplateLiteral(mod.source)}\`,
        bindings: ${bindingsJson}
      }`;
        })
        .join(',\n')
    : '';

  const wgslSource = emitFullWgsl
    ? escapeTemplateLiteral(modules.wgsl)
    : `/* ${artifact.source.sourceUri} (webgl2-only target) */`;

  const glslBody = glslEntries ? `\n${glslEntries}\n    ` : '';

  return `${metadataBody},
  modules: {
    wgsl: \`${wgslSource}\`,
    glslEs300: {${glslBody}}
  }
}`;
}

const isCheckMode = process.argv.includes('--check');
const tempDir = await mkdtemp(join(tmpdir(), 'aether-shader-cook-'));

try {
  for (const builtIn of BUILT_IN_RECIPES) {
    let sourcePath: string;
    let segments: readonly ComposedSourceSegment[] | undefined;

    if (builtIn.sourcePaths && builtIn.sourcePaths.length > 0) {
      const fragments = await Promise.all(
        builtIn.sourcePaths.map(async (p) => ({
          path: p,
          content: await readFile(resolve(ROOT, p), 'utf8')
        }))
      );
      const composed = composeWgslFragments(fragments);
      segments = composed.segments;

      if (builtIn.composedOutputPath) {
        const composedOutFullPath = resolve(ROOT, builtIn.composedOutputPath);
        if (isCheckMode) {
          const publishedWgsl = await readFile(composedOutFullPath, 'utf8').catch(() => '');
          if (publishedWgsl !== composed.composedSource) {
            throw new Error(
              `Built-in composed shader source is stale: "${builtIn.composedOutputPath}". Run "pnpm run shader:generate".`
            );
          }
        } else {
          await mkdir(dirname(composedOutFullPath), { recursive: true });
          await writeFile(composedOutFullPath, composed.composedSource, 'utf8');
        }
      }

      sourcePath = resolve(tempDir, `${builtIn.id}.wgsl`);
      await writeFile(sourcePath, composed.composedSource, 'utf8');
    } else if (builtIn.sourcePath) {
      sourcePath = resolve(ROOT, builtIn.sourcePath);
    } else {
      throw new Error(
        `Built-in shader recipe "${builtIn.id}" must specify sourcePath or sourcePaths.`
      );
    }

    const metadataPath = resolve(ROOT, builtIn.metadataPath);
    const outputPath = resolve(ROOT, builtIn.outputPath);

    let artifact: Awaited<ReturnType<typeof cookAuthoredShader>>;
    try {
      artifact = await cookAuthoredShader({
        source: defineShaderAuthoringSource({
          kind: 'wgsl',
          uri: builtIn.sourceUri,
          languageVersion: 'wgsl-1'
        }),
        sourcePath,
        metadataPath
      });
    } catch (cookError: unknown) {
      if (segments) {
        throw remapCookerError(cookError, segments);
      }
      throw cookError;
    }

    const relativeArtifactPath = relative(
      dirname(outputPath),
      resolve(ROOT, 'src/shader/artifact')
    ).replace(/\\/g, '/');

    const aliasLines = (builtIn.exportAliases ?? [])
      .map((alias) => `export const ${alias} = ${builtIn.exportName};\n`)
      .join('');

    const targetBackend = builtIn.targetBackend ?? 'both';
    const generated = await format(
      `/* This file is generated by scripts/cook-built-in-shaders.ts. Do not edit. */
import { decodeCookedShaderRuntimeArtifact } from '${relativeArtifactPath}';

export const ${builtIn.exportName} =
  decodeCookedShaderRuntimeArtifact(${formatArtifactSource(artifact, targetBackend)});
${aliasLines}`,
      {
        parser: 'typescript',
        singleQuote: true,
        trailingComma: 'none',
        semi: true,
        printWidth: 100
      }
    );

    if (isCheckMode) {
      const published = await readFile(outputPath, 'utf8').catch(() => '');
      if (published !== generated) {
        throw new Error(
          `Built-in shader artifact is stale: "${builtIn.outputPath}". Run "pnpm run shader:generate".`
        );
      }
    } else {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, generated, 'utf8');
    }
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
