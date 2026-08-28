/**
 * useChatViewScrollToBottom
 *
 * Tracks the scroll-nav state reported by ChatHistory and builds the
 * standalone "scroll to bottom" button shown when the history has scrolled
 * away from the latest turn (used by the external-history overlay and, via
 * `scrollNav`, ChatFloatingComposer).
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { PILL_CONTROL_IDLE_SURFACE_CLASS } from "@src/components/CompoundPill/config";
import { ArrowDown02Icon, HugeiconsIcon } from "@src/icons";

import { type ScrollNavState } from "../ChatHistory";

export function useChatViewScrollToBottom() {
  const { t } = useTranslation("sessions");
  const [scrollNav, setScrollNav] = useState<ScrollNavState | null>(null);
  const handleScrollNavChange = useCallback((state: ScrollNavState) => {
    setScrollNav(state);
  }, []);
  const externalScrollToBottomButton = scrollNav?.showScrollToBottom ? (
    <Button
      variant="secondary"
      appearance="outline"
      size="small"
      shape="round"
      icon={
        <HugeiconsIcon
          icon={ArrowDown02Icon}
          data-icon="arrow-down"
          size={14}
        />
      }
      iconOnly
      aria-label={t("common:chat.scrollToBottom")}
      title={t("common:chat.scrollToBottom")}
      onClick={scrollNav.onScrollToBottom}
      className={`shrink-0 ${PILL_CONTROL_IDLE_SURFACE_CLASS}`}
    />
  ) : null;

  return { scrollNav, handleScrollNavChange, externalScrollToBottomButton };
}
