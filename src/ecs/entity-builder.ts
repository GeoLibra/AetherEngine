import type { World } from './world';
import type { ComponentInput, ComponentType, Entity, RelationType } from './types';

interface PendingComponent {
  readonly type: ComponentType<object>;
  readonly data: ComponentInput;
}

interface PendingRelation {
  readonly relation: RelationType;
  readonly target: Entity;
}

export class EntityBuilder {
  private readonly components: PendingComponent[] = [];
  private readonly relations: PendingRelation[] = [];

  constructor(
    private readonly world: World,
    private readonly entity: Entity
  ) {}

  insert<TView extends object>(componentType: ComponentType<TView>, data: ComponentInput = {}): this {
    this.components.push({ type: componentType, data });
    return this;
  }

  addRelation(relation: RelationType, target: Entity): this {
    this.relations.push({ relation, target });
    return this;
  }

  build(): Entity {
    for (const component of this.components) {
      this.world.insertComponent(this.entity, component.type, component.data);
    }
    for (const relation of this.relations) {
      this.world.addRelation(this.entity, relation.relation, relation.target);
    }
    return this.entity;
  }
}
