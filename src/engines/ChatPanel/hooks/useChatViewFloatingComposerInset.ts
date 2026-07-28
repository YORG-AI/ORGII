/**
 * useChatViewFloatingComposerInset
 *
 * Measures the floating composer's rendered height (ResizeObserver + window
 * resize) so ChatView can reserve matching bottom inset space in the chat
 * history surface. Falls back to a fixed inset before the composer mounts
 * or reports a zero height.
 */
import { useCallback, useEffect, useState } from "react";

const CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX = 72;

export function useChatViewFloatingComposerInset(
  showFloatingComposer: boolean
) {
  const [floatingComposerNode, setFloatingComposerNode] =
    useState<HTMLDivElement | null>(null);
  const [floatingComposerHeight, setFloatingComposerHeight] = useState(
    CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX
  );
  const setMeasuredFloatingComposerRef = useCallback(
    (node: HTMLDivElement | null) => {
      setFloatingComposerNode(node);
    },
    []
  );

  useEffect(() => {
    if (!showFloatingComposer || !floatingComposerNode) return;

    const updateHeight = () => {
      const nextHeight = Math.ceil(
        floatingComposerNode.getBoundingClientRect().height
      );
      setFloatingComposerHeight(
        nextHeight > 0 ? nextHeight : CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX
      );
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(floatingComposerNode);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [floatingComposerNode, showFloatingComposer]);

  const historyBottomInset = showFloatingComposer
    ? Math.max(CHAT_FLOATING_COMPOSER_FALLBACK_INSET_PX, floatingComposerHeight)
    : 0;

  return { setMeasuredFloatingComposerRef, historyBottomInset };
}
