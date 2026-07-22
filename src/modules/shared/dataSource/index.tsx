/**
 * DataSourcePanel
 *
 * Shared data-source inventory panel, rendered both as the Kanban station's
 * "Data Sources" view and as the first-class Runtime chat surface. A single
 * inventory of every
 * external coding tool ORGII detects, driven by the one shared detect pipeline
 * (`external_cli_sources_detect`). Importable apps (Cursor, Codex, Claude,
 * OpenCode, Windsurf, WorkBuddy) show their imported-session count and can be
 * enabled/disabled, auto-scanned on a schedule, and rescanned on demand; the
 * rest show install status. Every row shows the on-disk path + file type.
 *
 * Per-source config (enabled / frequency / lastScannedAt) is persisted via
 * `dataSourceConfigAtom`. A disabled source is gated out of `loadSidebarSessions`
 * so its sessions never load anywhere. Rescan re-runs detection; for importable
 * sources it also clears the cache and re-imports.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import { RefreshCw, Terminal } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type ExternalCliSourceProbe,
  type ExternalSourceStats,
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistorySourceId,
  externalCliSourceProbe,
  externalCliSourcesDetect,
  externalHistoryRescanSource,
  externalHistoryRescanSources,
  fetchExternalSourceStats,
} from "@src/api/tauri/externalHistory";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import Menu from "@src/components/Menu";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import Select from "@src/components/Select";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import TabPill, {
  type TabPillItem,
  type TabPillProps,
} from "@src/components/TabPill";
import Tag, { type TagProps } from "@src/components/Tag";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { loadSidebarSessions } from "@src/store/session";
import {
  ACTIVE_EXTERNAL_SESSION_REFRESH_FREQUENCIES,
  type ActiveExternalSessionRefreshFrequency,
  type DataSourceConfigMap,
  GLOBAL_FREQUENCIES,
  SOURCE_FREQUENCIES,
  type ScanFrequency,
  type SourceFrequency,
  activeExternalSessionRefreshFrequencyAtom,
  dataSourceConfigAtom,
  dataSourceGlobalFrequencyAtom,
  externalSessionsEnabledAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import { copyText } from "@src/util/data/clipboard";
import { formatRelativeElapsedShort } from "@src/util/data/formatters/date";

import DataSourceDetailsCard from "./DataSourceDetailsCard";
import SessionProvenanceHooksPanel from "./SessionProvenanceHooksPanel";
import SessionUsagePanel from "./SessionUsagePanel";

type DataSourceTab = "all" | "apps" | "clis";
export type DataSourcePanelView =
  | "scanning"
  | "hooks"
  | "usage"
  | "quota"
  | "assets";

// The sources ORGII imports history from (have a cache + support Rescan).
const IMPORTABLE_SOURCE_IDS = new Set<ImportedHistorySourceId>(
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map((d) => d.sourceId)
);

function isImportableId(id: string): id is ImportedHistorySourceId {
  return IMPORTABLE_SOURCE_IDS.has(id as ImportedHistorySourceId);
}

interface SourceRow {
  probe: ExternalCliSourceProbe;
  importable: boolean;
  stats: ExternalSourceStats | null;
  statsLoading: boolean;
  rescanning: boolean;
  error: boolean;
}

const SourceIcon: React.FC<{ probe: ExternalCliSourceProbe }> = ({ probe }) => (
  <ModelIcon
    provider={probe.iconId as IconProvider}
    size={16}
    fallback={<Terminal size={16} className="text-text-3" />}
  />
);

interface DataSourcePanelProps {
  /** Optional Runtime-only content appended as the final Assets view. */
  assetsContent?: React.ReactNode;
  /** Optional Runtime-only content rendered in a dedicated Quota view. */
  quotaContent?: React.ReactNode;
  activePanelView?: DataSourcePanelView;
  onPanelViewChange?: (view: DataSourcePanelView) => void;
  hideHeader?: boolean;
  /** Hide scroll chrome while preserving scrolling in compact host surfaces. */
  hideScrollbars?: boolean;
}

interface DataSourcePanelViewTabsProps {
  activeView: DataSourcePanelView;
  showAssets: boolean;
  showQuota: boolean;
  size?: TabPillProps["size"];
  onChange: (view: DataSourcePanelView) => void;
}

export const DataSourcePanelViewTabs: React.FC<DataSourcePanelViewTabsProps> =
  memo(({ activeView, showAssets, showQuota, size = "large", onChange }) => {
    const { t } = useTranslation("sessions", {
      keyPrefix: "kanban.dataSource",
    });
    const viewTabs = useMemo<TabPillItem[]>(
      () => [
        {
          key: "usage",
          label: t("views.usage"),
          dataTestId: "data-source-view-usage",
        },
        ...(showQuota
          ? [
              {
                key: "quota",
                label: t("views.quota"),
                dataTestId: "data-source-view-quota",
              },
            ]
          : []),
        {
          key: "scanning",
          label: t("views.scanning"),
          dataTestId: "data-source-view-scanning",
        },
        {
          key: "hooks",
          label: t("views.hooks"),
          dataTestId: "data-source-view-hooks",
        },
        ...(showAssets
          ? [
              {
                key: "assets",
                label: t("views.assets"),
                dataTestId: "data-source-view-assets",
              },
            ]
          : []),
      ],
      [showAssets, showQuota, t]
    );

    return (
      <TabPill
        activeTab={activeView}
        tabs={viewTabs}
        onChange={(key) => onChange(key as DataSourcePanelView)}
        variant="simple"
        size={size}
        fillWidth={false}
      />
    );
  });

DataSourcePanelViewTabs.displayName = "DataSourcePanelViewTabs";

const DataSourcePanel: React.FC<DataSourcePanelProps> = ({
  assetsContent,
  quotaContent,
  activePanelView,
  onPanelViewChange,
  hideHeader = false,
  hideScrollbars = false,
}) => {
  const { t } = useTranslation("sessions", {
    keyPrefix: "kanban.dataSource",
  });
  const { t: tCommon } = useTranslation("common");
  const [rows, setRows] = useState<SourceRow[] | null>(null);
  const [rescanningAll, setRescanningAll] = useState(false);
  // sourceId whose rescan split-menu is open (null = none).
  const [openRescanMenu, setOpenRescanMenu] = useState<string | null>(null);
  const [tab, setTab] = useState<DataSourceTab>("all");
  // Top-level panel view: usage stats, Runtime quota, scan/import inventory,
  // hook capture, and (only in Runtime) the consolidated assets dashboard.
  const [internalPanelView, setInternalPanelView] =
    useState<DataSourcePanelView>("usage");
  const panelView = activePanelView ?? internalPanelView;
  const isRuntimeSurface = Boolean(quotaContent || assetsContent);
  const handlePanelViewChange = useCallback(
    (nextView: DataSourcePanelView) => {
      if (onPanelViewChange) {
        onPanelViewChange(nextView);
        return;
      }
      setInternalPanelView(nextView);
    },
    [onPanelViewChange]
  );
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [configMap, setConfigMap] = useAtom(dataSourceConfigAtom);
  const [globalFrequency, setGlobalFrequency] = useAtom(
    dataSourceGlobalFrequencyAtom
  );
  const [activeSessionRefreshFrequency, setActiveSessionRefreshFrequency] =
    useAtom(activeExternalSessionRefreshFrequencyAtom);
  const [externalSessionsEnabled, setExternalSessionsEnabled] = useAtom(
    externalSessionsEnabledAtom
  );
  const panelMountedRef = useRef(false);
  const scanningLoadStartedRef = useRef(false);

  useEffect(() => {
    panelMountedRef.current = true;
    return () => {
      panelMountedRef.current = false;
    };
  }, []);

  const patchRow = useCallback(
    (sourceId: string, patch: Partial<SourceRow>) => {
      if (!panelMountedRef.current) return;
      setRows((prev) =>
        prev
          ? prev.map((row) =>
              row.probe.sourceId === sourceId ? { ...row, ...patch } : row
            )
          : prev
      );
    },
    []
  );

  const updateConfig = useCallback(
    (sourceId: string, patch: Partial<DataSourceConfigMap[string]>) => {
      setConfigMap((prev) => ({
        ...prev,
        [sourceId]: { ...getSourceConfig(prev, sourceId), ...patch },
      }));
    },
    [setConfigMap]
  );

  const loadStats = useCallback(
    async (sourceId: ImportedHistorySourceId) => {
      patchRow(sourceId, { statsLoading: true, error: false });
      try {
        const stats = await fetchExternalSourceStats(sourceId);
        patchRow(sourceId, { stats, statsLoading: false });
      } catch {
        patchRow(sourceId, { statsLoading: false, error: true });
      }
    },
    [patchRow]
  );

  // Snapshot config for the initial detect effect without re-running on change.
  const configRef = useRef(configMap);
  configRef.current = configMap;

  // The Usage view is the default. Defer the comparatively expensive source
  // detection/stat fan-out until Scanning is actually opened, then retain the
  // result in this parent so internal tab switches do not re-scan.
  const loadScanningInventory = useCallback(async () => {
    let probes: ExternalCliSourceProbe[] = [];
    try {
      probes = await externalCliSourcesDetect();
    } catch {
      if (panelMountedRef.current) setRows([]);
      return;
    }
    if (!panelMountedRef.current) return;

    const built: SourceRow[] = probes
      .map((probe) => {
        const importable = probe.importable && isImportableId(probe.sourceId);
        const enabled = getSourceConfig(
          configRef.current,
          probe.sourceId
        ).enabled;
        return {
          probe,
          importable,
          stats: null,
          statsLoading: importable && enabled,
          rescanning: false,
          error: false,
        };
      })
      .sort((a, b) => {
        const rank = (r: SourceRow) =>
          r.importable ? 0 : r.probe.installed ? 1 : 2;
        return (
          rank(a) - rank(b) ||
          a.probe.displayName.localeCompare(b.probe.displayName)
        );
      });
    setRows(built);
    await Promise.all(
      built
        .filter(
          (row) =>
            row.importable &&
            isImportableId(row.probe.sourceId) &&
            getSourceConfig(configRef.current, row.probe.sourceId).enabled
        )
        .map((row) => loadStats(row.probe.sourceId as ImportedHistorySourceId))
    );
  }, [loadStats]);

  useEffect(() => {
    if (panelView !== "scanning" || scanningLoadStartedRef.current) return;
    scanningLoadStartedRef.current = true;
    void loadScanningInventory();
  }, [loadScanningInventory, panelView]);

  // Re-run detection for one source (install status, path, store kind).
  const reprobe = useCallback(
    async (sourceId: string) => {
      try {
        const probe = await externalCliSourceProbe(sourceId);
        if (probe) patchRow(sourceId, { probe });
      } catch {
        /* keep the last-known probe */
      }
    },
    [patchRow]
  );

  // Full manual rescan. Importable sources clear + re-import their history; all
  // sources re-probe so a newly-installed tool or freshly-created store is
  // picked up. Stamps lastScannedAt.
  const handleRescan = useCallback(
    async (row: SourceRow, clear = false) => {
      const sourceId = row.probe.sourceId;
      patchRow(sourceId, { rescanning: true, error: false });
      try {
        if (row.importable && isImportableId(sourceId)) {
          await externalHistoryRescanSource(sourceId, { clear });
          await loadSidebarSessions({ forceRefresh: true });
          await loadStats(sourceId);
        }
        await reprobe(sourceId);
      } catch {
        patchRow(sourceId, { error: true });
      } finally {
        patchRow(sourceId, { rescanning: false });
        updateConfig(sourceId, { lastScannedAt: Date.now() });
      }
    },
    [loadStats, patchRow, reprobe, updateConfig]
  );

  const handleRescanAll = useCallback(async () => {
    const current = rows ?? [];
    if (current.length === 0) return;
    setRescanningAll(true);
    setRows(
      (prev) =>
        prev?.map((r) => ({ ...r, rescanning: true, error: false })) ?? prev
    );
    const importables = current
      .filter(
        (r) =>
          r.importable &&
          isImportableId(r.probe.sourceId) &&
          getSourceConfig(configRef.current, r.probe.sourceId).enabled
      )
      .map((r) => r.probe.sourceId as ImportedHistorySourceId);
    try {
      await externalHistoryRescanSources(importables);
      if (importables.length > 0) {
        await loadSidebarSessions({ forceRefresh: true });
      }
      const probes = await externalCliSourcesDetect();
      const byId = new Map(probes.map((p) => [p.sourceId, p]));
      setRows(
        (prev) =>
          prev?.map((r) => {
            const probe = byId.get(r.probe.sourceId);
            return probe ? { ...r, probe } : r;
          }) ?? prev
      );
      await Promise.all(importables.map((s) => loadStats(s)));
      const now = Date.now();
      setConfigMap((prev) => {
        const next = { ...prev };
        for (const s of importables) {
          next[s] = { ...getSourceConfig(prev, s), lastScannedAt: now };
        }
        return next;
      });
    } catch {
      // Per-source errors surface via loadStats/reprobe; ignore the aggregate.
    } finally {
      setRows(
        (prev) => prev?.map((r) => ({ ...r, rescanning: false })) ?? prev
      );
      setRescanningAll(false);
    }
  }, [loadStats, rows, setConfigMap]);

  // Toggle a source on/off. Disabling clears it from the sidebar; enabling
  // loads it and stamps a scan.
  const toggleEnabled = useCallback(
    async (row: SourceRow, enabled: boolean) => {
      const sourceId = row.probe.sourceId;
      updateConfig(sourceId, { enabled });
      // Config write is synchronous in the shared store, so the reload below
      // already respects the new enabled state.
      await loadSidebarSessions({ forceRefresh: true });
      if (enabled) {
        if (row.importable && isImportableId(sourceId)) {
          await loadStats(sourceId);
          updateConfig(sourceId, { lastScannedAt: Date.now() });
        }
      } else {
        patchRow(sourceId, { stats: null });
      }
    },
    [loadStats, patchRow, updateConfig]
  );

  const importableStatusTag = (
    row: SourceRow
  ): { color: TagProps["color"]; labelKey: string } => {
    if (row.statsLoading) return { color: "processing", labelKey: "loading" };
    if (row.error) return { color: "danger", labelKey: "error" };
    if (row.stats && row.stats.sessionCount > 0) {
      return { color: "success", labelKey: "ready" };
    }
    return { color: "default", labelKey: "empty" };
  };

  const openFolder = useCallback((path: string) => {
    void invoke("open_folder", { path }).catch(() => {
      /* best-effort reveal */
    });
  }, []);

  const tabs = useMemo<TabPillItem[]>(
    () => [
      { key: "all", label: t("tabs.all") },
      { key: "apps", label: t("tabs.apps") },
      { key: "clis", label: t("tabs.clis") },
    ],
    [t]
  );

  const sourceFrequencyOptions = useMemo(
    () => SOURCE_FREQUENCIES.map((f) => ({ value: f, label: t(`freq.${f}`) })),
    [t]
  );
  const globalFrequencyOptions = useMemo(
    () => GLOBAL_FREQUENCIES.map((f) => ({ value: f, label: t(`freq.${f}`) })),
    [t]
  );
  const activeSessionRefreshFrequencyOptions = useMemo(
    () =>
      ACTIVE_EXTERNAL_SESSION_REFRESH_FREQUENCIES.map((frequency) => ({
        value: frequency,
        label: t(`activeSessionFreq.${frequency}`),
      })),
    [t]
  );

  const visibleRows = (rows ?? []).filter((row) =>
    tab === "apps" ? row.importable : tab === "clis" ? !row.importable : true
  );
  const importableCount = (rows ?? []).filter((r) => r.importable).length;

  const searchTerm = searchQuery.trim().toLowerCase();
  const searchedRows = searchTerm
    ? visibleRows.filter((row) =>
        [row.probe.displayName, row.probe.sourceId, ...row.probe.historyPaths]
          .join(" ")
          .toLowerCase()
          .includes(searchTerm)
      )
    : visibleRows;

  const statusTagFor = (
    row: SourceRow,
    disabled: boolean
  ): { color: TagProps["color"]; labelKey: string } => {
    if (disabled) return { color: "default", labelKey: "disabled" };
    if (row.importable) return importableStatusTag(row);
    return row.probe.installed
      ? { color: "success", labelKey: "installed" }
      : { color: "default", labelKey: "notInstalled" };
  };

  const columns: SettingsTableColumn<SourceRow>[] = [
    {
      key: "source",
      label: t("col.source"),
      sorter: (a, b) => a.probe.displayName.localeCompare(b.probe.displayName),
      renderCell: (row) => {
        const cfg = getSourceConfig(configMap, row.probe.sourceId);
        const disabled = row.importable && !cfg.enabled;
        const statusTag = statusTagFor(row, disabled);
        return (
          <span className={`${SETTINGS_TABLE_CELL.primaryIcon} min-w-0`}>
            <span className="shrink-0 text-text-2">
              <SourceIcon probe={row.probe} />
            </span>
            <span className="truncate">{row.probe.displayName}</span>
            <Tag size="mini" color={statusTag.color} pill className="shrink-0">
              {t(`status.${statusTag.labelKey}`)}
            </Tag>
          </span>
        );
      },
    },
    {
      key: "sessions",
      label: t("col.sessions"),
      width: "84px",
      sorter: (a, b) =>
        (a.stats?.sessionCount ?? 0) - (b.stats?.sessionCount ?? 0),
      renderCell: (row) => {
        const cfg = getSourceConfig(configMap, row.probe.sourceId);
        const disabled = row.importable && !cfg.enabled;
        return row.importable && !disabled && row.stats ? (
          <span className="tabular-nums text-text-2">
            {row.stats.sessionCount}
          </span>
        ) : null;
      },
    },
    {
      key: "subagents",
      label: "Subagents",
      width: "84px",
      sorter: (a, b) =>
        (a.stats?.subagentCount ?? 0) - (b.stats?.subagentCount ?? 0),
      renderCell: (row) => {
        const cfg = getSourceConfig(configMap, row.probe.sourceId);
        const disabled = row.importable && !cfg.enabled;
        if (!(row.importable && !disabled && row.stats)) return null;
        // Only Cursor has sub-agent sessions today; show a muted dash for the
        // sources that have none so the column doesn't read as a stray "0".
        return row.stats.subagentCount > 0 ? (
          <span className="tabular-nums text-text-2">
            {row.stats.subagentCount}
          </span>
        ) : (
          <span className="tabular-nums text-text-4">–</span>
        );
      },
    },
    {
      key: "lastScan",
      label: t("col.lastScan"),
      width: "118px",
      sorter: (a, b) => {
        const ta = getSourceConfig(configMap, a.probe.sourceId).lastScannedAt;
        const tb = getSourceConfig(configMap, b.probe.sourceId).lastScannedAt;
        return (
          (ta ? new Date(ta).getTime() : 0) - (tb ? new Date(tb).getTime() : 0)
        );
      },
      renderCell: (row) => {
        const cfg = getSourceConfig(configMap, row.probe.sourceId);
        const disabled = row.importable && !cfg.enabled;
        return row.importable && !disabled && cfg.lastScannedAt ? (
          <span className="whitespace-nowrap text-text-3">
            {formatRelativeElapsedShort(new Date(cfg.lastScannedAt))}
          </span>
        ) : null;
      },
    },
    {
      // Keep the combined control column pinned like the Settings CLI table.
      key: "actions",
      label: t("col.frequency"),
      width: SETTINGS_TABLE_COL.hug,
      align: "right",
      renderCell: (row) => {
        const cfg = getSourceConfig(configMap, row.probe.sourceId);
        const disabled = row.importable && !cfg.enabled;
        return (
          <div className="flex items-center justify-end gap-2">
            {row.importable && (
              <>
                <Switch
                  checked={cfg.enabled}
                  onChange={(checked) => void toggleEnabled(row, checked)}
                  size="default"
                  ariaLabel={cfg.enabled ? t("disable") : t("enable")}
                />
                <Select
                  value={cfg.frequency}
                  onChange={(v) => {
                    if (typeof v === "string") {
                      updateConfig(row.probe.sourceId, {
                        frequency: v as SourceFrequency,
                      });
                    }
                  }}
                  options={sourceFrequencyOptions}
                  size="small"
                  disabled={disabled}
                  style={{ width: 120 }}
                  selectorClassName="text-left"
                  aria-label={t("frequencyTitle")}
                />
              </>
            )}
            {!disabled &&
              (row.importable ? (
                // Importable sources have a cache, so offer two rescan modes via
                // a split button: the main click runs Update (incremental
                // re-sync); the caret opens Update / Clear + rescan (full rebuild).
                <Button
                  variant="secondary"
                  size="small"
                  iconOnly
                  splitDropdownWidth={22}
                  loading={row.rescanning}
                  loadingSpinIcon
                  icon={<RefreshCw size={14} />}
                  title={t("rescan")}
                  onClick={() => void handleRescan(row, false)}
                  dropdownVisible={openRescanMenu === row.probe.sourceId}
                  onDropdownClick={(event) => {
                    event.stopPropagation();
                    setOpenRescanMenu((current) =>
                      current === row.probe.sourceId ? null : row.probe.sourceId
                    );
                  }}
                  dropdownMenu={
                    <Dropdown
                      trigger="click"
                      position="bottom-end"
                      popupVisible={openRescanMenu === row.probe.sourceId}
                      onVisibleChange={(visible) =>
                        setOpenRescanMenu(visible ? row.probe.sourceId : null)
                      }
                      getPopupContainer={() => document.body}
                      avoidViewportOverflow
                      droplist={
                        <Menu>
                          <Menu.Item
                            key="update"
                            onClick={() => {
                              setOpenRescanMenu(null);
                              void handleRescan(row, false);
                            }}
                          >
                            {t("rescanUpdate")}
                          </Menu.Item>
                          <Menu.Item
                            key="clear"
                            onClick={() => {
                              setOpenRescanMenu(null);
                              void handleRescan(row, true);
                            }}
                          >
                            {t("rescanClear")}
                          </Menu.Item>
                        </Menu>
                      }
                    >
                      <div />
                    </Dropdown>
                  }
                />
              ) : (
                <Button
                  variant="secondary"
                  size="small"
                  iconOnly
                  loading={row.rescanning}
                  icon={<RefreshCw size={14} />}
                  title={t("rescan")}
                  onClick={() => void handleRescan(row)}
                />
              ))}
          </div>
        );
      },
    },
  ];

  return (
    <div className="absolute inset-0 flex min-h-0 flex-col overflow-hidden">
      {/* Keep the section tabs pinned above the panel's own scroll region. */}
      {!hideHeader ? (
        <InternalHeader
          noPanelHeader
          contentPadding
          className={DETAIL_PANEL_TOKENS.headerWidth}
          tabs={
            <div className="flex w-full justify-center">
              <DataSourcePanelViewTabs
                activeView={panelView}
                showQuota={Boolean(quotaContent)}
                showAssets={Boolean(assetsContent)}
                onChange={handlePanelViewChange}
              />
            </div>
          }
        />
      ) : null}

      <ScrollPreservation
        data-testid="data-source-scroll-region"
        className={
          panelView === "assets"
            ? "min-h-0 flex-1 overflow-hidden scrollbar-hide"
            : hideScrollbars
              ? "min-h-0 flex-1 overflow-y-auto px-4 scrollbar-hide @container"
              : DETAIL_PANEL_TOKENS.scrollContentNoTop
        }
      >
        {panelView === "assets" ? (
          assetsContent
        ) : (
          <div
            className={`${DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop} ${SECTION_GAP_CLASSES}`}
          >
            {panelView === "scanning" ? (
              <>
                {!isRuntimeSurface ? (
                  <h3
                    className={SECTION_SUBHEADING_CLASSES}
                    data-testid="data-source-section-title"
                  >
                    {t("title")}
                  </h3>
                ) : null}
                {importableCount > 0 && (
                  <SectionContainer>
                    <SectionRow
                      label={t("externalSessionsToggle")}
                      description={t("externalSessionsToggleDesc")}
                    >
                      <Switch
                        checked={externalSessionsEnabled}
                        onChange={(checked) =>
                          setExternalSessionsEnabled(checked)
                        }
                        ariaLabel={t("externalSessionsToggle")}
                      />
                    </SectionRow>
                    <SectionRow
                      label={t("globalFrequency")}
                      description={t("globalFrequencyDesc")}
                    >
                      <Select
                        value={globalFrequency}
                        onChange={(v) => {
                          if (typeof v === "string") {
                            setGlobalFrequency(v as ScanFrequency);
                          }
                        }}
                        options={globalFrequencyOptions}
                        size="default"
                        style={SECTION_CONTROL_STYLE}
                        aria-label={t("globalFrequency")}
                        disabled={!externalSessionsEnabled}
                      />
                    </SectionRow>
                    <SectionRow
                      label={t("activeSessionRefresh")}
                      description={t("activeSessionRefreshDesc")}
                    >
                      <Select
                        value={activeSessionRefreshFrequency}
                        onChange={(value) => {
                          if (typeof value === "string") {
                            setActiveSessionRefreshFrequency(
                              value as ActiveExternalSessionRefreshFrequency
                            );
                          }
                        }}
                        options={activeSessionRefreshFrequencyOptions}
                        size="default"
                        style={SECTION_CONTROL_STYLE}
                        aria-label={t("activeSessionRefresh")}
                        disabled={!externalSessionsEnabled}
                      />
                    </SectionRow>
                  </SectionContainer>
                )}

                <SettingsTable<SourceRow>
                  columns={columns}
                  rows={searchedRows}
                  getRowKey={(row) => row.probe.sourceId}
                  headerHeight="tall"
                  // Keep search + tabs + rescan inline when space allows; the shared
                  // toolbar stacks search/actions above the tabs in narrow panels.
                  inlineHeaderToolbar
                  className="table-expanded-no-hover table-settings-expanded-compact"
                  hover
                  loading={rows === null}
                  emptyTitle={
                    searchTerm ? tCommon("status.noResults") : undefined
                  }
                  searchBar={{
                    searchValue: searchQuery,
                    searchPlaceholder: tCommon("common.searchPlaceholder"),
                    onSearchChange: setSearchQuery,
                    onSearchClear: () => setSearchQuery(""),
                    rightContent:
                      (rows ?? []).length > 0 ? (
                        <Button
                          variant="secondary"
                          size="default"
                          iconOnly
                          loading={rescanningAll}
                          disabled={!externalSessionsEnabled}
                          icon={<RefreshCw size={14} />}
                          aria-label={t("rescanAll")}
                          title={t("rescanAll")}
                          onClick={() => void handleRescanAll()}
                        />
                      ) : undefined,
                    tabPills: (
                      <TabPill
                        activeTab={tab}
                        tabs={tabs}
                        onChange={(key) => setTab(key as DataSourceTab)}
                        variant="pill"
                        color="fill"
                        className="h-8 [&>button]:!h-full"
                        fillWidth={false}
                        size="small"
                        buttonStyle
                      />
                    ),
                    searchInputSize: "default",
                    searchCountText:
                      searchTerm && searchedRows.length !== visibleRows.length
                        ? `${searchedRows.length} / ${visibleRows.length}`
                        : undefined,
                  }}
                  expandable={{
                    expandedRowRender: (row) => (
                      <DataSourceDetailsCard
                        probe={row.probe}
                        stats={row.stats}
                        onOpenFolder={openFolder}
                        onCopyPath={(path) => void copyText(path)}
                      />
                    ),
                    rowExpandable: (row) => row.probe.historyPaths.length > 0,
                    expandedRowKeys,
                    onExpandedRowsChange: setExpandedRowKeys,
                  }}
                />
              </>
            ) : panelView === "hooks" ? (
              <SessionProvenanceHooksPanel showTitle={!isRuntimeSurface} />
            ) : panelView === "quota" ? (
              quotaContent
            ) : (
              <SessionUsagePanel />
            )}
          </div>
        )}
      </ScrollPreservation>
    </div>
  );
};

export default DataSourcePanel;
