/**
 * AgentStationTopHeader
 *
 * Drag-region header bar for the Agent-station variant of AppShell.
 * Contains: station mode chip, chat panel toggle, caption toggle,
 * layout settings dropdown, and a separate caption row below the top bar.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, startTransition, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { NoDragRegion } from "@src/components/WindowChrome";
import { CHROME_TOOLTIP_HOVER_DELAY } from "@src/config/tooltip";
import { TAB_BAR_CONTROLS_ROW_TRAILING_PADDING_PX } from "@src/config/workstation/tokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import CaptionBar from "@src/engines/Simulator/components/CaptionBar";
import { useCurrentTurnLastAgentMessage } from "@src/engines/Simulator/hooks/useCurrentTurnLastAgentMessage";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import {
  getCollapsedSidebarChromeOffset,
  useShouldOffsetWorkStationTopBar,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import {
  usePinnedWorkbenchChromeVisible,
  useWorkbenchRightEdgeReservation,
} from "@src/hooks/ui/workbench/usePinnedWorkbenchChrome";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  CaptionsIcon,
  HugeiconsIcon,
  PanelRightIcon,
} from "@src/icons";
import { CHROME_INSET_TRANSITION_CLASSES } from "@src/modules/shared/layouts/viewContainerTokens";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import {
  sessionMapAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  activeStationChatVisibleAtom,
  chatWidthAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  simulatorCaptionBarEnabledAtom,
  simulatorEffectiveDockAppAtom,
} from "@src/store/ui/simulatorAtom";
import { chatPanelPositionAtom } from "@src/store/ui/workStationAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { SimulatorAgentChip, StationModeChip } from "../shared";

const AgentStationTopHeader: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const shouldOffsetLeftChrome = useShouldOffsetWorkStationTopBar();
  const pinnedChrome = usePinnedWorkbenchChromeVisible();
  const rightEdge = useWorkbenchRightEdgeReservation();
  const getStationChatVisible = useAtomValue(activeStationChatVisibleAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const toggleChatPanelMaximized = useSetAtom(toggleChatPanelMaximizedAtom);
  const isChatPanelVisible =
    getStationChatVisible("agent-station") && chatWidth > 0;
  const location = useLocation();
  // Settings occupies the chat-panel slot; SettingsSlot owns its own
  // maximize/restore button, so the workstation-side toggle is redundant
  // and visually conflicting (two buttons driving the same atom).
  const isSettingsRoute = location.pathname.startsWith("/orgii/app/settings");
  const showPaneControls = !isSettingsRoute && !pinnedChrome;
  const effectiveDockApp = useAtomValue(simulatorEffectiveDockAppAtom);
  const [captionEnabled, setCaptionEnabled] = useAtom(
    simulatorCaptionBarEnabledAtom
  );
  const captionMessage = useCurrentTurnLastAgentMessage();
  const workstationActiveSessionId = useAtomValue(
    workstationActiveSessionIdAtom
  );
  const sessionMap = useAtomValue(sessionMapAtom);
  const activeSession = workstationActiveSessionId
    ? sessionMap.get(workstationActiveSessionId)
    : undefined;
  const captionAgentName = activeSession?.agentDisplayName?.trim() || "Agent";
  const showMessageNotice =
    captionMessage?.isCurrentEvent && effectiveDockApp === AppType.CHANNELS;
  const captionText = showMessageNotice
    ? captionMessage.eventKind === "thought"
      ? t("simulator.thoughtSentMessageCaption", {
          subject: captionAgentName,
        })
      : t(
          captionMessage.source === "user"
            ? "simulator.userSentMessageCaption"
            : "simulator.agentSentMessageCaption",
          { subject: captionAgentName }
        )
    : captionMessage?.text;
  const captionToggleLabel = t("simulator.captionBarToggleTooltip");
  const chatPanelLabel = isChatPanelVisible
    ? t("chat.maximizeWorkStation")
    : t("chat.restoreChatPanel");
  const hideWorkstationLabel = t("chat.hideWorkstation");

  const showCaptionBar =
    captionEnabled && !!captionMessage && !!workstationActiveSessionId;

  const handleToggleCaption = useCallback(() => {
    setCaptionEnabled((prev) => !prev);
  }, [setCaptionEnabled]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const isCaptionsShortcut = isMac
        ? event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey
        : event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey;
      if (!isCaptionsShortcut || event.code !== "KeyC") return;
      event.preventDefault();
      event.stopPropagation();
      handleToggleCaption();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleToggleCaption]);

  const getCaptionPortalBounds = useCallback(() => {
    const { width: vw } = getViewportSize();
    return {
      left: 12,
      right: vw - 12,
    };
  }, []);

  const handleToggleChatPanel = useCallback(() => {
    startTransition(() => {
      void WorkStationViewService.showWorkStation();
    });
  }, []);

  const handleToggleChatPanelMaximized = useCallback(() => {
    toggleChatPanelMaximized();
  }, [toggleChatPanelMaximized]);

  return (
    <div className="flex shrink-0 flex-col">
      <div
        className={`relative flex h-11 min-h-11 shrink-0 items-center pt-2 ${CHROME_INSET_TRANSITION_CLASSES}`}
        data-tauri-drag-region
        style={
          {
            paddingLeft: shouldOffsetLeftChrome
              ? getCollapsedSidebarChromeOffset()
              : undefined,
            // The trailing group keeps its own `pr-2`; only the remainder of
            // the pinned-chrome reservation goes here.
            paddingRight:
              rightEdge.owner === "workstation"
                ? rightEdge.reservedRight -
                  TAB_BAR_CONTROLS_ROW_TRAILING_PADDING_PX
                : undefined,
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      >
        {shouldOffsetLeftChrome ? (
          <NoDragRegion className="flex h-full items-center">
            <CollapsedSidebarButton />
          </NoDragRegion>
        ) : null}
        <NoDragRegion className="flex h-full min-w-0 items-center gap-1 px-2">
          <StationModeChip />
          <SimulatorAgentChip />
        </NoDragRegion>
        <div className="min-w-0 flex-1" />
        <NoDragRegion className="ml-auto flex h-full shrink-0 items-center gap-px pr-2 pl-1">
          <TabBarTrailingIconButton
            title={captionToggleLabel}
            shortcutId="toggle_captions"
            tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
            active={captionEnabled}
            aria-pressed={captionEnabled}
            onClick={handleToggleCaption}
          >
            <HugeiconsIcon
              icon={CaptionsIcon}
              data-icon="captions"
              size={16}
              strokeWidth={2}
            />
          </TabBarTrailingIconButton>
          {showPaneControls && !isChatPanelVisible && (
            <TabBarTrailingIconButton
              title={chatPanelLabel}
              shortcutId="maximize_work_station"
              tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
              onClick={handleToggleChatPanel}
            >
              <HugeiconsIcon
                icon={ArrowShrink01Icon}
                data-icon="minimize-2"
                size={14}
                strokeWidth={2}
              />
            </TabBarTrailingIconButton>
          )}
          {/* Empty macOS stations leave these actions to the pinned window
              chrome. Once a session populates Agent Station, this header
              owns them so the controls do not disappear with that chrome. */}
          {showPaneControls && (
            <TabBarTrailingIconButton
              title={chatPanelLabel}
              shortcutId="maximize_work_station"
              tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
              onClick={handleToggleChatPanel}
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
          )}
          {showPaneControls && isChatPanelVisible && (
            <TabBarTrailingIconButton
              title={hideWorkstationLabel}
              shortcutId="maximize_chat"
              tooltipMouseEnterDelay={CHROME_TOOLTIP_HOVER_DELAY}
              onClick={handleToggleChatPanelMaximized}
            >
              {chatPanelPosition === "left" ? (
                <HugeiconsIcon
                  icon={PanelRightIcon}
                  data-icon="panel-right"
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={2}
                />
              ) : (
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  data-icon="x"
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={1.75}
                />
              )}
            </TabBarTrailingIconButton>
          )}
        </NoDragRegion>
      </div>
      {showCaptionBar && captionMessage ? (
        <NoDragRegion className="flex h-10 min-h-10 shrink-0 items-center justify-start px-3">
          <div className="w-full min-w-0">
            <CaptionBar
              key={captionMessage.eventId}
              text={captionText ?? captionMessage.text}
              getPortalBounds={getCaptionPortalBounds}
            />
          </div>
        </NoDragRegion>
      ) : null}
    </div>
  );
});

AgentStationTopHeader.displayName = "AgentStationTopHeader";

export default AgentStationTopHeader;
