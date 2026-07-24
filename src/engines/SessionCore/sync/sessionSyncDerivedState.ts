export function isDuplicateSessionSyncInvocation(
  sessionId: string,
  reloadEpoch: number,
  previousSessionId: string | null,
  previousReloadEpoch: number
): boolean {
  return previousSessionId === sessionId && previousReloadEpoch === reloadEpoch;
}
