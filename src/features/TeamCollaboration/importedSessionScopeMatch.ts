import type { Session } from "@src/store/session";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { normalizeRepoScopeKey } from "./collabSyncUtils";
import { repoMatchesOrgScopes } from "./orgScopeRepoFilter";

type ScopePeek = (input: string) => string[] | null | undefined;
type ScopePrime = (input: string) => void;

type MatchableSession = Pick<Session, "session_id" | "repoPath">;

export function isScopeMatchableImportedSession(
  session: MatchableSession
): session is MatchableSession & { repoPath: string } {
  return (
    Boolean(session.repoPath) && isImportedHistorySession(session.session_id)
  );
}

/** Imported sessions whose repo falls inside THIS org's repo scope. */
export function collectScopeMatchedImportedSessionIds(
  sessions: readonly MatchableSession[],
  orgScopes: string[] | undefined,
  peek?: ScopePeek,
  prime?: ScopePrime
): Set<string> {
  const ids = new Set<string>();
  if (!orgScopes || orgScopes.length === 0) return ids;
  const normalizedScopes = orgScopes
    .map((scope) => normalizeRepoScopeKey(scope))
    .filter((scope) => scope.length > 0);
  if (normalizedScopes.length === 0) return ids;
  const verdictByRepoPath = new Map<string, boolean>();
  for (const session of sessions) {
    if (!isScopeMatchableImportedSession(session)) continue;
    let matched = verdictByRepoPath.get(session.repoPath);
    if (matched === undefined) {
      matched = repoMatchesOrgScopes(
        { fs_uri: session.repoPath },
        normalizedScopes,
        peek,
        prime
      );
      verdictByRepoPath.set(session.repoPath, matched);
    }
    if (matched) ids.add(session.session_id);
  }
  return ids;
}
