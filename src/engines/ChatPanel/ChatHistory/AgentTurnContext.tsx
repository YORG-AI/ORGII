/**
 * AgentTurnContext
 *
 * Per-group context that exposes turn-scoped actions (regenerate, etc.)
 * to the activity event renderer tree below `ChatItemRenderer`.
 *
 * Why context and not prop drill:
 *   - Registry-based lazy components (`getChatLazyComponent`) only accept
 *     `event` + `itemIndex`. Threading extra props through the registry
 *     would pollute the generic event-component contract.
 *   - "Regenerate" is a per-turn action, scoped to one group. The sticky
 *     header of that group (the user message) already lives in
 *     `ChatHistory`; context is the cleanest way to bind the turn-level
 *     callback to its descendants without widening every renderer signature.
 *   - Same shape will host future per-turn actions (copy turn, reply-to,
 *     share turn) without repeated prop-drill work.
 *
 * Consumer rules:
 *   - Only the event component that renders the *final* assistant message
 *     of a completed turn should surface the regenerate affordance.
 *     `isLastAssistantFlatIndex` is the flat index (within `ChatHistory`'s
 *     `flatItems`) of the turn's last assistant_message event. Consumers
 *     compare their own `itemIndex` against it.
 *   - When the agent is still streaming the turn, or when there is no
 *     assistant message in the group yet, `isLastAssistantFlatIndex` is
 *     `null` and consumers must not render the button.
 */
import { createContext, useContext } from "react";

export interface AgentTurnContextValue {
  /** Flat index (into `ChatHistory` flatItems) of the final assistant
   *  message event in the current group. `null` when no completed
   *  assistant message exists in the group yet. */
  lastAssistantFlatIndex: number | null;
  /** Resident, completed assistant-message ids for copy-turn behavior. */
  assistantCopyEventIds: readonly string[];
  /** Resolves copy text lazily from the current uncollapsed projection. */
  resolveAssistantTurnCopyContent: (eventIds: readonly string[]) => string;
  /** True when this turn is the most recent group in the chat — i.e. the
   *  user has not started a follow-up turn after it. Consumers that
   *  surface "resume this turn" affordances (AgentErrorChatItem's Resume
   *  button) should only render when this is true; resuming a stale turn
   *  is meaningless once a newer turn has been dispatched. */
  isLastGroup: boolean;
  /** True when the consuming item is the last item in its group. Used by
   *  AgentErrorChatItem to suppress the Resume button when the agent has
   *  already produced more output (assistant message, tool call, …)
   *  after the error within the same user turn — at that point Resume
   *  would clobber that newer output. */
  isLastItemInGroup: boolean;
  /** Regenerate the current turn by re-sending its originating user
   *  message through the truncate-and-resend pipeline. */
  onRegenerate?: () => void;
  /** Optional sender label for group-chat merged streams. */
  groupSenderName?: string | null;
}

export const AgentTurnContext = createContext<AgentTurnContextValue | null>(
  null
);

AgentTurnContext.displayName = "AgentTurnContext";

/** Returns the active turn context, or `null` when the consumer is not
 *  rendered inside an `AgentTurnContext.Provider`. Consumers must treat
 *  `null` as "no regenerate affordance available" and render nothing. */
export function useAgentTurnContext(): AgentTurnContextValue | null {
  return useContext(AgentTurnContext);
}
