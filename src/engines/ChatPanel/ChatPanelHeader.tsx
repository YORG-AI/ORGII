import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import {
  Maximize2,
  MonitorPlay,
  PanelRight,
  TerminalSquare,
} from "lucide-react";
import React from "react";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import RegionNoticeButton from "@src/components/RegionNoticeButton";
import Tooltip from "@src/components/Tooltip";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import { getCollapsedSidebarChromeOffset } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import { isWindows } from "@src/util/platform/tauri";

import { SessionHeaderActionsMenu } from "./components/SessionHeaderActionsMenu";
import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
  ChatPanelPublishedHeader,
  chatPanelHeaderSlotsAtom,
} from "./header";
import type { ChatPanelRegionNotice } from "./types";

const CHAT_PANEL_HEADER_ICON_SIZE = 14;

interface ChatPanelHeaderProps {
  activeSessionExists: boolean;
  copyEventJsonLabel: "idle" | "copied" | "failed";
  currentSessionId: string | null;
  displayMode: ChatHistoryDisplayMode;
  eventsLength: number;
  handleChatFocusToggle: () => void;
  handleCompactDisplayModeToggle: (checked: boolean) => void;
  handleCopyEventJson: () => void;
  handleMoveToWorkstation: () => void;
  handleOpenExportSessionJson: () => void;
  handleOpenLinkWorkItem: () => void;
  handleOpenCloudShareSettings: () => void;
  handleOpenRawTranscript: () => void;
  handleOpenSearch: () => void;
  handlePaginationToggle: (checked: boolean) => void;
  handleReloadFromMenu: () => void;
  handleTokenUsageVisibleToggle: (checked: boolean) => void;
  handleTurnMetadataVisibleToggle: (checked: boolean) => void;
  headerActionsDropdownRef: React.RefObject<HTMLDivElement | null>;
  headerActionsPosition: DropdownEnginePosition;
  headerActionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  isChatFocus: boolean;
  isHeaderActionsOpen: boolean;
  isHeaderActionsPositioned: boolean;
  focusedWorkstationMenuHostRef?: React.RefCallback<HTMLSpanElement>;
  paginationEnabled: boolean;
  tokenUsageVisible: boolean;
  turnMetadataVisible: boolean;
  shouldOffsetHeaderForCollapsedSidebar: boolean;
  /** Whether the active tab may reveal a Station beside the chat pane. */
  stationAvailable: boolean;
  showHeader: boolean;
  showSessionContent: boolean;
  /** Owner-side share entry gate (design §6.3): own session + org in scope. */
  showCloudShareSettings: boolean;
  showTranscriptActions?: boolean;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
  toggleHeaderActionsMenu: () => void;
  visibleRegionNotice: ChatPanelRegionNotice | null;
  showTuiModeToggle: boolean;
  tuiMode: boolean;
  handleTuiModeToggle: () => void;
  tabStrip: React.ReactNode;
  /** When provided, rendered before the ... button (tab-strip + menu replacement) */
  tabStripPlus?: React.ReactNode;
  /** Session-scoped extras (fork button / provenance chip), leading the toolbar */
  sessionHeaderExtras?: React.ReactNode;
  /** Canonical session-name breadcrumb rendered in the published 40px row. */
  sessionHeaderContent?: React.ReactNode;
}

export function ChatPanelHeader({
  activeSessionExists,
  copyEventJsonLabel,
  currentSessionId,
  displayMode,
  eventsLength,
  handleChatFocusToggle,
  handleCompactDisplayModeToggle,
  handleCopyEventJson,
  handleMoveToWorkstation,
  handleOpenExportSessionJson,
  handleOpenLinkWorkItem,
  handleOpenCloudShareSettings,
  handleOpenRawTranscript,
  handleOpenSearch,
  handlePaginationToggle,
  handleReloadFromMenu,
  handleTokenUsageVisibleToggle,
  handleTurnMetadataVisibleToggle,
  headerActionsDropdownRef,
  headerActionsPosition,
  headerActionsTriggerRef,
  isChatFocus,
  isHeaderActionsOpen,
  isHeaderActionsPositioned,
  focusedWorkstationMenuHostRef,
  paginationEnabled,
  tokenUsageVisible,
  turnMetadataVisible,
  shouldOffsetHeaderForCollapsedSidebar,
  stationAvailable,
  showHeader,
  showSessionContent,
  showCloudShareSettings,
  showTranscriptActions,
  t,
  toggleHeaderActionsMenu,
  visibleRegionNotice,
  showTuiModeToggle,
  tuiMode,
  handleTuiModeToggle,
  tabStrip,
  tabStripPlus,
  sessionHeaderExtras,
  sessionHeaderContent,
}: ChatPanelHeaderProps): React.ReactNode {
  const publishedHeaderSlots = useAtomValue(chatPanelHeaderSlotsAtom);
  const windowsHost = isWindows();
  if (!showHeader) return null;

  const chatFocusLabel = isChatFocus
    ? t("chat.showWorkstation")
    : t("chat.maximizeChatPanel");
  const shrinkToWorkstationLabel = t("chat.showWorkstation");
  const tuiModeLabel = tuiMode ? t("chat.tuiModeOn") : t("chat.tuiModeOff");

  const sessionPublishedActions =
    showSessionContent || showTuiModeToggle || visibleRegionNotice ? (
      <div
        className="flex h-7 flex-shrink-0 items-center gap-px"
        style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
      >
        {showSessionContent && sessionHeaderExtras}
        {showTuiModeToggle && (
          <Tooltip
            content={
              <KeyboardShortcutTooltipContent label={tuiModeLabel} noShortcut />
            }
            position="bottom-end"
            mouseEnterDelay={200}
            framedPanel
          >
            <span className="inline-flex">
              <Button
                htmlType="button"
                variant="tertiary"
                size="small"
                iconOnly
                onClick={handleTuiModeToggle}
                aria-label={tuiModeLabel}
                aria-pressed={tuiMode}
                className={tuiMode ? "!text-primary-6" : ""}
                icon={
                  tuiMode ? (
                    <MonitorPlay
                      size={CHAT_PANEL_HEADER_ICON_SIZE}
                      strokeWidth={2}
                    />
                  ) : (
                    <TerminalSquare
                      size={CHAT_PANEL_HEADER_ICON_SIZE}
                      strokeWidth={2}
                    />
                  )
                }
              />
            </span>
          </Tooltip>
        )}
        {visibleRegionNotice && (
          <RegionNoticeButton
            title={visibleRegionNotice.title}
            body={<p className="m-0">{visibleRegionNotice.body}</p>}
            alertClassName="!border-border-2 !bg-chat-container !text-text-1 shadow-lg"
          />
        )}
        {focusedWorkstationMenuHostRef && (
          <span
            ref={focusedWorkstationMenuHostRef}
            className="inline-flex shrink-0 @[1100px]/focusedchat:hidden"
          />
        )}
        {showSessionContent && (
          <SessionHeaderActionsMenu
            activeSessionExists={activeSessionExists}
            copyEventJsonLabel={copyEventJsonLabel}
            currentSessionId={currentSessionId}
            displayMode={displayMode}
            eventsLength={eventsLength}
            handleCompactDisplayModeToggle={handleCompactDisplayModeToggle}
            handleCopyEventJson={handleCopyEventJson}
            handleMoveSession={handleMoveToWorkstation}
            handleOpenCloudShareSettings={handleOpenCloudShareSettings}
            handleOpenExportSessionJson={handleOpenExportSessionJson}
            handleOpenLinkWorkItem={handleOpenLinkWorkItem}
            handleOpenRawTranscript={handleOpenRawTranscript}
            handleOpenSearch={handleOpenSearch}
            handlePaginationToggle={handlePaginationToggle}
            handleReloadFromMenu={handleReloadFromMenu}
            handleTokenUsageVisibleToggle={handleTokenUsageVisibleToggle}
            handleTurnMetadataVisibleToggle={handleTurnMetadataVisibleToggle}
            headerActionsDropdownRef={headerActionsDropdownRef}
            headerActionsPosition={headerActionsPosition}
            headerActionsTriggerRef={headerActionsTriggerRef}
            isHeaderActionsOpen={isHeaderActionsOpen}
            isHeaderActionsPositioned={isHeaderActionsPositioned}
            moveTarget="workstation"
            paginationEnabled={paginationEnabled}
            showCloudShareSettings={showCloudShareSettings}
            showTranscriptActions={showTranscriptActions}
            tokenUsageVisible={tokenUsageVisible}
            turnMetadataVisible={turnMetadataVisible}
            toggleHeaderActionsMenu={toggleHeaderActionsMenu}
            triggerTestId="chat-panel-header-more-button"
          />
        )}
      </div>
    ) : null;
  const effectivePublishedHeaderSlots =
    publishedHeaderSlots || sessionHeaderContent || sessionPublishedActions
      ? {
          leading: publishedHeaderSlots?.leading,
          content: publishedHeaderSlots?.content ?? sessionHeaderContent,
          joinWithFollowingRow:
            publishedHeaderSlots?.joinWithFollowingRow ?? false,
          trailing:
            publishedHeaderSlots?.trailing || sessionPublishedActions ? (
              <div className="flex shrink-0 items-center gap-px">
                {publishedHeaderSlots?.trailing}
                {sessionPublishedActions}
              </div>
            ) : null,
        }
      : null;

  const tabBarToolbar = (
    <div
      className="flex h-9 flex-shrink-0 items-center gap-px"
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
    >
      {tabStripPlus}
      <span className="inline-flex">
        <TabBarTrailingIconButton
          title={isChatFocus ? shrinkToWorkstationLabel : chatFocusLabel}
          shortcutId={stationAvailable ? "maximize_chat" : undefined}
          tooltipPosition="bottom-end"
          nativeTitle={false}
          onClick={stationAvailable ? handleChatFocusToggle : undefined}
          disabled={!stationAvailable}
        >
          {isChatFocus ? (
            <PanelRight size={HEADER_ICON_SIZE.md} strokeWidth={1.75} />
          ) : (
            <Maximize2 size={HEADER_ICON_SIZE.md} strokeWidth={1.75} />
          )}
        </TabBarTrailingIconButton>
      </span>
    </div>
  );

  return (
    <>
      <div
        className="workspace-header header-tab-group relative flex h-11 min-h-11 flex-shrink-0 items-center gap-1.5 pl-2 pr-[7px] pt-2"
        data-testid="chat-panel-header"
        data-tauri-drag-region={windowsHost ? undefined : true}
        style={
          {
            paddingLeft: shouldOffsetHeaderForCollapsedSidebar
              ? getCollapsedSidebarChromeOffset()
              : undefined,
            ...(windowsHost
              ? CHAT_PANEL_HEADER_NO_DRAG_STYLE
              : CHAT_PANEL_HEADER_DRAG_STYLE),
          } as React.CSSProperties
        }
      >
        {shouldOffsetHeaderForCollapsedSidebar ? (
          <div style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}>
            <CollapsedSidebarButton />
          </div>
        ) : null}
        {tabStrip}
        {tabBarToolbar}
      </div>
      <ChatPanelPublishedHeader
        slots={effectivePublishedHeaderSlots}
        windowsHost={windowsHost}
      />
    </>
  );
}
