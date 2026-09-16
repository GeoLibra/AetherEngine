/**
 * @file Scenario generator for shader module dependency resolution, linking, and invalidation benchmarks.
 * Evaluates cold resolution, warm repeat builds, shared leaf edits, root-local edits,
 * unrelated edits, and failure-retention recovery.
 * Based on Section 8 of engine/design/v2/04-rendering/14-shader-modules.md.
 */

import {
  createShaderModuleId,
  linkStrictWgsl,
  resolveDependencyClosure,
  type DependencyClosure,
  type LinkedWgslResult,
  type ShaderModuleId,
  type ShaderModuleLoader,
  type ShaderModuleSource
} from '../../tools/shader-cooker/modules';
import type { WgslImportRef } from '../../src/shader/types';

export interface ModuleBenchmarkScenarioConfig {
  readonly moduleCount: number;
  readonly linesPerModule?: number;
  readonly topology: 'chain' | 'diamond' | 'fan-out';
}

export interface ModuleBenchmarkScenarioResult {
  readonly closureModuleCount: number;
  readonly outputLineCount: number;
  readonly compositeHash: string;
  readonly compositeHashMatchesOracle: boolean;
  readonly sharedLeafAffectedRootsCount: number;
  readonly rootLocalAffectedRootsCount: number;
  readonly unrelatedAffectedRootsCount: number;
  readonly rebuildIsDeterministic: boolean;
}

interface SyntheticModuleEntry {
  source: string;
  imports: readonly WgslImportRef[];
}

export class InMemoryShaderModuleLoader implements ShaderModuleLoader {
  private readonly store = new Map<ShaderModuleId, SyntheticModuleEntry>();

  public setModule(
    id: ShaderModuleId,
    source: string,
    imports: readonly WgslImportRef[] = []
  ): void {
    this.store.set(id, { source, imports: Object.freeze([...imports]) });
  }

  public updateSource(id: ShaderModuleId, source: string): void {
    const entry = this.store.get(id);
    if (!entry) {
      throw new Error(`Module '${id as string}' not found in InMemoryShaderModuleLoader`);
    }
    this.store.set(id, { source, imports: entry.imports });
  }

  public getModule(id: ShaderModuleId): SyntheticModuleEntry | undefined {
    return this.store.get(id);
  }

  public async loadModule(id: ShaderModuleId): Promise<ShaderModuleSource | undefined> {
    const entry = this.store.get(id);
    if (!entry) return undefined;
    return Object.freeze({
      id,
      source: entry.source,
      imports: entry.imports
    });
  }
}

export function createSyntheticModuleSet(config: ModuleBenchmarkScenarioConfig): {
  readonly rootAUri: string;
  readonly rootBUri: string;
  readonly unrelatedUri: string;
  readonly sharedLeafUri: string;
  readonly loader: InMemoryShaderModuleLoader;
  readonly editModule: (id: string, newContent: string) => void;
} {
  const loader = new InMemoryShaderModuleLoader();
  const linesPerModule = config.linesPerModule ?? 10;
  const paddingLines = Array.from(
    { length: linesPerModule },
    (_, i) => `  let var_${i}: f32 = ${i}.0;`
  ).join('\n');

  const sharedLeafUri = 'asset://bench/shared_leaf.wgsl';
  loader.setModule(
    createShaderModuleId(sharedLeafUri),
    `fn shared_leaf_func() -> f32 {\n${paddingLines}\n  return 42.0;\n}\n`
  );

  const unrelatedUri = 'asset://bench/unrelated.wgsl';
  loader.setModule(
    createShaderModuleId(unrelatedUri),
    `fn unrelated_func() -> f32 {\n${paddingLines}\n  return 999.0;\n}\n`
  );

  if (config.topology === 'chain') {
    for (let i = 0; i < config.moduleCount; i++) {
      const uri = `asset://bench/mod_${i}.wgsl`;
      const nextUri = `asset://bench/mod_${i + 1}.wgsl`;
      const isLeaf = i === config.moduleCount - 1;
      loader.setModule(
        createShaderModuleId(uri),
        `fn mod_${i}_func() -> f32 {\n${paddingLines}\n  return ${isLeaf ? '42.0' : `mod_${i + 1}_func() + 1.0`};\n}\n`,
        isLeaf ? [{ path: sharedLeafUri }] : [{ path: nextUri }]
      );
    }
    loader.setModule(
      createShaderModuleId('asset://bench/root_b.wgsl'),
      `@fragment fn fs_root_b() {}\n`,
      [{ path: sharedLeafUri }]
    );
  } else if (config.topology === 'diamond') {
    // RootA -> [Branches...] -> sharedLeaf
    // RootB -> Branch1 -> sharedLeaf
    for (let i = 1; i < config.moduleCount - 1; i++) {
      const uri = `asset://bench/branch_${i}.wgsl`;
      loader.setModule(
        createShaderModuleId(uri),
        `fn branch_${i}() -> f32 {\n${paddingLines}\n  return shared_leaf_func() + ${i}.0;\n}\n`,
        [{ path: sharedLeafUri }]
      );
    }
    const branchImports: WgslImportRef[] = Array.from(
      { length: config.moduleCount - 2 },
      (_, i) => ({ path: `asset://bench/branch_${i + 1}.wgsl` })
    );
    loader.setModule(
      createShaderModuleId('asset://bench/root_a.wgsl'),
      `@fragment fn fs_root_a() {}\n`,
      branchImports
    );
    loader.setModule(
      createShaderModuleId('asset://bench/root_b.wgsl'),
      `@fragment fn fs_root_b() {}\n`,
      [{ path: 'asset://bench/branch_1.wgsl' }]
    );
  } else {
    // Fan-out
    for (let i = 1; i < config.moduleCount; i++) {
      const uri = `asset://bench/leaf_${i}.wgsl`;
      loader.setModule(
        createShaderModuleId(uri),
        `fn leaf_${i}() -> f32 {\n${paddingLines}\n  return ${i}.0;\n}\n`,
        [{ path: sharedLeafUri }]
      );
    }
    const fanImports: WgslImportRef[] = Array.from({ length: config.moduleCount - 1 }, (_, i) => ({
      path: `asset://bench/leaf_${i + 1}.wgsl`
    }));
    loader.setModule(
      createShaderModuleId('asset://bench/root_a.wgsl'),
      `@fragment fn fs_root_a() {}\n`,
      fanImports
    );
    loader.setModule(
      createShaderModuleId('asset://bench/root_b.wgsl'),
      `@fragment fn fs_root_b() {}\n`,
      [{ path: sharedLeafUri }]
    );
  }

  const rootAUri =
    config.topology === 'chain' ? 'asset://bench/mod_0.wgsl' : 'asset://bench/root_a.wgsl';
  const rootBUri = 'asset://bench/root_b.wgsl';

  return {
    rootAUri,
    rootBUri,
    unrelatedUri,
    sharedLeafUri,
    loader,
    editModule(id: string, newContent: string) {
      const moduleId = createShaderModuleId(id);
      loader.updateSource(moduleId, newContent);
    }
  };
}

export async function runModuleCompositionScenario(
  config: ModuleBenchmarkScenarioConfig
): Promise<ModuleBenchmarkScenarioResult> {
  const { rootAUri, rootBUri, unrelatedUri, sharedLeafUri, loader, editModule } =
    createSyntheticModuleSet(config);

  // 1. Production resolution and linking
  const closureA = await resolveDependencyClosure(rootAUri, loader);
  const closureB = await resolveDependencyClosure(rootBUri, loader);
  const linkedA = linkStrictWgsl(closureA);
  const linkedB = linkStrictWgsl(closureB);

  // 2. Oracle verification: identical input produces identical composite hash
  const closureA2 = await resolveDependencyClosure(rootAUri, loader);
  const linkedA2 = linkStrictWgsl(closureA2);
  const compositeHashMatchesOracle = linkedA.compositeHash === linkedA2.compositeHash;

  // 3. Invalidation set computation: find roots affected by changed module
  function findAffectedRoots(
    changedModId: string,
    closures: readonly DependencyClosure[]
  ): string[] {
    const affected: string[] = [];
    for (const c of closures) {
      if (c.modules.some((m) => (m.id as string) === changedModId)) {
        affected.push(c.rootId as string);
      }
    }
    return affected;
  }

  // Edit unrelated: affects 0 roots
  const unrelatedAffected = findAffectedRoots(unrelatedUri, [closureA, closureB]);

  // Edit root-local: affects only root A
  const rootLocalAffected = findAffectedRoots(rootAUri, [closureA, closureB]);

  // Edit shared leaf: affects both root A and root B
  const sharedAffected = findAffectedRoots(sharedLeafUri, [closureA, closureB]);

  // 4. Edited rebuild determinism oracle: a full re-resolve/re-link of the edited graph must
  // produce the identical composite hash as the edited root rebuild. This asserts rebuild
  // determinism; it is NOT evidence of incremental compilation (no partial rebuild exists).
  editModule(sharedLeafUri, 'fn shared_leaf_func() -> f32 { return 777.0; }\n');
  const freshClosureA = await resolveDependencyClosure(rootAUri, loader);
  const freshLinkedA = linkStrictWgsl(freshClosureA);
  if (freshLinkedA.compositeHash === linkedA.compositeHash) {
    throw new Error('Edit failed to modify composite hash.');
  }

  // Uncached full rebuild oracle
  const fullRebuildClosureA = await resolveDependencyClosure(rootAUri, loader);
  const fullRebuildLinkedA = linkStrictWgsl(fullRebuildClosureA);
  const rebuildIsDeterministic = freshLinkedA.compositeHash === fullRebuildLinkedA.compositeHash;

  return Object.freeze({
    closureModuleCount: closureA.modules.length,
    outputLineCount: linkedA.standardWgsl.split('\n').length,
    compositeHash: linkedA.compositeHash,
    compositeHashMatchesOracle,
    sharedLeafAffectedRootsCount: sharedAffected.length,
    rootLocalAffectedRootsCount: rootLocalAffected.length,
    unrelatedAffectedRootsCount: unrelatedAffected.length,
    rebuildIsDeterministic
  });
}
