import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";
import { WorkspacePortScanner } from "@src/modules/WorkStation/shared/StatusBar/WorkspacePortScanner";
import {
  workStationBrowserSidebarCollapsedAtom,
  workStationBrowserSidebarCollapsedPersistAtom,
} from "@src/store/ui/workStationAtom";

import BlankTabPortOptions from "./BlankTabPortOptions";

interface BrowserBlankTabPlaceholderProps {
  isIncognito?: boolean;
  onOpen: (url: string) => void;
}

const BrowserBlankTabPlaceholder: React.FC<BrowserBlankTabPlaceholderProps> =
  memo(({ isIncognito = false, onOpen }) => {
    const { t } = useTranslation();
    const sidebarCollapsed = useAtomValue(
      workStationBrowserSidebarCollapsedAtom
    );
    const setSidebarCollapsed = useSetAtom(
      workStationBrowserSidebarCollapsedPersistAtom
    );

    const actions = useMemo<QuickAction[]>(
      () => [
        {
          id: "toggle-browser-sidebar",
          label: sidebarCollapsed
            ? t("commands.showPrimarySidebar")
            : t("commands.hidePrimarySidebar"),
          shortcut: getShortcutKeys("browser_sidebar"),
          onAction: () => setSidebarCollapsed("toggle"),
        },
      ],
      [setSidebarCollapsed, sidebarCollapsed, t]
    );

    return (
      <>
        <WorkspacePortScanner enabled />
        <NoTabsPlaceholder
          icon="browser"
          caption={
            isIncognito
              ? t("workstation.browserCore.privateBrowsingEmptyTitle")
              : undefined
          }
          actions={actions}
        >
          <BlankTabPortOptions onOpen={onOpen} />
        </NoTabsPlaceholder>
      </>
    );
  });

BrowserBlankTabPlaceholder.displayName = "BrowserBlankTabPlaceholder";

export default BrowserBlankTabPlaceholder;
