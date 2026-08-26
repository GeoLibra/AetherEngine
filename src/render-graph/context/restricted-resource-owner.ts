import type { RHIResource, RHISubmission } from '../../rhi/contracts';

/** Owns pass-created RHI objects until failure or the accepted submission becomes terminal. */
export class RestrictedResourceOwner {
  private readonly resources: RHIResource[] = [];
  private retired = false;

  constructor(private readonly requireOpen: (action: string) => void) {}

  create<T extends RHIResource>(action: string, create: () => T): T {
    this.requireOpen(action);
    return this.own(create());
  }

  own<T extends RHIResource>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  retire(submission: RHISubmission): void {
    if (this.retired) return;
    this.retired = true;
    void submission.done.then(
      () => this.disposeAll(),
      () => this.disposeAll()
    );
  }

  disposeBeforeSubmit(): void {
    if (this.retired) return;
    this.retired = true;
    this.disposeAll();
  }

  private disposeAll(): void {
    for (let index = this.resources.length - 1; index >= 0; index -= 1) {
      this.resources[index]?.dispose();
    }
    this.resources.length = 0;
  }
}
