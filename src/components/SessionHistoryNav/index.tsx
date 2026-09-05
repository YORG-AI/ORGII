/**
 * SessionHistoryNav
 *
 * Browser-style Back / Forward over the active chat tab's session trail — the
 * same trail ⌘[ / ⌘] walk. Renders in the tokens of whichever surface hosts
 * it: the sidebar's round hover control, or the chat pane's tab-bar button.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import SidebarChromeIconButton from "@src/components/SidebarChromeIconButton";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  type IconSvgElement,
} from "@src/icons";
import {
  activeChatPanelTabCanGoBackAtom,
  activeChatPanelTabCanGoForwardAtom,
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabNavigationAtoms";

/** Two 28px icon buttons with the tab bar's 1px gap between them. */
export const SESSION_HISTORY_NAV_WIDTH = 28 + 1 + 28;
/** Gap the chrome rows keep between adjacent icon buttons. */
export const SESSION_HISTORY_NAV_GAP = 1;

/** Which surface's tokens to draw in. */
export type SessionHistoryNavVariant = "sidebar" | "chat";

export interface SessionHistoryNavProps {
  variant: SessionHistoryNavVariant;
  className?: string;
}

interface NavButtonProps {
  variant: SessionHistoryNavVariant;
  icon: IconSvgElement;
  label: string;
  shortcutId: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}

const NavButton: React.FC<NavButtonProps> = ({
  variant,
  icon,
  label,
  shortcutId,
  disabled,
  onClick,
  testId,
}) => {
  const glyph = <HugeiconsIcon icon={icon} size={16} strokeWidth={2} />;
  if (variant === "sidebar") {
    return (
      <SidebarChromeIconButton
        title={label}
        shortcutId={shortcutId}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
      >
        {glyph}
      </SidebarChromeIconButton>
    );
  }
  return (
    <TabBarTrailingIconButton
      title={label}
      shortcutId={shortcutId}
      tooltipPosition="bottom"
      nativeTitle={false}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      {glyph}
    </TabBarTrailingIconButton>
  );
};

export const SessionHistoryNav: React.FC<SessionHistoryNavProps> = memo(
  ({ variant, className = "" }) => {
    const { t } = useTranslation("sessions");
    const canGoBack = useAtomValue(activeChatPanelTabCanGoBackAtom);
    const canGoForward = useAtomValue(activeChatPanelTabCanGoForwardAtom);
    const goBack = useSetAtom(goBackChatPanelTabAtom);
    const goForward = useSetAtom(goForwardChatPanelTabAtom);

    return (
      <div
        className={`flex shrink-0 items-center gap-px ${className}`.trim()}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        data-testid="session-history-nav"
        data-variant={variant}
      >
        <NavButton
          variant={variant}
          icon={ArrowLeft01Icon}
          label={t("chat.tabs.goBack")}
          shortcutId="chat_go_back"
          disabled={!canGoBack}
          onClick={() => {
            goBack();
          }}
          testId="session-history-nav-back"
        />
        <NavButton
          variant={variant}
          icon={ArrowRight01Icon}
          label={t("chat.tabs.goForward")}
          shortcutId="chat_go_forward"
          disabled={!canGoForward}
          onClick={() => {
            goForward();
          }}
          testId="session-history-nav-forward"
        />
      </div>
    );
  }
);

SessionHistoryNav.displayName = "SessionHistoryNav";

export default SessionHistoryNav;
