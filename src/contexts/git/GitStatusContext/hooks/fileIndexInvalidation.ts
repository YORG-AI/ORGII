export interface FileIndexInvalidationScheduler {
  schedule(rootPath: string): void;
  dispose(): void;
}

/**
 * Coalesces file-create/delete/rename bursts into one invalidation per root.
 * Invalidating is deliberately cheap: it marks state stale but never scans.
 */
export function createFileIndexInvalidationScheduler(
  invalidate: (rootPath: string) => Promise<void>,
  delayMs = 250,
  onError: (error: unknown) => void = () => undefined
): FileIndexInvalidationScheduler {
  const pendingRoots = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    const roots = [...pendingRoots];
    pendingRoots.clear();

    for (const rootPath of roots) {
      void invalidate(rootPath).catch(onError);
    }
  };

  return {
    schedule(rootPath) {
      if (disposed || !rootPath) return;
      pendingRoots.add(rootPath);
      if (timer) return;
      timer = setTimeout(flush, delayMs);
    },
    dispose() {
      disposed = true;
      pendingRoots.clear();
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/** Content-only modifications do not change a file-path index. */
export function fileChangeInvalidatesPathIndex(kind: unknown): boolean {
  return typeof kind !== "string" || kind !== "modified";
}

export function repoChangeInvalidatesPathIndex(changeType: unknown): boolean {
  return changeType === "files";
}
