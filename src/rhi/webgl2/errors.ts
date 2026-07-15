export class WebGL2ProgramCreationError extends Error {
  readonly code = 'rhi/webgl2-program-creation-failed' as const;

  constructor(
    readonly pipelineLabel: string | undefined,
    override readonly cause: unknown
  ) {
    super(`WebGL2 failed to create program for pipeline "${pipelineLabel ?? 'unlabeled'}".`);
    this.name = 'WebGL2ProgramCreationError';
  }
}
