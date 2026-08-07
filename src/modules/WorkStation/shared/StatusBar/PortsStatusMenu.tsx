/**
 * Ports status-bar menu: workspace vs external listening ports.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Copy, Globe, Loader2, Search, Trash2, Unplug } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import {
  addressForPort,
  browserUrlForPort,
  canStopWorkspacePort,
  externalPortCountAtom,
  groupWorkspacePorts,
  workspacePortCountAtom,
  workspacePortProbesAtom,
  workspacePortsAtom,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";
import { requestNewBrowserSessionAtom } from "@src/store/workstation/workstationTabBarAtoms";
import { copyText } from "@src/util/data/clipboard";
import { classNames } from "@src/util/ui/classNames";

import { StatusBarButton } from "./StatusBarBase";
import { StatusBarTooltip } from "./StatusBarTooltip";
import {
  refreshWorkspacePortScan,
  stopWorkspacePort,
} from "./utils/workspacePortActions";

const logger = createLogger("PortsStatusMenu");
const MENU_ICON_SIZE = DROPDOWN_ITEM.iconSize;

interface PortRowProps {
  port: WorkspacePort;
  external?: boolean;
  onOpen: (port: WorkspacePort) => void;
  onCopy: (port: WorkspacePort) => void;
  onStop: (port: WorkspacePort) => void;
  stopping: boolean;
}

function portSearchHaystack(port: WorkspacePort): string {
  return [
    String(port.port),
    port.processName ?? "",
    port.pid != null ? String(port.pid) : "",
    port.connectHost,
    port.bindHost,
    port.advertisedUrl ?? "",
    addressForPort(port),
    port.owner?.displayName ?? "",
    port.kind,
  ]
    .join(" ")
    .toLowerCase();
}

function matchesPortQuery(port: WorkspacePort, query: string): boolean {
  if (!query) {
    return true;
  }
  return portSearchHaystack(port).includes(query);
}

const PortRow: React.FC<PortRowProps> = memo(
  ({ port, external = false, onOpen, onCopy, onStop, stopping }) => {
    const { t } = useTranslation();
    const canStop = canStopWorkspacePort(port);
    const addressLabel = external ? null : addressForPort(port);

    const processLabel =
      port.processName ??
      (port.pid
        ? t("workstation.ports.pidLabel", { pid: port.pid })
        : t("workstation.ports.unknownProcess"));

    return (
      <div
        className={classNames(
          DROPDOWN_CLASSES.menuControlItem,
          "group/port-row"
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span className="shrink-0 font-medium text-text-1">{port.port}</span>
          <span
            className="min-w-0 flex-1 truncate text-text-2"
            title={processLabel}
          >
            {processLabel}
          </span>
          {addressLabel && (
            <span
              className="max-w-[40%] shrink-0 truncate text-text-3"
              title={addressLabel}
            >
              {addressLabel}
            </span>
          )}
        </div>
        {/*
          Keep actions always painted (no opacity reveal). Opacity
          transitions promote compositor layers and make centered icons
          jitter on hover in Chromium.
        */}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            title={t("workstation.ports.openInBrowser")}
            aria-label={t("workstation.ports.openInBrowser")}
            onClick={(event) => {
              event.stopPropagation();
              onOpen(port);
            }}
          >
            <Globe size={MENU_ICON_SIZE} />
          </button>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            title={t("workstation.ports.copyAddress")}
            aria-label={t("workstation.ports.copyAddress")}
            onClick={(event) => {
              event.stopPropagation();
              onCopy(port);
            }}
          >
            <Copy size={MENU_ICON_SIZE} />
          </button>
          {canStop && (
            <button
              type="button"
              className="hover:text-danger-7 inline-flex h-6 w-6 items-center justify-center rounded text-danger-6 transition-colors hover:bg-danger-1 disabled:opacity-40"
              title={t("workstation.ports.stopProcess")}
              aria-label={t("workstation.ports.stopProcess")}
              disabled={stopping}
              onClick={(event) => {
                event.stopPropagation();
                onStop(port);
              }}
            >
              {stopping ? (
                <Loader2
                  size={MENU_ICON_SIZE}
                  className="animate-spin text-danger-6"
                />
              ) : (
                <Trash2 size={MENU_ICON_SIZE} />
              )}
            </button>
          )}
        </div>
      </div>
    );
  }
);
PortRow.displayName = "PortRow";

function sectionLabelWithCount(label: string, count: number): string {
  return `${label} · ${count}`;
}

export const PortsStatusMenu: React.FC = memo(() => {
  const { t } = useTranslation();
  const ports = useAtomValue(workspacePortsAtom);
  const workspaceCount = useAtomValue(workspacePortCountAtom);
  const externalCount = useAtomValue(externalPortCountAtom);
  const folders = useAtomValue(workspacePortProbesAtom);
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const [stoppingPortId, setStoppingPortId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [externalExpanded, setExternalExpanded] = useState(
    () => workspaceCount === 0 && externalCount > 0
  );
  const tauriSelectAll = useTauriSelectAllShortcut();

  const {
    isOpen,
    isPositioned,
    panelPosition,
    panelRef,
    toggle,
    triggerRef,
    close,
  } = useDropdownEngine<HTMLDivElement>({
    align: "left",
    gap: DROPDOWN_PANEL.triggerGap,
    placement: "top",
  });

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;

  const { workspaceGroups, externalPorts } = useMemo(() => {
    const filtered = ports.filter((port) =>
      matchesPortQuery(port, normalizedQuery)
    );
    return groupWorkspacePorts(filtered);
  }, [normalizedQuery, ports]);

  useEffect(() => {
    if (isSearching && externalPorts.length > 0) {
      setExternalExpanded(true);
    }
  }, [externalPorts.length, isSearching]);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery("");
    }
  }, [isOpen]);

  const handleToggle = useCallback(() => {
    if (!isOpen) {
      void refreshWorkspacePortScan({ folders, force: true });
    }
    toggle();
  }, [folders, isOpen, toggle]);

  const handleOpen = useCallback(
    (port: WorkspacePort) => {
      requestNewBrowserSession({ url: browserUrlForPort(port) });
      close();
    },
    [close, requestNewBrowserSession]
  );

  const handleCopy = useCallback((port: WorkspacePort) => {
    void copyText(addressForPort(port)).catch((error: unknown) => {
      logger.warn("failed to copy port address:", error);
    });
  }, []);

  const handleStop = useCallback(
    async (port: WorkspacePort) => {
      if (!canStopWorkspacePort(port) || port.pid == null) {
        return;
      }
      setStoppingPortId(port.id);
      try {
        const result = await stopWorkspacePort({
          folders,
          pid: port.pid,
          port: port.port,
        });
        if (!result.ok) {
          logger.warn("failed to stop process:", result.reason);
        }
      } catch (error) {
        logger.warn("failed to stop process:", error);
      } finally {
        setStoppingPortId(null);
      }
    },
    [folders]
  );

  const hasAnyMatches = workspaceGroups.length > 0 || externalPorts.length > 0;

  return (
    <div ref={triggerRef} className="flex h-full">
      <StatusBarTooltip
        label={t("workstation.ports.viewPortsTooltip", "View used ports")}
        disabled={isOpen}
      >
        <StatusBarButton
          onClick={handleToggle}
          active={isOpen}
          ariaLabel={t("workstation.ports.viewPortsTooltip", "View used ports")}
          className="gap-1.5"
          dataTestId="status-bar-ports"
        >
          <Unplug size={13} className="text-text-1" />
          <span className="font-medium text-text-1">{workspaceCount}</span>
        </StatusBarButton>
      </StatusBarTooltip>

      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} ${DROPDOWN_WIDTHS.fixedStatusPanelClass}`}
            style={{
              position: "fixed",
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
              right: panelPosition.right,
            }}
            role="menu"
          >
            <div className={DROPDOWN_CLASSES.searchContainer}>
              <Search
                size={DROPDOWN_ITEM.iconSize}
                className="shrink-0 text-text-3"
              />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={tauriSelectAll}
                placeholder={t("workstation.ports.searchPlaceholder")}
                className={DROPDOWN_CLASSES.searchInput}
                autoFocus
              />
            </div>

            <div className={DROPDOWN_CLASSES.optionsContainerBelowHeader}>
              {!hasAnyMatches ? (
                <div className={DROPDOWN_CLASSES.listMessage}>
                  {isSearching
                    ? t("workstation.ports.noSearchResults")
                    : t("workstation.ports.noWorkspacePorts")}
                </div>
              ) : (
                <>
                  {workspaceGroups.length === 0 ? (
                    <>
                      <div className={DROPDOWN_CLASSES.sectionLabel}>
                        {sectionLabelWithCount(
                          t("workstation.ports.workspaceSection"),
                          0
                        )}
                      </div>
                      {!isSearching && (
                        <div className={DROPDOWN_CLASSES.listMessage}>
                          {t("workstation.ports.noWorkspacePorts")}
                        </div>
                      )}
                    </>
                  ) : (
                    workspaceGroups.map((group) => (
                      <React.Fragment key={group.folderId}>
                        <div className={DROPDOWN_CLASSES.sectionLabel}>
                          {sectionLabelWithCount(
                            group.displayName,
                            group.ports.length
                          )}
                        </div>
                        {group.ports.map((port) => (
                          <PortRow
                            key={port.id}
                            port={port}
                            onOpen={handleOpen}
                            onCopy={handleCopy}
                            onStop={handleStop}
                            stopping={stoppingPortId === port.id}
                          />
                        ))}
                      </React.Fragment>
                    ))
                  )}

                  {externalPorts.length > 0 && (
                    <>
                      <div className={DROPDOWN_CLASSES.menuSeparator} />
                      <button
                        type="button"
                        className={classNames(
                          DROPDOWN_CLASSES.sectionLabel,
                          "w-full cursor-pointer text-left"
                        )}
                        onClick={() => setExternalExpanded((value) => !value)}
                      >
                        {sectionLabelWithCount(
                          t("workstation.ports.externalSection"),
                          externalPorts.length
                        )}
                      </button>
                      {(externalExpanded || isSearching) &&
                        externalPorts.map((port) => (
                          <PortRow
                            key={port.id}
                            port={port}
                            external
                            onOpen={handleOpen}
                            onCopy={handleCopy}
                            onStop={handleStop}
                            stopping={stoppingPortId === port.id}
                          />
                        ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
});
PortsStatusMenu.displayName = "PortsStatusMenu";

export default PortsStatusMenu;
