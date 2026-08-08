/**
 * Cancel handles for in-flight cloud session downloads, keyed by the remote
 * row id — the progress card's Cancel button reaches the right
 * AbortController for the manual replay transfer. Functions cannot live in
 * Jotai state, so this is a plain module registry mirroring the busy atom's
 * keys.
 */
const abortsByRowId = new Map<string, () => void>();

export function registerCloudDownloadAbort(
  rowId: string,
  abort: () => void
): void {
  abortsByRowId.set(rowId, abort);
}

export function unregisterCloudDownloadAbort(rowId: string): void {
  abortsByRowId.delete(rowId);
}

/** Returns true when an in-flight download existed and was signalled. */
export function cancelCloudSessionDownload(rowId: string): boolean {
  const abort = abortsByRowId.get(rowId);
  if (!abort) return false;
  abortsByRowId.delete(rowId);
  abort();
  return true;
}
