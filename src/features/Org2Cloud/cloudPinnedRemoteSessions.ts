/**
 * localStorage-backed "pinned remote session" bookkeeping for cloud Team
 * Sessions, mirroring `cloudHiddenRemoteSessions`.
 *
 * A pin is the viewer's own view state, not a property of the shared record:
 * pinning a teammate's session must never mutate the cloud row, and two
 * viewers of the same session pin independently. That is why this lives
 * beside the hidden-row set rather than going through `session_patch` — a
 * Team Session has no local row to patch, and `cloudremote-` ids resolve to
 * nothing in `agent_sessions` / `code_sessions`.
 *
 * Keyed on `<orgId>|<rowId>` — the same stable pair the sidebar already
 * encodes in every `cloudremote-` menu item id.
 */
export const PINNED_REMOTE_SESSIONS_STORAGE_KEY =
  "orgii:org2-cloud-v1:pinned-remote-sessions";

export function readPinnedRemoteSessionIds(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(
      localStorage.getItem(PINNED_REMOTE_SESSIONS_STORAGE_KEY) ?? "[]"
    );
    return new Set(
      Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []
    );
  } catch {
    return new Set();
  }
}

export function writePinnedRemoteSessionIds(ids: ReadonlySet<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      PINNED_REMOTE_SESSIONS_STORAGE_KEY,
      JSON.stringify([...ids])
    );
  } catch {
    // Best-effort persistence only.
  }
}

export function pinnedRemoteSessionKey(orgId: string, rowId: string): string {
  return `${orgId}|${rowId}`;
}

export function isRemoteSessionPinned(
  pinnedKeys: ReadonlySet<string>,
  orgId: string,
  rowId: string
): boolean {
  return pinnedKeys.has(pinnedRemoteSessionKey(orgId, rowId));
}

/**
 * Toggle one row's pin and return the next set. Returns a new Set so callers
 * can hand it straight to React state without mutating the current value.
 */
export function togglePinnedRemoteSession(
  pinnedKeys: ReadonlySet<string>,
  orgId: string,
  rowId: string
): Set<string> {
  const key = pinnedRemoteSessionKey(orgId, rowId);
  const next = new Set(pinnedKeys);
  if (!next.delete(key)) next.add(key);
  return next;
}
