/**
 * Event-id namespacing for imported/forked session copies.
 *
 * The `events` table PK is `id` alone, and save_events UPSERTs
 * ON CONFLICT(id) DO UPDATE SET session_id — so two local copies that inherit
 * the SAME source event id (a fork and its parent import, both derived from
 * one source) can never both hold it; the last writer steals the row. Every
 * copy's event ids are namespaced by its local session id so id-spaces stay
 * disjoint and both copies persist independently.
 *
 * The delimiter must stay colon-free: parseActivityId splits on ":", and a
 * namespaced id must classify identically to the bare id it wraps. Local
 * session ids are colon-free, so a "~" prefix preserves the colon count.
 */
const COPY_ID_DELIMITER = "~";

export function namespaceCopyEventId(
  localSessionId: string,
  originalId: string
): string {
  const prefix = `${localSessionId}${COPY_ID_DELIMITER}`;
  return originalId.startsWith(prefix) ? originalId : `${prefix}${originalId}`;
}

export function stripCopyEventNamespace(
  localSessionId: string,
  namespacedId: string
): string {
  const prefix = `${localSessionId}${COPY_ID_DELIMITER}`;
  return namespacedId.startsWith(prefix)
    ? namespacedId.slice(prefix.length)
    : namespacedId;
}
