import type { RHICommandBuffer } from '../command-types';
import type { RHIQueue } from '../device-types';
import type { RHIResource } from '../resource-types';
import type { RHISubmission, RHISubmissionStatus } from '../submission-types';
import { WebGL2CommandBuffer } from './command';
import { WebGL2Metrics, type WebGL2MetricsSnapshot } from './metrics';
import type { WebGL2NativeContextPort, WebGL2NativeObject } from './native-types';
import { WebGL2ReplayExecutor } from './replay';
import {
  WebGL2ResourceBase,
  WebGL2TextureView,
  assertWebGL2Resource,
  releaseWebGL2Native
} from './resource';
import type { WebGL2DeviceOwner } from './resource-types';
import { WebGL2Submission } from './submission';
import { WebGL2UploadQueue } from './upload';

interface PendingEpoch {
  readonly submission: WebGL2Submission;
  readonly resources: Set<WebGL2ResourceBase>;
}

interface DeferredRelease {
  readonly handle: WebGL2NativeObject;
  readonly owned: boolean;
}

type TerminalStatus = Exclude<RHISubmissionStatus, 'pending'>;

export class WebGL2Queue extends WebGL2UploadQueue implements RHIQueue {
  private readonly pending = new Map<number, PendingEpoch>();
  private readonly leaseCounts = new Map<WebGL2ResourceBase, number>();
  private readonly deferredReleases = new Map<WebGL2ResourceBase, DeferredRelease>();
  private readonly replay: WebGL2ReplayExecutor;
  private nextSubmissionId = 1;
  private submittedCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private deviceLostCount = 0;
  private lossHandled = false;

  constructor(owner: WebGL2DeviceOwner, native: WebGL2NativeContextPort) {
    const metrics = new WebGL2Metrics();
    super(owner, native, metrics);
    this.replay = new WebGL2ReplayExecutor(owner, native, metrics);
  }

  submit(commandBuffers: readonly RHICommandBuffer[]): RHISubmission {
    if (this.owner.state !== 'live') throw new Error('WebGL2Queue belongs to a lost device.');
    const validated: WebGL2CommandBuffer[] = [];
    const resources = new Set<WebGL2ResourceBase>();
    const seen = new Set<RHICommandBuffer>();

    // No command is marked or replayed until every buffer and lease in the logical batch is valid.
    for (const commandBuffer of commandBuffers) {
      const webgl2CommandBuffer = assertWebGL2CommandBuffer(commandBuffer, this.owner);
      if (seen.has(commandBuffer)) {
        throw new Error(`Command buffer "${commandBuffer.label ?? 'command-buffer'}" has already been submitted.`);
      }
      seen.add(commandBuffer);
      webgl2CommandBuffer.assertReadyForSubmit();
      resources.add(webgl2CommandBuffer);
      for (const lease of webgl2CommandBuffer.getLeasedResources()) {
        addResourceAndDependencies(resources, lease, this.owner);
      }
      validated.push(webgl2CommandBuffer);
    }

    const submission = new WebGL2Submission(this.nextSubmissionId++);
    const epoch = { submission, resources };
    for (const commandBuffer of validated) commandBuffer.markSubmitted();
    for (const resource of resources) this.retain(resource);
    this.pending.set(submission.id, epoch);
    this.submittedCount += 1;

    try {
      for (const commandBuffer of validated) this.replay.execute(commandBuffer.getReplayCommands());
      this.beginCompletion(epoch);
    } catch (error) {
      // A failed GL call may have changed driver state before throwing; no cached slot remains trustworthy.
      this.replay.state.invalidate();
      this.settle(epoch, 'failed', error);
    }
    return submission;
  }

  metrics(): WebGL2MetricsSnapshot {
    let leasedResources = 0;
    for (const epoch of this.pending.values()) leasedResources += epoch.resources.size;
    return Object.freeze({
      submitted: this.submittedCount,
      pending: this.pending.size,
      completed: this.completedCount,
      failed: this.failedCount,
      deviceLost: this.deviceLostCount,
      leasedResources,
      submissionEpochs: this.submittedCount,
      logicalDraws: this.webgl2Metrics.logicalDraws,
      physicalDraws: this.webgl2Metrics.physicalDraws,
      glCalls: this.webgl2Metrics.glCalls,
      stateSkips: this.webgl2Metrics.stateSkips,
      multiDrawMerges: 0,
      programCacheHits: this.webgl2Metrics.programCacheHits,
      programCacheMisses: this.webgl2Metrics.programCacheMisses,
      framebufferCacheHits: this.webgl2Metrics.framebufferCacheHits,
      framebufferCacheMisses: this.webgl2Metrics.framebufferCacheMisses,
      vertexArrayCacheHits: this.webgl2Metrics.vertexArrayCacheHits,
      vertexArrayCacheMisses: this.webgl2Metrics.vertexArrayCacheMisses,
      uploadBytes: this.webgl2Metrics.uploadBytes,
      syncLag: this.pending.size,
      contextLosses: this.webgl2Metrics.contextLosses
    });
  }

  disposeResource(resource: WebGL2ResourceBase, handle: WebGL2NativeObject, owned: boolean): void {
    if ((this.leaseCounts.get(resource) ?? 0) > 0) {
      this.deferredReleases.set(resource, { handle, owned });
      return;
    }
    if (this.owner.state === 'live') releaseWebGL2Native(this.native, resource, handle, owned);
  }

  invalidateExternalState(): void {
    if (this.owner.state !== 'live') throw new Error('WebGL2 context control belongs to a lost device.');
    this.replay.invalidateExternalState();
  }

  handleDeviceLoss(reason: 'destroyed' | 'context-lost'): void {
    if (this.lossHandled) return;
    this.lossHandled = true;
    this.replay.handleContextLoss();
    if (reason === 'context-lost') this.webgl2Metrics.recordContextLoss();
    for (const epoch of [...this.pending.values()]) this.settle(epoch, 'device-lost');
  }

  private beginCompletion(epoch: PendingEpoch): void {
    const createFence = this.native.createSubmissionFence;
    if (createFence === undefined) {
      void Promise.resolve().then(() => this.settle(epoch, 'completed'));
      return;
    }
    let completion: Promise<void>;
    try {
      completion = createFence.call(this.native);
      this.webgl2Metrics.recordGLCall();
    } catch (error) {
      this.settle(epoch, 'failed', error);
      return;
    }
    void completion.then(
      () => this.settle(epoch, 'completed'),
      (error: unknown) => this.settle(epoch, 'failed', error)
    );
  }

  private retain(resource: WebGL2ResourceBase): void {
    this.leaseCounts.set(resource, (this.leaseCounts.get(resource) ?? 0) + 1);
  }

  private release(resource: WebGL2ResourceBase): void {
    const next = (this.leaseCounts.get(resource) ?? 1) - 1;
    if (next > 0) {
      this.leaseCounts.set(resource, next);
      return;
    }
    this.leaseCounts.delete(resource);
    const deferred = this.deferredReleases.get(resource);
    if (deferred === undefined) return;
    this.deferredReleases.delete(resource);
    if (this.owner.state === 'live') {
      releaseWebGL2Native(this.native, resource, deferred.handle, deferred.owned);
    }
  }

  private settle(epoch: PendingEpoch, status: TerminalStatus, error?: unknown): void {
    if (!this.pending.delete(epoch.submission.id)) return;
    for (const resource of epoch.resources) this.release(resource);
    if (status === 'completed') this.completedCount += 1;
    if (status === 'failed') this.failedCount += 1;
    if (status === 'device-lost') this.deviceLostCount += 1;
    epoch.submission.settle(status, error);
  }
}

function addResourceAndDependencies(
  resources: Set<WebGL2ResourceBase>,
  resource: RHIResource,
  owner: WebGL2DeviceOwner
): void {
  const wrapper = assertWebGL2Resource(resource, owner);
  resources.add(wrapper);
  // Texture views alias their texture handle, so retaining only the non-owning view is insufficient.
  if (wrapper instanceof WebGL2TextureView) resources.add(assertWebGL2Resource(wrapper.texture, owner));
}

function assertWebGL2CommandBuffer(
  commandBuffer: RHICommandBuffer,
  owner: WebGL2DeviceOwner
): WebGL2CommandBuffer {
  assertWebGL2Resource(commandBuffer, owner);
  if (!(commandBuffer instanceof WebGL2CommandBuffer)) {
    throw new Error('WebGL2Queue only accepts command buffers created by WebGL2Device.');
  }
  return commandBuffer;
}
