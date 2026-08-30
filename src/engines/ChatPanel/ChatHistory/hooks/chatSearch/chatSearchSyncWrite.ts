import type { ChatSearchSyncState } from "@src/store/ui/chatPanel/miscAtoms";

export const EMPTY_CHAT_SEARCH_SYNC: ChatSearchSyncState = {
  query: "",
  activeEventId: null,
};

type ChatSearchSyncResult = {
  item: { id?: string | null; chunk_id?: string | null };
};

export function resolveChatSearchActiveEventId(
  result: ChatSearchSyncResult
): string | null {
  return result.item.id || result.item.chunk_id || null;
}

export function buildChatSearchSyncState(input: {
  isOpen: boolean;
  query: string;
  results: ReadonlyArray<ChatSearchSyncResult>;
  currentResultIndex: number;
}): ChatSearchSyncState {
  if (!input.isOpen) return EMPTY_CHAT_SEARCH_SYNC;

  const activeResult = input.results[input.currentResultIndex];
  return {
    query: input.query,
    activeEventId: activeResult
      ? resolveChatSearchActiveEventId(activeResult)
      : null,
  };
}

export function writeChatSearchSyncState(
  setSync: (value: ChatSearchSyncState) => void,
  state: ChatSearchSyncState
) {
  setSync(state);
}
