import { describe, expect, test } from 'vitest';

import {
  validateNativeBuildManifest,
  type NativeBuildManifest,
  type NativeTargetPolicy
} from '../src';

const policy: NativeTargetPolicy = {
  approvedTargets: [
    {
      platform: 'macos', runtime: 'jsc', ownership: 'dedicated',
      bridge: 'engine-adapter', jitEnabled: false
    },
    {
      platform: 'ios', runtime: 'hermes', ownership: 'embedded',
      bridge: 'jsi', jitEnabled: false
    },
    {
      platform: 'windows', runtime: 'v8', ownership: 'dedicated',
      bridge: 'napi-compatible', jitEnabled: true
    }
  ]
};

function manifest(overrides: Partial<NativeBuildManifest> = {}): NativeBuildManifest {
  return {
    buildId: 'native-dev',
    engineAbiVersion: 2,
    rhiContractVersion: 3,
    target: {
      platform: 'macos', runtime: 'jsc', ownership: 'dedicated',
      bridge: 'engine-adapter', jitEnabled: false
    },
    modules: [
      { name: 'filesystem', version: 1, required: true },
      { name: 'sensors', version: 2, required: false }
    ],
    abi: {
      endianness: 'little', pointerBits: 64,
      arrayBuffer: { transfer: true, mapped: false, shared: false }
    },
    sourceFiles: ['./src/native/main.cpp', 'src\\native\\host.cpp'],
    ...overrides
  };
}

describe('Native build manifest', () => {
  test('normalizes and deeply freezes an approved dedicated target', () => {
    const input = manifest();
    const result = validateNativeBuildManifest(input, policy);

    expect(result.sourceFiles).toEqual(['src/native/main.cpp', 'src/native/host.cpp']);
    expect(result.target).toEqual({
      platform: 'macos', runtime: 'jsc', ownership: 'dedicated',
      bridge: 'engine-adapter', jitEnabled: false
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.target)).toBe(true);
    expect(Object.isFrozen(result.modules)).toBe(true);
    expect(Object.isFrozen(result.modules[0])).toBe(true);
    expect(Object.isFrozen(result.abi.arrayBuffer)).toBe(true);
  });

  test('accepts embedded ownership only with an approved JSI target', () => {
    const embedded = manifest({
      target: {
        platform: 'ios', runtime: 'hermes', ownership: 'embedded',
        bridge: 'jsi', jitEnabled: false
      }
    });

    expect(validateNativeBuildManifest(embedded, policy).target.ownership).toBe('embedded');
    expect(() => validateNativeBuildManifest(manifest({
      target: {
        platform: 'ios', runtime: 'hermes', ownership: 'embedded',
        bridge: 'napi-compatible', jitEnabled: false
      }
    }), policy)).toThrow('Embedded native runtimes require the JSI bridge.');
    expect(() => validateNativeBuildManifest(manifest({
      target: {
        platform: 'macos', runtime: 'jsc', ownership: 'dedicated',
        bridge: 'jsi', jitEnabled: false
      }
    }), policy)).toThrow('Dedicated native runtimes cannot use the JSI bridge.');
  });

  test.each([
    ['src/native/**/*.cpp', 'glob'],
    ['/Users/me/native.cpp', 'relative'],
    ['C:\\native\\main.cpp', 'relative'],
    ['src/native/../secret.cpp', 'traversal']
  ])('rejects unsafe explicit source path %s', (source, diagnostic) => {
    expect(() => validateNativeBuildManifest(manifest({ sourceFiles: [source] }), policy))
      .toThrow(diagnostic);
  });

  test('rejects duplicate sources, modules, and unapproved platform/runtime policy', () => {
    expect(() => validateNativeBuildManifest(manifest({
      sourceFiles: ['src/native/main.cpp', './src/native/main.cpp']
    }), policy)).toThrow('duplicate source file');
    expect(() => validateNativeBuildManifest(manifest({
      modules: [
        { name: 'filesystem', version: 1, required: true },
        { name: 'filesystem', version: 2, required: false }
      ]
    }), policy)).toThrow('duplicate module "filesystem"');
    expect(() => validateNativeBuildManifest(manifest({
      target: {
        platform: 'macos', runtime: 'v8', ownership: 'dedicated',
        bridge: 'napi-compatible', jitEnabled: true
      }
    }), policy)).toThrow('not approved by the target policy');
    expect(() => validateNativeBuildManifest(manifest({
      target: {
        platform: 'browser' as 'macos', runtime: 'wasm' as 'jsc', ownership: 'dedicated',
        bridge: 'engine-adapter', jitEnabled: false
      }
    }), policy)).toThrow('not a native platform');
  });
});
