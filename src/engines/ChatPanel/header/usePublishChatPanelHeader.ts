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

function sameHeaderSlots(
  a: ChatPanelHeaderSlots | null,
  b: ChatPanelHeaderSlots | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.leading === b.leading &&
    a.content === b.content &&
    a.trailing === b.trailing &&
    (a.joinWithFollowingRow ?? false) === (b.joinWithFollowingRow ?? false)
  );
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

    // Defensive dedupe: a caller that rebuilds the `content` wrapper object
    // every render (without memoizing) would otherwise re-publish on every
    // commit, and because the header atom's subscriber re-render can cascade
    // back into the publisher this becomes an unbounded synchronous update
    // loop. Compare the meaningful slot references — the slot elements are
    // memoized even when the wrapper object is not — and only publish when
    // one actually changes.
    setHeader((previous) => {
      if (sameHeaderSlots(previous, content)) {
        ownedContentRef.current = previous;
        return previous;
      }
      ownedContentRef.current = content;
      return content;
    });
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
