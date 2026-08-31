import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { turnIntentIdOf } from "@src/engines/SessionCore/sync/utils/activityIds";
import {
  isAgentChildSession,
  resolveAgentChildParentSessionId,
} from "@src/util/session/agentChildSession";

export interface ParentAgentSenderInput {
  sessionId: string;
  parentSessionId?: string | null;
  orgMemberId?: string | null;
  background?: boolean;
}

/**
 * The session whose agent wrote this session's user-role turns, or null when
 * the reader is the author.
 *
 * A subagent's dispatch prompt is stored with the same `user` role the
 * composer produces — the orchestrator hands the child a system + user pair,
 * and a re-dispatch appends another user turn — so the message list cannot
 * tell them apart by role. It can tell them apart by session: nothing in an
 * agent-started session's transcript came from the person reading it, so every
 * user turn there belongs to whichever session spawned it.
 *
 * Null when the session is not an agent child, and null when the parent cannot
 * be identified: a message attributed to nobody reads worse than one left on
 * the viewer's side.
 */
export function resolveParentAgentSenderSessionId(
  input: ParentAgentSenderInput
): string | null {
  if (!isAgentChildSession(input)) return null;
  return resolveAgentChildParentSessionId(
    input.sessionId,
    input.parentSessionId
  );
}

/**
 * Whether the person reading this session submitted this turn.
 *
 * Every turn `agent_send_message` accepts — composer submit, queue dispatch,
 * Send Now, mobile-remote — is minted a canonical turn-intent id at the
 * frontend submit boundary, and that id is persisted onto the `user_message`
 * row (`session-persistence::turn_index`), so it survives a reload. The
 * orchestrator's subagent launch never goes through that command: it starts
 * the child's turn with an empty intent id. The dispatch prompt is therefore
 * exactly the user turn that carries none.
 *
 * This is what keeps the attribution per message rather than per session: a
 * person can open a subagent session and type into it, and their message
 * arrives with an id while the parent's dispatch does not.
 *
 * Rows written before intent ids existed carry none and read as not
 * submitted. In an agent-started session those are dispatches in all but
 * name, so the verdict matches; elsewhere the caller has already decided the
 * turn is the viewer's on other grounds.
 *
 * Known blind spot: `agent_send_message` also accepts agent-driven sources
 * (`agent_org`, `wingman`) and mints ids for them too, and the source itself
 * is not carried on the event — only in `session_turn_intents`. An Agent Team
 * member session's dispatch therefore reads as viewer-submitted here. That is
 * the conservative direction (it leaves the turn where it already was), and
 * closing it means carrying `turnIntentSource` onto the persisted row.
 */
export function wasSubmittedByViewer(
  event: Pick<SessionEvent, "source" | "result"> | undefined
): boolean {
  return Boolean(event && turnIntentIdOf(event) !== null);
}
