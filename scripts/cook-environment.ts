/**
 * @file CLI script to cook an HDR panorama into deterministic EnvironmentArtifact@1 manifests and RGBA16F binary blobs.
 *
 * Usage:
 *   vite-node --script scripts/cook-environment.ts [--input <path.hdr>] [--outDir <dir>] [--samples <number>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cookEnvironmentPanorama,
  parseRadianceRgbe,
  serializeBrdfLutManifest,
  serializeEnvironmentManifest,
  type EnvironmentCookRecipe
} from '../tools/asset-cook/environment';

interface CookCliArgs {
  readonly inputPath: string;
  readonly outDir: string;
  readonly samples: number;
}

function parseCliArgs(argv: readonly string[]): CookCliArgs {
  let inputPath = resolve(process.cwd(), 'assets/environments/venice_sunset_1k.hdr');
  let outDir = resolve(
    process.cwd(),
    'examples/react-vite-ts/public/assets/environment/venice_sunset'
  );
  let samples = 256;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--input' && i + 1 < argv.length) {
      inputPath = resolve(process.cwd(), argv[++i]!);
    } else if (arg === '--outDir' && i + 1 < argv.length) {
      outDir = resolve(process.cwd(), argv[++i]!);
    } else if (arg === '--samples' && i + 1 < argv.length) {
      samples = Math.max(16, parseInt(argv[++i]!, 10));
    }
  }

  return { inputPath, outDir, samples };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));

  if (!existsSync(args.inputPath)) {
    console.error(`❌ Input HDR file not found: ${args.inputPath}`);
    process.exit(1);
  }

  console.log(`🌅 Cooking Environment HDR: ${args.inputPath}`);
  const startTime = Date.now();

  const fileBytes = new Uint8Array(readFileSync(args.inputPath));
  console.log(`   Source size: ${(fileBytes.byteLength / (1024 * 1024)).toFixed(2)} MiB`);

  const t0 = Date.now();
  const canonicalHdr = parseRadianceRgbe(fileBytes);
  console.log(
    `   Parsed ${canonicalHdr.width}x${canonicalHdr.height} in ${Date.now() - t0} ms (format: ${canonicalHdr.metadata.format})`
  );

  const recipe: EnvironmentCookRecipe = {
    recipeName: `custom-s${args.samples}`,
    irradianceSize: [32, 16],
    irradianceSamples: args.samples,
    radianceBaseSize: [128, 64],
    radianceSamples: args.samples,
    lutSize: 128,
    lutSamples: Math.min(args.samples * 2, 1024)
  };

  console.log(
    `   Convolving with recipe (irradiance 32x16, radiance base 128x64, lut 128x128, samples=${args.samples})...`
  );

  const t1 = Date.now();
  const result = cookEnvironmentPanorama(canonicalHdr, recipe);
  console.log(`   Convolution completed in ${Date.now() - t1} ms`);

  mkdirSync(args.outDir, { recursive: true });

  const manifestPath = resolve(args.outDir, 'manifest.json');
  const irradianceBlobPath = resolve(args.outDir, 'irradiance.bin');
  const radianceBlobPath = resolve(args.outDir, 'radiance.bin');
  const brdfManifestPath = resolve(args.outDir, 'brdf_lut.json');
  const brdfBlobPath = resolve(args.outDir, 'brdf_lut.bin');

  writeFileSync(manifestPath, serializeEnvironmentManifest(result.environmentArtifact));
  writeFileSync(irradianceBlobPath, result.irradianceBlob);
  writeFileSync(radianceBlobPath, result.radianceBlob);
  writeFileSync(brdfManifestPath, serializeBrdfLutManifest(result.brdfLutArtifact));
  writeFileSync(brdfBlobPath, result.brdfLutBlob);

  console.log(`✨ Cooked environment artifacts written to: ${args.outDir}`);
  console.log(`   - manifest.json: ${manifestPath}`);
  console.log(
    `   - irradiance.bin: ${(result.irradianceBlob.byteLength / 1024).toFixed(1)} KiB (32x16 RGBA16F)`
  );
  console.log(
    `   - radiance.bin:   ${(result.radianceBlob.byteLength / 1024).toFixed(1)} KiB (${result.environmentArtifact.radiance.levels.length} mips RGBA16F)`
  );
  console.log(
    `   - brdf_lut.bin:   ${(result.brdfLutBlob.byteLength / 1024).toFixed(1)} KiB (128x128 RG16F)`
  );
  console.log(`🎉 Total time: ${Date.now() - startTime} ms`);
}

main().catch((err) => {
  console.error('Cook error:', err);
  process.exit(1);
});
