import { useAtomValue } from "jotai";
import { SquareArrowOutUpRight } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
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

interface BlankTabPortOptionsProps {
  onOpen: (url: string) => void;
}

const BlankTabPortOptions: React.FC<BlankTabPortOptionsProps> = memo(
  ({ onOpen }) => {
    const { t } = useTranslation();
    const scannedPorts = useAtomValue(workspacePortsAtom);
    const ports = useMemo(
      () => selectBlankTabPortOptions(scannedPorts),
      [scannedPorts]
    );

    if (ports.length === 0) {
      return null;
    }

    return (
      <div className="mt-4 w-80 max-w-full text-left">
        <div className="mb-1 px-1.5 text-xs font-medium text-text-3">
          {t("workstation.ports.workspaceSection")} · {ports.length}
        </div>
        <div className="flex flex-col gap-0.5">
          {ports.map((port) => {
            const address = addressForPort(port);
            const processLabel =
              port.processName ??
              (port.pid != null
                ? t("workstation.ports.pidLabel", { pid: port.pid })
                : t("workstation.ports.unknownProcess"));
            const openLabel = `${t("workstation.ports.openInBrowser")}: ${address}`;

            return (
              <button
                key={port.id}
                type="button"
                className={`${DROPDOWN_CLASSES.menuControlItem} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30`}
                aria-label={openLabel}
                title={openLabel}
                onClick={() => onOpen(browserUrlForPort(port))}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                  <span className="shrink-0 font-medium text-text-1">
                    {port.port}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-2">
                    {processLabel}
                  </span>
                  <span className="w-28 shrink-0 truncate text-text-3">
                    {address}
                  </span>
                </span>
                <SquareArrowOutUpRight
                  size={DROPDOWN_ITEM.iconSize}
                  className="shrink-0 text-text-3"
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      </div>
    );
  }
);

BlankTabPortOptions.displayName = "BlankTabPortOptions";

export default BlankTabPortOptions;
