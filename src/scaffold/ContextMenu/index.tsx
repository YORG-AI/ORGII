/**
 * Shared + / @ composer menu.
 *
 * Both triggers render this exact component. The composer owns the query and
 * keyboard focus; the menu owns rows, filtering, results, and navigation.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import {
  AGENT_EXEC_MODES,
  COMPOSER_MODES,
  type ComposerModeEntry,
} from "@src/config/sessionCreatorConfig";
import { useMouseMoved } from "@src/hooks/ui/useMouseMoved";
import { AtIcon, AttachmentIcon } from "@src/icons";
import { fuzzyMatch } from "@src/util/search/fuzzy";

import { ResultItemRow, SecondLayerPanel } from "./MenuSections";
import { MenuItemRow, SearchLoadingOrEmpty } from "./ResultItems";
import { MENU_ITEMS, type MenuItem, type SecondLayerId } from "./config";
import type { ContextMenuCustomMentionOption, ContextMenuProps } from "./types";
import { useContextMenu } from "./useContextMenu";
import { useMenuEffects } from "./useMenuEffects";

type MainMenuEntry =
  | { kind: "image"; flatIndex: number }
  | { kind: "mode"; flatIndex: number; mode: ComposerModeEntry }
  | {
      kind: "mention";
      flatIndex: number;
      option: ContextMenuCustomMentionOption;
    }
  | { kind: "context"; flatIndex: number; item: MenuItem };

interface CustomMentionGroup {
  label: string | null;
  entries: Array<Extract<MainMenuEntry, { kind: "mention" }>>;
}

function matchesSearch(query: string, ...values: Array<string | undefined>) {
  return !query || values.some((value) => value && fuzzyMatch(query, value));
}

function groupCustomMentionEntries(
  entries: Array<Extract<MainMenuEntry, { kind: "mention" }>>
): CustomMentionGroup[] {
  const groups: CustomMentionGroup[] = [];
  for (const entry of entries) {
    const label = entry.option.groupLabel ?? null;
    const lastGroup = groups[groups.length - 1];
    if (!lastGroup || lastGroup.label !== label) {
      groups.push({ label, entries: [entry] });
    } else {
      lastGroup.entries.push(entry);
    }
  }
  return groups;
}

const ContextMenu: React.FC<ContextMenuProps> = ({
  visible,
  onClose,
  onSelect,
  onImageUpload,
  currentMode,
  onModeSelect,
  includeProjectMode = false,
  customMentionOptions = [],
  onCustomMentionSelect,
  searchQuery = "",
  recentFiles = [],
  repoPath,
  className = "",
  keyboardHandlerRef,
  treePosition = "right",
}) => {
  const { t } = useTranslation("sessions");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const mouseMovedRef = useMouseMoved(visible);
  const imageLabel = t("common:actions.upload");
  const modeOptions = includeProjectMode ? COMPOSER_MODES : AGENT_EXEC_MODES;
  const mainEntries = useMemo<MainMenuEntry[]>(() => {
    const query = searchQuery.trim();
    const entries: MainMenuEntry[] = [];
    let flatIndex = 0;

    if (
      onImageUpload &&
      matchesSearch(query, imageLabel, "Upload image", "Image")
    ) {
      entries.push({ kind: "image", flatIndex: flatIndex++ });
    }

    for (const mode of modeOptions) {
      if (
        matchesSearch(
          query,
          mode.name,
          mode.id,
          mode.description,
          t(mode.i18nKey)
        )
      ) {
        entries.push({ kind: "mode", mode, flatIndex: flatIndex++ });
      }
    }

    for (const option of customMentionOptions) {
      if (
        matchesSearch(
          query,
          option.label,
          option.description,
          option.groupLabel
        )
      ) {
        entries.push({ kind: "mention", option, flatIndex: flatIndex++ });
      }
    }

    for (const item of MENU_ITEMS) {
      const localizedLabel = t(item.translationKey, {
        defaultValue: item.label,
      });
      if (matchesSearch(query, item.id, item.label, localizedLabel)) {
        entries.push({ kind: "context", item, flatIndex: flatIndex++ });
      }
    }

    return entries;
  }, [
    customMentionOptions,
    imageLabel,
    searchQuery,
    modeOptions,
    onImageUpload,
    t,
  ]);

  const imageEntry = mainEntries.find((entry) => entry.kind === "image");
  const modeEntries = mainEntries.filter(
    (entry): entry is Extract<MainMenuEntry, { kind: "mode" }> =>
      entry.kind === "mode"
  );
  const mentionEntries = mainEntries.filter(
    (entry): entry is Extract<MainMenuEntry, { kind: "mention" }> =>
      entry.kind === "mention"
  );
  const contextEntries = mainEntries.filter(
    (entry): entry is Extract<MainMenuEntry, { kind: "context" }> =>
      entry.kind === "context"
  );
  const customMentionGroups = useMemo(
    () => groupCustomMentionEntries(mentionEntries),
    [mentionEntries]
  );

  const handleImageUpload = useCallback(() => {
    if (!onImageUpload) return;
    onClose();
    onImageUpload();
  }, [onClose, onImageUpload]);
  const mainSelectionRef = useRef<(index: number) => void>(() => undefined);

  const {
    activeIndex,
    setActiveIndex,
    keyboardNavigated,
    setKeyboardNavigated,
    secondLayer,
    setSecondLayer,
    searchResults,
    searchLoading,
    secondLayerActiveIndex,
    setSecondLayerActiveIndex,
    handleKeyDown,
    handleSelect,
    reset,
  } = useContextMenu({
    repoPath,
    onSelect,
    onClose,
    searchQuery,
    mainItemCount: mainEntries.length,
    onMainItemIndexSelect: (index) => mainSelectionRef.current(index),
    searchFilesFromMain: true,
  });

  const handleMainItemIndexSelect = useCallback(
    (index: number) => {
      const entry = mainEntries[index];
      if (!entry) return;
      if (entry.kind === "image") {
        handleImageUpload();
      } else if (entry.kind === "mode") {
        onModeSelect(entry.mode.id);
      } else if (entry.kind === "mention") {
        onCustomMentionSelect?.(entry.option);
      } else if (entry.item.hasSecondLayer) {
        setSecondLayer(entry.item.id as SecondLayerId);
      } else {
        handleSelect(entry.item.id);
      }
    },
    [
      handleImageUpload,
      handleSelect,
      mainEntries,
      onCustomMentionSelect,
      onModeSelect,
      setSecondLayer,
    ]
  );
  useEffect(() => {
    mainSelectionRef.current = handleMainItemIndexSelect;
  }, [handleMainItemIndexSelect]);

  const resetActiveIndex = useCallback(() => {
    if (!mouseMovedRef.current) return;
    setKeyboardNavigated(false);
    setActiveIndex(-1);
  }, [mouseMovedRef, setActiveIndex, setKeyboardNavigated]);
  const resetSecondLayerIndex = useCallback(() => {
    if (!mouseMovedRef.current) return;
    setKeyboardNavigated(false);
    setSecondLayerActiveIndex(-1);
  }, [mouseMovedRef, setKeyboardNavigated, setSecondLayerActiveIndex]);

  const { handleSearchResultSelect } = useMenuEffects({
    visible,
    keyboardHandlerRef,
    handleKeyDown,
    handleSelect,
    setSecondLayer,
    secondLayer,
    searchResults,
    reset,
  });

  const handleMainItemHover = useCallback(
    (itemIndex: number) => {
      if (!mouseMovedRef.current) return;
      setKeyboardNavigated(false);
      setActiveIndex(itemIndex);
    },
    [mouseMovedRef, setActiveIndex, setKeyboardNavigated]
  );

  const handleSecondLayerHover = useCallback(
    (itemIndex: number) => {
      if (!mouseMovedRef.current) return;
      setKeyboardNavigated(false);
      setSecondLayerActiveIndex(itemIndex);
    },
    [mouseMovedRef, setKeyboardNavigated, setSecondLayerActiveIndex]
  );

  useEffect(() => {
    const rows = listRef.current?.querySelectorAll("[data-context-menu-flat]");
    rows?.[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!visible) return null;

  const isSearching = searchQuery.trim().length > 0;
  const mainFileActiveIndex = activeIndex - mainEntries.length;
  const hasAnyMainResults =
    mainEntries.length > 0 || searchResults.length > 0 || searchLoading;

  return (
    <div
      ref={dropdownRef}
      className={`context-menu flex flex-col gap-2 ${className}`}
      data-dropdown-keyboard-mode={keyboardNavigated ? "true" : undefined}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        event.nativeEvent.stopImmediatePropagation();
      }}
    >
      {secondLayer ? (
        <SecondLayerPanel
          layerId={secondLayer}
          results={searchResults}
          loading={searchLoading}
          activeIndex={secondLayerActiveIndex}
          onSelect={handleSearchResultSelect}
          onHover={handleSecondLayerHover}
          onHoverEnd={resetSecondLayerIndex}
          repoPath={repoPath}
          treePosition={treePosition}
          recentFiles={secondLayer === "files" ? recentFiles : undefined}
        />
      ) : (
        <div className={DROPDOWN_CLASSES.panel} style={{ width: "100%" }}>
          <div ref={listRef} className={DROPDOWN_CLASSES.optionsContainer}>
            {imageEntry && (
              <div data-context-menu-flat>
                <MenuItemRow
                  icon={AttachmentIcon}
                  label={imageLabel}
                  dataTestId="context-menu-image-upload"
                  isActive={
                    keyboardNavigated && activeIndex === imageEntry.flatIndex
                  }
                  onClick={handleImageUpload}
                  onMouseEnter={() => handleMainItemHover(imageEntry.flatIndex)}
                  onMouseLeave={resetActiveIndex}
                />
              </div>
            )}

            {modeEntries.length > 0 && (
              <>
                {imageEntry && (
                  <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                )}
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("creator.slashMenu.mode", { defaultValue: "Mode" })}
                </div>
                {modeEntries.map((entry) => {
                  const isCurrent = entry.mode.id === currentMode;
                  return (
                    <div key={entry.mode.id} data-context-menu-flat>
                      <div
                        data-testid={`context-menu-mode-option-${entry.mode.id}`}
                        className={`${DROPDOWN_CLASSES.item} group cursor-pointer justify-between ${
                          keyboardNavigated && activeIndex === entry.flatIndex
                            ? DROPDOWN_CLASSES.itemActive
                            : DROPDOWN_CLASSES.itemHover
                        }`}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          onModeSelect(entry.mode.id);
                        }}
                        onMouseEnter={() =>
                          handleMainItemHover(entry.flatIndex)
                        }
                        onMouseLeave={resetActiveIndex}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <AnyIcon
                            icon={entry.mode.icon}
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={1.75}
                            className={
                              isCurrent ? "text-primary-6" : "text-text-2"
                            }
                          />
                          <span
                            className={`truncate text-[13px] ${
                              isCurrent ? "text-primary-6" : "text-text-1"
                            }`}
                          >
                            {t(entry.mode.i18nKey)}
                          </span>
                        </div>
                        {isCurrent && <DropdownSelectedCheck />}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {mentionEntries.length > 0 && (
              <>
                <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                {customMentionGroups.map((group, groupIndex) => (
                  <React.Fragment
                    key={`${group.label ?? "mentions"}:${groupIndex}`}
                  >
                    {group.label && (
                      <div className={DROPDOWN_CLASSES.sectionLabel}>
                        {group.label}
                      </div>
                    )}
                    {group.entries.map((entry) => (
                      <div key={entry.option.id} data-context-menu-flat>
                        <MenuItemRow
                          icon={AtIcon}
                          label={entry.option.label}
                          description={entry.option.description}
                          isActive={
                            keyboardNavigated && activeIndex === entry.flatIndex
                          }
                          dataTestId="agent-org-mention-option"
                          dataMentionId={entry.option.id}
                          onClick={() => onCustomMentionSelect?.(entry.option)}
                          onMouseEnter={() =>
                            handleMainItemHover(entry.flatIndex)
                          }
                          onMouseLeave={resetActiveIndex}
                        />
                      </div>
                    ))}
                  </React.Fragment>
                ))}
              </>
            )}

            {contextEntries.length > 0 && (
              <>
                {(imageEntry ||
                  modeEntries.length > 0 ||
                  mentionEntries.length > 0) && (
                  <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                )}
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("creator.slashMenu.commands", {
                    defaultValue: "Commands",
                  })}
                </div>
                {contextEntries.map((entry) => (
                  <div key={entry.item.id} data-context-menu-flat>
                    <MenuItemRow
                      icon={entry.item.icon}
                      label={t(entry.item.translationKey, {
                        defaultValue: entry.item.label,
                      })}
                      hasArrow={entry.item.hasSecondLayer}
                      isActive={
                        keyboardNavigated && activeIndex === entry.flatIndex
                      }
                      dataTestId={`context-menu-command-${entry.item.id}`}
                      onClick={() => handleMainItemIndexSelect(entry.flatIndex)}
                      onMouseEnter={() => handleMainItemHover(entry.flatIndex)}
                      onMouseLeave={resetActiveIndex}
                    />
                  </div>
                ))}
              </>
            )}

            {isSearching && searchResults.length > 0 && (
              <>
                {mainEntries.length > 0 && (
                  <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                )}
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t("creator.contextMenu.filesAndFolders", {
                    defaultValue: "Files & Folders",
                  })}
                </div>
                {searchResults.map((item, index) => (
                  <div
                    key={`${item.repoPath ?? ""}:${item.path}`}
                    data-context-menu-flat
                  >
                    <ResultItemRow
                      item={item}
                      index={index}
                      activeIndex={mainFileActiveIndex}
                      onSelect={() =>
                        handleSelect(
                          item.type === "folder" ? "folder" : "files",
                          item.path,
                          item.name
                        )
                      }
                      onHover={() =>
                        handleMainItemHover(mainEntries.length + index)
                      }
                      onHoverEnd={resetActiveIndex}
                      itemRef={() => undefined}
                    />
                  </div>
                ))}
              </>
            )}

            {isSearching && !hasAnyMainResults && (
              <SearchLoadingOrEmpty searchQuery={searchQuery} loading={false} />
            )}
            {isSearching && searchLoading && searchResults.length === 0 && (
              <SearchLoadingOrEmpty searchQuery={searchQuery} loading />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(ContextMenu);
