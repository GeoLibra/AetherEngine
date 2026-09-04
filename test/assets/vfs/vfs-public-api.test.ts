import { expect, test } from 'vitest';
import {
  VirtualFileSystem,
  MemoryVFSProvider,
  normalizeVFSUri,
  VFS_FAILURE_KIND
} from '../../../src/assets';

test('exports the VFS core through the assets boundary', () => {
  expect(VirtualFileSystem).toBeTypeOf('function');
  expect(MemoryVFSProvider).toBeTypeOf('function');
  expect(normalizeVFSUri('ASSET://item')).toBe('asset://item');
  expect(VFS_FAILURE_KIND.Integrity).toBe('integrity');
});
