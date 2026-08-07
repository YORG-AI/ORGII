/**
 * AgentStationTopHeader
 *
 * Drag-region header bar for the Agent-station variant of AppShell.
 * Contains: station mode chip, chat panel toggle, caption toggle,
 * layout settings dropdown, and a separate caption row below the top bar.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  Captions,
  Maximize2,
  MessageCircle,
  Minimize2,
  PanelRight,
  X,
} from "lucide-react";
import React, { memo, startTransition, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import CaptionBar from "@src/engines/Simulator/components/CaptionBar";
import { useCurrentTurnLastAgentMessage } from "@src/engines/Simulator/hooks/useCurrentTurnLastAgentMessage";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import {
  COLLAPSED_SIDEBAR_CHROME_OFFSET,
  useShouldOffsetWorkStationTopBar,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
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
import { sessionChatPositionAtom } from "@src/store/ui/workStationAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import {
  NoDragRegion,
  SimulatorAgentChip,
  StationModeChip,
  TabBarTrailingIconButton,
} from "../shared";

const AgentStationTopHeader: React.FC = memo(() => {
  const { t } = useTranslation("sessions");
  const shouldOffsetLeftChrome = useShouldOffsetWorkStationTopBar();
  const getStationChatVisible = useAtomValue(activeStationChatVisibleAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const sessionChatPosition = useAtomValue(sessionChatPositionAtom);
  const toggleChatPanelMaximized = useSetAtom(toggleChatPanelMaximizedAtom);
  const isChatPanelVisible =
    getStationChatVisible("agent-station") && chatWidth > 0;
  const location = useLocation();
  // Settings occupies the chat-panel slot; SettingsSlot owns its own
  // maximize/restore button, so the workstation-side toggle is redundant
  // and visually conflicting (two buttons driving the same atom).
  const isSettingsRoute = location.pathname.startsWith("/orgii/app/settings");
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
      ? t("workStation.chat.messages.bubble.senderTitle.thought", {
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
        className="relative flex h-11 min-h-11 shrink-0 items-center pt-2"
        data-tauri-drag-region
        style={
          {
            paddingLeft: shouldOffsetLeftChrome
              ? COLLAPSED_SIDEBAR_CHROME_OFFSET
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
        <NoDragRegion className="ml-auto flex h-full shrink-0 items-center gap-px pl-1 pr-2">
          <TabBarTrailingIconButton
            title={captionToggleLabel}
            shortcutId="toggle_captions"
            active={captionEnabled}
            aria-pressed={captionEnabled}
            onClick={handleToggleCaption}
          >
            <Captions size={16} strokeWidth={2} />
          </TabBarTrailingIconButton>
          {!isSettingsRoute && !isChatPanelVisible && (
            <TabBarTrailingIconButton
              title={chatPanelLabel}
              shortcutId="maximize_work_station"
              onClick={handleToggleChatPanel}
            >
              <Minimize2 size={14} strokeWidth={2} />
            </TabBarTrailingIconButton>
          )}
          {!isSettingsRoute && (
            <TabBarTrailingIconButton
              title={chatPanelLabel}
              shortcutId="maximize_work_station"
              onClick={handleToggleChatPanel}
            >
              {isChatPanelVisible ? (
                <Maximize2 size={14} strokeWidth={2} />
              ) : (
                <MessageCircle size={14} strokeWidth={2} />
              )}
            </TabBarTrailingIconButton>
          )}
          {!isSettingsRoute && isChatPanelVisible && (
            <TabBarTrailingIconButton
              title={hideWorkstationLabel}
              shortcutId="maximize_chat"
              onClick={handleToggleChatPanelMaximized}
            >
              {sessionChatPosition === "left" ? (
                <PanelRight size={HEADER_ICON_SIZE.md} strokeWidth={2} />
              ) : (
                <X size={HEADER_ICON_SIZE.md} strokeWidth={1.75} />
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
