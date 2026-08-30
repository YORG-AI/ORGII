/**
 * Agent-started child sessions: sessions another session's agent opened
 * rather than the user.
 *
 * More than one surface needs this verdict — the chat header badges the
 * session as a subagent, and the message list attributes the session's
 * user-role turns to the parent agent — so it lives here rather than in
 * either consumer. Two surfaces disagreeing about what counts as an agent
 * child would show a session tagged as a subagent whose prompts still read as
 * the viewer's own.
 */
export const SUBAGENT_SESSION_ID_SEGMENT = ":subagent:";

export interface AgentChildSessionInput {
  sessionId: string;
  parentSessionId?: string | null;
  orgMemberId?: string | null;
  background?: boolean;
}

/**
 * A parent id also exists on ordinary continuation/import sessions, so it
 * cannot identify an agent child by itself. Agent children additionally carry
 * a subagent-shaped id, an Agent Team member id, or background-child state.
 */
export function isAgentChildSession({
  sessionId,
  parentSessionId,
  orgMemberId,
  background,
}: AgentChildSessionInput): boolean {
  if (sessionId.includes(SUBAGENT_SESSION_ID_SEGMENT)) return true;
  if (!parentSessionId) return false;
  return Boolean(orgMemberId) || background === true;
}

/**
 * The session that spawned this one. Prefers the persisted parent id and
 * falls back to the id's own subagent prefix, which is present on spawned
 * sessions before the parent link is hydrated.
 */
export function resolveAgentChildParentSessionId(
  sessionId: string,
  parentSessionId?: string | null
): string | null {
  const explicitParentId = parentSessionId?.trim();
  if (explicitParentId) return explicitParentId;
  const segmentIndex = sessionId.indexOf(SUBAGENT_SESSION_ID_SEGMENT);
  return segmentIndex > 0 ? sessionId.slice(0, segmentIndex) : null;
}
