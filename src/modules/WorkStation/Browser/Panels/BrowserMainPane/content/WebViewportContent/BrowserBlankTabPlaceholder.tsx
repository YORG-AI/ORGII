import { useAtomValue } from "jotai";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
import {
  NoTabsPlaceholder,
  type QuickAction,
} from "@src/modules/WorkStation/shared";
import { WorkspacePortScanner } from "@src/modules/WorkStation/shared/StatusBar/WorkspacePortScanner";
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
  /**
   * Open the "import cookies from your browser" flow. When omitted (e.g. in
   * unit tests, or private windows) the action is not shown.
   */
  onImportCookies?: () => void;
}

const BrowserBlankTabPlaceholder: React.FC<BrowserBlankTabPlaceholderProps> =
  memo(({ isIncognito = false, onOpen, onImportCookies }) => {
    const { t } = useTranslation();
    const scannedPorts = useAtomValue(workspacePortsAtom);
    const ports = useMemo(
      () => selectBlankTabPortOptions(scannedPorts),
      [scannedPorts]
    );

    const actions = useMemo<QuickAction[]>(() => {
      const portActions: QuickAction[] = ports.map((port) => {
        const address = addressForPort(port);
        return {
          id: `open-workspace-port-${port.id}`,
          label: t("workstation.ports.openAddress", { address }),
          onAction: () => onOpen(browserUrlForPort(port)),
        };
      });

      // Importing carries persistent logins, so it is offered only for regular
      // (non-private) browsing and only when the host wires up the flow.
      const importAction: QuickAction[] =
        onImportCookies && !isIncognito
          ? [
              {
                id: "import-browser-cookies",
                label: t("browserCookieImport.action"),
                onAction: onImportCookies,
              },
            ]
          : [];

      return [...importAction, ...portActions];
    }, [isIncognito, onImportCookies, onOpen, ports, t]);

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
