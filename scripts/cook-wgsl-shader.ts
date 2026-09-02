/**
 * @file CLI script to cook WGSL shader into deterministic JSON artifact.
 *
 * Usage:
 *   vite-node --script scripts/cook-wgsl-shader.ts -- <file.wgsl> [--source-uri <uri>] [--metadata <file>] [--output <file>]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  assertValidCanonicalShaderSourceUri,
  defineShaderAuthoringSource
} from '../src/shader/authoring';
import { cookAuthoredShader } from '../tools/shader-cooker/authoring-dispatch';

interface CookCliArgs {
  readonly inputPath: string;
  readonly sourceUri: string;
  readonly metadataPath?: string | undefined;
  readonly outputPath?: string | undefined;
  readonly diagnoseLayout?: boolean | undefined;
}

function parseCliArgs(argv: readonly string[]): CookCliArgs {
  let inputPath = '';
  let sourceUri = '';
  let metadataPath: string | undefined;
  let outputPath: string | undefined;
  let diagnoseLayout = false;

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
    } else if (arg === '--diagnose-layout' || arg === '--layout-diagnostics') {
      diagnoseLayout = true;
    } else if (arg === '--input' && i + 1 < argv.length) {
      inputPath = argv[++i]!;
    } else if (!arg.startsWith('-') && !inputPath) {
      inputPath = arg;
    }
  }

  if (!inputPath) {
    throw new Error(
      'Missing required input shader file.\nUsage: vite-node --script scripts/cook-wgsl-shader.ts -- <file.wgsl> [--source-uri <uri>] [--metadata <meta>] [--output <file>] [--diagnose-layout]'
    );
  }

  const resolvedInput = resolve(process.cwd(), inputPath);
  if (!existsSync(resolvedInput)) {
    throw new Error(`Input shader file not found at: ${resolvedInput}`);
  }

  if (!resolvedInput.endsWith('.wgsl')) {
    throw new Error(
      `[cook-wgsl-shader] Input shader file must have a .wgsl extension, received: "${inputPath}".`
    );
  }

  const resolvedUri = sourceUri || `asset://shaders/${basename(inputPath)}`;
  assertValidCanonicalShaderSourceUri(resolvedUri);

  return {
    inputPath: resolvedInput,
    sourceUri: resolvedUri,
    metadataPath: metadataPath ? resolve(process.cwd(), metadataPath) : undefined,
    outputPath: outputPath ? resolve(process.cwd(), outputPath) : undefined,
    diagnoseLayout
  };
}

export async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  const source = defineShaderAuthoringSource({
    kind: 'wgsl',
    uri: args.sourceUri
  });

  const artifact = await cookAuthoredShader(
    {
      source,
      sourcePath: args.inputPath,
      ...(args.metadataPath !== undefined ? { metadataPath: args.metadataPath } : {})
    },
    {
      diagnoseLayout: args.diagnoseLayout
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
