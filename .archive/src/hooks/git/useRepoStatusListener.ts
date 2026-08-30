/**
 * useRepoStatusListener
 *
 * Subscribes to the `repo:status_updated` WebSocket event for a specific
 * repository and calls `onUpdate` (debounced) whenever the backend signals
 * that the repo's working-tree status has changed.
 *
 * Centralises the three-line boilerplate that was copy-pasted into
 * usePerRepoSourceControl and useSessionDiff:
 *
 *   const ws = getCodeEditorWebSocket();
 *   ws.on("repo:status_updated", (data) => {
 *     if (payload.repo_id === repoId) debouncedFetch();
 *   });
 *
 * The callback passed by the caller is already expected to be stable
 * (e.g. a debounced function). The effect only re-registers when `repoId`
 * changes, so callers avoid redundant listener churn.
 */
import { useEffect } from "react";

import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";

/**
 * @param repoId   - Repository to watch. Pass `null` / empty string to
 *                   skip registration entirely (hook is a no-op).
 * @param onUpdate - Stable callback invoked when the repo's status changes.
 *                   Pass a debounced function to avoid rapid re-fetches.
 */
export function useRepoStatusListener(
  repoId: string | null | undefined,
  onUpdate: () => void
): void {
  useEffect(() => {
    if (!repoId) return;

    const ws = getCodeEditorWebSocket();
    if (!ws) return;

    let cancelled = false;

    const unsubscribe = ws.on("repo:status_updated", (data: unknown) => {
      if (cancelled) return;
      if (document.hidden) return;
      const payload = data as { repo_id?: string };
      if (payload.repo_id === repoId) onUpdate();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [repoId, onUpdate]);
}
