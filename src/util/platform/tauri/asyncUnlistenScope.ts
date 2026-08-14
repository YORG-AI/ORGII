/**
 * Owns asynchronously-created event listener cleanup handles.
 *
 * Tauri's `listen()` resolves after the native listener is registered. If a
 * React effect is cleaned up before that promise resolves, simply dropping the
 * eventual unlisten handle leaks the native subscription. This scope closes
 * that race and also rolls back earlier registrations when a later one fails.
 */
export type AsyncUnlisten = () => void | Promise<void>;

export class AsyncUnlistenScope {
  private disposed = false;
  private readonly unlisteners = new Set<AsyncUnlisten>();

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Register one listener and retain its cleanup handle while active. */
  async register(register: () => Promise<AsyncUnlisten>): Promise<void> {
    if (this.disposed) return;

    const unlisten = await register();
    if (this.disposed) {
      this.release(unlisten);
      return;
    }
    this.unlisteners.add(unlisten);
  }

  /**
   * Register a group atomically from the caller's perspective. A failure in
   * any registration releases every handle that was already acquired.
   */
  async registerAll(
    registrations: ReadonlyArray<() => Promise<AsyncUnlisten>>
  ): Promise<void> {
    try {
      for (const register of registrations) {
        await this.register(register);
        if (this.disposed) return;
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /** Release every retained handle. Safe to call more than once. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unlisten of this.unlisteners) {
      this.release(unlisten);
    }
    this.unlisteners.clear();
  }

  private release(unlisten: AsyncUnlisten): void {
    try {
      const result = unlisten();
      if (result && typeof result.catch === "function") {
        void result.catch(() => undefined);
      }
    } catch {
      // Cleanup is best-effort and must not mask the original setup failure.
    }
  }
}
