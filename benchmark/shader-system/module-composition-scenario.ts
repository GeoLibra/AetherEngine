/**
 * @file Scenario generator for shader module dependency resolution, linking, and invalidation benchmarks.
 * Based on Section 8 of engine/design/v2/04-rendering/14-shader-modules.md.
 */

import {
  linkStrictWgsl,
  resolveDependencyClosure,
  type ModuleSourceLoader
} from '../../tools/shader-cooker/modules';

export interface ModuleBenchmarkScenarioConfig {
  readonly moduleCount: number;
  readonly linesPerModule?: number;
  readonly topology: 'chain' | 'diamond' | 'fan-out';
}

export interface ModuleBenchmarkScenarioResult {
  readonly closureModuleCount: number;
  readonly outputLineCount: number;
  readonly compositeHash: string;
  readonly invalidationCount: number;
}

export function createSyntheticModuleSet(config: ModuleBenchmarkScenarioConfig): {
  readonly rootUri: string;
  readonly loader: ModuleSourceLoader;
  readonly editModule: (id: string, newContent: string) => void;
} {
  const store = new Map<string, string>();
  const linesPerModule = config.linesPerModule ?? 10;
  const paddingLines = Array.from(
    { length: linesPerModule },
    (_, i) => `  let var_${i}: f32 = ${i}.0;`
  ).join('\n');

  if (config.topology === 'chain') {
    for (let i = 0; i < config.moduleCount; i++) {
      const uri = `asset://bench/mod_${i}.wgsl`;
      const nextUri = i + 1 < config.moduleCount ? `asset://bench/mod_${i + 1}.wgsl` : undefined;
      const importLine = nextUri ? `#import "${nextUri}"\n` : '';
      const content = `${importLine}fn helper_${i}() -> f32 {\n${paddingLines}\n  return ${i}.0;\n}\n`;
      store.set(uri, content);
    }
  } else if (config.topology === 'diamond') {
    // Root -> [Branches...] -> Leaf
    const leafUri = 'asset://bench/leaf.wgsl';
    store.set(leafUri, `fn leaf_func() -> f32 {\n${paddingLines}\n  return 100.0;\n}\n`);
    for (let i = 1; i < config.moduleCount - 1; i++) {
      const uri = `asset://bench/branch_${i}.wgsl`;
      store.set(
        uri,
        `#import "${leafUri}"\nfn branch_${i}() -> f32 {\n${paddingLines}\n  return leaf_func() + ${i}.0;\n}\n`
      );
    }
    const imports = Array.from(
      { length: config.moduleCount - 2 },
      (_, i) => `#import "asset://bench/branch_${i + 1}.wgsl"`
    ).join('\n');
    store.set('asset://bench/root.wgsl', `${imports}\n@fragment fn fs_main() {}\n`);
  } else {
    // Fan-out
    for (let i = 1; i < config.moduleCount; i++) {
      const uri = `asset://bench/leaf_${i}.wgsl`;
      store.set(uri, `fn leaf_${i}() -> f32 {\n${paddingLines}\n  return ${i}.0;\n}\n`);
    }
    const imports = Array.from(
      { length: config.moduleCount - 1 },
      (_, i) => `#import "asset://bench/leaf_${i + 1}.wgsl"`
    ).join('\n');
    store.set('asset://bench/root.wgsl', `${imports}\n@fragment fn fs_main() {}\n`);
  }

  const rootUri =
    config.topology === 'chain' ? 'asset://bench/mod_0.wgsl' : 'asset://bench/root.wgsl';

  const loader: ModuleSourceLoader = {
    loadSource(uri: string) {
      return store.get(uri);
    }
  };

  return {
    rootUri,
    loader,
    editModule(id: string, newContent: string) {
      store.set(id, newContent);
    }
  };
}

export async function runModuleCompositionScenario(
  config: ModuleBenchmarkScenarioConfig
): Promise<ModuleBenchmarkScenarioResult> {
  const { rootUri, loader, editModule } = createSyntheticModuleSet(config);

  // 1. Initial resolution & link
  const closure = await resolveDependencyClosure(rootUri, loader);
  const linked = linkStrictWgsl(closure);

  // 2. Invalidation test: edit the deepest dependency
  const deepestId = closure.modules[0]?.id ?? rootUri;
  editModule(deepestId as string, '// edited\nfn edited() -> f32 { return 1.0; }\n');

  // Invalidate dependent modules
  const dependentSet = new Set<string>();
  function collectDependents(modId: string) {
    const rd = closure.reverseDependencies.get(modId as any) ?? [];
    for (const dep of rd) {
      if (!dependentSet.has(dep)) {
        dependentSet.add(dep);
        collectDependents(dep);
      }
    }
  }
  collectDependents(deepestId as string);

  return Object.freeze({
    closureModuleCount: closure.modules.length,
    outputLineCount: linked.standardWgsl.split('\n').length,
    compositeHash: linked.compositeHash,
    invalidationCount: dependentSet.size
  });
}
