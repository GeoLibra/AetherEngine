import { bench, expect } from 'vitest';
import {
  createConstantHdrFixture,
  createDirectionalLandmarksFixture,
  createPeriodicSeamFixture
} from './environment-cook/fixtures';
import {
  serialReferenceBrdfLut,
  serialReferenceGgxRadiance,
  serialReferenceIrradiance
} from './environment-cook/serial-reference';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';

const sourceWidth = profile === 'nightly' ? 256 : profile === 'standard' ? 128 : 64;
const sourceHeight = sourceWidth / 2;

const outIrradianceWidth = profile === 'nightly' ? 32 : profile === 'standard' ? 16 : 16;
const outIrradianceHeight = outIrradianceWidth / 2;
const irradianceSamples = profile === 'nightly' ? 256 : profile === 'standard' ? 128 : 64;

const outRadianceWidth = profile === 'nightly' ? 64 : profile === 'standard' ? 32 : 16;
const outRadianceHeight = outRadianceWidth / 2;
const radianceSamples = profile === 'nightly' ? 256 : profile === 'standard' ? 128 : 64;

const lutSize = profile === 'nightly' ? 64 : profile === 'standard' ? 32 : 16;
const lutSamples = profile === 'nightly' ? 256 : profile === 'standard' ? 128 : 64;

const constantFixture = createConstantHdrFixture(sourceWidth, sourceHeight, [1.0, 1.0, 1.0]);
const landmarksFixture = createDirectionalLandmarksFixture(sourceWidth, sourceHeight);
const seamFixture = createPeriodicSeamFixture(sourceWidth, sourceHeight);

bench(
  `diffuse irradiance convolution ${outIrradianceWidth}x${outIrradianceHeight} (${irradianceSamples} samples)`,
  () => {
    const result = serialReferenceIrradiance(
      landmarksFixture,
      outIrradianceWidth,
      outIrradianceHeight,
      irradianceSamples
    );
    expect(result.data.length).toBe(outIrradianceWidth * outIrradianceHeight * 3);
    expect(result.data[0]).toBeGreaterThan(0);
  }
);

bench(
  `GGX prefiltered radiance mip roughness=0.5 ${outRadianceWidth}x${outRadianceHeight} (${radianceSamples} samples)`,
  () => {
    const result = serialReferenceGgxRadiance(
      landmarksFixture,
      outRadianceWidth,
      outRadianceHeight,
      0.5,
      radianceSamples
    );
    expect(result.data.length).toBe(outRadianceWidth * outRadianceHeight * 3);
    expect(result.data[0]).toBeGreaterThan(0);
  }
);

bench(`shared BRDF LUT generation ${lutSize}x${lutSize} (${lutSamples} samples)`, () => {
  const result = serialReferenceBrdfLut(lutSize, lutSamples);
  expect(result.length).toBe(lutSize * lutSize * 2);
  expect(result[0]).toBeGreaterThanOrEqual(0);
});

bench(`periodic seam sampling verification ${sourceWidth}x${sourceHeight}`, () => {
  const result = serialReferenceIrradiance(
    seamFixture,
    outIrradianceWidth,
    outIrradianceHeight,
    irradianceSamples
  );
  expect(result.data.length).toBe(outIrradianceWidth * outIrradianceHeight * 3);
});
