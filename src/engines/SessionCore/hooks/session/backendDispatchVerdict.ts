/**
 * Backend statuses that mean a turn is genuinely still executing.
 * Interactive waits remain busy so natural follow-ups cannot enter a blocked
 * turn.
 */
const BACKEND_ACTIVE_STATUSES = new Set([
  "running",
  "installing",
  "waiting_for_user",
  "waiting_for_funds",
]);

/**
 * Failure-class terminal statuses. A natural queue drain must park instead of
 * dispatching into a session whose scheduler can no longer run a turn.
 * Completed and cancelled sessions remain dispatchable.
 */
const BACKEND_DEAD_STATUSES = new Set([
  "failed",
  "error",
  "timeout",
  "killed",
  "abandoned",
  "archived",
]);

export type BackendDispatchVerdict = "busy" | "dead" | "ready";

export function classifyBackendSessionStatus(
  status: string | undefined | null
): BackendDispatchVerdict {
  if (!status) return "ready";
  if (BACKEND_ACTIVE_STATUSES.has(status)) return "busy";
  if (BACKEND_DEAD_STATUSES.has(status)) return "dead";
  return "ready";
}
