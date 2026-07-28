import { useSetAtom } from "jotai";
import { useLayoutEffect, useRef } from "react";

import {
  type ChatPanelHeaderContribution,
  type ChatPanelHeaderSlots,
  chatPanelHeaderSlotsAtom,
} from "./chatPanelHeaderSlots";

interface UsePublishChatPanelHeaderOptions {
  content: ChatPanelHeaderContribution;
  enabled?: boolean;
}

export function usePublishChatPanelHeader({
  content,
  enabled = true,
}: UsePublishChatPanelHeaderOptions): void {
  const setHeader = useSetAtom(chatPanelHeaderSlotsAtom);
  const ownedContentRef = useRef<ChatPanelHeaderSlots | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setHeader((previous) =>
        previous === ownedContentRef.current ? null : previous
      );
      ownedContentRef.current = null;
      return;
    }

    ownedContentRef.current = content;
    setHeader(content);
  }, [content, enabled, setHeader]);

  useLayoutEffect(() => {
    return () => {
      setHeader((previous) =>
        previous === ownedContentRef.current ? null : previous
      );
      ownedContentRef.current = null;
    };
  }, [setHeader]);
}
