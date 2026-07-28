import React from "react";

import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import type { CustomMentionOption } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import type { AddressCommentsFlyoutData } from "@src/engines/ChatPanel/hooks/useInputArea/useSlashCommand";
import type { MenuItemId } from "@src/scaffold/ContextMenu/config";
import type { SlashItem } from "@src/types/extensions";

import ContextMenuPortal from "./ContextMenuPortal";
import SlashCommandPortal from "./SlashCommandPortal";

interface InputAreaPortalsProps {
  contextMenuVisible: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onContextMenuClose: () => void;
  onAtSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  customMentionOptions: ReadonlyArray<CustomMentionOption>;
  onCustomMentionSelect: (option: CustomMentionOption) => void;
  atSearchQuery: string;
  contextMenuKeyboardOpened: boolean;
  currentRepoPath?: string;
  contextMenuKeyboardHandlerRef: React.MutableRefObject<
    ((event: React.KeyboardEvent) => boolean) | null
  >;
  mentionTreePosition: "left" | "right";
  isEditMode: boolean;
  showSlashMenu: boolean;
  filteredSlashItems: SlashItem[];
  slashLoading: boolean;
  currentMode: AgentExecMode;
  slashQuery: string;
  onSlashCommandClose: () => void;
  onSlashSelect: (item: SlashItem) => void;
  onModeSelect: (mode: AgentExecMode) => void;
  slashCommandKeyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
  onImageUpload?: () => void;
  showActionFlyouts?: boolean;
  showModeRows?: boolean;
  showPlusSlashMenu: boolean;
  plusSlashQuery: string;
  onPlusSlashClose: () => void;
  onSlashAppendSelect: (item: SlashItem) => void;
  plusSlashCommandKeyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
  onPlusSlashQueryChange: (query: string) => void;
  addressCommentsFlyout?: AddressCommentsFlyoutData;
  /**
   * When true, the composer is anchored to the bottom of the viewport (the
   * floating chat composer), so its menus must open upward even in edit mode —
   * the default edit-mode "down" placement only works for the message-edit
   * composer that lives mid-history with room beneath it.
   */
  bottomAnchored?: boolean;
}

export const InputAreaPortals: React.FC<InputAreaPortalsProps> = ({
  contextMenuVisible,
  containerRef,
  onContextMenuClose,
  onAtSelect,
  customMentionOptions,
  onCustomMentionSelect,
  atSearchQuery,
  contextMenuKeyboardOpened,
  currentRepoPath,
  contextMenuKeyboardHandlerRef,
  mentionTreePosition,
  isEditMode,
  showSlashMenu,
  filteredSlashItems,
  slashLoading,
  currentMode,
  slashQuery,
  onSlashCommandClose,
  onSlashSelect,
  onModeSelect,
  slashCommandKeyboardHandlerRef,
  onImageUpload,
  showActionFlyouts = true,
  showModeRows = true,
  showPlusSlashMenu,
  plusSlashQuery,
  onPlusSlashClose,
  onSlashAppendSelect,
  plusSlashCommandKeyboardHandlerRef,
  onPlusSlashQueryChange,
  addressCommentsFlyout,
  bottomAnchored = false,
}) => {
  const portalPlacement = isEditMode && !bottomAnchored ? "down" : "prefer-up";
  const menuAnchorSelector = isEditMode
    ? "[data-editor-slot]"
    : "[data-composer-menu-anchor]";
  const plusMenuAnchorSelector = "[data-composer-plus-menu-trigger]";

  return (
    <>
      <ContextMenuPortal
        visible={contextMenuVisible}
        containerRef={containerRef}
        onClose={onContextMenuClose}
        onSelect={onAtSelect}
        customMentionOptions={customMentionOptions}
        onCustomMentionSelect={onCustomMentionSelect}
        searchQuery={atSearchQuery}
        keyboardOpened={contextMenuKeyboardOpened}
        repoPath={currentRepoPath || undefined}
        keyboardHandlerRef={contextMenuKeyboardHandlerRef}
        treePosition={mentionTreePosition}
        placement={portalPlacement}
        anchorSelector={menuAnchorSelector}
      />

      <SlashCommandPortal
        visible={showSlashMenu}
        containerRef={containerRef}
        anchorSelector={menuAnchorSelector}
        placement={portalPlacement}
        items={filteredSlashItems}
        loading={slashLoading}
        currentMode={currentMode}
        searchQuery={slashQuery}
        onClose={onSlashCommandClose}
        onSelect={onSlashSelect}
        onModeSelect={onModeSelect}
        keyboardHandlerRef={slashCommandKeyboardHandlerRef}
        showActionFlyouts={showActionFlyouts}
        showModeRows={showModeRows}
        onImageUpload={onImageUpload}
        addressComments={addressCommentsFlyout}
      />

      <SlashCommandPortal
        visible={showPlusSlashMenu}
        containerRef={containerRef}
        anchorSelector={plusMenuAnchorSelector}
        placement={portalPlacement}
        items={filteredSlashItems}
        loading={slashLoading}
        currentMode={currentMode}
        searchQuery={plusSlashQuery}
        onClose={onPlusSlashClose}
        onSelect={(item) => {
          onSlashAppendSelect(item);
          onPlusSlashClose();
        }}
        onModeSelect={(mode) => {
          onModeSelect(mode);
          onPlusSlashClose();
        }}
        keyboardHandlerRef={plusSlashCommandKeyboardHandlerRef}
        searchMode="header"
        showActionFlyouts={showActionFlyouts}
        showModeRows={showModeRows}
        addressComments={addressCommentsFlyout}
        onSearchQueryChange={onPlusSlashQueryChange}
        onImageUpload={
          onImageUpload
            ? () => {
                onPlusSlashClose();
                onImageUpload();
              }
            : undefined
        }
      />
    </>
  );
};
