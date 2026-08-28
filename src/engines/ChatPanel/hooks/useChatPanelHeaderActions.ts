import { useSessionHeaderActions } from "./useSessionHeaderActions";

interface UseChatPanelHeaderActionsOptions {
  sessionId: string | null;
  handleReloadSession: () => void;
}

export function useChatPanelHeaderActions({
  sessionId,
  handleReloadSession,
}: UseChatPanelHeaderActionsOptions) {
  return useSessionHeaderActions({ sessionId, handleReloadSession });
}
