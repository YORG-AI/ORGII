import React from "react";

import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";
import type { CustomMentionOption } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import type { MenuItemId } from "@src/scaffold/ContextMenu/config";
import type { SlashItem } from "@src/types/extensions";

import ContextMenuPortal from "./ContextMenuPortal";
import SlashCommandPortal from "./SlashCommandPortal";

interface InputAreaPortalsProps {
  contextMenuVisible: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onContextMenuClose: () => void;
  onAtSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  onImageUpload?: () => void;
  customMentionOptions: ReadonlyArray<CustomMentionOption>;
  onCustomMentionSelect: (option: CustomMentionOption) => void;
  atSearchQuery: string;
  currentRepoPath?: string;
  contextMenuKeyboardHandlerRef: React.MutableRefObject<
    ((event: React.KeyboardEvent) => boolean) | null
  >;
  isEditMode: boolean;
  showSlashMenu: boolean;
  filteredSlashItems: SlashItem[];
  slashLoading: boolean;
  currentMode: ComposerModeEntry["id"];
  includeProjectMode?: boolean;
  slashQuery: string;
  onSlashCommandClose: () => void;
  onSlashSelect: (item: SlashItem) => void;
  onContextModeSelect: (mode: ComposerModeEntry["id"]) => void;
  slashCommandKeyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
}

export const InputAreaPortals: React.FC<InputAreaPortalsProps> = ({
  contextMenuVisible,
  containerRef,
  onContextMenuClose,
  onAtSelect,
  onImageUpload,
  customMentionOptions,
  onCustomMentionSelect,
  atSearchQuery,
  currentRepoPath,
  contextMenuKeyboardHandlerRef,
  isEditMode,
  showSlashMenu,
  filteredSlashItems,
  slashLoading,
  currentMode,
  includeProjectMode,
  slashQuery,
  onSlashCommandClose,
  onSlashSelect,
  onContextModeSelect,
  slashCommandKeyboardHandlerRef,
}) => {
  const menuAnchorSelector = isEditMode
    ? "[data-editor-slot]"
    : "[data-composer-menu-anchor]";
  const menuPortalFrame = {
    containerRef,
    anchorSelector: menuAnchorSelector,
  };

  return (
    <>
      <ContextMenuPortal
        visible={contextMenuVisible}
        {...menuPortalFrame}
        onClose={onContextMenuClose}
        onSelect={onAtSelect}
        onImageUpload={onImageUpload}
        customMentionOptions={customMentionOptions}
        onCustomMentionSelect={onCustomMentionSelect}
        searchQuery={atSearchQuery}
        currentMode={currentMode}
        onModeSelect={onContextModeSelect}
        includeProjectMode={includeProjectMode}
        repoPath={currentRepoPath || undefined}
        keyboardHandlerRef={contextMenuKeyboardHandlerRef}
      />

      <SlashCommandPortal
        visible={showSlashMenu}
        {...menuPortalFrame}
        items={filteredSlashItems.filter((item) => item.category === "skill")}
        loading={slashLoading}
        searchQuery={slashQuery}
        onClose={onSlashCommandClose}
        onSelect={onSlashSelect}
        keyboardHandlerRef={slashCommandKeyboardHandlerRef}
      />
    </>
  );
};
