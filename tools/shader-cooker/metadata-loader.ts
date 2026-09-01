/**
 * @file Node-only loader and validator for WGSL sidecar metadata.
 */

import { readFile } from 'node:fs/promises';
import { validateWgslShaderMetadata } from '../../src/shader/authoring';
import type { WgslShaderMetadata } from '../../src/shader/types';

/**
 * Pluggable file system reader for loading metadata.
 */
export interface MetadataFileSystemAdapter {
  readonly readFile: (path: string, encoding: 'utf8') => Promise<string>;
}

const defaultFsAdapter: MetadataFileSystemAdapter = Object.freeze({
  readFile: (filePath: string, encoding: 'utf8') => readFile(filePath, encoding)
});

/**
 * Loads and validates a WGSL sidecar JSON metadata file from disk.
 *
 * @param metadataPath Path to the `.wgsl.meta.json` or `.shader.json` file.
 * @param fs File system adapter (defaults to node:fs/promises).
 * @returns Validated, frozen WgslShaderMetadata snapshot.
 * @throws {Error} On I/O failure, malformed JSON, or schema validation violations.
 */
export async function loadWgslMetadata(
  metadataPath: string,
  fs: MetadataFileSystemAdapter = defaultFsAdapter
): Promise<WgslShaderMetadata> {
  const content = await fs.readFile(metadataPath, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    throw new Error(
      `Failed to parse WGSL metadata JSON at "${metadataPath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return validateWgslShaderMetadata(parsed);
}
