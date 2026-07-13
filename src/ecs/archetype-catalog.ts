import { createArchetypeId, Table } from './table';
import type { PackedComponentSchema } from './types';

export type ArchetypeTransitionOperation = `add:${string}` | `remove:${string}`;

export interface ArchetypeCatalogSnapshot {
  readonly version: number;
  readonly tableCount: number;
  readonly migrations: number;
  readonly edgeHits: number;
  readonly edgeMisses: number;
}

export class ArchetypeCatalog {
  private readonly tablesBySignature = new Map<string, Table>();
  private readonly tablesByCreation = new Array<Table>();
  private readonly edges = new Map<number, Map<ArchetypeTransitionOperation, Table>>();
  private migrations = 0;
  private edgeHits = 0;
  private edgeMisses = 0;

  get version(): number {
    return this.tablesByCreation.length;
  }

  getOrCreate(
    componentTypes: readonly PackedComponentSchema<object>[],
    tags: Iterable<string> = []
  ): Table {
    const sorted = [...componentTypes].sort((left, right) => left.id.localeCompare(right.id));
    const tagList = [...tags].sort();
    const signature = createArchetypeId(sorted, tagList);
    let table = this.tablesBySignature.get(signature);
    if (!table) {
      table = new Table(sorted, tagList, { id: this.tablesByCreation.length });
      this.tablesBySignature.set(signature, table);
      this.tablesByCreation.push(table);
    }
    return table;
  }

  transition(
    source: Table,
    operation: ArchetypeTransitionOperation,
    componentTypes: readonly PackedComponentSchema<object>[],
    tags: Iterable<string> = []
  ): Table {
    this.migrations++;
    const sourceEdges = this.edges.get(source.id);
    const cached = sourceEdges?.get(operation);
    if (cached) {
      this.edgeHits++;
      return cached;
    }

    this.edgeMisses++;
    const target = this.getOrCreate(componentTypes, tags);
    const edges = sourceEdges ?? new Map<ArchetypeTransitionOperation, Table>();
    edges.set(operation, target);
    if (!sourceEdges) {
      this.edges.set(source.id, edges);
    }
    return target;
  }

  tablesSince(version: number): readonly Table[] {
    const start = Math.max(0, Math.min(version, this.tablesByCreation.length));
    return this.tablesByCreation.slice(start);
  }

  values(): IterableIterator<Table> {
    return this.tablesByCreation.values();
  }

  snapshot(): ArchetypeCatalogSnapshot {
    return Object.freeze({
      version: this.version,
      tableCount: this.tablesByCreation.length,
      migrations: this.migrations,
      edgeHits: this.edgeHits,
      edgeMisses: this.edgeMisses
    });
  }

  clear(): void {
    this.tablesBySignature.clear();
    this.tablesByCreation.length = 0;
    this.edges.clear();
    this.migrations = 0;
    this.edgeHits = 0;
    this.edgeMisses = 0;
  }
}
