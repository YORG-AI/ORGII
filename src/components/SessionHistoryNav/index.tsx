/**
 * SessionHistoryNav
 *
 * Browser-style Back / Forward over the active chat tab's session trail — the
 * same trail ⌘[ / ⌘] walk. Lives in the sidebar header by default; the chat
 * pane shows its own copy only while the sidebar is collapsed, so the trail
 * is always reachable from exactly one place.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
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

export type SessionHistoryNavVariant = "sidebar" | "tabBar";

export interface SessionHistoryNavProps {
  /** `sidebar` matches the sidebar header's round 28px controls; `tabBar` the chat tab row's icon buttons. */
  variant: SessionHistoryNavVariant;
  className?: string;
}

interface NavButtonProps {
  variant: SessionHistoryNavVariant;
  icon: IconSvgElement;
  dataIcon: string;
  label: string;
  shortcutId: string;
  disabled: boolean;
  onClick: () => void;
  testId: string;
}

const NavButton: React.FC<NavButtonProps> = ({
  variant,
  icon,
  dataIcon,
  label,
  shortcutId,
  disabled,
  onClick,
  testId,
}) => {
  if (variant === "tabBar") {
    return (
      <TabBarTrailingIconButton
        title={label}
        shortcutId={shortcutId}
        tooltipPosition="bottom-start"
        nativeTitle={false}
        disabled={disabled}
        onClick={onClick}
        data-testid={testId}
      >
        <HugeiconsIcon
          icon={icon}
          data-icon={dataIcon}
          size={16}
          strokeWidth={1.75}
        />
      </TabBarTrailingIconButton>
    );
  }

  return (
    <ToolbarTooltip label={label} shortcutId={shortcutId} position="bottom">
      <button
        type="button"
        className={`flex h-[28px] w-[28px] items-center justify-center rounded-[100px] text-text-2 transition-colors duration-150 ${
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
        className={`flex shrink-0 items-center ${
          variant === "sidebar" ? "gap-0" : "h-full gap-px"
        } ${className}`.trim()}
        data-testid={`session-history-nav-${variant}`}
      >
        <NavButton
          variant={variant}
          icon={ArrowLeft01Icon}
          dataIcon="arrow-left"
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
          dataIcon="arrow-right"
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
