import { createContext, useContext } from "react";

import type { Session } from "@src/store/session";

export interface ParentAgentSender {
  /** The session whose agent wrote this session's user-role turns. */
  parentSessionId: string;
  /** Undefined until the parent is hydrated; the icon degrades, not the row. */
  parentSession: Session | undefined;
}

/**
 * Identity of the agent that drove this conversation, when the conversation
 * is an agent-started child.
 *
 * Resolved once per chat rather than per message: every user row in a session
 * shares one answer, and reading it from the session store per row would
 * subscribe hundreds of memoized rows to a session object that churns on every
 * status update. `SharedConversationSenderContext` carries teammate identity
 * the same way and for the same reason.
 */
const ParentAgentSenderContext = createContext<ParentAgentSender | null>(null);

export const ParentAgentSenderProvider = ParentAgentSenderContext.Provider;

export function useParentAgentSender(): ParentAgentSender | null {
  return useContext(ParentAgentSenderContext);
}
