import { rpc } from "@src/api/tauri/rpc";
import type {
  SessionFollowUpMessage,
  SessionFollowUpSuggestion,
  SessionFollowUpSuggestionsResponse,
} from "@src/api/tauri/rpc/schemas/agentSession";

export type {
  SessionFollowUpMessage,
  SessionFollowUpSuggestion,
  SessionFollowUpSuggestionsResponse,
};

/** Generate transient suggestions with the model/account bound to the session. */
export async function sessionFollowUpSuggestions(
  sessionId: string,
  messages: SessionFollowUpMessage[]
): Promise<SessionFollowUpSuggestionsResponse> {
  return rpc.agentSession.followUpSuggestions({
    request: {
      sessionId,
      messages,
    },
  });
}
