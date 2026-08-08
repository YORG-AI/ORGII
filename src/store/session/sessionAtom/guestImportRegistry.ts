/**
 * Compatibility boundary for guest share-token imports.
 *
 * The generalized client-created session registry now owns durability and
 * roster projection for every local creation. These helpers preserve the
 * guest capability-specific call sites while routing storage through that
 * single owner.
 */
import {
  __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS,
  mergeClientCreatedSessions,
  recordClientCreatedSession,
  removeClientCreatedSession,
} from "./createdSessionRegistry";
import type { Session } from "./types";

/** No-op unless the row carries a share-token capability (guest import). */
export function recordGuestImportedSession(session: Session): void {
  if (!session.importedFrom?.shareToken) return;
  recordClientCreatedSession(session, {
    category: "standalone_agent",
    ownership: "local",
  });
}

export const removeGuestImportedSession = removeClientCreatedSession;

export function mergeGuestImportedSessions(
  sessions: readonly Session[]
): Session[] {
  return mergeClientCreatedSessions(sessions, {
    include: (session) => Boolean(session.importedFrom?.shareToken),
  });
}

export const __GUEST_IMPORT_REGISTRY_INTERNALS = {
  GUEST_IMPORT_REGISTRY_STORAGE_KEY:
    __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS.CLIENT_CREATED_SESSION_REGISTRY_STORAGE_KEY,
  LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY:
    __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS.LEGACY_GUEST_IMPORT_REGISTRY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES:
    __CLIENT_CREATED_SESSION_REGISTRY_INTERNALS.MAX_REGISTRY_ENTRIES,
};
