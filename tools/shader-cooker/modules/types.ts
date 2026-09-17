/**
 * @file Type definitions and contractual interfaces for the shader module system.
 * Based on engine/design/v2/04-rendering/14-shader-modules.md.
 */

import type { WgslImportRef } from '../../../src/shader/types';

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
 * Declared shader module source accompanied by its explicit metadata imports.
 */
export interface ShaderModuleSource {
  readonly id: ShaderModuleId;
  readonly source: string;
  readonly imports: readonly WgslImportRef[];
}

/**
 * Interface for asynchronously loading a shader module and its metadata imports.
 */
export interface ShaderModuleLoader {
  loadModule(id: ShaderModuleId): Promise<ShaderModuleSource | undefined>;
}

/**
 * Immutable source snapshot of a single module at a specific build revision.
 */
export interface ModuleSourceSnapshot {
  readonly id: ShaderModuleId;
  readonly content: string;
  readonly contentHash: string;
  readonly imports: readonly WgslImportRef[];
  readonly dependencies: readonly ShaderModuleId[];
}

/**
 * Closed dependency graph result for a root module.
 */
export interface DependencyClosure {
  readonly rootId: ShaderModuleId;
  /** Topologically sorted list of modules (dependencies before dependants, root last). */
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
 * Error thrown when resolving shader module identity, metadata, or dependency closure.
 */
export class ShaderModuleResolutionError extends Error {
  readonly code: string;
  readonly moduleId?: ShaderModuleId | undefined;
  readonly relatedModuleIds?: readonly ShaderModuleId[] | undefined;

  constructor(
    message: string,
    code: string,
    moduleId?: ShaderModuleId,
    relatedModuleIds?: readonly ShaderModuleId[]
  ) {
    super(message);
    this.name = 'ShaderModuleResolutionError';
    this.code = code;
    this.moduleId = moduleId;
    this.relatedModuleIds = relatedModuleIds;
  }
}

/** Alias for backward compatibility within tooling. */
export const ModuleResolutionError = ShaderModuleResolutionError;
export type ModuleResolutionError = ShaderModuleResolutionError;

/**
 * Error thrown when linking shader modules into a unified standard WGSL text.
 */
export class ShaderModuleLinkingError extends Error {
  readonly code: string;
  readonly moduleId?: ShaderModuleId | undefined;

  constructor(message: string, code: string, moduleId?: ShaderModuleId) {
    super(message);
    this.name = 'ShaderModuleLinkingError';
    this.code = code;
    this.moduleId = moduleId;
  }
}
