import type { AssetImportContext } from '../../importer/types';

/**
 * Creates a fetch polyfill function that intercepts network/file requests
 * and routes them safely through the Aether VFS and dependency resolver.
 */
export function createVfsFetchBridge(
  parentUri: string,
  context: AssetImportContext
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL, _init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input.toString();
    const resolvedUri = context.dependencies.resolve(parentUri, rawUrl);

    // Check cancellation
    if (context.signal.aborted) {
      throw new Error('Asset load operation was aborted.');
    }

    const data = await context.dependencies.load(resolvedUri, context.signal);
    context.budget.recordRead(data.byteLength);

    return new Response(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-length': data.byteLength.toString(),
        'content-type': guessMimeType(resolvedUri)
      }
    });
  };
}

function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.bin')) return 'application/octet-stream';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gltf')) return 'model/gltf+json';
  if (lower.endsWith('.glb')) return 'model/gltf-binary';
  return 'application/octet-stream';
}
