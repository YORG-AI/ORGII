/**
 * ContextMenu Item Rendering Components
 *
 * Reusable item-level components for rendering menu items,
 * search result icons, and empty/loading states.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import FolderIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import AnyIcon from "@src/components/AnyIcon";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { Placeholder } from "@src/components/Placeholder";
import {
  CodeXmlIcon,
  ComputerTerminal01Icon,
  DeliveryBox01Icon,
  HugeiconsIcon,
  type IconSvgElement,
  InternetIcon,
  ListChecksIcon,
} from "@src/icons";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import { ICON_CONFIG, type SecondLayerId } from "./config";
import type { SearchResultItem } from "./types";

// ============================================
// Empty & Loading States
// ============================================

/** i18n-aware empty state for second layer panels */
export const SecondLayerEmptyState: React.FC<{ layerId: SecondLayerId }> = memo(
  ({ layerId }) => {
    const { t } = useTranslation();
    const emptyTextMap: Record<SecondLayerId, string> = {
      files: t("placeholders.typeToSearchFiles"),
      sessions: t("placeholders.noSessionsFound"),
      projects: t("placeholders.noProjectsFound", "No projects found"),
    };
    return (
      <Placeholder
        variant="empty"
        title={emptyTextMap[layerId]}
        className="!h-auto"
      />
    );
  }
);
SecondLayerEmptyState.displayName = "SecondLayerEmptyState";

/** i18n-aware loading/empty state for search panels */
export const SearchLoadingOrEmpty: React.FC<{
  searchQuery: string;
  loading: boolean;
}> = memo(({ searchQuery, loading }) => {
  const { t } = useTranslation();
  if (loading) {
    return (
      <Placeholder
        variant="loading"
        title={t("status.searching")}
        className="!h-auto"
      />
    );
  }
  return (
    <Placeholder
      variant={searchQuery ? "no-results" : "empty"}
      title={
        searchQuery
          ? t("common:common.noResults")
          : t("placeholders.typeToSearch")
      }
      className="!h-auto"
    />
  );
});
SearchLoadingOrEmpty.displayName = "SearchLoadingOrEmpty";

// ============================================
// Icon Rendering
// ============================================

const iconAccent = "flex-shrink-0 text-text-2";

/** Render appropriate icon based on item type */
export const ResultItemIcon: React.FC<{
  item: SearchResultItem;
  displayName: string;
}> = memo(({ item, displayName }) => {
  if (item.iconType === "terminal") {
    return (
      <HugeiconsIcon
        icon={ComputerTerminal01Icon}
        data-icon="terminal"
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.iconType === "session") {
    const sessionIcon = resolveSessionRowIcon({
      session_id: item.path,
      user_input: item.userInput,
      agentIconId: item.agentIconId,
      cliAgentType: item.cliAgentType,
    });
    return (
      <AnyIcon
        icon={sessionIcon}
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.iconType === "browser") {
    return (
      <HugeiconsIcon
        icon={InternetIcon}
        data-icon="globe"
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.iconType === "repo") {
    return (
      <HugeiconsIcon
        icon={CodeXmlIcon}
        data-icon="code"
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.iconType === "project") {
    return (
      <HugeiconsIcon
        icon={DeliveryBox01Icon}
        data-icon="box"
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.iconType === "workitem") {
    return (
      <HugeiconsIcon
        icon={ListChecksIcon}
        data-icon="list-checks"
        size={DROPDOWN_ITEM.iconSize}
        strokeWidth={1.75}
        className={iconAccent}
      />
    );
  }

  if (item.type === "folder") {
    return <FolderIcon width="16" height="16" className={iconAccent} />;
  }

  return (
    <FileTypeIcon fileName={displayName} size="medium" className={iconAccent} />
  );
});
ResultItemIcon.displayName = "ResultItemIcon";

// ============================================
// Menu Item Row
// ============================================

interface MenuItemRowProps {
  icon: IconSvgElement;
  label: string;
  description?: string;
  hasArrow?: boolean;
  isActive?: boolean;
  dataTestId?: string;
  dataMentionId?: string;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export const MenuItemRow: React.FC<MenuItemRowProps> = memo(
  ({
    icon,
    label,
    description,
    hasArrow = false,
    isActive = false,
    dataTestId,
    dataMentionId,
    onClick,
    onMouseEnter,
    onMouseLeave,
  }) => (
    <div
      data-testid={dataTestId}
      data-mention-id={dataMentionId}
      className={`${DROPDOWN_CLASSES.item} group cursor-pointer justify-between ${
        isActive ? DROPDOWN_CLASSES.itemActive : DROPDOWN_CLASSES.itemHover
      }`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex min-w-0 items-center gap-2">
        <AnyIcon
          icon={icon}
          size={DROPDOWN_ITEM.iconSize}
          className="shrink-0 text-text-2"
          strokeWidth={1.75}
        />
        <span className="min-w-0 shrink truncate text-[13px] text-text-1">
          {label}
        </span>
        {description && (
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-3">
            {description}
          </span>
        )}
      </div>
      {hasArrow && (
        <AnyIcon
          icon={ICON_CONFIG.arrow}
          size={DROPDOWN_ITEM.iconSize}
          className="text-text-3"
          strokeWidth={1.75}
        />
      )}
    </div>
  )
);
MenuItemRow.displayName = "MenuItemRow";
