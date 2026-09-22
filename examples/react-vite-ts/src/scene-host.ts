/**
 * @file Serialized lifecycle host for mounting Aether scenes into React components,
 * preventing async race conditions and swapchain corruption in React StrictMode.
 */

import { mountAetherScene, type AetherSceneOptions, type MountedAetherScene } from './aether-scene';

/**
 * Manages serialized mounting and unmounting of an Aether scene on a canvas element.
 *
 * Guarantees:
 * 1. Rapid successive mounts (e.g. React 18 StrictMode double-invoke) are strictly serialized.
 * 2. An in-flight mount from an aborted lifecycle run is awaited and destroyed before the next mount acquires the canvas.
 * 3. Never permits concurrent graphics sessions on the same canvas.
 */
export interface DestroyableScene {
  destroy(): Promise<void>;
}

/** A mounted scene that can be recreated after a recoverable graphics loss. */
interface RecoverableScene extends DestroyableScene {
  readonly lost: Promise<Readonly<{ readonly recreationAllowed: boolean }>>;
  readonly recoveryReady: Promise<void>;
}

export class AetherSceneHost<
  TScene extends DestroyableScene = MountedAetherScene,
  TOptions = AetherSceneOptions
> {
  private inFlightOperation: Promise<void> = Promise.resolve();
  private currentScene: TScene | null = null;
  private currentCanvas: HTMLCanvasElement | null = null;
  private readonly sceneListeners = new Set<(scene: TScene | null) => void>();
  private abortController: AbortController | null = null;
  private generation = 0;
  private readonly mountFn: (canvas: HTMLCanvasElement, options?: TOptions) => Promise<TScene>;

  constructor(mountFn?: (canvas: HTMLCanvasElement, options?: TOptions) => Promise<TScene>) {
    this.mountFn =
      mountFn ??
      ((canvas: HTMLCanvasElement, options?: TOptions) =>
        mountAetherScene(canvas, options as AetherSceneOptions) as unknown as Promise<TScene>);
  }

  /**
   * Mounts the scene on the specified canvas.
   * If a mount or teardown is already in flight, this operation queues behind it.
   */
  async mount(canvas: HTMLCanvasElement, options?: TOptions): Promise<TScene> {
    const mountGen = ++this.generation;
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    // Chain onto in-flight operations to guarantee strictly sequential execution
    const mountTask = this.inFlightOperation
      .catch(() => {})
      .then(async () => {
        // Destroy existing scene if canvas changed or re-mounting
        if (this.currentScene !== null) {
          const oldScene = this.currentScene;
          this.currentScene = null;
          this.currentCanvas = null;
          this.publishScene(null);
          await oldScene.destroy();
        }

        if (controller.signal.aborted || this.generation !== mountGen) {
          throw new Error('Scene mount cancelled by subsequent lifecycle event.');
        }

        const scene = await this.mountFn(canvas, options);

        if (controller.signal.aborted || this.generation !== mountGen) {
          await scene.destroy();
          throw new Error('Scene mount cancelled during initialization.');
        }

        this.currentScene = scene;
        this.currentCanvas = canvas;
        this.publishScene(scene);
        this.scheduleGraphicsRecovery(scene, canvas, options);
        return scene;
      });

    this.inFlightOperation = mountTask.then(() => {}).catch(() => {});
    return mountTask;
  }

  /**
   * Unmounts the current scene, ensuring all in-flight operations complete cleanly.
   */
  async unmount(): Promise<void> {
    this.generation++;
    this.abortController?.abort();
    this.abortController = null;

    const unmountTask = this.inFlightOperation
      .catch(() => {})
      .then(async () => {
        if (this.currentScene !== null) {
          const oldScene = this.currentScene;
          this.currentScene = null;
          this.currentCanvas = null;
          this.publishScene(null);
          await oldScene.destroy();
        }
      });

    this.inFlightOperation = unmountTask;
    await unmountTask;
  }

  /** Checks whether the active scene belongs to the given canvas. */
  isCurrent(canvas: HTMLCanvasElement): boolean {
    return this.currentCanvas === canvas && this.currentScene !== null;
  }

  /** Gets the currently active scene, if any. */
  get activeScene(): TScene | null {
    return this.currentScene;
  }

  /** Subscribes to scene replacement caused by host mounting, unmounting, or graphics recovery. */
  subscribe(listener: (scene: TScene | null) => void): () => boolean {
    this.sceneListeners.add(listener);
    return () => this.sceneListeners.delete(listener);
  }

  private scheduleGraphicsRecovery(
    scene: TScene,
    canvas: HTMLCanvasElement,
    options: TOptions | undefined
  ): void {
    if (!isRecoverableScene(scene)) return;
    void scene.lost
      .then(async (loss) => {
        if (!loss.recreationAllowed) return;
        await scene.recoveryReady;
        if (this.currentScene !== scene || this.currentCanvas !== canvas) return;
        await this.mount(canvas, options);
      })
      // Recovery failure remains owned by the next explicit mount attempt. This prevents an
      // unhandled rejection while preserving serial ownership of the canvas lease.
      .catch(() => {});
  }

  private publishScene(scene: TScene | null): void {
    for (const listener of [...this.sceneListeners]) listener(scene);
  }
}

function isRecoverableScene(scene: DestroyableScene): scene is RecoverableScene {
  const candidate = scene as Partial<RecoverableScene>;
  return candidate.lost instanceof Promise && candidate.recoveryReady instanceof Promise;
}
