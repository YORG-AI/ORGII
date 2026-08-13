import { createContext, useContext } from "react";

export interface SharedConversationSender {
  displayName: string;
  avatarUrl?: string;
}

const SharedConversationSenderContext =
  createContext<SharedConversationSender | null>(null);

export const SharedConversationSenderProvider =
  SharedConversationSenderContext.Provider;

export function useSharedConversationSender(): SharedConversationSender | null {
  return useContext(SharedConversationSenderContext);
}
