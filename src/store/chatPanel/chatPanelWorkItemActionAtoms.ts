import { atom } from "jotai";

export type ChatPanelWorkItemAction = "start_agent";

export interface ChatPanelWorkItemActionRequest {
  requestId: string;
  workItemShortId: string;
  action: ChatPanelWorkItemAction;
}

export const pendingChatPanelWorkItemActionAtom =
  atom<ChatPanelWorkItemActionRequest | null>(null);

export const requestChatPanelWorkItemActionAtom = atom(
  null,
  (_get, set, request: Omit<ChatPanelWorkItemActionRequest, "requestId">) => {
    const pendingRequest: ChatPanelWorkItemActionRequest = {
      ...request,
      requestId: crypto.randomUUID(),
    };
    set(pendingChatPanelWorkItemActionAtom, pendingRequest);
    return pendingRequest;
  }
);

export const consumeChatPanelWorkItemActionAtom = atom(
  null,
  (
    get,
    set,
    request: ChatPanelWorkItemActionRequest
  ): ChatPanelWorkItemActionRequest | null => {
    const pendingRequest = get(pendingChatPanelWorkItemActionAtom);
    if (
      pendingRequest?.requestId !== request.requestId ||
      pendingRequest.workItemShortId !== request.workItemShortId ||
      pendingRequest.action !== request.action
    ) {
      return null;
    }

    set(pendingChatPanelWorkItemActionAtom, null);
    return pendingRequest;
  }
);
