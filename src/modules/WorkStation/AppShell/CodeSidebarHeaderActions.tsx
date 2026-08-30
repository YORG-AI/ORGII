import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { type IconSvgElement, Search01Icon } from "@src/icons";
import {
  PRIMARY_SIDEBAR_TABS,
  type PrimarySidebarTabKey,
  activeStatusBarAppAtom,
  workStationPrimarySidebarCollapsedPersistAtom,
  workStationPrimarySidebarTabAtom,
} from "@src/store/ui/workStationAtom";
import {
  type WorkStationTab,
  activeWorkStationTabAtom,
} from "@src/store/workstation/tabs";

const CODE_SIDEBAR_HEADER_ACTIONS: Array<{
  key: PrimarySidebarTabKey;
  icon: IconSvgElement;
  labelKey: string;
}> = [
  {
    key: PRIMARY_SIDEBAR_TABS.SEARCH,
    icon: Search01Icon,
    labelKey: "tabs.search",
  },
];

function usesFallbackCodeSidebar(tab: WorkStationTab | null): boolean {
  if (!tab) return true;
  return (
    tab.type !== "agent-config" &&
    tab.type !== "chat-session" &&
    tab.type !== "github-issue-detail" &&
    tab.type !== "github-pr-detail" &&
    tab.type !== "source-control" &&
    tab.type !== "terminal" &&
    tab.type !== "search-sessions"
  );
}

const CodeSidebarHeaderActionsComponent: React.FC = () => {
  const { t } = useTranslation("common");
  const activeApp = useAtomValue(activeStatusBarAppAtom);
  const activeTab = useAtomValue(activeWorkStationTabAtom);
  const [activeSidebarTab, setActiveSidebarTab] = useAtom(
    workStationPrimarySidebarTabAtom
  );
  const setSidebarCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );

  const handleSelect = useCallback(
    (tab: PrimarySidebarTabKey) => {
      const nextTab =
        activeSidebarTab === tab ? PRIMARY_SIDEBAR_TABS.FILES : tab;
      setActiveSidebarTab(nextTab);
      setSidebarCollapsed(false);
    },
    [activeSidebarTab, setActiveSidebarTab, setSidebarCollapsed]
  );

  if (activeApp !== "code" || !usesFallbackCodeSidebar(activeTab)) return null;

  return (
    <div className="flex shrink-0 items-center gap-px">
      {CODE_SIDEBAR_HEADER_ACTIONS.map((action) => {
        const active = activeSidebarTab === action.key;
        const label = t(action.labelKey);
        const shortcutId =
          action.key === PRIMARY_SIDEBAR_TABS.SEARCH
            ? "search_files"
            : undefined;

        return (
          <ToolbarTooltip
            key={action.key}
            label={label}
            shortcutId={shortcutId}
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={active ? "!bg-fill-2 !text-primary-6" : ""}
              onClick={() => handleSelect(action.key)}
              aria-label={label}
              icon={
                <AnyIcon
                  icon={action.icon}
                  size={HEADER_ICON_SIZE.sm}
                  strokeWidth={2}
                />
              }
            />
          </ToolbarTooltip>
        );
      })}
    </div>
  );
};

export const CodeSidebarHeaderActions = memo(CodeSidebarHeaderActionsComponent);
CodeSidebarHeaderActions.displayName = "CodeSidebarHeaderActions";
