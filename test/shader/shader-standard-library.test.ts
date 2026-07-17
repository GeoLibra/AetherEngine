import { describe, expect, test } from 'vitest';

import {
  AETHER_SHADER_STANDARD_LIBRARY_ROOT,
  AETHER_SHADER_STANDARD_LIBRARY_VERSION,
  StandardLibraryShaderResolver,
  cookShaderArtifact
} from '../../src/shader';

describe('cookable shader standard library', () => {
  test.each(['math', 'noise', 'pbr', 'sdf'])(
    'cooks %s deterministically to typed IR',
    async (name) => {
      const resolver = new StandardLibraryShaderResolver();
      const source = {
        uri: `${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/${name}.flux`,
        languageVersion: 1
      };
      const versions = {
        compiler: 2,
        ir: 3,
        abi: 4,
        standardLibrary: AETHER_SHADER_STANDARD_LIBRARY_VERSION
      };

      const first = await cookShaderArtifact(source, resolver, versions);
      const second = await cookShaderArtifact(source, resolver, versions);

      expect(first.identity).toBe(second.identity);
      expect(first.dependencies.length).toBeGreaterThan(0);
      expect(first.ir.functions.length).toBeGreaterThan(0);
      expect(first.ir.functions[0]).not.toHaveProperty('source');
    }
  );

  test('changes artifact identity when compiler, IR, ABI or stdlib versions change', async () => {
    const resolver = new StandardLibraryShaderResolver();
    const source = {
      uri: `${AETHER_SHADER_STANDARD_LIBRARY_ROOT}/math.flux`,
      languageVersion: 1
    };
    const base = { compiler: 1, ir: 1, abi: 1, standardLibrary: 1 };
    const identities = await Promise.all(
      [
        base,
        { ...base, compiler: 2 },
        { ...base, ir: 2 },
        { ...base, abi: 2 },
        { ...base, standardLibrary: 2 }
      ].map(async (versions) => (await cookShaderArtifact(source, resolver, versions)).identity)
    );
    expect(new Set(identities)).toHaveLength(5);
  });
});
