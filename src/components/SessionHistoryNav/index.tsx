/**
 * SessionHistoryNav
 *
 * Browser-style Back / Forward over the active chat tab's session trail — the
 * same trail ⌘[ / ⌘] walk. Styled as the sidebar header's round 28px
 * controls. It lives in the sidebar header while the sidebar is open and
 * travels with the collapsed-sidebar toggle once it folds away, so it keeps
 * the same spot on screen in both states.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  type IconSvgElement,
} from "@src/icons";
import {
  activeChatPanelTabCanGoBackAtom,
  activeChatPanelTabCanGoForwardAtom,
  goBackChatPanelTabAtom,
  goForwardChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabNavigationAtoms";

/** Width the pair occupies, for hosts that reserve chrome space up front. */
export const SESSION_HISTORY_NAV_WIDTH = 56;

export interface SessionHistoryNavProps {
  className?: string;
}

interface NavButtonProps {
  icon: IconSvgElement;
  label: string;
  shortcutId: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}

const NavButton: React.FC<NavButtonProps> = ({
  icon,
  label,
  shortcutId,
  disabled,
  onClick,
  testId,
}) => (
  <ToolbarTooltip label={label} shortcutId={shortcutId} position="bottom">
    <button
      type="button"
      className={`flex h-[28px] w-[28px] items-center justify-center rounded-[100px] border-none bg-transparent p-0 text-text-2 transition-colors duration-150 ${
        disabled
          ? "cursor-default opacity-40"
          : "cursor-pointer hover:bg-sidebar-selected"
      }`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
    >
      <AnyIcon icon={icon} size={16} strokeWidth={2} />
    </button>
  </ToolbarTooltip>
);

export const SessionHistoryNav: React.FC<SessionHistoryNavProps> = memo(
  ({ className = "" }) => {
    const { t } = useTranslation("sessions");
    const canGoBack = useAtomValue(activeChatPanelTabCanGoBackAtom);
    const canGoForward = useAtomValue(activeChatPanelTabCanGoForwardAtom);
    const goBack = useSetAtom(goBackChatPanelTabAtom);
    const goForward = useSetAtom(goForwardChatPanelTabAtom);

    return (
      <div
        className={`flex shrink-0 items-center ${className}`.trim()}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        data-testid="session-history-nav"
      >
        <NavButton
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
