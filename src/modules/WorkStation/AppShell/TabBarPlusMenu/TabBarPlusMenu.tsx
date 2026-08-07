/**
 * TabBarPlusMenu
 *
 * Trailing `+` button for the unified workstation tab bar. Opens a tiny
 * palette with quick-action items. The item list is shared with the empty-pool
 * Launchpad (`WorkStationStartPage`) through `useWorkStationLaunchActions`, so
 * the `+` menu and the Launchpad always offer the same actions and icons.
 *
 * Each action adds (or activates) a tab in `mainPane` — or, for the Browser
 * entries, reveals the Browser host — and `AppShell` swaps in the matching
 * host content.
 *
 * Keyboard: ⌘T (`new_tab`) opens whichever instance of this menu is currently
 * mounted. The global keydown listener dispatches `workstation-new-tab` from
 * any `/orgii/workstation*` route (see `useTabShortcuts`); we listen for it
 * here so the shortcut is owned exclusively by the `+` menu.
 */
import { Plus } from "lucide-react";
import React, { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";

import {
  LAUNCHPAD_ACTION_IDS,
  type WorkStationLaunchActionId,
  useWorkStationLaunchActions,
} from "../useWorkStationLaunchActions";

const WORKSTATION_NEW_TAB_EVENT = "workstation-new-tab";

export type TabBarPlusMenuItem = WorkStationLaunchActionId;

/**
 * Full launcher palette — kept identical to the Launchpad list. Callers may
 * pass a narrower `items` list (e.g. a Browser-only surface).
 */
const DEFAULT_ITEMS: readonly TabBarPlusMenuItem[] = LAUNCHPAD_ACTION_IDS;

export interface TabBarPlusMenuProps {
  /** Menu items to render. Defaults to the full launcher palette. */
  items?: readonly TabBarPlusMenuItem[];
}

const TabBarPlusMenuComponent: React.FC<TabBarPlusMenuProps> = ({
  items = DEFAULT_ITEMS,
}) => {
  const { t } = useTranslation("navigation");
  const actions = useWorkStationLaunchActions();
  const { repoId, repoPath } = useActiveRepoRef();
  const { additions, deletions } = useWorkingTreeDiffTotals(repoId, repoPath);
  const [menuVisible, setMenuVisible] = useState(false);

  // ⌘T (`new_tab`) is exclusively bound to opening this menu. Only one
  // TabBarPlusMenu is mounted at a time per surface, so there is no
  // double-fire.
  useEffect(() => {
    const handler = () => setMenuVisible((open) => !open);
    window.addEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    return () => {
      window.removeEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    };
  }, []);

  const triggerLabel = t("workstation.plusMenu.title");

  const visibleActions = useMemo(
    () => actions.filter((action) => items.includes(action.id)),
    [actions, items]
  );

  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        {visibleActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.id}
              type="button"
              onClick={() => {
                action.onClick();
                setMenuVisible(false);
              }}
              className={DROPDOWN_CLASSES.menuActionItem}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Icon size={HEADER_ICON_SIZE.sm} />
                <span className="truncate">{action.label}</span>
              </span>
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
              {action.shortcut ? (
                <KeyboardShortcut
                  shortcut={action.shortcut}
                  variant={KEYBOARD_SHORTCUT_VARIANT.dropdown}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <Dropdown
      droplist={droplist}
      position="bottom-end"
      trigger="click"
      popupVisible={menuVisible}
      onVisibleChange={setMenuVisible}
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <span
        className="inline-flex"
        data-tour-target={CODE_EDITOR_TOUR_TARGETS.plusMenu}
      >
        <TabBarTrailingIconButton
          title={triggerLabel}
          shortcutId="new_tab"
          tooltipDisabled={menuVisible}
          active={menuVisible}
          className="flex-shrink-0"
        >
          <Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
};

export const TabBarPlusMenu = memo(TabBarPlusMenuComponent);

TabBarPlusMenu.displayName = "TabBarPlusMenu";
