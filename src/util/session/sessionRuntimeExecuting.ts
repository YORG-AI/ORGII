const SESSION_ENGINE_ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "installing",
  "waiting_for_user",
  "waiting_for_funds",
]);

/**
 * Returns whether a session turn is open, including interactive waits where the
 * provider has not released the turn yet.
 */
export function isSessionEngineActiveStatus(
  status: string | undefined | null
): boolean {
  return status != null && SESSION_ENGINE_ACTIVE_STATUSES.has(status);
}

/** Returns whether a backend worker is actively attached to the session. */
export function isSessionRuntimeExecuting(
  status: string | undefined | null
): boolean {
  return status === "running" || status === "installing";
}
