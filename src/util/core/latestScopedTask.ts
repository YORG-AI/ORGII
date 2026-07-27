export interface ScopedTaskContext {
  readonly generation: number;
  isCurrent(): boolean;
}

interface ActiveScopedTask<T> {
  key: string;
  promise: Promise<T>;
}

/**
 * Join equal async scopes while allowing a changed scope to supersede them.
 *
 * Callers use `context.isCurrent()` before committing results so late
 * responses from a previous filter/project cannot overwrite newer state.
 */
export class LatestScopedTask {
  private active?: ActiveScopedTask<unknown>;
  private generation = 0;

  run<T>(
    key: string,
    operation: (context: ScopedTaskContext) => Promise<T>
  ): Promise<T> {
    if (this.active?.key === key) {
      return this.active.promise as Promise<T>;
    }

    const generation = ++this.generation;
    const context: ScopedTaskContext = {
      generation,
      isCurrent: () => this.generation === generation,
    };
    const promise = operation(context);
    this.active = { key, promise };
    const release = () => {
      if (this.active?.promise === promise) {
        this.active = undefined;
      }
    };
    void promise.then(release, release);
    return promise;
  }

  supersede(): void {
    this.generation += 1;
    this.active = undefined;
  }
}
