import { describe, expect, test } from 'vitest';

import {
  NativeHandshakeError,
  negotiateNativeHandshake,
  validateNativeBuildManifest,
  type NativeBuildManifest,
  type NativeHandshake,
  type NativeTargetPolicy
} from '../../src';

const policy: NativeTargetPolicy = {
  approvedTargets: [
    {
      platform: 'macos',
      runtime: 'jsc',
      ownership: 'dedicated',
      bridge: 'engine-adapter',
      jitEnabled: false
    }
  ]
};

function manifest(): NativeBuildManifest {
  return validateNativeBuildManifest(
    {
      buildId: 'build-a',
      engineAbiVersion: 2,
      rhiContractVersion: 4,
      target: policy.approvedTargets[0]!,
      modules: [
        { name: 'filesystem', version: 2, required: true },
        { name: 'audio', version: 3, required: true },
        { name: 'sensors', version: 2, required: false }
      ],
      abi: {
        endianness: 'little',
        pointerBits: 64,
        arrayBuffer: { transfer: true, mapped: true, shared: false }
      },
      sourceFiles: ['src/native/main.cpp']
    },
    policy
  );
}

function handshake(overrides: Partial<NativeHandshake> = {}): NativeHandshake {
  return {
    buildId: 'build-a',
    engineAbiVersion: 2,
    rhiContractVersion: 4,
    modules: [
      { name: 'filesystem', version: 2 },
      { name: 'audio', version: 4 },
      { name: 'sensors', version: 2 }
    ],
    abi: {
      endianness: 'little',
      pointerBits: 64,
      arrayBuffer: { transfer: true, mapped: true, shared: true }
    },
    ...overrides
  };
}

describe('Native ABI handshake', () => {
  test('negotiates an immutable compatible module and ABI snapshot', () => {
    const actual = handshake();
    const result = negotiateNativeHandshake(manifest(), actual);

    expect(result.modules).toEqual([
      { name: 'filesystem', version: 2 },
      { name: 'audio', version: 4 },
      { name: 'sensors', version: 2 }
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.modules)).toBe(true);
    expect(Object.isFrozen(result.modules[0])).toBe(true);
    expect(Object.isFrozen(result.abi.arrayBuffer)).toBe(true);
  });

  test('collects every required/actual difference in deterministic order', () => {
    const expected = manifest();
    const actual = handshake({
      buildId: 'build-b',
      engineAbiVersion: 1,
      rhiContractVersion: 3,
      modules: [{ name: 'audio', version: 1 }],
      abi: {
        endianness: 'big',
        pointerBits: 32,
        arrayBuffer: { transfer: false, mapped: false, shared: false }
      }
    });

    let error: unknown;
    try {
      negotiateNativeHandshake(expected, actual);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NativeHandshakeError);
    expect((error as NativeHandshakeError).differences).toEqual([
      { kind: 'build-id', required: 'build-a', actual: 'build-b' },
      { kind: 'engine-abi', required: 2, actual: 1 },
      { kind: 'rhi-contract', required: 4, actual: 3 },
      { kind: 'endianness', required: 'little', actual: 'big' },
      { kind: 'pointer-bits', required: 64, actual: 32 },
      { kind: 'array-buffer', capability: 'transfer', required: true, actual: false },
      { kind: 'array-buffer', capability: 'mapped', required: true, actual: false },
      { kind: 'module', module: 'filesystem', required: 2, actual: undefined },
      { kind: 'module', module: 'audio', required: 3, actual: 1 }
    ]);
    expect(String(error)).toContain('required=2 actual=1');
    expect(Object.isFrozen((error as NativeHandshakeError).differences)).toBe(true);
  });

  test('omits unavailable or outdated optional modules without failing startup', () => {
    const missing = negotiateNativeHandshake(
      manifest(),
      handshake({
        modules: [
          { name: 'filesystem', version: 2 },
          { name: 'audio', version: 3 }
        ]
      })
    );
    const outdated = negotiateNativeHandshake(
      manifest(),
      handshake({
        modules: [
          { name: 'filesystem', version: 2 },
          { name: 'audio', version: 3 },
          { name: 'sensors', version: 1 }
        ]
      })
    );

    expect(missing.modules.map(({ name }) => name)).toEqual(['filesystem', 'audio']);
    expect(outdated.modules.map(({ name }) => name)).toEqual(['filesystem', 'audio']);
  });

  test('rejects duplicate actual module facts before negotiation', () => {
    expect(() =>
      negotiateNativeHandshake(
        manifest(),
        handshake({
          modules: [
            { name: 'filesystem', version: 2 },
            { name: 'filesystem', version: 3 },
            { name: 'audio', version: 3 }
          ]
        })
      )
    ).toThrow('duplicate module "filesystem"');
  });
});
