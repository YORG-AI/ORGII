import { useSessionHeaderActions } from "./useSessionHeaderActions";

interface UseChatPanelHeaderActionsOptions {
  handleReloadSession: () => void;
}

export function useChatPanelHeaderActions({
  handleReloadSession,
}: UseChatPanelHeaderActionsOptions) {
  return useSessionHeaderActions({ handleReloadSession });
}
