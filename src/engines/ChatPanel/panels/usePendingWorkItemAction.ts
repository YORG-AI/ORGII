import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import {
  consumeChatPanelWorkItemActionAtom,
  pendingChatPanelWorkItemActionAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";

interface UsePendingWorkItemActionOptions {
  workItemShortId: string;
  onStartAgent: () => void | Promise<void>;
}

export function usePendingWorkItemAction({
  workItemShortId,
  onStartAgent,
}: UsePendingWorkItemActionOptions): void {
  const pendingWorkItemAction = useAtomValue(
    pendingChatPanelWorkItemActionAtom
  );
  const consumeWorkItemAction = useSetAtom(consumeChatPanelWorkItemActionAtom);

  useEffect(() => {
    if (
      pendingWorkItemAction?.workItemShortId !== workItemShortId ||
      pendingWorkItemAction.action !== "start_agent"
    ) {
      return;
    }

    const consumedRequest = consumeWorkItemAction(pendingWorkItemAction);
    if (!consumedRequest) return;
    void onStartAgent();
  }, [
    consumeWorkItemAction,
    onStartAgent,
    pendingWorkItemAction,
    workItemShortId,
  ]);
}
