/**
 * Ports status-bar menu: workspace vs external listening ports.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { REFRESH_ICON_TOKENS } from "@src/components/RefreshIcon/tokens";
import { resolveTimeZoneForIntl } from "@src/config/timezone";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { createLogger } from "@src/hooks/logger";
import {
  ArrowRight01Icon,
  Copy01Icon,
  HugeiconsIcon,
  InternetIcon,
  Loading03Icon,
  Refresh04Icon,
  ServerStack03Icon,
  StopIcon,
} from "@src/icons";
import {
  addressForPort,
  browserUrlForPort,
  canStopWorkspacePort,
  externalPortCountAtom,
  groupWorkspacePorts,
  workspacePortCountAtom,
  workspacePortProbesAtom,
  workspacePortsAtom,
  workspacePortsLastScanStartedAtAtom,
  workspacePortsRefreshingAtom,
} from "@src/store/workstation/codeEditor/workspacePortsAtom";
import { requestNewBrowserSessionAtom } from "@src/store/workstation/workstationTabBarAtoms";
import { copyText } from "@src/util/data/clipboard";
import { toIntlLocaleTag } from "@src/util/data/formatters/date";
import { classNames } from "@src/util/ui/classNames";

import { StatusBarButton, StatusBarLabel } from "./StatusBarBase";
import { StatusBarTooltip } from "./StatusBarTooltip";
import { useWorkspacePortScanSync } from "./useWorkspacePortScanSync";
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
            <HugeiconsIcon
              icon={InternetIcon}
              data-icon="chrome"
              size={MENU_ICON_SIZE}
              aria-hidden
            />
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
            <HugeiconsIcon
              icon={Copy01Icon}
              data-icon="copy"
              size={MENU_ICON_SIZE}
            />
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
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="loader-2"
                  size={MENU_ICON_SIZE}
                  className="animate-spin text-danger-6"
                />
              ) : (
                <HugeiconsIcon
                  icon={StopIcon}
                  data-icon="stop"
                  size={MENU_ICON_SIZE}
                />
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

interface PortSectionHeaderProps {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}

/** Collapsible section header: chevron points right when collapsed, down when open. */
const PortSectionHeader: React.FC<PortSectionHeaderProps> = memo(
  ({ label, count, expanded, onToggle }) => (
    <button
      type="button"
      className={classNames(
        DROPDOWN_CLASSES.sectionLabel,
        "flex w-full cursor-pointer items-center gap-1 text-left hover:text-text-2"
      )}
      onClick={onToggle}
      aria-expanded={expanded}
      data-dropdown-keyboard-skip="true"
    >
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={12}
        className={classNames(
          "shrink-0 transition-transform duration-150",
          expanded ? "rotate-90" : ""
        )}
        aria-hidden
      />
      <span className="truncate">{sectionLabelWithCount(label, count)}</span>
    </button>
  )
);
PortSectionHeader.displayName = "PortSectionHeader";

/** Clock time of the last scan, in the user's language and timezone preference. */
function formatScanClockTime(timestamp: number, language: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString(toIntlLocaleTag(language), {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: resolveTimeZoneForIntl(),
    });
  } catch {
    return "";
  }
}

export const PortsStatusMenu: React.FC = memo(() => {
  const { t, i18n } = useTranslation();
  const ports = useAtomValue(workspacePortsAtom);
  const workspaceCount = useAtomValue(workspacePortCountAtom);
  const externalCount = useAtomValue(externalPortCountAtom);
  const folders = useAtomValue(workspacePortProbesAtom);
  const refreshing = useAtomValue(workspacePortsRefreshingAtom);
  const lastScanStartedAt = useAtomValue(workspacePortsLastScanStartedAtAtom);
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const [stoppingPortId, setStoppingPortId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaceExpanded, setWorkspaceExpanded] = useState(true);
  const [externalExpanded, setExternalExpanded] = useState(
    () => workspaceCount === 0 && externalCount > 0
  );

  useWorkspacePortScanSync();

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

  const runScan = useCallback(() => {
    refreshWorkspacePortScan({ folders, force: true }).catch(() => {
      // refreshWorkspacePortScan already logged the failure; swallow here so a
      // failed scan never surfaces as an unhandled rejection.
    });
  }, [folders]);

  const toggleWorkspaceSection = useCallback(() => {
    setWorkspaceExpanded((value) => !value);
  }, []);

  const toggleExternalSection = useCallback(() => {
    setExternalExpanded((value) => !value);
  }, []);

  const handleToggle = useCallback(() => {
    if (!isOpen) {
      runScan();
    }
    toggle();
  }, [isOpen, runScan, toggle]);

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

  const workspacePortMatches = useMemo(
    () =>
      workspaceGroups.reduce((total, group) => total + group.ports.length, 0),
    [workspaceGroups]
  );

  const workspaceOpen = workspaceExpanded || isSearching;
  const externalOpen = externalExpanded || isSearching;

  const lastScanLabel =
    lastScanStartedAt > 0 && !refreshing
      ? formatScanClockTime(lastScanStartedAt, i18n.language)
      : "";

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
          <HugeiconsIcon
            icon={ServerStack03Icon}
            data-icon="server-stack-03"
            size={13}
            className="text-text-1"
          />
          <StatusBarLabel emphasis numeric className="text-text-1">
            {workspaceCount}
          </StatusBarLabel>
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
            <DropdownSearch
              type="text"
              value={searchQuery}
              onChange={setSearchQuery}
              placeholder={t("workstation.ports.searchPlaceholder")}
              autoFocus
            />

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
                      {!isSearching && (
                        <div className={DROPDOWN_CLASSES.listMessage}>
                          {t("workstation.ports.noWorkspacePorts")}
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <PortSectionHeader
                        label={t("workstation.ports.workspaceSection")}
                        count={workspacePortMatches}
                        expanded={workspaceOpen}
                        onToggle={toggleWorkspaceSection}
                      />
                      {workspaceOpen &&
                        workspaceGroups.map((group) => (
                          <React.Fragment key={group.folderId}>
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
                        ))}
                    </>
                  )}

                  {externalPorts.length > 0 && (
                    <>
                      <div className={DROPDOWN_CLASSES.menuGroupSeparator} />
                      <PortSectionHeader
                        label={t("workstation.ports.externalSection")}
                        count={externalPorts.length}
                        expanded={externalOpen}
                        onToggle={toggleExternalSection}
                      />
                      {externalOpen &&
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

            <div className={DROPDOWN_CLASSES.footerContainer}>
              <button
                type="button"
                className={classNames(
                  DROPDOWN_CLASSES.menuActionItem,
                  "min-w-0 flex-1 disabled:cursor-default disabled:text-text-3"
                )}
                onClick={runScan}
                disabled={refreshing}
                title={t("workstation.ports.rescanTooltip")}
                data-testid="ports-menu-rescan"
              >
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={MENU_ICON_SIZE}
                  className={refreshing ? REFRESH_ICON_TOKENS.spin : undefined}
                  aria-hidden
                />
                <span className="truncate">
                  {refreshing
                    ? t("workstation.ports.rescanning")
                    : t("workstation.ports.rescan")}
                </span>
              </button>
              {lastScanLabel && (
                <span
                  className="shrink-0 text-[11px] tabular-nums text-text-3"
                  title={t("workstation.ports.lastScannedAt", {
                    time: lastScanLabel,
                  })}
                >
                  {lastScanLabel}
                </span>
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
