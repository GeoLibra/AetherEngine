import type { ExtractorToken, RenderFieldToken } from './render-world';

export type AnyExtractorToken = ExtractorToken<readonly RenderFieldToken<unknown>[]>;

export interface RenderFieldCandidate<T> {
  readonly extractor: AnyExtractorToken;
  readonly operation: Readonly<{ kind: 'upsert'; value: T }> | Readonly<{ kind: 'remove' }>;
}

export interface RenderFieldArbitrator<T> {
  readonly field: RenderFieldToken<T>;
  readonly contributors: readonly AnyExtractorToken[];
  resolve(
    candidates: readonly RenderFieldCandidate<T>[],
    previous: T | undefined
  ):
    | Readonly<{ kind: 'publish'; value: T }>
    | Readonly<{ kind: 'remove' }>
    | Readonly<{ kind: 'unchanged' }>;
}

export class RenderExtractorPlan {
  private constructor(
    private readonly tokens: ReadonlyMap<symbol, AnyExtractorToken>,
    private readonly owners: ReadonlyMap<RenderFieldToken<unknown>, readonly AnyExtractorToken[]>,
    private readonly arbitrators: ReadonlyMap<
      RenderFieldToken<unknown>,
      RenderFieldArbitrator<unknown>
    >
  ) {}

  static compile(
    extractors: readonly AnyExtractorToken[],
    arbitrators: readonly RenderFieldArbitrator<unknown>[] = []
  ): RenderExtractorPlan {
    const tokens = new Map<symbol, AnyExtractorToken>();
    const names = new Set<string>();
    const owners = new Map<RenderFieldToken<unknown>, AnyExtractorToken[]>();
    for (const extractor of extractors) {
      if (tokens.has(extractor.id) || names.has(extractor.name)) {
        throw new Error(`Duplicate render extractor "${extractor.name}".`);
      }
      tokens.set(extractor.id, extractor);
      names.add(extractor.name);
      for (const field of extractor.writes) {
        const contributors = owners.get(field) ?? [];
        contributors.push(extractor);
        owners.set(field, contributors);
      }
    }

    const byField = new Map<RenderFieldToken<unknown>, RenderFieldArbitrator<unknown>>();
    for (const arbitrator of arbitrators) {
      if (byField.has(arbitrator.field)) {
        throw new Error(`Duplicate arbitrator for field "${arbitrator.field.name}".`);
      }
      const declared = owners.get(arbitrator.field) ?? [];
      for (const contributor of arbitrator.contributors) {
        if (!tokens.has(contributor.id)) {
          throw new Error(`Arbitrator references unknown extractor "${contributor.name}".`);
        }
        if (!contributor.writes.has(arbitrator.field)) {
          throw new Error(
            `Extractor "${contributor.name}" does not declare field "${arbitrator.field.name}".`
          );
        }
      }
      const expected = [...declared].sort(compareExtractor);
      const actual = [...arbitrator.contributors].sort(compareExtractor);
      if (
        expected.length !== actual.length ||
        expected.some((extractor, index) => extractor !== actual[index])
      ) {
        throw new Error(
          `Arbitrator for field "${arbitrator.field.name}" must list every contributor exactly once.`
        );
      }
      byField.set(
        arbitrator.field,
        Object.freeze({
          ...arbitrator,
          contributors: Object.freeze([...actual])
        }) as RenderFieldArbitrator<unknown>
      );
    }
    for (const [field, contributors] of owners) {
      if (contributors.length > 1 && !byField.has(field)) {
        throw new Error(`Field "${field.name}" has multiple owners but no arbitrator.`);
      }
    }
    return new RenderExtractorPlan(
      tokens,
      new Map(
        [...owners].map(([field, contributors]) => [
          field,
          Object.freeze([...contributors].sort(compareExtractor))
        ])
      ),
      byField
    );
  }

  assertExtractor(extractor: AnyExtractorToken): void {
    if (this.tokens.get(extractor.id) !== extractor) {
      throw new Error(`Extractor "${extractor.name}" is not registered in this RenderWorld.`);
    }
  }

  contributors(field: RenderFieldToken<unknown>): readonly AnyExtractorToken[] {
    return this.owners.get(field) ?? Object.freeze([]);
  }

  arbitrator<T>(field: RenderFieldToken<T>): RenderFieldArbitrator<T> | undefined {
    return this.arbitrators.get(field) as RenderFieldArbitrator<T> | undefined;
  }
}

export class RenderExtractorRegistryBuilder {
  private readonly extractors: AnyExtractorToken[] = [];
  private readonly arbitrators: RenderFieldArbitrator<unknown>[] = [];
  private built = false;

  registerExtractor(extractor: AnyExtractorToken): this {
    this.assertMutable();
    this.extractors.push(extractor);
    return this;
  }

  registerArbitrator<T>(arbitrator: RenderFieldArbitrator<T>): this {
    this.assertMutable();
    this.arbitrators.push(arbitrator as RenderFieldArbitrator<unknown>);
    return this;
  }

  build(): RenderExtractorPlan {
    this.assertMutable();
    this.built = true;
    return RenderExtractorPlan.compile(this.extractors, this.arbitrators);
  }

  private assertMutable(): void {
    if (this.built) throw new Error('Render extractor registration is closed after plan build.');
  }
}

function compareExtractor(left: AnyExtractorToken, right: AnyExtractorToken): number {
  return left.name.localeCompare(right.name);
}
