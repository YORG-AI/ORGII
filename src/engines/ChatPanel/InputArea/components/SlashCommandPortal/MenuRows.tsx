/**
 * Atomic row components for SlashCommandMenu.
 * Each renders one list entry, taking its own data and shared active/hover state.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import type {
  AgentExecMode,
  ComposerModeEntry,
} from "@src/config/sessionCreatorConfig";
import { ArrowRight01Icon, HugeiconsIcon, Image01Icon } from "@src/icons";
import { MenuItemRow } from "@src/scaffold/ContextMenu/ResultItems";
import type { SlashItem, SlashItemCategory } from "@src/types/extensions";

import { categoryIcon } from "./constants";

// ── Shared ────────────────────────────────────────────────────────────────────

function rowClass(isActive: boolean, isSelected = false): string {
  const bgClass = isActive || isSelected ? "bg-fill-2" : "hover:bg-fill-2";
  return `${DROPDOWN_CLASSES.item} group cursor-pointer ${bgClass}`;
}

function iconClass(isSelected: boolean, extra = ""): string {
  return isSelected ? `text-primary-6 ${extra}` : `text-text-2 ${extra}`;
}

function labelClass(isSelected: boolean): string {
  return `text-[13px] ${isSelected ? "text-primary-6" : "text-text-1"}`;
}

// ── SectionHeaderRow ─────────────────────────────────────────────────────────

interface SectionHeaderRowProps {
  label: string;
}

export const SectionHeaderRow: React.FC<SectionHeaderRowProps> = React.memo(
  ({ label }) => (
    <div className={`${DROPDOWN_CLASSES.sectionLabel} first:pt-1`}>{label}</div>
  )
);

SectionHeaderRow.displayName = "SectionHeaderRow";

// ── ImageRow ──────────────────────────────────────────────────────────────────

interface ImageRowProps {
  isActive: boolean;
  onMouseEnter: () => void;
  onMouseDown: () => void;
}

export const ImageRow: React.FC<ImageRowProps> = React.memo(
  ({ isActive, onMouseEnter, onMouseDown }) => {
    const { t } = useTranslation("sessions");
    return (
      <div
        data-slash-flat
        data-testid="slash-command-image-upload"
        className={rowClass(isActive)}
        onMouseEnter={onMouseEnter}
        onMouseDown={(e) => {
          e.preventDefault();
          onMouseDown();
        }}
      >
        <HugeiconsIcon
          icon={Image01Icon}
          data-icon="image-icon"
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={1.75}
          className={iconClass(false)}
        />
        <span className={labelClass(false)}>
          {t("creator.slashMenu.uploadImage", { defaultValue: "Upload image" })}
        </span>
      </div>
    );
  }
);

ImageRow.displayName = "ImageRow";

// ── ModeRow ───────────────────────────────────────────────────────────────────

interface ModeRowProps {
  mode: ComposerModeEntry;
  isActive: boolean;
  isCurrent: boolean;
  onMouseEnter: () => void;
  onMouseDown: () => void;
}

export const ModeRow: React.FC<ModeRowProps> = React.memo(
  ({ mode, isActive, isCurrent, onMouseEnter, onMouseDown }) => {
    const { t } = useTranslation("sessions");
    const ModeIcon = mode.icon;
    return (
      <div
        data-slash-flat
        data-testid={`slash-command-mode-option-${mode.id}`}
        className={`${rowClass(isActive)} justify-between`}
        onMouseEnter={onMouseEnter}
        onMouseDown={(e) => {
          e.preventDefault();
          onMouseDown();
        }}
      >
        <div className="flex items-center gap-2">
          <AnyIcon
            icon={ModeIcon}
            size={DROPDOWN_ITEM.iconSize}
            strokeWidth={1.75}
            className={iconClass(isCurrent)}
          />
          <span className={labelClass(isCurrent)}>{t(mode.i18nKey)}</span>
        </div>
        {isCurrent && <DropdownSelectedCheck />}
      </div>
    );
  }
);

ModeRow.displayName = "ModeRow";

// ── FlyoutTriggerRow ──────────────────────────────────────────────────────────

interface FlyoutTriggerRowProps {
  category: SlashItemCategory;
  label: string;
  isActive: boolean;
  isOpen: boolean;
  onMouseEnter: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
}

export const FlyoutTriggerRow: React.FC<FlyoutTriggerRowProps> = React.memo(
  ({ category, label, isActive, isOpen, onMouseEnter, onMouseDown }) => {
    return (
      <div
        data-slash-flat
        className={`${rowClass(isActive, isOpen)} justify-between`}
        onMouseEnter={onMouseEnter}
        onMouseDown={(e) => {
          e.preventDefault();
          onMouseDown(e);
        }}
      >
        <div className="flex items-center gap-2">
          <AnyIcon
            icon={categoryIcon(category)}
            size={14}
            strokeWidth={1.75}
            className={iconClass(isOpen)}
          />
          <span className={labelClass(isOpen)}>{label}</span>
        </div>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          data-icon="chevron-right"
          size={DROPDOWN_ITEM.iconSize}
          strokeWidth={1.75}
          className={isOpen ? "text-primary-6" : "text-text-3"}
        />
      </div>
    );
  }
);

FlyoutTriggerRow.displayName = "FlyoutTriggerRow";

// ── SlashItemRow ──────────────────────────────────────────────────────────────

interface SlashItemRowProps {
  item: SlashItem;
  isActive: boolean;
  onMouseEnter: () => void;
  onClick: (event?: React.MouseEvent<HTMLElement>) => void;
}

export const SlashItemRow: React.FC<SlashItemRowProps> = React.memo(
  ({ item, isActive, onMouseEnter, onClick }) => {
    const Icon = categoryIcon(item.category);
    const description =
      item.category === "tool" && item.serverName ? item.serverName : undefined;
    return (
      <div
        data-slash-flat
        data-testid="slash-command-item"
        data-slash-category={item.category}
        data-slash-name={item.name}
        data-slash-source={item.source}
      >
        <MenuItemRow
          icon={Icon}
          label={item.name}
          description={description}
          isActive={isActive}
          onClick={onClick}
          onMouseEnter={onMouseEnter}
        />
      </div>
    );
  }
);

SlashItemRow.displayName = "SlashItemRow";

// ── DividerRow ────────────────────────────────────────────────────────────────

export const DividerRow: React.FC = () => (
  <div className="mx-2 my-1 h-px bg-border-1" />
);

DividerRow.displayName = "DividerRow";
// ── Re-export AgentExecMode for callers that need it ──────────────────────────

export type { AgentExecMode };
