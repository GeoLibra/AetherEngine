import type { World } from '../world';
import type { QueryState } from './query-state';
import type { ComponentType, QueryFilter, QueryItem } from '../types';

export class QueryBuilder<TComponents extends readonly ComponentType<object>[]> implements Iterable<
  QueryItem<TComponents>
> {
  private filter: QueryFilter = {};
  private state: QueryState<TComponents> | undefined;

  constructor(
    private readonly world: World,
    private readonly componentTypes: TComponents
  ) {}

  with(...types: NonNullable<QueryFilter['with']>): this {
    return this.invalidate({ ...this.filter, with: types });
  }

  without(...types: NonNullable<QueryFilter['without']>): this {
    return this.invalidate({ ...this.filter, without: types });
  }

  changed(...types: NonNullable<QueryFilter['changed']>): this {
    return this.invalidate({ ...this.filter, changed: types });
  }

  added(...types: NonNullable<QueryFilter['added']>): this {
    return this.invalidate({ ...this.filter, added: types });
  }

  withFilter(filter?: QueryFilter): this {
    return this.invalidate(filter ?? {});
  }

  [Symbol.iterator](): Iterator<QueryItem<TComponents>> {
    this.state ??= this.world.createQueryState(this.componentTypes, this.filter);
    return this.state[Symbol.iterator]();
  }

  private invalidate(filter: QueryFilter): this {
    this.filter = filter;
    this.state = undefined;
    return this;
  }
}
