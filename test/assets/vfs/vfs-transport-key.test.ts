import { describe, expect, test } from 'vitest';
import { deriveVFSTransportKey } from '../../../src/assets/vfs';

describe('VFS transport key derivation', () => {
  test('generates deterministic keys for identical inputs', () => {
    const key1 = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'full',
      revision: 'v1'
    });
    const key2 = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'full',
      revision: 'v1'
    });
    expect(key1).toBe(key2);
  });

  test('differentiates full reads from range reads', () => {
    const fullKey = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'full'
    });
    const rangeKey = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'range',
      range: { offset: 0, length: 1024 }
    });
    expect(fullKey).not.toBe(rangeKey);
    expect(rangeKey).toContain('range:0+1024');
    expect(fullKey).toContain('range:full');
  });

  test('differentiates distinct range slices', () => {
    const range1 = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'range',
      range: { offset: 0, length: 1024 }
    });
    const range2 = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://models/car.glb',
      channel: 'range',
      range: { offset: 1024, length: 1024 }
    });
    expect(range1).not.toBe(range2);
  });

  test('differentiates credential and cache partitions', () => {
    const userA = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://user-data/profile.json',
      channel: 'full',
      credentialPartition: 'user-123'
    });
    const userB = deriveVFSTransportKey({
      providerId: 'http-cdn',
      canonicalUri: 'asset://user-data/profile.json',
      channel: 'full',
      credentialPartition: 'user-456'
    });
    expect(userA).not.toBe(userB);
  });

  test('differentiates delivery channels', () => {
    const fullKey = deriveVFSTransportKey({
      providerId: 'memory',
      canonicalUri: 'asset://data.bin',
      channel: 'full'
    });
    const streamKey = deriveVFSTransportKey({
      providerId: 'memory',
      canonicalUri: 'asset://data.bin',
      channel: 'stream'
    });
    expect(fullKey).not.toBe(streamKey);
  });

  test('differentiates expectedLength expectations', () => {
    const keyDefault = deriveVFSTransportKey({
      providerId: 'memory',
      canonicalUri: 'asset://data.bin',
      channel: 'full'
    });
    const key100 = deriveVFSTransportKey({
      providerId: 'memory',
      canonicalUri: 'asset://data.bin',
      channel: 'full',
      expectedLength: 100
    });
    const key200 = deriveVFSTransportKey({
      providerId: 'memory',
      canonicalUri: 'asset://data.bin',
      channel: 'full',
      expectedLength: 200
    });
    expect(keyDefault).not.toBe(key100);
    expect(key100).not.toBe(key200);
    expect(key100).toContain('length:100');
  });
});
