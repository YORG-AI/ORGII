interface LatestOnlySearchRunner<TRequest> {
  submit: (request: TRequest) => Promise<void>;
  clearPending: () => void;
  dispose: () => void;
}

/**
 * Run at most one expensive search at a time while retaining only the newest
 * request that arrives during the active call. This bounds both backend work
 * and retained request state without adding a timer or app-lifetime cache.
 */
export function createLatestOnlySearchRunner<TRequest>(
  execute: (request: TRequest) => Promise<void>
): LatestOnlySearchRunner<TRequest> {
  let active: Promise<void> | null = null;
  let pending: TRequest | null = null;
  let disposed = false;

  const drain = async (initial: TRequest) => {
    let current: TRequest | null = initial;
    while (current !== null && !disposed) {
      pending = null;
      await execute(current);
      current = pending;
    }
  };

  const submit = (request: TRequest): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (active) {
      pending = request;
      return active;
    }

    active = drain(request).finally(() => {
      active = null;
      pending = null;
    });
    return active;
  };

  return {
    submit,
    clearPending: () => {
      pending = null;
    },
    dispose: () => {
      disposed = true;
      pending = null;
    },
  };
}
