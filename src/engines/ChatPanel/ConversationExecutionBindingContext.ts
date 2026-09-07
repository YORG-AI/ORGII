import { createContext, useContext } from "react";

import type { ConversationTargetBinding } from "./conversationTargetSelection";

/**
 * One canonical conversation binding per ChatView surface.
 *
 * Runtime/model controls are deep composer children, but resolving a binding
 * can probe the local workspace and subscribe to durable target memory. Keep
 * that work at the ChatView boundary and share the result instead of mounting
 * an independent resolver in every consumer.
 */
export const ConversationExecutionBindingContext =
  createContext<ConversationTargetBinding | null>(null);

export function useConversationExecutionBinding(): ConversationTargetBinding | null {
  return useContext(ConversationExecutionBindingContext);
}
