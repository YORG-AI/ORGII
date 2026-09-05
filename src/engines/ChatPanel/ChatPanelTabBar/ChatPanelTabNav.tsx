/**
 * ChatPanelTabNav
 *
 * Browser-style Back / Forward for the chat pane. Leads the tab row (or the
 * folded header while the pane has a single tab) and walks the active tab's
 * session history — the same trail ⌘[ / ⌘] move along.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { ArrowLeft01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import {
  activeChatPanelTabCanGoBackAtom,
  activeChatPanelTabCanGoForwardAtom,
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabNavigationAtoms";

import { CHAT_PANEL_HEADER_NO_DRAG_STYLE } from "../header";

const NAV_ICON_SIZE = 16;

export const ChatPanelTabNav: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const canGoBack = useAtomValue(activeChatPanelTabCanGoBackAtom);
  const canGoForward = useAtomValue(activeChatPanelTabCanGoForwardAtom);
  const goBack = useSetAtom(goBackChatPanelTabAtom);
  const goForward = useSetAtom(goForwardChatPanelTabAtom);

  return (
    <div
      className="flex h-full shrink-0 items-center gap-px"
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
      data-testid="chat-panel-tab-nav"
    >
      <TabBarTrailingIconButton
        title={t("chat.tabs.goBack")}
        shortcutId="chat_go_back"
        tooltipPosition="bottom-start"
        nativeTitle={false}
        disabled={!canGoBack}
        onClick={() => {
          goBack();
        }}
        data-testid="chat-panel-tab-nav-back"
      >
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          data-icon="arrow-left"
          size={NAV_ICON_SIZE}
          strokeWidth={1.75}
        />
      </TabBarTrailingIconButton>
      <TabBarTrailingIconButton
        title={t("chat.tabs.goForward")}
        shortcutId="chat_go_forward"
        tooltipPosition="bottom-start"
        nativeTitle={false}
        disabled={!canGoForward}
        onClick={() => {
          goForward();
        }}
        data-testid="chat-panel-tab-nav-forward"
      >
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          data-icon="arrow-right"
          size={NAV_ICON_SIZE}
          strokeWidth={1.75}
        />
      </TabBarTrailingIconButton>
    </div>
  );
});

ChatPanelTabNav.displayName = "ChatPanelTabNav";
