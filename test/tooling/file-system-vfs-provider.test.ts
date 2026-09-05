import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { FileSystemVFSProvider } from '../../tools/asset-vfs';
import {
  DEFAULT_VFS_READ_POLICY,
  VirtualFileSystem,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  toNormalizedMountPath
} from '../../src/assets/vfs';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; provider: FileSystemVFSProvider }> {
  const root = await mkdtemp(join(tmpdir(), 'aether-vfs-'));
  roots.push(root);
  const provider = await FileSystemVFSProvider.open({
    id: 'native',
    rootDirectory: root,
    resolvedRootUri: normalizeVFSUri('asset://native')
  });
  return { root, provider };
}

describe('FileSystemVFSProvider', () => {
  test('reads detached bytes with canonical provenance and known MIME', async () => {
    const { root, provider } = await fixture();
    await mkdir(join(root, 'textures'));
    await writeFile(join(root, 'textures', 'sample.json'), '{"ok":true}');
    const path = toNormalizedMountPath(['textures', 'sample.json']);

    const first = await provider.read(path, {});
    expect(first).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://native/textures/sample.json',
      contentLength: 11,
      mime: 'application/json',
      providerId: 'native'
    });
    if (first.kind !== 'success') throw new Error('Expected filesystem read success.');
    expect(first.revision).toMatch(/^fs:/u);
    expect(first.integrity).toMatch(/^[a-f0-9]{64}$/u);
    first.bytes[0] = 0;
    expect(await readFile(join(root, 'textures', 'sample.json'), 'utf8')).toBe('{"ok":true}');
    const second = await provider.read(path, {});
    expect(second.kind === 'success' && new TextDecoder().decode(second.bytes)).toBe('{"ok":true}');
  });

  test('maps missing files and pre-aborted reads to typed outcomes', async () => {
    const { provider } = await fixture();
    expect(await provider.read(toNormalizedMountPath(['missing.bin']), {})).toMatchObject({
      kind: 'not-found',
      code: 'vfs-filesystem-not-found'
    });
    const controller = new AbortController();
    controller.abort();
    expect(
      await provider.read(toNormalizedMountPath(['missing.bin']), { signal: controller.signal })
    ).toMatchObject({ kind: 'aborted', code: 'vfs-read-aborted' });
  });

  test('rejects directories and internal symbolic links without exposing native paths', async () => {
    const { root, provider } = await fixture();
    await mkdir(join(root, 'directory'));
    await writeFile(join(root, 'target.txt'), 'secret');
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'));

    const directory = await provider.read(toNormalizedMountPath(['directory']), {});
    expect(directory).toMatchObject({ kind: 'provider-failure', code: 'vfs-filesystem-not-file' });
    const linked = await provider.read(toNormalizedMountPath(['link.txt']), {});
    expect(linked).toMatchObject({ kind: 'permission', code: 'vfs-filesystem-symlink' });
    expect(JSON.stringify([directory, linked])).not.toContain(root);
  });

  test('rejects a symbolic-link directory before it can escape the root', async () => {
    const { root, provider } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'aether-vfs-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(root, 'escape'));
    expect(await provider.read(toNormalizedMountPath(['escape', 'secret.txt']), {})).toMatchObject({
      kind: 'permission',
      code: 'vfs-filesystem-symlink'
    });
  });

  test('resolves a root symbolic link once and validates construction inputs', async () => {
    const actual = await mkdtemp(join(tmpdir(), 'aether-vfs-actual-'));
    const holder = await mkdtemp(join(tmpdir(), 'aether-vfs-holder-'));
    roots.push(actual, holder);
    await writeFile(join(actual, 'item.bin'), new Uint8Array([1]));
    const linkedRoot = join(holder, 'root-link');
    await symlink(actual, linkedRoot);
    const provider = await FileSystemVFSProvider.open({
      id: 'native',
      rootDirectory: linkedRoot,
      resolvedRootUri: normalizeVFSUri('asset://native')
    });
    expect((await provider.read(toNormalizedMountPath(['item.bin']), {})).kind).toBe('success');
    await expect(
      FileSystemVFSProvider.open({
        id: '',
        rootDirectory: actual,
        resolvedRootUri: normalizeVFSUri('asset://native')
      })
    ).rejects.toThrow('id');
  });

  test('snapshots construction getters exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aether-vfs-getters-'));
    roots.push(root);
    const calls = { id: 0, root: 0, uri: 0 };
    const options = {
      get id() {
        calls.id++;
        return 'native';
      },
      get rootDirectory() {
        calls.root++;
        return root;
      },
      get resolvedRootUri() {
        calls.uri++;
        return calls.uri === 1
          ? normalizeVFSUri('asset://native')
          : normalizeVFSUri('asset://changed');
      }
    };
    await expect(FileSystemVFSProvider.open(options)).resolves.toBeInstanceOf(
      FileSystemVFSProvider
    );
    expect(calls).toEqual({ id: 1, root: 1, uri: 1 });
  });

  test('redacts native root paths from construction failures', async () => {
    const missingRoot = join(tmpdir(), 'aether-vfs-does-not-exist-private-root');
    let message = '';
    try {
      await FileSystemVFSProvider.open({
        id: 'native',
        rootDirectory: missingRoot,
        resolvedRootUri: normalizeVFSUri('asset://native')
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Filesystem VFS root is unavailable.');
    expect(message).not.toContain(missingRoot);
  });

  test('maps native permission errors to a redacted outcome', async () => {
    const { root, provider } = await fixture();
    const path = join(root, 'private.bin');
    await writeFile(path, 'private');
    await chmod(path, 0o000);
    try {
      const result = await provider.read(toNormalizedMountPath(['private.bin']), {});
      expect(result).toMatchObject({ kind: 'permission', code: 'vfs-filesystem-permission' });
      expect(JSON.stringify(result)).not.toContain(root);
    } finally {
      await chmod(path, 0o600);
    }
  });

  test('integrates with VFS normalization for percent and space path segments', async () => {
    const { root, provider } = await fixture();
    await writeFile(join(root, '100% ready.txt'), 'ready');
    const vfs = new VirtualFileSystem();
    const mountRoot = normalizeVFSUri('asset://native');
    vfs.mount({
      root: mountRoot,
      scheme: parseCanonicalVFSUri(mountRoot).scheme,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.read({ uri: 'asset://native/100%25%20ready.txt' });
    expect(result).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://native/100%25%20ready.txt',
      contentLength: 5
    });
  });
});
