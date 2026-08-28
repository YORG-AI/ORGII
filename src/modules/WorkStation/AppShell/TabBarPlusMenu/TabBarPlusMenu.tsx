/**
 * TabBarPlusMenu
 *
 * Trailing `+` button for the unified workstation tab bar. The action model is
 * shared with the empty-pool Launchpad through `useWorkStationLaunchActions`,
 * while the extracted item renderer keeps this coordinator focused on menu
 * state and repository diff data.
 */
import React, { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { Add01Icon, HugeiconsIcon } from "@src/icons";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";

import {
  LAUNCHPAD_ACTION_IDS,
  type WorkStationLaunchActionId,
  useWorkStationLaunchActions,
} from "../useWorkStationLaunchActions";
import { TabBarPlusMenuItems } from "./TabBarPlusMenuItems";

const WORKSTATION_NEW_TAB_EVENT = "workstation-new-tab";

export type TabBarPlusMenuItem = WorkStationLaunchActionId;

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
  // TabBarPlusMenu is mounted at a time per surface, so there is no double-fire.
  useEffect(() => {
    const handler = () => setMenuVisible((open) => !open);
    window.addEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    return () => window.removeEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
  }, []);

  const visibleActions = useMemo(
    () => actions.filter((action) => items.includes(action.id)),
    [actions, items]
  );
  const triggerLabel = t("workstation.plusMenu.title");
  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        <TabBarPlusMenuItems
          actions={visibleActions}
          additions={additions}
          deletions={deletions}
          onActionComplete={() => setMenuVisible(false)}
        />
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
          <HugeiconsIcon
            icon={Add01Icon}
            data-icon="plus"
            size={HEADER_ICON_SIZE.md}
            strokeWidth={2}
          />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
};

export const TabBarPlusMenu = memo(TabBarPlusMenuComponent);
TabBarPlusMenu.displayName = "TabBarPlusMenu";
