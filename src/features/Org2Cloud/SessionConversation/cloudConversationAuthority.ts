import type { Session } from "@src/store/session";

import type { CloudOrgRemoteSessionsEntry } from "../org2CloudRemoteSessionsAtom";

/**
 * An owner-local session keeps its Cloud authority only while the org listing
 * still carries its root row. Once that row is gone (replay retention expired
 * or the engine retracted it) the Cloud plane can never admit another turn,
 * so the session must continue as an ordinary local conversation instead of
 * waiting forever for root metadata that will not return. Replay viewers and
 * hydrating imports are not affected: their rows are the import input itself.
 */
export function cloudConversationAuthorityIsLive(params: {
  session: Pick<Session, "importedFrom"> | undefined;
  target: { orgId: string; sessionId: string } | null;
  entry: Pick<CloudOrgRemoteSessionsEntry, "state" | "rows"> | undefined;
  loadingSource: unknown;
}): boolean {
  const { session, target, entry, loadingSource } = params;
  if (!target || !session || session.importedFrom || loadingSource) return true;
  if (entry?.state !== "ready") return true;
  return entry.rows.some(
    (candidate) => candidate.sourceSessionId === target.sessionId
  );
}
