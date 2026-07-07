const SESSION_ENGINE_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "installing",
  "waiting_for_user",
  "waiting_for_funds",
]);

/**
 * Composer / queue gate: the session turn is open and the Stop button should
 * stay visible. Includes interactive-wait statuses where the provider has not
 * yet released the turn.
 *
 * Distinct from `isSessionInProgress` (sidebar row spinners — broader set
 * including queued/pending) and `isSessionRuntimeExecuting` (narrow worker-
 * attached gate — running/installing only).
 */
export function isSessionEngineActiveStatus(
  status: string | undefined | null
): boolean {
  return (
    status !== undefined &&
    status !== null &&
    SESSION_ENGINE_ACTIVE_STATUSES.has(status)
  );
}

/**
 * Narrow runtime gate for sessions whose backend worker is actively attached.
 *
 * Distinct from `isSessionInProgress` (sidebar rows) and
 * `isSessionEngineActiveStatus` (composer stop/send — also includes
 * waiting_for_user / waiting_for_funds).
 */
export function isSessionRuntimeExecuting(
  status: string | undefined | null
): boolean {
  return status === "running" || status === "installing";
}
