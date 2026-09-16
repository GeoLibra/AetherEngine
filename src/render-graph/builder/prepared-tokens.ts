import type { PreparedResourceKind, PreparedToken } from '../types';

/**
 * Creates a typed key for an engine resource created before graph surface acquisition.
 *
 * @param resourceKind - The kind of prepared resource ('compute-pipeline' | 'bind-group-layout' | 'render-pipeline' | 'draw-resources').
 * @param name - A non-empty diagnostic name identifying the resource.
 * @throws {TypeError} If the token name is empty.
 */
export function createPreparedToken<K extends PreparedResourceKind>(
  resourceKind: K,
  name: string
): PreparedToken<K> {
  if (name.length === 0) {
    throw new TypeError(`Prepared ${resourceKind} token name must not be empty.`);
  }
  return Object.freeze({
    kind: `prepared-${resourceKind}-token` as const,
    name,
    id: Symbol(name)
  }) as PreparedToken<K>;
}
