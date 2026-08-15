export interface NestedMutableExposure {
  readonly location: string;
  readonly propertyPath: string;
  readonly kind: string;
}

export interface FreezeCallAudit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly argumentKind: string;
  readonly enclosingFunction: string | null;
  readonly argumentIsFunctionParameter: boolean;
  readonly category: string | null;
  readonly nestedMutableBuiltIns: readonly NestedMutableExposure[];
}

export interface FreezeAudit {
  readonly total: number;
  readonly byArgumentKind: Readonly<Record<string, number>>;
  readonly banned: Readonly<Record<string, readonly FreezeCallAudit[]>>;
  readonly nestedMutableBuiltIns: readonly (NestedMutableExposure & {
    readonly path: string;
    readonly line: number;
    readonly column: number;
  })[];
  readonly calls: readonly FreezeCallAudit[];
}

export function sourceFiles(directory: string): readonly string[];
export function analyzeFreezeSource(
  sourceText: string,
  path?: string,
  sourceRoot?: string
): readonly FreezeCallAudit[];
export function analyzeProductionFreeze(sourceRoot?: string): readonly FreezeCallAudit[];
export function auditProductionFreeze(sourceRoot?: string): FreezeAudit;
