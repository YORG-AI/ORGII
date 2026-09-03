/**
 * Identity + provenance helpers for teammate-session imports: the
 * deterministic local session id, endpoint normalization, snapshot event
 * rewriting and the legacy (pre-M3) metadata lookup.
 *
 * Lives apart from the `collabSyncEngineHelpers` barrel so the import and
 * fork modules can depend on it without a barrel import cycle.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import { sha256Hex } from "../collabSyncUtils";
import { namespaceCopyEventId } from "../copyEventId";

/**
 * Deterministic local session id for a teammate-session import, derived from
 * (endpoint, orgId, sourceSessionId). A FAILED import (durable cache write returned 0)
 * used to mint a fresh random id per retry, leaking one orphaned event-store
 * entry per pull cycle; a deterministic id makes every retry land on the
 * same local id, so an aborted attempt is simply overwritten.
 */
export async function deriveImportedSessionId(
  orgId: string,
  sourceSessionId: string,
  sourceEndpointUrl = "unknown-cloud-endpoint"
): Promise<string> {
  const digest = await sha256Hex(
    `${normalizeSourceEndpointUrl(sourceEndpointUrl)}:${orgId}:${sourceSessionId}`
  );
  return `imported-session-${digest.slice(0, 32)}`;
}

export function normalizeSourceEndpointUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function rewriteEventsForImportedSnapshot(
  events: SessionEvent[],
  localSessionId: string
): SessionEvent[] {
  return events.map((event) => ({
    ...event,
    id: namespaceCopyEventId(localSessionId, event.id),
    chunk_id:
      event.chunk_id == null
        ? event.chunk_id
        : namespaceCopyEventId(localSessionId, event.chunk_id),
    sessionId: localSessionId,
  }));
}

/** Legacy (pre-M3) shape: import provenance JSON-encoded in error_message. */
export interface ImportedSessionMetadata {
  originalSessionId?: string;
  orgId?: string;
  ownerMemberId?: string;
  contentHash?: string;
}

/**
 * Legacy fallback only: pre-M3 collab imports stored provenance in
 * `error_message`. New imports carry the first-class `importedFrom` field;
 * this parser exists so those old rows are still FOUND (and upgraded in
 * place on the next import).
 */
export function parseImportedSessionMetadata(
  session: Session
): ImportedSessionMetadata | null {
  if (session.category !== "external_history") return null;
  if (!session.error_message) return null;
  try {
    const parsed = JSON.parse(session.error_message) as ImportedSessionMetadata;
    return parsed;
  } catch {
    return null;
  }
}

export function findImportedSession(
  sessions: readonly Session[],
  orgId: string,
  sourceSessionId: string,
  sourceEndpointUrl = "unknown-cloud-endpoint"
): Session | undefined {
  const endpoint = normalizeSourceEndpointUrl(sourceEndpointUrl);
  return sessions.find((session) => {
    if (
      session.importedFrom?.orgId === orgId &&
      session.importedFrom.sourceSessionId === sourceSessionId &&
      normalizeSourceEndpointUrl(
        session.importedFrom.sourceEndpointUrl ?? "unknown-cloud-endpoint"
      ) === endpoint
    ) {
      return true;
    }
    const meta = parseImportedSessionMetadata(session);
    return meta?.orgId === orgId && meta?.originalSessionId === sourceSessionId;
  });
}
