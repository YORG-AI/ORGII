/**
 * PinnedWorkbenchChrome
 *
 * macOS only. The window's right-edge collapse toggles — hide / restore the
 * chat pane, and maximize chat / show workstation — drawn once, fixed in
 * window coordinates, so they hold still while the chat slot and the
 * workstation animate under them. The counterpart of `PinnedSidebarChrome`
 * on the left. Hosts (`TabBar`, `AgentStationTopHeader`, `ChatPanelHeader`)
 * only reserve the space; see `useWorkbenchRightEdgeOwner`.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, startTransition, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { CHROME_TOOLTIP_HOVER_DELAY } from "@src/config/tooltip";
import {
  PINNED_WORKBENCH_CHROME_CENTER_TOP,
  PINNED_WORKBENCH_CHROME_RIGHT_INSET,
  useCurrentStationChatVisible,
  usePinnedWorkbenchChromeVisible,
} from "@src/hooks/ui/workbench/usePinnedWorkbenchChrome";
import {
  ArrowExpand01Icon,
  BubbleChatIcon,
  HugeiconsIcon,
  LayoutAlignRightIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
} from "@src/icons";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import {
  activeChatPanelTabAtom,
  isChatPanelTabStationAvailable,
  toggleActiveChatPanelMaximizedAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  chatPanelMaximizedAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import { chatPanelPositionAtom } from "@src/store/ui/workStationAtom";

import { WorkstationMaximizeChatIcon } from "./useWorkstationTrailingSlot";

const PinnedWorkbenchChromeComponent: React.FC = () => {
  const { t } = useTranslation("sessions");
  const visible = usePinnedWorkbenchChromeVisible();
  const isChatPanelVisible = useCurrentStationChatVisible();
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const activeTab = useAtomValue(activeChatPanelTabAtom);
  const toggleChatPanelMaximized = useSetAtom(toggleChatPanelMaximizedAtom);
  const toggleActiveChatMaximized = useSetAtom(
    toggleActiveChatPanelMaximizedAtom
  );

  const handleToggleChatPanel = useCallback(() => {
    startTransition(() => {
      void WorkStationViewService.showWorkStation();
    });
  }, []);
  const handleMaximizeChat = useCallback(() => {
    toggleChatPanelMaximized();
  }, [toggleChatPanelMaximized]);
  const handleShowWorkstation = useCallback(() => {
    toggleActiveChatMaximized();
  }, [toggleActiveChatMaximized]);

  if (!visible) return null;

  const stationAvailable = isChatPanelTabStationAvailable(activeTab);

  // Slot A: hide / restore the chat pane. Meaningless while the chat is
  // maximized (there is no workstation to grow), so it is dropped outright.
  const chatVisibilityControl = chatPanelMaximized ? null : (
    <TabBarTrailingIconButton
      title={
        isChatPanelVisible
          ? t("chat.maximizeWorkStation")
          : t("chat.restoreChatPanel")
      }
      shortcutId="maximize_work_station"
      tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
      onClick={handleToggleChatPanel}
      data-testid="pinned-workbench-chrome-chat-visibility"
    >
      {isChatPanelVisible ? (
        <HugeiconsIcon
          icon={ArrowExpand01Icon}
          data-icon="maximize-2"
          size={14}
          strokeWidth={2}
        />
      ) : (
        <HugeiconsIcon
          icon={BubbleChatIcon}
          data-icon="message-circle"
          size={14}
          strokeWidth={2}
        />
      )}
    </TabBarTrailingIconButton>
  );

  // Slot B: maximize chat while the workstation shows; show the workstation
  // again while the chat is maximized. Nothing to draw while the chat is
  // hidden — no spacer either, so the restore toggle sits flush right and
  // the host reserves for one slot (`useWorkbenchRightEdgeReservation`).
  let maximizeControl: React.ReactNode;
  if (!isChatPanelVisible) {
    maximizeControl = null;
  } else if (chatPanelMaximized) {
    maximizeControl = (
      <TabBarTrailingIconButton
        title={
          stationAvailable
            ? t("chat.showWorkstation")
            : t("chat.workstationUnavailableForPage")
        }
        shortcutId={stationAvailable ? "maximize_chat" : undefined}
        tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
        nativeTitle={false}
        onClick={stationAvailable ? handleShowWorkstation : undefined}
        disabled={!stationAvailable}
        className="group"
        data-testid="pinned-workbench-chrome-show-workstation"
      >
        <span className="flex h-4 w-4 items-center justify-center">
          <HugeiconsIcon
            icon={
              chatPanelPosition === "left"
                ? LayoutAlignRightIcon
                : PanelRightIcon
            }
            data-icon={
              chatPanelPosition === "left"
                ? "layout-align-right"
                : "panel-right"
            }
            size={HEADER_ICON_SIZE.md}
            strokeWidth={1.75}
            className="group-hover:hidden"
          />
          <HugeiconsIcon
            icon={
              chatPanelPosition === "left" ? PanelRightIcon : PanelRightOpenIcon
            }
            data-icon={
              chatPanelPosition === "left" ? "panel-right" : "panel-right-open"
            }
            size={HEADER_ICON_SIZE.md}
            strokeWidth={1.75}
            className="hidden group-hover:block"
          />
        </span>
      </TabBarTrailingIconButton>
    );
  } else {
    maximizeControl = (
      <TabBarTrailingIconButton
        title={t("chat.hideWorkstation")}
        shortcutId="maximize_chat"
        tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
        onClick={handleMaximizeChat}
        className={chatPanelPosition === "left" ? "group" : undefined}
        data-testid="pinned-workbench-chrome-maximize-chat"
      >
        <WorkstationMaximizeChatIcon chatPanelPosition={chatPanelPosition} />
      </TabBarTrailingIconButton>
    );
  }

  return (
    <div
      className="fixed z-[10000] flex -translate-y-1/2 items-center gap-px"
      data-testid="pinned-workbench-chrome"
      style={
        {
          right: PINNED_WORKBENCH_CHROME_RIGHT_INSET,
          top: PINNED_WORKBENCH_CHROME_CENTER_TOP,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      {chatVisibilityControl}
      {maximizeControl}
    </div>
  );
};

export const PinnedWorkbenchChrome = memo(PinnedWorkbenchChromeComponent);
PinnedWorkbenchChrome.displayName = "PinnedWorkbenchChrome";
