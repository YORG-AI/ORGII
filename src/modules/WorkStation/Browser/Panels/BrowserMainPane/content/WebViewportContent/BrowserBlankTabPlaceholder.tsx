import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
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
import {
  addressForPort,
  browserUrlForPort,
  workspacePortsAtom,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";

export const BLANK_TAB_PORT_OPTION_LIMIT = 6;

export function selectBlankTabPortOptions(
  ports: WorkspacePort[]
): WorkspacePort[] {
  return ports
    .filter((port) => port.kind === "workspace")
    .slice(0, BLANK_TAB_PORT_OPTION_LIMIT);
}

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
    const scannedPorts = useAtomValue(workspacePortsAtom);
    const ports = useMemo(
      () => selectBlankTabPortOptions(scannedPorts),
      [scannedPorts]
    );

    const actions = useMemo<QuickAction[]>(() => {
      const sidebarAction: QuickAction = {
        id: "toggle-browser-sidebar",
        label: sidebarCollapsed
          ? t("commands.showPrimarySidebar")
          : t("commands.hidePrimarySidebar"),
        shortcut: getShortcutKeys("browser_sidebar"),
        onAction: () => setSidebarCollapsed("toggle"),
      };
      const portActions: QuickAction[] = ports.map((port) => {
        const address = addressForPort(port);
        return {
          id: `open-workspace-port-${port.id}`,
          label: t("workstation.ports.openAddress", { address }),
          onAction: () => onOpen(browserUrlForPort(port)),
        };
      });

      return [sidebarAction, ...portActions];
    }, [onOpen, ports, setSidebarCollapsed, sidebarCollapsed, t]);

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
        />
      </>
    );
  });

BrowserBlankTabPlaceholder.displayName = "BrowserBlankTabPlaceholder";

export default BrowserBlankTabPlaceholder;
