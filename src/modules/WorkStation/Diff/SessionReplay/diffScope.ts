/**
 * diffScope
 *
 * Pure (React-free) logic backing the chat `TurnMetadataFooter` "Review"
 * affordance. The Agent Station diff is always cumulative (issue #24): a
 * "Review"/file click no longer narrows the file list to one round, it only
 * scrolls the cumulative list to the clicked file. These helpers decide
 * whether such a scroll request applies to the session on screen and which
 * file (if any) to scroll to — unit-testable without rendering the diff app.
 *
 * Scope semantics (see `simulatorDiffScopeRequestAtom`):
 * - `null` scope, empty `filePaths`, or a session mismatch → inactive (no
 *   scroll target).
 * - active scope with a `selectedPath` in its set → scroll to that file.
 */
import type { SimulatorDiffScopeRequest } from "@src/store/ui/simulatorAtom";

/**
 * A scope is active only when it carries at least one path AND (when it
 * declares a session) that session matches the one currently on screen. The
 * session guard makes scope self-clearing across session switches: a stale
 * scope tied to a previous session simply becomes inactive.
 */
export function isDiffScopeActive(
  scope: SimulatorDiffScopeRequest | null | undefined,
  currentSessionId: string | null | undefined
): boolean {
  if (!scope) return false;
  if (!scope.filePaths || scope.filePaths.length === 0) return false;
  if (
    scope.sessionId &&
    currentSessionId &&
    scope.sessionId !== currentSessionId
  ) {
    return false;
  }
  return true;
}

/**
 * The path the diff app should scroll to / focus when a scope opens. Only the
 * clicked row (`selectedPath`) qualifies, and only when it is part of the
 * scope set. Returns `null` for the bare "Review" case (no single file) or an
 * inactive scope.
 */
export function resolveScopedSelectedPath(
  scope: SimulatorDiffScopeRequest | null | undefined,
  currentSessionId: string | null | undefined
): string | null {
  if (!isDiffScopeActive(scope, currentSessionId)) return null;
  const selected = scope!.selectedPath;
  if (selected && scope!.filePaths.includes(selected)) return selected;
  return null;
}
