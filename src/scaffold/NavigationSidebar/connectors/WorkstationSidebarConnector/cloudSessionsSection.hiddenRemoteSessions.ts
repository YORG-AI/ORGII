/**
 * localStorage-backed "hidden remote session" bookkeeping for the cloud
 * Team Sessions section (`cloudSessionsSection.tsx`). A viewer's row-menu
 * "Remove" action hides a teammate row locally without touching the shared
 * cloud record; this is the persisted id set that survives reload.
 */
export const HIDDEN_REMOTE_SESSIONS_STORAGE_KEY =
  "orgii:org2-cloud-v1:hidden-remote-sessions";

export function readHiddenRemoteSessionIds(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(
      localStorage.getItem(HIDDEN_REMOTE_SESSIONS_STORAGE_KEY) ?? "[]"
    );
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []
    );
  } catch {
    return new Set();
  }
}

export function hiddenRemoteSessionKey(orgId: string, rowId: string): string {
  return `${orgId}|${rowId}`;
}
