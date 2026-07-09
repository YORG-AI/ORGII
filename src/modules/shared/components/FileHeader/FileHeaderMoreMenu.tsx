/**
 * FileHeaderMoreMenu
 *
 * Renders the "More actions" dropdown surfaced by {@link FileHeader} via the
 * Ellipsis trailing icon. Groups menu entries into three semantic blocks:
 *
 *  - File change actions     — Save / Discard.
 *  - Menu actions            — Search / Go to line / Copy relative path / Reload.
 *  - Editor switches         — Line numbers / Word wrap / Minimap / Active-line
 *                              highlight / Git blame.
 *
 * Menu entries are always rendered for stable discoverability. Entries whose
 * backing action is not available in the current context are disabled.
 */
import {
  Copy,
  Ellipsis,
  FolderOpen,
  Hash,
  RefreshCw,
  Save,
  Search,
  Settings,
  Undo2,
} from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
  KeyboardShortcutTooltipContent,
} from "@src/components/KeyboardShortcut";
import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";

export interface FileHeaderMoreMenuProps {
  // Visibility flags
  showReloadButton: boolean;
  showSearchAction: boolean;
  showGoToLineAction: boolean;
  showSaveAction: boolean;
  showDiscardAction: boolean;
  showCopyRelativePathAction: boolean;
  showRevealInFileManagerAction: boolean;
  showLineNumbersToggle: boolean;
  showWordWrapToggle: boolean;
  showMinimapToggle: boolean;
  showHighlightActiveLineToggle: boolean;
  showGitBlameToggle: boolean;
  showMoreSettingsAction: boolean;

  // Toggle current values
  lineNumbersEnabled: boolean;
  wordWrapEnabled: boolean;
  minimapEnabled: boolean;
  highlightActiveLineEnabled: boolean;
  gitBlameEnabled: boolean;

  // States
  loading: boolean;
  hasUnsavedChanges: boolean;
  reloadSpinClass: string | undefined;
  reloadMenuCoolingDown: boolean;
  menuVisible: boolean;
  setMenuVisible: (visible: boolean) => void;

  // Handlers
  onSaveClick: () => void;
  onDiscardClick: () => void;
  onSearchClick: () => void;
  onGoToLineClick: () => void;
  onCopyRelativePathClick: () => void;
  onRevealInFileManagerClick: () => void;
  onReloadClick: () => void;
  onLineNumbersChange: (enabled: boolean) => void;
  onWordWrapChange: (enabled: boolean) => void;
  onMinimapChange: (enabled: boolean) => void;
  onHighlightActiveLineChange: (enabled: boolean) => void;
  onGitBlameChange: (enabled: boolean) => void;
  onMoreSettingsClick: () => void;
}

export const FileHeaderMoreMenu: React.FC<FileHeaderMoreMenuProps> = ({
  showReloadButton,
  showSearchAction,
  showGoToLineAction,
  showSaveAction,
  showDiscardAction,
  showCopyRelativePathAction,
  showRevealInFileManagerAction,
  showLineNumbersToggle,
  showWordWrapToggle,
  showMinimapToggle,
  showHighlightActiveLineToggle,
  showGitBlameToggle,
  showMoreSettingsAction,
  lineNumbersEnabled,
  wordWrapEnabled,
  minimapEnabled,
  highlightActiveLineEnabled,
  gitBlameEnabled,
  loading,
  hasUnsavedChanges,
  reloadSpinClass,
  reloadMenuCoolingDown,
  menuVisible,
  setMenuVisible,
  onSaveClick,
  onDiscardClick,
  onSearchClick,
  onGoToLineClick,
  onCopyRelativePathClick,
  onRevealInFileManagerClick,
  onReloadClick,
  onLineNumbersChange,
  onWordWrapChange,
  onMinimapChange,
  onHighlightActiveLineChange,
  onGitBlameChange,
  onMoreSettingsClick,
}) => {
  const { t } = useTranslation();
  const searchShortcut = getShortcutKeys("find");
  const goToLineShortcut = getShortcutKeys("go_to_line");
  const saveShortcut = getShortcutKeys("save_file");
  const revealInFileManagerLabelKey = getFileManagerRevealLabelKey();
  const fileChangeActionsDisabled = !hasUnsavedChanges || loading;
  const saveDisabled = !showSaveAction || fileChangeActionsDisabled;
  const discardDisabled = !showDiscardAction || fileChangeActionsDisabled;
  const searchDisabled = !showSearchAction;
  const goToLineDisabled = !showGoToLineAction;
  const copyRelativePathDisabled = !showCopyRelativePathAction;
  const revealInFileManagerDisabled = !showRevealInFileManagerAction;
  const reloadDisabled = !showReloadButton || loading || reloadMenuCoolingDown;

  const renderToggleRow = useCallback(
    ({
      label,
      checked,
      enabled,
      onChange,
    }: {
      label: React.ReactNode;
      checked: boolean;
      enabled: boolean;
      onChange: (enabled: boolean) => void;
    }) => {
      const handleToggle = (event: React.MouseEvent | React.KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (!enabled) return;
        onChange(!checked);
      };

      return (
        <div
          role="menuitemcheckbox"
          aria-checked={checked}
          aria-disabled={!enabled}
          tabIndex={enabled ? 0 : -1}
          className={`${DROPDOWN_CLASSES.menuControlItem} ${
            enabled ? "cursor-pointer" : DROPDOWN_CLASSES.itemDisabled
          }`}
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            handleToggle(event);
          }}
        >
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <Switch
            size="small"
            checked={checked}
            disabled={!enabled}
            onChange={(nextChecked, event) => {
              event.preventDefault();
              event.stopPropagation();
              onChange(nextChecked);
            }}
          />
        </div>
      );
    },
    []
  );

  return (
    <Dropdown
      droplist={
        <div
          className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
        >
          <DropdownItem
            icon={<Save size={HEADER_ICON_SIZE.sm} />}
            disabled={saveDisabled}
            suffix={
              saveShortcut ? (
                <KeyboardShortcut
                  shortcut={saveShortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              ) : undefined
            }
            onClick={onSaveClick}
          >
            {t("common:actions.save")}
          </DropdownItem>

          <DropdownItem
            icon={<Undo2 size={HEADER_ICON_SIZE.sm} />}
            disabled={discardDisabled}
            onClick={onDiscardClick}
          >
            {t("common:workstation.discardChanges")}
          </DropdownItem>

          <div className={DROPDOWN_CLASSES.menuSeparator} />

          <DropdownItem
            icon={<Search size={HEADER_ICON_SIZE.sm} />}
            disabled={searchDisabled}
            suffix={
              searchShortcut ? (
                <KeyboardShortcut
                  shortcut={searchShortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              ) : undefined
            }
            onClick={onSearchClick}
          >
            {t("actions.search")}
          </DropdownItem>

          <DropdownItem
            icon={<Hash size={HEADER_ICON_SIZE.sm} />}
            disabled={goToLineDisabled}
            suffix={
              goToLineShortcut ? (
                <KeyboardShortcut
                  shortcut={goToLineShortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              ) : undefined
            }
            onClick={onGoToLineClick}
          >
            {t("selectors.editorSpotlight.modes.goToLine.label")}
          </DropdownItem>

          <DropdownItem
            icon={<Copy size={HEADER_ICON_SIZE.sm} />}
            disabled={copyRelativePathDisabled}
            onClick={onCopyRelativePathClick}
          >
            {t("common:actions.copyRelativePath")}
          </DropdownItem>

          <DropdownItem
            icon={<FolderOpen size={HEADER_ICON_SIZE.sm} />}
            disabled={revealInFileManagerDisabled}
            onClick={onRevealInFileManagerClick}
          >
            {t(revealInFileManagerLabelKey)}
          </DropdownItem>

          <DropdownItem
            icon={
              <RefreshCw
                size={HEADER_ICON_SIZE.sm}
                className={reloadSpinClass}
              />
            }
            disabled={reloadDisabled}
            onClick={onReloadClick}
          >
            {t("common:actions.refresh")}
          </DropdownItem>

          <div className={DROPDOWN_CLASSES.menuSeparator} />

          {renderToggleRow({
            label: t("settings:editor.lineNumbers"),
            checked: lineNumbersEnabled,
            enabled: showLineNumbersToggle,
            onChange: onLineNumbersChange,
          })}

          {renderToggleRow({
            label: t("settings:editor.wordWrap"),
            checked: wordWrapEnabled,
            enabled: showWordWrapToggle,
            onChange: onWordWrapChange,
          })}

          {renderToggleRow({
            label: t("settings:editor.minimap"),
            checked: minimapEnabled,
            enabled: showMinimapToggle,
            onChange: onMinimapChange,
          })}

          {renderToggleRow({
            label: t("settings:editor.highlightActiveLine"),
            checked: highlightActiveLineEnabled,
            enabled: showHighlightActiveLineToggle,
            onChange: onHighlightActiveLineChange,
          })}

          {renderToggleRow({
            label: "Git Blame",
            checked: gitBlameEnabled,
            enabled: showGitBlameToggle,
            onChange: onGitBlameChange,
          })}

          <div className={DROPDOWN_CLASSES.menuSeparator} />

          <DropdownItem
            icon={<Settings size={HEADER_ICON_SIZE.sm} />}
            disabled={!showMoreSettingsAction}
            onClick={onMoreSettingsClick}
          >
            {t("common:actions.moreSettings")}
          </DropdownItem>
        </div>
      }
      position="bottom-end"
      trigger="click"
      popupVisible={menuVisible}
      onVisibleChange={setMenuVisible}
    >
      <Tooltip
        content={
          <KeyboardShortcutTooltipContent label={t("common:actions.more")} />
        }
        position="bottom-end"
        mouseEnterDelay={200}
        disabled={menuVisible}
        framedPanel
      >
        <span className="inline-flex">
          <TabBarTrailingIconButton
            title={t("common:actions.more")}
            active={menuVisible}
            nativeTitle={false}
            className="flex-shrink-0"
          >
            <Ellipsis size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          </TabBarTrailingIconButton>
        </span>
      </Tooltip>
    </Dropdown>
  );
};
