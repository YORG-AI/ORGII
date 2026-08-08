import type { Session } from "@src/store/session";

export function continuationLineagesForRevealedSessions(
  sessions: readonly Session[],
  revealedSessionIds: ReadonlySet<string>
): ReadonlySet<string> {
  const lineages = new Set<string>();
  for (const session of sessions) {
    if (
      revealedSessionIds.has(session.session_id) &&
      session.continuationLineageId
    ) {
      lineages.add(session.continuationLineageId);
    }
  }
  return lineages;
}

export function isRosterSiblingOfRevealedContinuation(
  session: Session,
  revealedSessionIds: ReadonlySet<string>,
  revealedContinuationLineages: ReadonlySet<string>
): boolean {
  return Boolean(
    !revealedSessionIds.has(session.session_id) &&
    session.continuationLineageId &&
    revealedContinuationLineages.has(session.continuationLineageId)
  );
}
