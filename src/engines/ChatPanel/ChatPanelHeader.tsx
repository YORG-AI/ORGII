import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import React from "react";

import Button from "@src/components/Button";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import RegionNoticeButton from "@src/components/RegionNoticeButton";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import Tooltip from "@src/components/Tooltip";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import {
  ArrowExpand01Icon,
  ComputerVideoIcon,
  HugeiconsIcon,
  LayoutAlignRightIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  SquareTerminalIcon,
} from "@src/icons";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";
import type { ChatPanelPosition } from "@src/store/ui/workStationLayout/chatPositionAtoms";

import { SessionHeaderActionsMenu } from "./components/SessionHeaderActionsMenu";
import {
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
  ChatPanelChrome,
  ChatPanelCollapsedTabHeading,
  chatPanelHeaderSlotsAtom,
} from "./header";
import type { ChatPanelRegionNotice } from "./types";

const CHAT_PANEL_HEADER_ICON_SIZE = 14;

interface ChatPanelHeaderProps {
  activeSessionExists: boolean;
  chatPanelPosition: ChatPanelPosition;
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
  /**
   * Fold the 44px tab row into the published 36px row, which then hosts the
   * tab controls the folded row would have carried.
   */
  tabRowCollapsed: boolean;
  /** Session-scoped extras (fork button / provenance chip), leading the toolbar */
  sessionHeaderExtras?: React.ReactNode;
  /** Canonical session-name breadcrumb rendered in the published 36px row. */
  sessionHeaderContent?: React.ReactNode;
  /** Let the GUI transcript scroll beneath the published session header. */
  overlayPublishedHeader?: boolean;
}

export function ChatPanelHeader({
  activeSessionExists,
  chatPanelPosition,
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
  tabRowCollapsed,
  sessionHeaderExtras,
  sessionHeaderContent,
  overlayPublishedHeader = false,
}: ChatPanelHeaderProps): React.ReactNode {
  const publishedHeaderSlots = useAtomValue(chatPanelHeaderSlotsAtom);
  if (!showHeader) return null;

  const chatFocusLabel = isChatFocus
    ? t("chat.showWorkstation")
    : t("chat.maximizeChatPanel");
  const shrinkToWorkstationLabel = t("chat.showWorkstation");
  const workstationUnavailableLabel = t("chat.workstationUnavailableForPage");
  const tuiModeLabel = tuiMode ? t("chat.tuiModeOn") : t("chat.tuiModeOff");

  const sessionPublishedActions =
    showSessionContent || showTuiModeToggle || visibleRegionNotice ? (
      <div
        className="flex h-7 shrink-0 items-center gap-px"
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
                className={tuiMode ? "text-primary-6!" : ""}
                icon={
                  tuiMode ? (
                    <HugeiconsIcon
                      icon={ComputerVideoIcon}
                      data-icon="monitor-play"
                      size={CHAT_PANEL_HEADER_ICON_SIZE}
                      strokeWidth={2}
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={SquareTerminalIcon}
                      data-icon="terminal-square"
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
            alertClassName="border-border-2! bg-chat-container! text-text-1! shadow-lg"
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
  const chatFocusToggleButton = (
    <span className="inline-flex">
      <TabBarTrailingIconButton
        title={
          stationAvailable
            ? isChatFocus
              ? shrinkToWorkstationLabel
              : chatFocusLabel
            : workstationUnavailableLabel
        }
        shortcutId={stationAvailable ? "maximize_chat" : undefined}
        tooltipPosition="bottom-end"
        nativeTitle={false}
        onClick={stationAvailable ? handleChatFocusToggle : undefined}
        disabled={!stationAvailable}
        className="group"
      >
        {isChatFocus ? (
          // Swap glyphs without cross-fading so their outlines never overlap.
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
                chatPanelPosition === "left"
                  ? PanelRightIcon
                  : PanelRightOpenIcon
              }
              data-icon={
                chatPanelPosition === "left"
                  ? "panel-right"
                  : "panel-right-open"
              }
              size={HEADER_ICON_SIZE.md}
              strokeWidth={1.75}
              className="hidden group-hover:block"
            />
          </span>
        ) : (
          <HugeiconsIcon
            icon={ArrowExpand01Icon}
            data-icon="maximize-2"
            size={HEADER_ICON_SIZE.md}
            strokeWidth={1.75}
          />
        )}
      </TabBarTrailingIconButton>
    </span>
  );

  const tabBarToolbar = (
    <div
      className="flex h-9 shrink-0 items-center gap-px"
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
    >
      {tabStripPlus}
      {chatFocusToggleButton}
    </div>
  );

  // The folded tab row's controls, rehomed on the published row. No close
  // control: closing the pane's last tab only reseeds another one, so it
  // earned no place in the row it would have crowded.
  const collapsedTabControls = (
    <div
      className="flex h-7 shrink-0 items-center gap-px"
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
      data-testid="chat-panel-collapsed-tab-controls"
    >
      {tabStripPlus}
      {chatFocusToggleButton}
    </div>
  );

  const publishedContent =
    publishedHeaderSlots?.content ?? sessionHeaderContent;
  // While collapsed this row is the pane's only chrome, so it renders even for
  // a surface that publishes nothing — otherwise folding the tab row would
  // strip the new-tab, close, and restore controls with it.
  // A split surface beneath the visible tab bar owns its controls in its
  // left-column header. Treat this as absent rather than merely hiding the
  // row so the shell also releases the 36px stack reservation.
  const effectivePublishedHeaderSlots = publishedHeaderSlots?.hidden
    ? null
    : tabRowCollapsed ||
        publishedHeaderSlots ||
        sessionHeaderContent ||
        sessionPublishedActions
      ? {
          leading: publishedHeaderSlots?.leading,
          content:
            publishedContent ??
            (tabRowCollapsed ? <ChatPanelCollapsedTabHeading /> : undefined),
          // Collapsed, this row stands in for the borderless tab row and is
          // the maximized pane's only chrome — a rule under it would be a
          // line the pane never had. Uncollapsed, the publisher decides.
          joinWithFollowingRow:
            tabRowCollapsed ||
            (publishedHeaderSlots?.joinWithFollowingRow ?? false),
          trailing:
            publishedHeaderSlots?.trailing ||
            sessionPublishedActions ||
            tabRowCollapsed ? (
              <div className="flex shrink-0 items-center gap-px">
                {publishedHeaderSlots?.trailing}
                {sessionPublishedActions}
                {tabRowCollapsed ? collapsedTabControls : null}
              </div>
            ) : null,
        }
      : null;

  return (
    <ChatPanelChrome
      tabStrip={tabStrip}
      toolbar={tabBarToolbar}
      publishedHeaderSlots={effectivePublishedHeaderSlots}
      overlayPublishedHeader={overlayPublishedHeader}
      shouldOffsetHeaderForCollapsedSidebar={
        shouldOffsetHeaderForCollapsedSidebar
      }
      tabRowCollapsed={tabRowCollapsed}
    />
  );
}
