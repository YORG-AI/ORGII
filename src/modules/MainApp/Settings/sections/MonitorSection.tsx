/**
 * Monitor Settings Section
 *
 * Displays real-time RAM, CPU, and network usage using Rust performance monitoring
 */
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ProgressBar } from "@src/components/ProgressBar";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import {
  type ToolProcessMemoryDiagnostic,
  describeAppMemoryMeasurement,
  getAppMemoryRoleLabelKey,
  getAppMemoryTotals,
} from "@src/hooks/perf";

import NetworkSection from "./NetworkSection";
import StorageSection from "./StorageSection";
import {
  type BreakdownRow,
  formatMemory,
  useMonitorMetrics,
} from "./useMonitorMetrics";

export const MONITOR_TAB_KEYS = {
  RESOURCES: "resources",
  NETWORK: "network",
  STORAGE: "storage",
} as const;

export type MonitorTabKey =
  (typeof MONITOR_TAB_KEYS)[keyof typeof MONITOR_TAB_KEYS];

interface MonitorSectionProps {
  activeTab?: string;
}

const MonitorSection: React.FC<MonitorSectionProps> = ({
  activeTab = MONITOR_TAB_KEYS.RESOURCES,
}) => {
  const { t } = useTranslation("settings");

  const {
    systemMemory,
    appMemoryState,
    toolProcesses,
    systemInfo,
    containerRef,
  } = useMonitorMetrics(activeTab);

  const appMemorySnapshot = appMemoryState.snapshot;
  const appMemoryTotals = getAppMemoryTotals(appMemorySnapshot);
  const totalMemoryMb = appMemoryTotals.totalBytes / (1024 * 1024);
  const backendMemoryMb = appMemoryTotals.backendBytes / (1024 * 1024);
  const webviewMemoryMb = appMemoryTotals.webviewHelperBytes / (1024 * 1024);
  const residentPrivateMb =
    appMemoryTotals.residentPrivateBytes / (1024 * 1024);
  const swappedMb = appMemoryTotals.swappedBytes / (1024 * 1024);
  const measurementLabel = describeAppMemoryMeasurement(
    appMemorySnapshot,
    (key) => t(key)
  );
  const toolProcessMemoryMb =
    toolProcesses.reduce((sum, process) => sum + process.rss_bytes, 0) /
    (1024 * 1024);
  const systemTotalMb = systemMemory?.total_mb ?? 1;
  const totalMemoryPercent = (totalMemoryMb / systemTotalMb) * 100;

  function buildToolProcessDescription(): string {
    if (toolProcesses.length === 0) {
      return t("monitor.noToolProcesses");
    }
    return `${toolProcesses.length} ${t("monitor.processes")} · ${formatMemory(
      toolProcessMemoryMb
    )} · ${t("monitor.excludedFromAppMemory")}`;
  }

  const categoryLabels: Record<string, string> = useMemo(
    () => ({
      terminal: t("monitor.categoryTerminal"),
      agent_cli: t("monitor.categoryAgentCli"),
      mcp_or_tool: t("monitor.categoryMcpOrTool"),
    }),
    [t]
  );

  const breakdownRows = useMemo<BreakdownRow[]>(() => {
    if (!appMemorySnapshot) return [];
    const rows: BreakdownRow[] = [
      {
        key: "backendEffective",
        label: t("monitor.appBackend"),
        megabytes: backendMemoryMb,
        totalMb: totalMemoryMb,
      },
      {
        key: "webkitHelpers",
        label: t("monitor.appWebviewHelpers"),
        megabytes: webviewMemoryMb,
        totalMb: totalMemoryMb,
      },
      ...appMemorySnapshot.processes
        .filter((process) => process.role !== "backend")
        .map((process) => ({
          key: `helper-${process.process_instance_id}`,
          label: `${t(getAppMemoryRoleLabelKey(process.role))} · PID ${process.pid}`,
          megabytes: process.effective_memory_bytes / (1024 * 1024),
          totalMb: totalMemoryMb,
        })),
      ...(appMemoryTotals.hasBreakdown
        ? [
            {
              key: "residentPrivate",
              label: t("monitor.residentPrivate"),
              megabytes: residentPrivateMb,
              totalMb: totalMemoryMb,
            },
            {
              key: "swappedMemory",
              label: t("monitor.swappedMemory"),
              megabytes: swappedMb,
              totalMb: totalMemoryMb,
            },
          ]
        : []),
      {
        key: "rssMappedDiagnostic",
        label: t("monitor.rssMappedDiagnostic"),
        megabytes: appMemorySnapshot.rss_mapped_total_bytes / (1024 * 1024),
        totalMb: totalMemoryMb,
      },
    ];
    return rows;
  }, [
    appMemorySnapshot,
    appMemoryTotals.hasBreakdown,
    backendMemoryMb,
    residentPrivateMb,
    swappedMb,
    totalMemoryMb,
    webviewMemoryMb,
    t,
  ]);

  const breakdownColumns = useMemo<SettingsTableColumn<BreakdownRow>[]>(
    () => [
      {
        key: "subsystem",
        label: t("monitor.tableSubsystem"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primary}>{row.label}</span>
        ),
      },
      {
        key: "size",
        label: t("monitor.tableSize"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.megabytes - rowB.megabytes,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            {formatMemory(row.megabytes)}
          </span>
        ),
      },
      {
        key: "percent",
        label: t("monitor.tablePercent"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right" as const,
        renderCell: (row) => {
          if (row.key === "rssMappedDiagnostic") {
            return <span className={SETTINGS_TABLE_CELL.muted}>—</span>;
          }
          const pct =
            row.totalMb > 0
              ? ((row.megabytes / row.totalMb) * 100).toFixed(1)
              : "0";
          return (
            <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
              {pct}%
            </span>
          );
        },
      },
    ],
    [t]
  );

  const toolColumns = useMemo<
    SettingsTableColumn<ToolProcessMemoryDiagnostic>[]
  >(
    () => [
      {
        key: "name",
        label: t("monitor.tableName"),
        width: SETTINGS_TABLE_COL.valueSm,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (process) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} whitespace-nowrap`}>
            {process.name}
          </span>
        ),
      },
      {
        key: "detail",
        label: t("monitor.tableDetail"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (process) => (
          <span className={SETTINGS_TABLE_CELL.muted}>
            {categoryLabels[process.category] || process.category} · PID{" "}
            {process.pid}
          </span>
        ),
      },
      {
        key: "memory",
        label: `${t("monitor.tableMemory")} (RSS)`,
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.rss_bytes - rowB.rss_bytes,
        renderCell: (process) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            {formatMemory(process.rss_bytes / (1024 * 1024))}
          </span>
        ),
      },
      {
        key: "percent",
        label: t("monitor.tablePercent"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right" as const,
        renderCell: (process) => {
          const totalBytes = toolProcesses.reduce(
            (sum, item) => sum + item.rss_bytes,
            0
          );
          const pct =
            totalBytes > 0
              ? ((process.rss_bytes / totalBytes) * 100).toFixed(1)
              : "0";
          return (
            <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
              {pct}%
            </span>
          );
        },
      },
    ],
    [t, categoryLabels, toolProcesses]
  );

  function getProgressColor(percent: number): string {
    if (percent > 50) return "bg-red-500";
    if (percent > 25) return "bg-yellow-500";
    return "bg-green-500";
  }

  const systemDesc = systemInfo
    ? systemInfo.os_name +
      " " +
      systemInfo.os_version +
      " · " +
      systemInfo.chip_type
    : "";
  const memoryLabel =
    formatMemory(totalMemoryMb) +
    " / " +
    formatMemory(systemTotalMb) +
    ` (${t("monitor.appBackend")} ` +
    formatMemory(backendMemoryMb) +
    `, ${t("monitor.appWebviewHelpers")} ` +
    formatMemory(webviewMemoryMb) +
    ")";

  return (
    <div ref={containerRef} className={SECTION_GAP_CLASSES}>
      {activeTab === MONITOR_TAB_KEYS.RESOURCES && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("monitor.performanceMonitor")}
              description={systemDesc}
            />
            <SectionRow label="" indent showHeader={false}>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-2">
                      {t("monitor.memory")} {totalMemoryPercent.toFixed(1)}%
                    </span>
                    <span className="text-xs text-text-2">{memoryLabel}</span>
                  </div>
                  <ProgressBar
                    percent={totalMemoryPercent}
                    color={getProgressColor(totalMemoryPercent)}
                  />
                  <div className="flex items-center justify-between gap-3 text-xs text-text-3">
                    <span>{t("monitor.measurement")}</span>
                    <span>{measurementLabel}</span>
                  </div>
                  {appMemoryState.errorMessage && (
                    <div className="text-danger-7 rounded-md border border-solid border-danger-3 bg-danger-1 px-3 py-2 text-xs">
                      {appMemoryState.errorMessage}
                    </div>
                  )}
                </div>
              </div>
            </SectionRow>
          </SectionContainer>
          <SectionContainer>
            <SectionRow
              label={t("monitor.memoryBreakdown")}
              description={t("monitor.measurement")}
            />
            <SectionRow label="" indent showHeader={false}>
              {breakdownRows.length > 0 ? (
                <SettingsTable<BreakdownRow>
                  columns={breakdownColumns}
                  rows={breakdownRows}
                  getRowKey={(row) => row.key}
                  showHeader={false}
                  noPx
                />
              ) : (
                <div className="py-2 text-xs text-text-3">
                  {t("monitor.breakdownNotImplemented")}
                </div>
              )}
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("monitor.toolProcessDiagnostics")}
              description={buildToolProcessDescription()}
            />
            {toolProcesses.length > 0 && (
              <SectionRow label="" indent showHeader={false}>
                <SettingsTable<ToolProcessMemoryDiagnostic>
                  columns={toolColumns}
                  rows={toolProcesses}
                  getRowKey={(process) => process.process_instance_id}
                  showHeader={false}
                  noPx
                />
              </SectionRow>
            )}
          </SectionContainer>
        </>
      )}

      {activeTab === MONITOR_TAB_KEYS.NETWORK && <NetworkSection />}
      {activeTab === MONITOR_TAB_KEYS.STORAGE && <StorageSection />}
    </div>
  );
};

export default MonitorSection;
