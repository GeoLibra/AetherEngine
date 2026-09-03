import { describe, expect, test } from 'vitest';
import { DEFAULT_VFS_READ_POLICY, VFS_FAILURE_KIND } from '../../../src/assets/vfs';

describe('VFS contracts', () => {
  test('uses only recoverable absence failures for default fallback', () => {
    expect(VFS_FAILURE_KIND).toEqual({
      NotFound: 'not-found',
      Offline: 'offline',
      Aborted: 'aborted',
      Integrity: 'integrity',
      Permission: 'permission',
      ProviderFailure: 'provider-failure'
    });
    expect(DEFAULT_VFS_READ_POLICY).toEqual({
      consultCaches: true,
      fallbackOn: ['not-found', 'offline']
    });
  });
});
