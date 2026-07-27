import React from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";

import type { WorkStationLaunchAction } from "../useWorkStationLaunchActions";

interface TabBarPlusMenuItemsProps {
  actions: readonly WorkStationLaunchAction[];
  additions: number;
  deletions: number;
  onActionComplete: () => void;
}

export function TabBarPlusMenuItems({
  actions,
  additions,
  deletions,
  onActionComplete,
}: TabBarPlusMenuItemsProps) {
  return (
    <>
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            onClick={() => {
              action.onClick();
              onActionComplete();
            }}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <Icon size={HEADER_ICON_SIZE.sm} />
              <span className="min-w-0 truncate">{action.label}</span>
              {action.id === "sourceControl" &&
              (additions > 0 || deletions > 0) ? (
                <DiffStatsBadge
                  additions={additions}
                  deletions={deletions}
                  variant="plain"
                  size="xs"
                  reserveValueWidth={false}
                  className="shrink-0"
                />
              ) : null}
            </span>
            {action.shortcut ? (
              <KeyboardShortcut
                shortcut={action.shortcut}
                variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
              />
            ) : null}
          </button>
        );
      })}
    </>
  );
}
