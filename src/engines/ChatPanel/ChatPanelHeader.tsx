import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import {
  ChevronLeft,
  Clipboard,
  FolderOutput,
  GalleryThumbnails,
  Link2,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Maximize2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import React from "react";
import { createPortal } from "react-dom";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import RegionNoticeButton from "@src/components/RegionNoticeButton";
import Select, { type SelectOption } from "@src/components/Select";
import SessionHoverCard from "@src/components/SessionHoverCard";
import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import type { DropdownEnginePosition } from "@src/hooks/dropdown";
import { COLLAPSED_SIDEBAR_CHROME_OFFSET } from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";
import { PresenceMenuButton } from "@src/scaffold/NavigationSidebar/blocks/SidebarBottomBar";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatHistoryDisplayMode,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";
import { isWindows } from "@src/util/platform/tauri";

import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
  ChatPanelHeaderAgentSwitch,
  ChatPanelHeaderDragSpacer,
  ChatPanelHeaderSlotsView,
  ChatPanelHeaderTitlePill,
  chatPanelHeaderSlotsAtom,
} from "./header";
import type { ChatPanelRegionNotice } from "./types";

const CHAT_PANEL_HEADER_ICON_SIZE = 14;
const CHAT_PANEL_HEADER_PROMINENT_ICON_SIZE = 16;

interface ChatPanelHeaderProps {
  activeSessionExists: boolean;
  allBlocksCollapsed: boolean;
  collapseToggleLabel: string;
  copyEventJsonLabel: "idle" | "copied" | "failed";
  createTarget: ChatPanelCreateTarget;
  createTargetOptions: SelectOption[];
  currentSessionId: string | null;
  displayMode: ChatHistoryDisplayMode;
  eventsLength: number;
  exploreAgentSearchEnabled: boolean;
  handleChatFocusToggle: () => void;
  handleCompactDisplayModeToggle: (checked: boolean) => void;
  handleCopyEventJson: () => void;
  handleCreateTargetChange: (
    value: string | number | (string | number)[]
  ) => void;
  handleExploreAgentSearchToggle: (enabled: boolean) => void;
  handleOpenExportSessionJson: () => void;
  handleOpenLinkWorkItem: () => void;
  handleOpenSearch: () => void;
  handleNewSession: () => void;
  handleOpenStartPage: () => void;
  handlePaginationToggle: (checked: boolean) => void;
  handleProjectAgentCreatorToggle: (enabled: boolean) => void;
  handleProjectTitleChange: (title: string) => void;
  handleReloadFromMenu: () => void;
  handleToggleAllBlocksCollapsed: () => void;
  handleWorkItemAgentCreatorToggle: (enabled: boolean) => void;
  handleWorkItemTitleChange: (title: string) => void;
  headerActionsDropdownRef: React.RefObject<HTMLDivElement | null>;
  headerActionsPosition: DropdownEnginePosition;
  headerActionsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  headerTitle: string;
  headerTitleContent?: React.ReactNode;
  isChatFocus: boolean;
  isCompactLayout: boolean;
  isHeaderActionsOpen: boolean;
  isHeaderActionsPositioned: boolean;
  isProjectTarget: boolean;
  paginationEnabled: boolean;
  showStartPageBackButton: boolean;
  selectedProjectVisible: boolean;
  selectedWorkItemVisible: boolean;
  shouldOffsetHeaderForCollapsedSidebar: boolean;
  showBenchmarkSessionGroupContent: boolean;
  showChatFocusToggle: boolean;
  showCreatorPresenceInHeader: boolean;
  showHeader: boolean;
  showExploreAgentSwitchInHeader: boolean;
  showNewSessionButton: boolean;
  showNonSessionContent: boolean;
  showProjectAgentCreator: boolean;
  showProjectAgentSwitchInHeader: boolean;
  showSessionContent: boolean;
  showStartPage: boolean;
  showWorkItemAgentCreator: boolean;
  showWorkItemAgentSwitchInHeader: boolean;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
  toggleHeaderActionsMenu: () => void;
  visibleRegionNotice: ChatPanelRegionNotice | null;
}

export function ChatPanelHeader({
  activeSessionExists,
  allBlocksCollapsed,
  collapseToggleLabel,
  copyEventJsonLabel,
  createTarget,
  createTargetOptions,
  currentSessionId,
  displayMode,
  eventsLength,
  exploreAgentSearchEnabled,
  handleChatFocusToggle,
  handleCompactDisplayModeToggle,
  handleCopyEventJson,
  handleCreateTargetChange,
  handleExploreAgentSearchToggle,
  handleOpenExportSessionJson,
  handleOpenLinkWorkItem,
  handleOpenSearch,
  handleNewSession,
  handleOpenStartPage,
  handlePaginationToggle,
  handleProjectAgentCreatorToggle,
  handleProjectTitleChange,
  handleReloadFromMenu,
  handleToggleAllBlocksCollapsed,
  handleWorkItemAgentCreatorToggle,
  handleWorkItemTitleChange,
  headerActionsDropdownRef,
  headerActionsPosition,
  headerActionsTriggerRef,
  headerTitle,
  headerTitleContent,
  isChatFocus,
  isCompactLayout,
  isHeaderActionsOpen,
  isHeaderActionsPositioned,
  isProjectTarget,
  paginationEnabled,
  showStartPageBackButton,
  selectedProjectVisible,
  selectedWorkItemVisible,
  shouldOffsetHeaderForCollapsedSidebar,
  showBenchmarkSessionGroupContent,
  showChatFocusToggle,
  showCreatorPresenceInHeader,
  showHeader,
  showExploreAgentSwitchInHeader,
  showNewSessionButton,
  showNonSessionContent,
  showProjectAgentCreator,
  showProjectAgentSwitchInHeader,
  showSessionContent,
  showStartPage,
  showWorkItemAgentCreator,
  showWorkItemAgentSwitchInHeader,
  t,
  toggleHeaderActionsMenu,
  visibleRegionNotice,
}: ChatPanelHeaderProps): React.ReactNode {
  const publishedHeaderSlots = useAtomValue(chatPanelHeaderSlotsAtom);
  const windowsHost = isWindows();
  if (!showHeader) return null;

  const showStaticCollabCreateTitle =
    showNonSessionContent &&
    !selectedWorkItemVisible &&
    !selectedProjectVisible &&
    createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG;

  const chatFocusLabel = isChatFocus
    ? t("chat.showWorkstation")
    : t("chat.maximizeChatPanel");
  const chatFocusShortcut = getShortcutKeys("maximize_chat");
  const chatFocusTooltip = (
    <KeyboardShortcutTooltipContent
      label={chatFocusLabel}
      shortcut={chatFocusShortcut}
    />
  );
  const shrinkToWorkstationLabel = t("chat.showWorkstation");
  const shrinkToWorkstationTooltip = (
    <KeyboardShortcutTooltipContent
      label={shrinkToWorkstationLabel}
      shortcut={chatFocusShortcut}
    />
  );
  const agentSwitchLabel = t("navigation:labels.agent", {
    defaultValue: "Agent",
  });

  const headerToolbar = (
    <div
      className="flex h-9 flex-shrink-0 items-center gap-px"
      style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
    >
      {showSessionContent && (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent label={collapseToggleLabel} />
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
              onClick={handleToggleAllBlocksCollapsed}
              aria-label={collapseToggleLabel}
              icon={
                allBlocksCollapsed ? (
                  <ListChevronsUpDown
                    size={CHAT_PANEL_HEADER_ICON_SIZE}
                    strokeWidth={2}
                  />
                ) : (
                  <ListChevronsDownUp
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
      {showSessionContent && (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent label={t("common:actions.more")} />
          }
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          <span className="inline-flex">
            <Button
              ref={
                headerActionsTriggerRef as React.RefObject<HTMLButtonElement>
              }
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={
                isHeaderActionsOpen ? "!bg-fill-1 !text-primary-6" : ""
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleHeaderActionsMenu();
              }}
              aria-label={t("common:actions.more")}
              aria-expanded={isHeaderActionsOpen}
              data-testid="chat-panel-header-more-button"
              icon={
                <MoreHorizontal
                  size={CHAT_PANEL_HEADER_ICON_SIZE}
                  strokeWidth={2}
                />
              }
            />
          </span>
        </Tooltip>
      )}
      {showChatFocusToggle && (
        <Tooltip
          content={isChatFocus ? shrinkToWorkstationTooltip : chatFocusTooltip}
          position="bottom-end"
          mouseEnterDelay={200}
          framedPanel
        >
          <span className="inline-flex">
            <TabBarTrailingIconButton
              title={isChatFocus ? shrinkToWorkstationLabel : chatFocusLabel}
              nativeTitle={false}
              onClick={handleChatFocusToggle}
            >
              {isChatFocus ? (
                <GalleryThumbnails
                  size={HEADER_ICON_SIZE.md}
                  strokeWidth={1.75}
                />
              ) : (
                <Maximize2 size={HEADER_ICON_SIZE.md} strokeWidth={1.75} />
              )}
            </TabBarTrailingIconButton>
          </span>
        </Tooltip>
      )}
      {showNewSessionButton && (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent
              label={t("chat.newSession")}
              shortcut={getShortcutKeys("new_session")}
            />
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
              onClick={handleNewSession}
              aria-label={t("chat.newSession")}
              icon={
                <Plus
                  size={CHAT_PANEL_HEADER_PROMINENT_ICON_SIZE}
                  strokeWidth={2}
                />
              }
            />
          </span>
        </Tooltip>
      )}
      {isHeaderActionsOpen &&
        isHeaderActionsPositioned &&
        createPortal(
          <div
            ref={headerActionsDropdownRef as React.RefObject<HTMLDivElement>}
            className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
            style={{
              position: "fixed",
              top: headerActionsPosition.top ?? 0,
              right: headerActionsPosition.right ?? 0,
              zIndex: 9999,
            }}
          >
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left`}
              onClick={handleOpenSearch}
            >
              <Search size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">{t("chat.findInChat")}</span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleReloadFromMenu}
              disabled={!showSessionContent}
            >
              <RefreshCw size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("common:actions.reload")}
              </span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleCopyEventJson}
              disabled={eventsLength === 0}
            >
              <Clipboard size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {copyEventJsonLabel === "copied"
                  ? t("chat.copyEventJsonCopied")
                  : copyEventJsonLabel === "failed"
                    ? t("chat.copyEventJsonFailed")
                    : t("chat.copyEventJson")}
              </span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleOpenLinkWorkItem}
              disabled={!currentSessionId}
              data-testid="session-link-work-item-button"
            >
              <Link2 size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">Link to Work Item…</span>
            </button>
            <button
              type="button"
              className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full text-left disabled:cursor-not-allowed disabled:opacity-50`}
              onClick={handleOpenExportSessionJson}
              disabled={!activeSessionExists}
            >
              <FolderOutput size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
              <span className="flex-1 truncate">
                {t("chat.importExport.exportAction")}
              </span>
            </button>
            <div className="my-1 border-t border-solid border-border-2" />
            <div
              className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
            >
              <span className="flex-1 truncate">
                {t("common:pagination.title")}
              </span>
              <Switch
                checked={paginationEnabled}
                onChange={handlePaginationToggle}
                size="small"
              />
            </div>
            <div
              className={`${DROPDOWN_CLASSES.item} w-full justify-between text-left`}
            >
              <span className="flex-1 truncate">
                {t("chat.compactDisplayMode")}
              </span>
              <Switch
                checked={displayMode === "compact"}
                onChange={handleCompactDisplayModeToggle}
                size="small"
              />
            </div>
          </div>,
          document.body
        )}
    </div>
  );

  return (
    <div
      className={`workspace-header header-tab-group relative flex flex-shrink-0 items-center gap-1.5 ${isCompactLayout ? "h-11 min-h-11 pl-2 pr-[7px] pt-2" : "h-9 min-h-9 px-2"}`}
      data-testid="chat-panel-header"
      data-tauri-drag-region={windowsHost ? undefined : true}
      style={
        {
          paddingLeft: shouldOffsetHeaderForCollapsedSidebar
            ? COLLAPSED_SIDEBAR_CHROME_OFFSET
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
      {showStartPageBackButton ? (
        <Tooltip
          content={
            <KeyboardShortcutTooltipContent
              label={t("chat.startPage.back")}
              noShortcut
            />
          }
          position="bottom-start"
          mouseEnterDelay={200}
          framedPanel
        >
          <span className="inline-flex" style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={handleOpenStartPage}
              aria-label={t("chat.startPage.back")}
              data-testid="chat-panel-start-page-back-button"
              icon={
                <ChevronLeft
                  size={CHAT_PANEL_HEADER_PROMINENT_ICON_SIZE}
                  strokeWidth={2}
                />
              }
            />
          </span>
        </Tooltip>
      ) : null}
      {showNonSessionContent &&
        !showStartPage &&
        !selectedWorkItemVisible &&
        !selectedProjectVisible && (
          <div
            className="flex h-9 w-auto flex-shrink-0 items-center"
            style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
          >
            {showStaticCollabCreateTitle ? (
              <ChatPanelHeaderTitlePill>{headerTitle}</ChatPanelHeaderTitlePill>
            ) : (
              <Select
                value={createTarget}
                options={createTargetOptions}
                onChange={handleCreateTargetChange}
                size="small"
                variant="ghost"
                radius="pill"
                dropdownMinWidth={168}
                dropdownWidthMode="auto"
                className="w-auto"
                selectorClassName="!h-7 max-w-[180px] !gap-1.5 !rounded-lg !border-0 !bg-transparent !px-1.5 !text-[13px] font-medium !text-text-1 hover:!bg-surface-hover [&_.select-suffix]:!ml-0 [&_.select-value]:-translate-y-[0.5px]"
                dataTestId="chat-panel-create-target-select"
              />
            )}
            {showCreatorPresenceInHeader && (
              <>
                <div
                  className="mx-1 h-4 w-px shrink-0 bg-border-2"
                  role="separator"
                  aria-hidden
                />
                <PresenceMenuButton dropdownPosition="bottom-end" />
              </>
            )}
            {(showWorkItemAgentSwitchInHeader ||
              showProjectAgentSwitchInHeader) && (
              <>
                <div
                  className="mx-1 h-4 w-px shrink-0 bg-border-2"
                  role="separator"
                  aria-hidden
                />
                <ChatPanelHeaderAgentSwitch
                  checked={
                    isProjectTarget
                      ? showProjectAgentCreator
                      : showWorkItemAgentCreator
                  }
                  label={agentSwitchLabel}
                  onChange={
                    isProjectTarget
                      ? handleProjectAgentCreatorToggle
                      : handleWorkItemAgentCreatorToggle
                  }
                  dataTestId={
                    isProjectTarget
                      ? "chat-panel-project-agent-switch"
                      : "chat-panel-work-item-agent-switch"
                  }
                />
              </>
            )}
          </div>
        )}
      {publishedHeaderSlots ? (
        <div className="flex h-9 min-w-0 flex-1 items-center">
          <ChatPanelHeaderSlotsView slots={publishedHeaderSlots} />
        </div>
      ) : showBenchmarkSessionGroupContent ||
        showSessionContent ||
        selectedWorkItemVisible ||
        selectedProjectVisible ||
        headerTitleContent ? (
        <>
          <div
            className="flex h-9 min-w-0 shrink items-center"
            style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
          >
            {showBenchmarkSessionGroupContent ? (
              <ChatPanelHeaderTitlePill>{headerTitle}</ChatPanelHeaderTitlePill>
            ) : headerTitleContent ? (
              <span
                className="flex min-w-0 max-w-full items-center gap-2"
                data-testid="chat-panel-header-title"
              >
                {headerTitleContent}
                {showExploreAgentSwitchInHeader ? (
                  <>
                    <div
                      className="h-4 w-px shrink-0 bg-border-2"
                      role="separator"
                      aria-hidden
                    />
                    <ChatPanelHeaderAgentSwitch
                      checked={exploreAgentSearchEnabled}
                      label={agentSwitchLabel}
                      onChange={handleExploreAgentSearchToggle}
                      dataTestId="chat-panel-explore-agent-search-switch"
                    />
                  </>
                ) : null}
              </span>
            ) : showSessionContent ||
              (selectedWorkItemVisible && currentSessionId) ? (
              <SessionHoverCard sessionId={currentSessionId}>
                <ChatPanelHeaderTitlePill>
                  {headerTitle}
                </ChatPanelHeaderTitlePill>
              </SessionHoverCard>
            ) : selectedProjectVisible ? (
              <Input
                type="text"
                value={headerTitle}
                onChange={handleProjectTitleChange}
                fieldVariant="ghost"
                size="small"
                data-testid="chat-panel-header-title-input"
              />
            ) : (
              <Input
                type="text"
                value={headerTitle}
                onChange={handleWorkItemTitleChange}
                readOnly={!selectedWorkItemVisible}
                fieldVariant="ghost"
                size="small"
                data-testid="chat-panel-header-title-input"
              />
            )}
          </div>
          <ChatPanelHeaderDragSpacer />
        </>
      ) : (
        <ChatPanelHeaderDragSpacer />
      )}
      {headerToolbar}
    </div>
  );
}
