/**
 * @file Type definitions and contractual interfaces for the shader module system.
 * Based on engine/design/v2/04-rendering/14-shader-modules.md.
 */

/**
 * Unique canonical URI identifier of a shader module (e.g. `asset://aether/shared/uv.wgsl`).
 */
export type ShaderModuleId = string & { readonly __brand: unique symbol };

/**
 * Creates a branded ShaderModuleId from a validated URI string.
 */
export function createShaderModuleId(uri: string): ShaderModuleId {
  if (!uri || !uri.trim()) {
    throw new Error('ShaderModuleId cannot be empty');
  }
  return uri.trim() as ShaderModuleId;
}

/**
 * Source coordinate span within an authored module or composed output.
 */
export interface SourceSpan {
  readonly line: number;
  readonly column?: number | undefined;
  readonly length?: number | undefined;
}

/**
 * Declared import reference inside an authored WGSL source.
 */
export interface ModuleImportDeclaration {
  /** Raw import specifier as authored in source (e.g. `./uv.wgsl` or `asset://aether/shared/uv.wgsl`). */
  readonly rawSpecifier: string;
  /** Canonical resolved module ID after path normalization. */
  readonly resolvedId: ShaderModuleId;
  /** Source span where the import was declared in the importing module. */
  readonly span: SourceSpan;
}

/**
 * Immutable source snapshot of a single module at a specific build revision.
 */
export interface ModuleSourceSnapshot {
  readonly id: ShaderModuleId;
  readonly content: string;
  readonly contentHash: string;
  /** Explicit imported references declared by this module. */
  readonly imports: readonly ModuleImportDeclaration[];
  /** Compiler directives parsed at module level (e.g. `enable f16;`, `diagnostic(off, derivative_uniformity);`). */
  readonly directives: readonly string[];
}

/**
 * Closed dependency graph result for a root module.
 */
export interface DependencyClosure {
  readonly rootId: ShaderModuleId;
  /** Topologically sorted list of modules (dependencies before dependants). */
  readonly modules: readonly ModuleSourceSnapshot[];
  /** Map from module ID to list of downstream modules that directly depend on it. */
  readonly reverseDependencies: ReadonlyMap<ShaderModuleId, readonly ShaderModuleId[]>;
  /** Composite digest representing all participating module IDs and contents. */
  readonly compositeHash: string;
}

/**
 * Mapped segment in the linked standard WGSL.
 */
export interface LinkedSourceSegment {
  readonly moduleId: ShaderModuleId;
  /** 1-based starting line in the generated WGSL. */
  readonly outputStartLine: number;
  /** 1-based ending line in the generated WGSL (inclusive). */
  readonly outputEndLine: number;
  /** 1-based starting line in the original source module. */
  readonly sourceStartLine: number;
}

/**
 * Result of linking a dependency closure into standard WGSL.
 */
export interface LinkedWgslResult {
  readonly standardWgsl: string;
  readonly rootId: ShaderModuleId;
  readonly segments: readonly LinkedSourceSegment[];
  readonly hoistedDirectives: readonly string[];
  readonly compositeHash: string;
}

/**
 * Structured diagnostic produced during module resolution, linking, or validation.
 */
export interface ModuleDiagnostic {
  readonly stage: 'resolve' | 'link' | 'validate' | 'reflect';
  readonly code: string;
  readonly message: string;
  readonly moduleId?: ShaderModuleId | undefined;
  readonly span?: SourceSpan | undefined;
  readonly relatedSpans?:
    | readonly {
        readonly moduleId: ShaderModuleId;
        readonly span: SourceSpan;
        readonly message?: string;
      }[]
    | undefined;
}

/**
 * Interface for loading shader module contents from an arbitrary storage layer.
 */
export interface ModuleSourceLoader {
  loadSource(uri: string): Promise<string | undefined> | string | undefined;
}
