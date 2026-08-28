import { useAtomValue } from "jotai";

import {
  chatFindInChatOpenAtomFamily,
  chatSearchSyncAtomFamily,
} from "@src/store/ui/chatPanelAtom";

/** Read the shared chat-search sync snapshot for any pane (history / station). */
export function useChatSearchSyncState(sessionId: string | null) {
  const sessionKey = sessionId ?? "";
  const isOpen = useAtomValue(chatFindInChatOpenAtomFamily(sessionKey));
  const sync = useAtomValue(chatSearchSyncAtomFamily(sessionKey));
  const trimmedQuery = sync.query.trim();

  return {
    isOpen,
    query: sync.query,
    trimmedQuery,
    activeEventId: sync.activeEventId,
    enabled: isOpen && trimmedQuery.length > 0,
  };
}
