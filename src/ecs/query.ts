import type { World } from './world';
import type { ComponentType, QueryFilter, QueryItem } from './types';

export class QueryBuilder<TComponents extends readonly ComponentType<object>[]>
  implements Iterable<QueryItem<TComponents>>
{
  private filter: QueryFilter = {};

  constructor(
    private readonly world: World,
    private readonly componentTypes: TComponents
  ) {}

  with(...types: NonNullable<QueryFilter['with']>): this {
    this.filter = { ...this.filter, with: types };
    return this;
  }

  without(...types: NonNullable<QueryFilter['without']>): this {
    this.filter = { ...this.filter, without: types };
    return this;
  }

  changed(...types: NonNullable<QueryFilter['changed']>): this {
    this.filter = { ...this.filter, changed: types };
    return this;
  }

  added(...types: NonNullable<QueryFilter['added']>): this {
    this.filter = { ...this.filter, added: types };
    return this;
  }

  withFilter(filter?: QueryFilter): this {
    this.filter = filter ?? {};
    return this;
  }

  [Symbol.iterator](): Iterator<QueryItem<TComponents>> {
    return this.world.iterateQuery(this.componentTypes, this.filter);
  }
}
