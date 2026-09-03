import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { HugeiconsIcon, PinIcon, PinOffIcon } from "@src/icons";
import { MenuItemRow } from "@src/scaffold/ContextMenu/ResultItems";
import type { SlashItem } from "@src/types/extensions";

import { SLASH_SKILL_ICON } from "./constants";

export const SectionHeaderRow: React.FC<{ label: string }> = React.memo(
  ({ label }) => (
    <div className={`${DROPDOWN_CLASSES.sectionLabel} first:pt-1`}>{label}</div>
  )
);

SectionHeaderRow.displayName = "SectionHeaderRow";

interface SlashItemRowProps {
  item: SlashItem;
  isActive: boolean;
  isPinned: boolean;
  onMouseEnter: () => void;
  onClick: (event?: React.MouseEvent<HTMLElement>) => void;
  onTogglePin: () => void;
}

export const SlashItemRow: React.FC<SlashItemRowProps> = React.memo(
  ({ item, isActive, isPinned, onMouseEnter, onClick, onTogglePin }) => {
    const { t } = useTranslation("sessions");
    const description =
      item.category === "tool" && item.serverName ? item.serverName : undefined;
    const pinLabel = `${t("common:selectors.repo.sections.pinned")} ${item.name}`;
    return (
      <div
        data-slash-flat
        data-testid="slash-command-item"
        data-slash-category={item.category}
        data-slash-name={item.name}
        data-slash-source={item.source}
      >
        <MenuItemRow
          icon={SLASH_SKILL_ICON}
          label={item.name}
          description={description}
          isActive={isActive}
          onClick={onClick}
          onMouseEnter={onMouseEnter}
          trailingContent={
            <Button
              variant="tertiary"
              appearance="ghost"
              size="mini"
              shape="square"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={isPinned ? PinOffIcon : PinIcon}
                  data-icon={isPinned ? "pin-off" : "pin"}
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              }
              tabIndex={-1}
              data-testid="slash-command-pin"
              aria-label={pinLabel}
              aria-pressed={isPinned}
              title={pinLabel}
              className={`shrink-0 enabled:hover:bg-fill-3 ${
                isPinned
                  ? "bg-fill-3 text-primary-6!"
                  : isActive
                    ? "text-text-3! opacity-100"
                    : "text-text-3! opacity-0 group-hover:opacity-100"
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onTogglePin();
              }}
            />
          }
        />
      </div>
    );
  }
);

SlashItemRow.displayName = "SlashItemRow";

export const MenuGroupSeparatorRow: React.FC = () => (
  <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
);

MenuGroupSeparatorRow.displayName = "MenuGroupSeparatorRow";
