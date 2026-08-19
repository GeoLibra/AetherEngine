import type { CommandBuffer } from '../ecs/command';

export interface StateTransition<S> {
  readonly from: S;
  readonly to: S;
  readonly reason: string;
}

export interface StateTransitionContext {
  readonly commands?: CommandBuffer;
}

export interface StateHooks<S> {
  readonly onExit?: (transition: StateTransition<S>, context: StateTransitionContext) => void;
  readonly onCleanup?: (transition: StateTransition<S>, context: StateTransitionContext) => void;
  readonly onEnter?: (transition: StateTransition<S>, context: StateTransitionContext) => void;
}

interface StateRequest<S> {
  readonly to: S;
  readonly reason: string;
}

export class StateStore<S> {
  private value: S;
  private readonly queue: StateRequest<S>[] = [];
  private readonly applied: StateTransition<S>[] = [];
  private applying = false;

  constructor(
    initial: S,
    private readonly hooks: Readonly<StateHooks<S>> = {}
  ) {
    this.value = initial;
  }

  get current(): S {
    return this.value;
  }

  get pending(): number {
    return this.queue.length;
  }

  get history(): readonly StateTransition<S>[] {
    return Object.freeze([...this.applied]);
  }

  request(to: S, reason: string): boolean {
    if (this.applying) {
      throw new Error('State transition cannot be requested during transition hooks.');
    }
    const effective = this.queue.at(-1)?.to ?? this.value;
    if (Object.is(to, effective)) {
      return false;
    }
    if (reason.trim() === '') {
      throw new Error('State transition reason must not be empty.');
    }
    this.queue.push({ to, reason });
    return true;
  }

  applyNext(commands?: CommandBuffer): StateTransition<S> | undefined {
    const request = this.queue[0];
    if (!request) {
      return undefined;
    }
    const transition = Object.freeze({
      from: this.value,
      to: request.to,
      reason: request.reason
    });

    this.applying = true;
    const context: StateTransitionContext = Object.freeze(
      commands === undefined ? {} : { commands }
    );
    try {
      this.hooks.onExit?.(transition, context);
      this.hooks.onCleanup?.(transition, context);
      this.value = request.to;
      try {
        this.hooks.onEnter?.(transition, context);
      } catch (error) {
        this.value = transition.from;
        throw error;
      }
    } finally {
      this.applying = false;
    }

    this.queue.shift();
    this.applied.push(transition);
    return transition;
  }

  applyAll(commands?: CommandBuffer): readonly StateTransition<S>[] {
    const transitions: StateTransition<S>[] = [];
    while (this.queue.length > 0) {
      const transition = this.applyNext(commands);
      if (transition) {
        transitions.push(transition);
      }
    }
    return Object.freeze(transitions);
  }
}
