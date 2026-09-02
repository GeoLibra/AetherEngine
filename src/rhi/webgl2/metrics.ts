import type { RHIQueueMetrics } from '../contracts/submission';

export interface WebGL2MetricsSnapshot extends RHIQueueMetrics {
  readonly submissionEpochs: number;
  readonly logicalDraws: number;
  readonly physicalDraws: number;
  readonly glCalls: number;
  readonly stateSkips: number;
  readonly multiDrawMerges: number;
  readonly programCacheHits: number;
  readonly programCacheMisses: number;
  readonly framebufferCacheHits: number;
  readonly framebufferCacheMisses: number;
  readonly vertexArrayCacheHits: number;
  readonly vertexArrayCacheMisses: number;
  readonly uploadBytes: number;
  readonly syncLag: number;
  readonly contextLosses: number;
  readonly lastFailure?: string;
}

export class WebGL2Metrics {
  logicalDraws = 0;
  physicalDraws = 0;
  glCalls = 0;
  stateSkips = 0;
  uploadBytes = 0;
  programCacheHits = 0;
  programCacheMisses = 0;
  contextLosses = 0;
  framebufferCacheHits = 0;
  framebufferCacheMisses = 0;
  vertexArrayCacheHits = 0;
  vertexArrayCacheMisses = 0;

  recordLogicalDraw(): void {
    this.logicalDraws += 1;
  }
  recordPhysicalDraw(): void {
    this.physicalDraws += 1;
  }
  recordGLCall(): void {
    this.glCalls += 1;
  }
  recordStateSkip(): void {
    this.stateSkips += 1;
  }
  recordUpload(byteLength: number): void {
    this.uploadBytes += byteLength;
  }
  recordProgramCacheHit(): void {
    this.programCacheHits += 1;
  }
  recordProgramCacheMiss(): void {
    this.programCacheMisses += 1;
  }
  recordContextLoss(): void {
    this.contextLosses += 1;
  }
  recordFramebufferCacheHit(): void {
    this.framebufferCacheHits += 1;
  }
  recordFramebufferCacheMiss(): void {
    this.framebufferCacheMisses += 1;
  }
  recordVertexArrayCacheHit(): void {
    this.vertexArrayCacheHits += 1;
  }
  recordVertexArrayCacheMiss(): void {
    this.vertexArrayCacheMisses += 1;
  }
}
