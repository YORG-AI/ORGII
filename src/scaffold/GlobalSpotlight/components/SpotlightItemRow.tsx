/**
 * SpotlightItemRow Component
 *
 * Memoized row renderer for spotlight items.
 * Handles icons, labels, status indicators, git badges, and keyboard shortcuts.
 */
import {
  MenuItem,
  PredefinedMenuItem,
  Menu as TauriMenu,
} from "@tauri-apps/api/menu";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronRight,
  CornerDownRight,
  Diff,
  Info,
  Lock,
} from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { KeyboardShortcut } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { createLogger } from "@src/hooks/logger";
import { copyText } from "@src/util/data/clipboard";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";

import { ICONS } from "../config";
import { SPOTLIGHT_TOKENS } from "../constants";
import type { SpotlightItem, SpotlightItemData } from "../types";
import { HighlightText } from "./highlightUtils";

// ============ CONSTANTS ============

export const ITEM_HEIGHT = SPOTLIGHT_TOKENS.itemHeight;
export const ITEM_HEIGHT_WITH_DESC = SPOTLIGHT_TOKENS.itemHeightWithDesc;

const TAG_BASE_CLASSES =
  "flex items-center gap-[6px] rounded-full font-medium cursor-default";

const GIT_BADGE_GROUP_CLASSES = "flex items-center gap-3";

const GIT_BADGE_CLASSES = `${TAG_BASE_CLASSES} !gap-1 text-[12px] text-text-2`;
const PATH_ELLIPSIS_SEGMENT = "/ ... /";
const log = createLogger("SpotlightItemRow");

interface SpotlightContextMenuOptions {
  name?: string;
  path?: string;
  copyNameLabel: string;
  copyPathLabel: string;
  revealLabel: string;
}

async function showSpotlightContextMenu({
  name,
  path,
  copyNameLabel,
  copyPathLabel,
  revealLabel,
}: SpotlightContextMenuOptions): Promise<void> {
  const items: (MenuItem | PredefinedMenuItem)[] = [];
  if (path) {
    items.push(
      await MenuItem.new({
        text: copyPathLabel,
        action: () => {
          void copyText(path).catch((error: unknown) => {
            log.error("Failed to copy path:", error);
          });
        },
      })
    );
  }
  if (name) {
    items.push(
      await MenuItem.new({
        text: copyNameLabel,
        action: () => {
          void copyText(name).catch((error: unknown) => {
            log.error("Failed to copy name:", error);
          });
        },
      })
    );
  }
  if (path) {
    items.push(
      await PredefinedMenuItem.new({ item: "Separator" }),
      await MenuItem.new({
        text: revealLabel,
        action: () => {
          void revealItemInDir(path).catch((error: unknown) => {
            log.error("Failed to reveal path in file manager:", error);
          });
        },
      })
    );
  }
  if (items.length === 0) return;
  const menu = await TauriMenu.new({ items });
  await menu.popup();
}

interface PathParts {
  prefix: string;
  suffix: string;
}

function splitPathForMiddleTruncation(path: string): PathParts | null {
  if (path === "/") return null;

  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 2) return null;

  const suffixSegments = segments.slice(-2);
  const prefixSegments = segments.slice(0, -2);

  return {
    prefix: prefixSegments.join("/"),
    suffix: suffixSegments.join("/"),
  };
}

/** Get the height of an item based on whether it has a description */
export function getItemHeight(item: SpotlightItem): number {
  return item.desc ? ITEM_HEIGHT_WITH_DESC : ITEM_HEIGHT;
}

/** Type-safe accessor for item data */
function getItemData(item: SpotlightItem): SpotlightItemData {
  return (item.data || {}) as SpotlightItemData;
}

// ============ TYPES ============

export interface SpotlightItemRowProps {
  item: SpotlightItem;
  index: number;
  isSelected: boolean;
  isKeyboardMode: boolean;
  onSelect: (item: SpotlightItem) => void;
  onHover: (index: number) => void;
  onHoverEnd?: () => void;
  searchQuery: string;
}

// ============ DESC LINE ============

/** Renders the desc text. When descTitle is set, the "+ N more" suffix becomes
 *  a hoverable pill with an info icon that shows the full list in a tooltip. */
const DescLine = memo<{ desc: string; descTitle: unknown }>(
  ({ desc, descTitle }) => {
    if (typeof descTitle !== "string" || !descTitle) {
      return (
        <div className={`truncate ${SPOTLIGHT_TOKENS.subFontSize} text-text-2`}>
          {desc}
        </div>
      );
    }

    const plusIdx = desc.lastIndexOf(" +");
    if (plusIdx === -1) {
      return (
        <div className={`truncate ${SPOTLIGHT_TOKENS.subFontSize} text-text-2`}>
          {desc}
        </div>
      );
    }

    const visiblePart = desc.slice(0, plusIdx);
    const overflowPart = desc.slice(plusIdx + 1);

    const tooltipContent = (
      <div className="flex flex-col gap-0.5">
        {descTitle.split(", ").map((name) => (
          <span
            key={name}
            className={`whitespace-nowrap ${SPOTLIGHT_TOKENS.subFontSize}`}
          >
            {name}
          </span>
        ))}
      </div>
    );

    return (
      <div
        className={`flex items-center gap-1 ${SPOTLIGHT_TOKENS.subFontSize} text-text-2`}
      >
        <span className="truncate">{visiblePart}</span>
        <Tooltip
          content={tooltipContent}
          position="bottom-start"
          style={{ zIndex: 10000 }}
        >
          <span className="inline-flex flex-shrink-0 cursor-default items-center gap-0.5 rounded-full bg-fill-2 px-1.5 py-px text-[10px] text-text-3 hover:bg-fill-2 hover:text-text-2">
            <Info size={10} strokeWidth={2} />
            {overflowPart}
          </span>
        </Tooltip>
      </div>
    );
  }
);
DescLine.displayName = "DescLine";

const FilePathRightLabel = memo<{ path: string; searchQuery: string }>(
  ({ path, searchQuery }) => {
    const splitPath = splitPathForMiddleTruncation(path);

    if (!splitPath) {
      return (
        <span className="block max-w-[min(45vw,360px)] truncate text-[12px] text-text-2">
          <HighlightText text={path} query={searchQuery} />
        </span>
      );
    }

    return (
      <span className="flex min-w-0 max-w-[min(45vw,360px)] items-center text-[12px] text-text-2">
        <span className="min-w-0 truncate">
          <HighlightText text={splitPath.prefix} query={searchQuery} />
        </span>
        <span className="shrink-0 text-text-3">{PATH_ELLIPSIS_SEGMENT}</span>
        <span className="shrink-0">
          <HighlightText text={splitPath.suffix} query={searchQuery} />
        </span>
      </span>
    );
  }
);
FilePathRightLabel.displayName = "FilePathRightLabel";

// ============ ITEM ROW ============

export const SpotlightItemRow = memo<SpotlightItemRowProps>(
  ({
    item,
    index,
    isSelected,
    isKeyboardMode,
    onSelect,
    onHover,
    onHoverEnd,
    searchQuery,
  }) => {
    const { t } = useTranslation();
    const data = getItemData(item);
    const isChildItem = data.parentAction && item.type === "option";
    const isCurrentSelection = data.isCurrentSelection;
    const isHeader = data.isHeader;
    const isDisabled = !!data.disabled;
    const isDanger = !!data.isDanger;
    const hasDisclosureChevron = !!data.showDisclosureChevron && !isDisabled;
    const ArrowRightIcon = ICONS.arrowRight;
    const DisclosureIcon =
      data.disclosureIcon === "arrowRight" ? ArrowRightIcon : ChevronRight;
    const itemTextClassName = isDanger ? "text-danger-6" : "text-text-1";
    const iconTone =
      typeof data.iconTone === "string" ? data.iconTone : undefined;
    const itemIconClassName = isDanger
      ? "text-danger-6"
      : iconTone === "primary"
        ? "text-primary-6"
        : iconTone === "text1"
          ? "text-text-1"
          : "text-text-2";
    // Only the currently-checked option uses medium weight; regular rows are normal.
    const labelWeightClass = isCurrentSelection ? "font-medium" : "font-normal";
    const modelSection =
      typeof data.modelSection === "string" ? data.modelSection : undefined;
    const modelId = typeof data.modelId === "string" ? data.modelId : undefined;
    const groupModelIds = Array.isArray(data.groupModelIds)
      ? data.groupModelIds
          .filter((value): value is string => typeof value === "string")
          .join(" ")
      : undefined;
    const testId = typeof data.testId === "string" ? data.testId : undefined;
    const sourceAccountId =
      typeof data.sourceAccountId === "string"
        ? data.sourceAccountId
        : undefined;
    const sourceModelType =
      typeof data.sourceModelType === "string"
        ? data.sourceModelType
        : undefined;
    const sourceType =
      typeof data.sourceType === "string" ? data.sourceType : undefined;
    const copyName = data.contextMenuCopy?.name;
    const copyPath = data.contextMenuCopy?.path;

    const handleMouseEnter = useCallback(() => {
      if (!isKeyboardMode && !isHeader && !isDisabled) {
        onHover(index);
      }
    }, [isKeyboardMode, onHover, index, isHeader, isDisabled]);

    const handleMouseLeave = useCallback(() => {
      if (!isKeyboardMode && !isHeader && !isDisabled) {
        onHoverEnd?.();
      }
    }, [isKeyboardMode, onHoverEnd, isHeader, isDisabled]);

    const handleClick = useCallback(
      (e: React.MouseEvent) => {
        if (!isHeader && !isDisabled) {
          e.preventDefault();
          onSelect(item);
        }
      },
      [onSelect, item, isHeader, isDisabled]
    );

    const handleContextMenu = useCallback(
      (event: React.MouseEvent) => {
        if (isHeader || isDisabled || (!copyName && !copyPath)) return;
        event.preventDefault();
        event.stopPropagation();
        onHover(index);
        void showSpotlightContextMenu({
          name: copyName,
          path: copyPath,
          copyNameLabel: t("actions.copyName", "Copy Name"),
          copyPathLabel: t("actions.copyPath", "Copy Path"),
          revealLabel: t(getFileManagerRevealLabelKey()),
        }).catch((error: unknown) => {
          log.error("Failed to show context menu:", error);
        });
      },
      [copyName, copyPath, index, isDisabled, isHeader, onHover, t]
    );

    if (isHeader) {
      return (
        <div
          data-spotlight-item-index={index}
          data-is-header="true"
          className="pointer-events-none mx-2 flex items-center"
          style={{ height: ITEM_HEIGHT }}
        >
          <span className={DROPDOWN_CLASSES.sectionLabel}>{item.label}</span>
        </div>
      );
    }

    return (
      <div
        data-testid={testId}
        data-spotlight-item-index={index}
        data-spotlight-item-id={item.id}
        data-spotlight-model-section={modelSection}
        data-spotlight-model-id={modelId}
        data-spotlight-group-model-ids={groupModelIds}
        data-source-account-id={sourceAccountId}
        data-source-model-type={sourceModelType}
        data-source-type={sourceType}
        className={`spotlight-item group relative mx-2 mb-[3px] flex items-center gap-2.5 rounded-lg px-2 ${
          isDisabled
            ? "cursor-not-allowed opacity-50"
            : `cursor-pointer ${isCurrentSelection ? "is-current-selection" : ""} ${isSelected ? "selected" : ""}`
        }`}
        style={{ height: getItemHeight(item) }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {data.selectionState && !isDisabled && (
          <div
            className="flex flex-shrink-0 items-center justify-center"
            onClick={(e) => {
              e.stopPropagation();
              data.selectionState?.onToggle(e);
            }}
          >
            <Checkbox
              size="small"
              checked={data.selectionState.checked}
              onChange={(_checked, event) => {
                event.stopPropagation();
                data.selectionState?.onToggle();
              }}
              ariaLabel="Select item"
            />
          </div>
        )}

        {isChildItem && (
          <div className="flex w-5 flex-shrink-0 items-center justify-center">
            <CornerDownRight className="text-text-2" size={10} />
          </div>
        )}

        {item.icon && (
          <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center">
            {isCurrentSelection ? (
              <Check
                size={SPOTLIGHT_TOKENS.iconSize}
                className="text-primary-6"
                strokeWidth={2.5}
              />
            ) : typeof item.icon === "string" ? (
              <i
                className={`${item.icon} text-[${SPOTLIGHT_TOKENS.iconSize}px] ${itemIconClassName}`}
              />
            ) : (
              React.createElement(item.icon, {
                size: SPOTLIGHT_TOKENS.iconSize,
                className: itemIconClassName,
                strokeWidth: 2,
              })
            )}
          </div>
        )}

        <div className="min-w-0 flex-1 basis-0">
          <div className="flex min-w-0 items-center gap-2">
            {item.type === "hint" && data.prefix ? (
              <span
                className={`truncate ${SPOTLIGHT_TOKENS.labelFontSize} ${labelWeightClass}`}
              >
                <span className="text-text-1">
                  <HighlightText
                    text={item.label.replace(`  ${data.prefix}`, "")}
                    query={searchQuery}
                  />
                </span>
                <span className="ml-2 text-text-3">{data.prefix}</span>
              </span>
            ) : item.type === "hint" ? (
              <span
                className={`truncate ${SPOTLIGHT_TOKENS.labelFontSize} ${labelWeightClass} ${itemTextClassName}`}
              >
                <HighlightText text={item.label} query={searchQuery} />
              </span>
            ) : data.labelContent ? (
              <span
                className={`flex min-w-0 items-center gap-1.5 truncate ${SPOTLIGHT_TOKENS.labelFontSize}`}
              >
                {data.labelContent as React.ReactNode}
              </span>
            ) : item.type === "command" && item.label.includes(": ") ? (
              <span
                className={`truncate ${SPOTLIGHT_TOKENS.labelFontSize} ${labelWeightClass}`}
              >
                <span className="text-text-3">
                  {item.label.split(": ")[0]}:
                </span>{" "}
                <span className={itemTextClassName}>
                  <HighlightText
                    text={item.label.split(": ").slice(1).join(": ")}
                    query={searchQuery}
                  />
                </span>
              </span>
            ) : (
              <span
                className={`truncate ${SPOTLIGHT_TOKENS.labelFontSize} ${labelWeightClass} ${itemTextClassName}`}
              >
                <HighlightText text={item.label} query={searchQuery} />
              </span>
            )}
            {data.inlineTag && (
              <span className="shrink-0 text-[10px] text-text-3">
                {data.inlineTag}
              </span>
            )}
          </div>
          {item.desc && (
            <DescLine desc={item.desc} descTitle={data.descTitle} />
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {item.type === "repo" &&
            data.gitStatus &&
            (data.gitStatus.uncommittedFiles > 0 ||
              data.gitStatus.behind > 0 ||
              data.gitStatus.ahead > 0) && (
              <div
                className={`spotlight-git-badges ${GIT_BADGE_GROUP_CLASSES}`}
              >
                {data.gitStatus.uncommittedFiles > 0 && (
                  <span
                    className={GIT_BADGE_CLASSES}
                    title={`${data.gitStatus.uncommittedFiles} file${data.gitStatus.uncommittedFiles !== 1 ? "s" : ""} uncommitted`}
                  >
                    {data.gitStatus.uncommittedFiles}
                    <Diff size={12} />
                  </span>
                )}

                {(data.gitStatus.behind > 0 || data.gitStatus.ahead > 0) && (
                  <span
                    className={`${GIT_BADGE_CLASSES} !gap-2`}
                    title={(() => {
                      const parts: string[] = [];
                      if (data.gitStatus.behind > 0) {
                        parts.push(
                          `${data.gitStatus.behind} commit${data.gitStatus.behind !== 1 ? "s" : ""} behind`
                        );
                      }
                      if (data.gitStatus.ahead > 0) {
                        parts.push(
                          `${data.gitStatus.ahead} commit${data.gitStatus.ahead !== 1 ? "s" : ""} ahead`
                        );
                      }
                      return parts.join(", ");
                    })()}
                  >
                    {data.gitStatus.behind > 0 && (
                      <span>{data.gitStatus.behind} ↓</span>
                    )}
                    {data.gitStatus.ahead > 0 && (
                      <span>{data.gitStatus.ahead} ↑</span>
                    )}
                  </span>
                )}
              </div>
            )}

          {data.rightContent
            ? data.rightContent
            : data.rightLabel &&
              (item.type === "file" ? (
                <FilePathRightLabel
                  path={data.rightLabel}
                  searchQuery={searchQuery}
                />
              ) : (
                <span className="block max-w-[min(45vw,360px)] truncate text-[12px] text-text-2">
                  <HighlightText text={data.rightLabel} query={searchQuery} />
                </span>
              ))}

          {data.statusContent ? (
            <span className="flex h-6 w-6 items-center justify-center">
              {data.statusContent as React.ReactNode}
            </span>
          ) : (
            data.tagLabel &&
            item.type !== "branch" && (
              <span
                className={`${TAG_BASE_CLASSES} px-[10px] py-1.5 text-[11px] ${
                  isDisabled ? "bg-fill-2 text-text-3" : "text-slate-600"
                }`}
              >
                {isDisabled && <Lock size={10} />}
                {data.tagLabel}
              </span>
            )
          )}

          {(item.type === "action" ||
            item.type === "command" ||
            item.type === "hint") &&
            item.shortcut && <KeyboardShortcut shortcut={item.shortcut} />}

          {hasDisclosureChevron && (
            <span className="spotlight-disclosure-chevron pointer-events-none inline-flex h-5 shrink-0 items-center justify-center overflow-hidden text-primary-6">
              <DisclosureIcon
                size={15}
                strokeWidth={2.25}
                className="shrink-0"
              />
            </span>
          )}
        </div>
      </div>
    );
  }
);

SpotlightItemRow.displayName = "SpotlightItemRow";
