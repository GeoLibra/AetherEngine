/**
 * @file CLI script to cook WGSL or experimental FluxSL shader into deterministic JSON artifact.
 *
 * Usage:
 *   vite-node --script scripts/cook-wgsl-shader.ts -- <file> [--source-uri <uri>] [--metadata <file>] [--output <file>] [--allow-experimental-flux]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { defineShaderAuthoringSource } from '../src/shader/authoring';
import { cookAuthoredShader } from '../tools/shader-cooker/authoring-dispatch';
import type { ShaderSourceKind } from '../src/shader/types';

interface CookCliArgs {
  readonly inputPath: string;
  readonly sourceUri: string;
  readonly metadataPath?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly allowExperimentalFlux: boolean;
}

function parseCliArgs(argv: readonly string[]): CookCliArgs {
  let inputPath = '';
  let sourceUri = '';
  let metadataPath: string | undefined;
  let outputPath: string | undefined;
  let allowExperimentalFlux = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--source-uri' && i + 1 < argv.length) {
      sourceUri = argv[++i]!;
    } else if (arg === '--metadata' && i + 1 < argv.length) {
      metadataPath = argv[++i]!;
    } else if (arg === '--output' || arg === '-o') {
      if (i + 1 < argv.length) {
        outputPath = argv[++i]!;
      }
    } else if (arg === '--allow-experimental-flux') {
      allowExperimentalFlux = true;
    } else if (arg === '--input' && i + 1 < argv.length) {
      inputPath = argv[++i]!;
    } else if (!arg.startsWith('-') && !inputPath) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    throw new Error(
      'Missing required input shader file.\nUsage: vite-node --script scripts/cook-wgsl-shader.ts -- <file> [--source-uri <uri>] [--metadata <meta>] [--output <file>]'
    );
  }

  const resolvedInput = resolve(process.cwd(), inputPath);
  if (!existsSync(resolvedInput)) {
    throw new Error(`Input shader file not found at: ${resolvedInput}`);
  }

  const resolvedUri = sourceUri || `asset://shaders/${basename(inputPath)}`;

  return {
    inputPath: resolvedInput,
    sourceUri: resolvedUri,
    metadataPath: metadataPath ? resolve(process.cwd(), metadataPath) : undefined,
    outputPath: outputPath ? resolve(process.cwd(), outputPath) : undefined,
    allowExperimentalFlux
  };
}

export async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const isFlux = args.inputPath.endsWith('.flux');
  const kind: ShaderSourceKind = isFlux ? 'flux-experimental' : 'wgsl';

  const source = defineShaderAuthoringSource({
    kind,
    uri: args.sourceUri
  });

  const artifact = await cookAuthoredShader(
    {
      source,
      sourcePath: args.inputPath,
      ...(args.metadataPath !== undefined ? { metadataPath: args.metadataPath } : {})
    },
    {
      ...(args.allowExperimentalFlux ? { allowExperimentalFlux: true } : {})
    }
  );

  const json = JSON.stringify(artifact, null, 2);

  if (args.outputPath) {
    writeFileSync(args.outputPath, json, 'utf8');
    console.log(`Successfully cooked shader artifact to: ${args.outputPath}`);
  } else {
    process.stdout.write(json + '\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`Shader cook failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
