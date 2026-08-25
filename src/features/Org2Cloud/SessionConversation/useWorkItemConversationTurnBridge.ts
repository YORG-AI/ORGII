import { useEffect } from "react";

import { installWorkItemConversationTurnBridge } from "./workItemConversationTurnBridge";

/** Mount once so background Work Item dispatches always find a listener. */
export function useWorkItemConversationTurnBridge(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void installWorkItemConversationTurnBridge().then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
