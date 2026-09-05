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
export class AetherSceneHost {
  private inFlightOperation: Promise<void> = Promise.resolve();
  private currentScene: MountedAetherScene | null = null;
  private currentCanvas: HTMLCanvasElement | null = null;
  private abortController: AbortController | null = null;
  private generation = 0;

  /**
   * Mounts the Aether scene on the specified canvas.
   * If a mount or teardown is already in flight, this operation queues behind it.
   */
  async mount(
    canvas: HTMLCanvasElement,
    options: AetherSceneOptions = {}
  ): Promise<MountedAetherScene> {
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
          await oldScene.destroy();
        }

        if (controller.signal.aborted || this.generation !== mountGen) {
          throw new Error('Scene mount cancelled by subsequent lifecycle event.');
        }

        const scene = await mountAetherScene(canvas, options);

        if (controller.signal.aborted || this.generation !== mountGen) {
          await scene.destroy();
          throw new Error('Scene mount cancelled during initialization.');
        }

        this.currentScene = scene;
        this.currentCanvas = canvas;
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
  get activeScene(): MountedAetherScene | null {
    return this.currentScene;
  }
}
