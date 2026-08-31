import { ReadonlySetSnapshot } from './readonly-collection-snapshot';
import type { ExtractorToken, RenderFieldToken, RenderTagToken } from './types';

/**
 * Creates an immutable typed field token.
 */
export function defineRenderField<T>(
  name: string,
  options: { readonly compare?: (previous: T, next: T) => boolean } = {}
): RenderFieldToken<T> {
  return Object.freeze({
    id: Symbol(name),
    name,
    ...(options.compare
      ? { compare: options.compare as (previous: unknown, next: unknown) => boolean }
      : {})
  });
}

/**
 * Creates an immutable zero-payload tag token for entity classification.
 */
export function defineRenderTag(name: string): RenderTagToken {
  return Object.freeze({ id: Symbol(name), name, __tag: true });
}

/**
 * Defines an extractor token bound to the specific set of fields it writes.
 */
export function defineExtractorToken<const W extends readonly RenderFieldToken<unknown>[]>(
  name: string,
  writes: W
): ExtractorToken<W> {
  return Object.freeze({
    id: Symbol(name),
    name,
    writes: new ReadonlySetSnapshot<RenderFieldToken<unknown>>(writes)
  }) as ExtractorToken<W>;
}
