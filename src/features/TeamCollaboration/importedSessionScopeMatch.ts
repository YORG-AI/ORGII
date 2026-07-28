import type { Session } from "@src/store/session";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { normalizeRepoScopeKey } from "./collabSyncUtils";
import {
  peekMatchingOrgRepoScope,
  shareableScopeKeysFromRemoteUrls,
} from "./repoScopeResolver";

type MatchableSession = Pick<
  Session,
  "session_id" | "repoPath" | "repoRemoteUrls" | "parentSessionId"
>;

/**
 * Persisted repo scope keys for imported history. `undefined` means the
 * session is not imported; `null` means it is imported but has no cached
 * shareable remote — or is a spawned CHILD (subagent transcript), which is
 * a rendering detail of its parent, never an independently shareable unit.
 * Without the child exclusion every subagent transcript in a scoped
 * checkout auto-published as its own top-level team session, flooding the
 * team list with prompt-titled rows no fold can reclaim (the cloud row
 * carries no parent linkage).
 */
export function persistedScopeKeysForImportedSession(
  session: MatchableSession
): string[] | null | undefined {
  if (!isImportedHistorySession(session.session_id)) return undefined;
  if (session.parentSessionId) return null;
  return shareableScopeKeysFromRemoteUrls(session.repoRemoteUrls);
}

export function isScopeMatchableImportedSession(
  session: MatchableSession
): boolean {
  return Boolean(persistedScopeKeysForImportedSession(session)?.length);
}

/** Imported sessions whose repo falls inside THIS org's repo scope. */
export function collectScopeMatchedImportedSessionIds(
  sessions: readonly MatchableSession[],
  orgScopes: string[] | undefined
): Set<string> {
  const ids = new Set<string>();
  if (!orgScopes || orgScopes.length === 0) return ids;
  const normalizedScopes = orgScopes
    .map((scope) => normalizeRepoScopeKey(scope))
    .filter((scope) => scope.length > 0);
  if (normalizedScopes.length === 0) return ids;
  const verdictByIdentity = new Map<string, boolean>();
  for (const session of sessions) {
    const scopeKeys = persistedScopeKeysForImportedSession(session);
    if (!scopeKeys?.length) continue;
    const identityKey = scopeKeys.join("\0");
    let matched = verdictByIdentity.get(identityKey);
    if (matched === undefined) {
      const matchingScope = peekMatchingOrgRepoScope(
        scopeKeys,
        normalizedScopes
      );
      matched = matchingScope !== null && matchingScope !== undefined;
      verdictByIdentity.set(identityKey, matched);
    }
    if (matched) ids.add(session.session_id);
  }
  return ids;
}
