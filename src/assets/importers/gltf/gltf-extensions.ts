const SUPPORTED_EXTENSIONS = new Set<string>(['KHR_texture_transform']);

/**
 * Validates glTF extensionsRequired list.
 *
 * @throws When an extension in extensionsRequired is not supported by Aether in the current profile.
 */
export function validateGltfRequiredExtensions(gltf: Record<string, any>): void {
  const required = gltf.extensionsRequired;
  if (!Array.isArray(required)) return;

  const unsupported: string[] = [];
  for (const ext of required) {
    if (typeof ext === 'string' && !SUPPORTED_EXTENSIONS.has(ext)) {
      unsupported.push(ext);
    }
  }

  if (unsupported.length > 0) {
    throw new Error(`glTF document requires unsupported extension(s): ${unsupported.join(', ')}.`);
  }
}
