/**
 * UsageHistory Page
 *
 * Displays local session usage from Tauri SQLite (CLI + OS agent sessions).
 *
 * Layout: InternalHeader + main content (chart + transactions) + right filter sidebar.
 * Follows the same layout pattern as the Models Properties page.
 */
import dayjs from "dayjs";
import { Loader2, LogIn, LogOut } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatAgentType } from "@src/assets/providers";
import { CHART_AXIS_TICK, ChartTooltip } from "@src/components/Chart";
import ModelIcon from "@src/components/ModelIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { createLogger } from "@src/hooks/logger";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  Placeholder,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";

import DateRangePill from "../../components/DateRangePill";
import { useRegisterFilterToggle } from "../../hooks/useRegisterRefresh";
import {
  DATE_RANGE_OPTIONS,
  DEFAULT_RANGE,
  computeDateRange,
} from "../CodingProfileView/config";
import {
  type ProfileDateRange,
  formatModelNameFull,
} from "../CodingProfileView/config";
import UsageHistoryFilterSidebar from "./UsageHistoryFilterSidebar";
import {
  CHART_METRIC,
  type TokenUsageRecord,
  USAGE_SOURCE,
  type UsageHistoryFilters,
  type UsageItem,
  buildChartData,
  fetchSessionTokenRecords,
  fetchUsageSessions,
  getProviderColor,
} from "./utils";

export type { UsageHistoryFilters };

const log = createLogger("UsageHistory");

const EMPTY_FILTERS: UsageHistoryFilters = {
  source: "all",
  selectedProvider: null,
  dateRange: DEFAULT_RANGE,
};

interface UsageHistoryProps {
  /** Additional filter toggle registration callback for cross-page reuse. */
  onFilterRegistration?: (visible: boolean, toggle: () => void) => void;
}

const UsageHistory: React.FC<UsageHistoryProps> = ({
  onFilterRegistration,
}) => {
  const { t } = useTranslation();

  const [filters, setFilters] = useState<UsageHistoryFilters>({
    ...EMPTY_FILTERS,
  });
  const [customDates, setCustomDates] = useState<{
    startDate: string;
    endDate: string;
  } | null>(null);
  const [isFilterSidebarVisible, setIsFilterSidebarVisible] = useState(true);

  const handleToggleFilter = useCallback(() => {
    setIsFilterSidebarVisible((prev) => !prev);
  }, []);

  useRegisterFilterToggle(
    "sessions",
    isFilterSidebarVisible,
    handleToggleFilter
  );

  useEffect(() => {
    onFilterRegistration?.(isFilterSidebarVisible, handleToggleFilter);
  }, [onFilterRegistration, isFilterSidebarVisible, handleToggleFilter]);

  const [items, setItems] = useState<UsageItem[]>([]);
  const [loading, setLoading] = useState(true);

  const dateRange = useMemo(
    () =>
      computeDateRange(
        filters.dateRange as ProfileDateRange,
        customDates ?? undefined
      ),
    [filters.dateRange, customDates]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const sessions = await fetchUsageSessions({
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
        });
        if (!cancelled) {
          setItems(sessions);
        }
      } catch (err) {
        log.warn("[UsageHistory] Failed to load sessions:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [dateRange.startDate, dateRange.endDate]);

  const allItems = useMemo(
    () =>
      [...items].sort(
        (itemA, itemB) => itemB.date.valueOf() - itemA.date.valueOf()
      ),
    [items]
  );

  const filteredItems = useMemo(() => {
    if (filters.source === USAGE_SOURCE.LOCAL)
      return allItems.filter((item) => item.source === USAGE_SOURCE.LOCAL);
    if (filters.source === USAGE_SOURCE.POOLING)
      return allItems.filter((item) => item.source === USAGE_SOURCE.POOLING);
    return allItems;
  }, [allItems, filters.source]);

  const hasCostData = useMemo(
    () => filteredItems.some((item) => item.cost > 0),
    [filteredItems]
  );

  const providers = useMemo(
    () =>
      Array.from(new Set(filteredItems.map((item) => item.provider))).sort(),
    [filteredItems]
  );

  const providerStats = useMemo(() => {
    const stats: Record<
      string,
      { totalSpend: number; totalTokens: number; usageCount: number }
    > = {};

    providers.forEach((provider) => {
      const providerItems = filteredItems.filter(
        (item) => item.provider === provider
      );
      stats[provider] = {
        totalSpend: providerItems.reduce((sum, item) => sum + item.cost, 0),
        totalTokens: providerItems.reduce((sum, item) => sum + item.tokens, 0),
        usageCount: providerItems.length,
      };
    });

    stats["all"] = {
      totalSpend: filteredItems.reduce((sum, item) => sum + item.cost, 0),
      totalTokens: filteredItems.reduce((sum, item) => sum + item.tokens, 0),
      usageCount: filteredItems.length,
    };

    return stats;
  }, [filteredItems, providers]);

  const chartMetric = hasCostData ? CHART_METRIC.COST : CHART_METRIC.TOKENS;
  const chartData = useMemo(() => {
    const filterItems = filters.selectedProvider
      ? filteredItems.filter(
          (item) => item.provider === filters.selectedProvider
        )
      : filteredItems;
    return buildChartData(
      filterItems,
      dateRange.startDate,
      dateRange.endDate,
      chartMetric
    );
  }, [
    filteredItems,
    dateRange.startDate,
    dateRange.endDate,
    filters.selectedProvider,
    chartMetric,
  ]);

  const chartProviders = useMemo(() => {
    const filterItems = filters.selectedProvider
      ? filteredItems.filter(
          (item) => item.provider === filters.selectedProvider
        )
      : filteredItems;
    return Array.from(new Set(filterItems.map((item) => item.provider))).sort();
  }, [filteredItems, filters.selectedProvider]);

  const timelineUsage = useMemo(() => {
    if (!filters.selectedProvider) return filteredItems;
    return filteredItems.filter(
      (item) => item.provider === filters.selectedProvider
    );
  }, [filteredItems, filters.selectedProvider]);

  // --- Expandable round detail ---
  const [roundCache, setRoundCache] = useState<
    Record<string, TokenUsageRecord[]>
  >({});
  const [roundLoading, setRoundLoading] = useState<string | null>(null);

  const loadRounds = useCallback(
    async (sessionId: string) => {
      if (roundCache[sessionId]) return;
      setRoundLoading(sessionId);
      const records = await fetchSessionTokenRecords(sessionId);
      setRoundCache((prev) => ({ ...prev, [sessionId]: records }));
      setRoundLoading(null);
    },
    [roundCache]
  );

  const renderExpandedRow = useCallback(
    (item: UsageItem): React.ReactNode | React.ReactNode[][] => {
      loadRounds(item.id);
      const records = roundCache[item.id];
      const isLoading = roundLoading === item.id;

      if (isLoading || !records) {
        return (
          <div className="flex items-center justify-center py-4">
            <Loader2
              size={SPINNER_TOKENS.default}
              className="animate-spin text-text-2"
            />
          </div>
        );
      }
      if (records.length === 0) {
        return (
          <Placeholder
            variant="empty"
            title={t("market:usageHistory.noRoundData")}
          />
        );
      }

      return records.map((record, roundIdx) => [
        <span key="time" className="whitespace-nowrap tabular-nums text-text-2">
          {dayjs(record.createdAt).format("HH:mm:ss")}
        </span>,
        <span
          key="round"
          className="flex flex-wrap items-center gap-2 whitespace-nowrap text-text-2"
        >
          <span>
            {t("market:usageHistory.roundDetail", { index: roundIdx + 1 })}:
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <LogIn size={12} className="text-text-2" />
            {record.inputTokens.toLocaleString()}
          </span>
          <span className="flex items-center gap-1 tabular-nums">
            <LogOut size={12} className="text-text-2" />
            {record.outputTokens.toLocaleString()}
          </span>
          {record.cacheWriteTokens > 0 && (
            <span className="tabular-nums text-text-2">
              {t("market:usageHistory.cacheWriteTokens", {
                count: record.cacheWriteTokens,
              })}
            </span>
          )}
          {record.cacheReadTokens > 0 && (
            <span className="tabular-nums text-text-2">
              {t("market:usageHistory.cacheReadTokens", {
                count: record.cacheReadTokens,
              })}
            </span>
          )}
        </span>,
        <span key="agent" />,
        <span
          key="model"
          className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
        >
          <ModelIcon modelName={record.model ?? undefined} size="small" />
          <span className="text-text-1">
            {record.model ? formatModelNameFull(record.model) : "—"}
          </span>
        </span>,
        <span key="source" />,
        <span
          key="total"
          className="whitespace-nowrap font-medium tabular-nums text-text-2"
        >
          {record.totalTokens > 0
            ? record.totalTokens >= 1000
              ? `${(record.totalTokens / 1000).toFixed(1)}K`
              : record.totalTokens.toLocaleString()
            : "—"}
        </span>,
      ]);
    },
    [roundCache, roundLoading, loadRounds, t]
  );

  const usageColumns = useMemo<SettingsTableColumn<UsageItem>[]>(
    () => [
      {
        key: "date",
        label: t("market:usageHistory.colDate"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowB.date.valueOf() - rowA.date.valueOf(),
        renderCell: (item) => (
          <span
            className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap tabular-nums`}
          >
            {item.date.format("MMM D")} {item.date.format("HH:mm")}
          </span>
        ),
      },
      {
        key: "name",
        label: t("market:usageHistory.colName"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (item) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} truncate`}
            title={item.name}
          >
            {item.name || "—"}
          </span>
        ),
      },
      {
        key: "provider",
        label: t("market:usageHistory.colAgent"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (item) => (
          <span className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap`}>
            {formatAgentType(item.provider)}
          </span>
        ),
      },
      {
        key: "model",
        label: t("market:usageHistory.colModel"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (item) => (
          <span
            className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
            title={item.model}
          >
            <ModelIcon modelName={item.model} size="small" />
            <span className="text-text-1">
              {formatModelNameFull(item.model)}
            </span>
          </span>
        ),
      },
      {
        key: "source",
        label: t("market:usageHistory.colSource"),
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (item) => (
          <span
            className={`whitespace-nowrap tabular-nums ${
              item.cost > 0
                ? "font-medium text-primary-6"
                : SETTINGS_TABLE_CELL.value
            }`}
          >
            {item.cost > 0
              ? `$${item.cost.toFixed(4)}`
              : item.source === USAGE_SOURCE.POOLING
                ? "$0.00"
                : t("common:filters.myKeys")}
          </span>
        ),
      },
      {
        key: "tokens",
        label: t("market:usageHistory.colTokens"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right",
        sorter: (rowA, rowB) => rowA.tokens - rowB.tokens,
        renderCell: (item) =>
          item.tokens > 0 ? (
            <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
              {item.tokens >= 1_000_000
                ? `${(item.tokens / 1_000_000).toFixed(1)}M`
                : item.tokens >= 1_000
                  ? `${(item.tokens / 1_000).toFixed(0)}K`
                  : item.tokens.toLocaleString()}
            </span>
          ) : (
            <span className={SETTINGS_TABLE_CELL.muted}>—</span>
          ),
      },
    ],
    [t]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        actions={
          !isFilterSidebarVisible ? (
            <DateRangePill
              options={DATE_RANGE_OPTIONS}
              activeKey={filters.dateRange}
              onChange={(tab) =>
                setFilters((prev) => ({ ...prev, dateRange: tab }))
              }
              onCustomDatesChange={(startDate, endDate) =>
                setCustomDates({ startDate, endDate })
              }
              customStartDate={customDates?.startDate}
              customEndDate={customDates?.endDate}
            />
          ) : undefined
        }
      />

      <div className="flex min-h-0 flex-1">
        <ScrollFadeContainer className={DETAIL_PANEL_TOKENS.scrollContent}>
          <div className={DETAIL_PANEL_TOKENS.contentWidthWithPadding}>
            {loading ? (
              <Placeholder variant="loading" placement="detail-panel" />
            ) : (
              <>
                <CollapsibleSection title={t("market:usageHistory.trends")}>
                  <div className="rounded-xl bg-fill-2 p-3">
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart
                        data={chartData}
                        barCategoryGap="8%"
                        margin={{ top: 5, right: 5, left: 0, bottom: 5 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="var(--color-border-1)"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="date"
                          axisLine={false}
                          tickLine={false}
                          tick={CHART_AXIS_TICK}
                        />
                        <YAxis
                          axisLine={false}
                          tickLine={false}
                          tick={CHART_AXIS_TICK}
                          tickFormatter={(value) =>
                            hasCostData ? `$${value}` : `${value}K`
                          }
                          width={40}
                        />
                        <Tooltip
                          content={
                            <ChartTooltip
                              formatValue={(value) =>
                                hasCostData
                                  ? `$${value.toFixed(2)}`
                                  : `${value.toFixed(1)}K tokens`
                              }
                            />
                          }
                        />
                        {chartProviders.map((provider) => (
                          <Bar
                            key={provider}
                            dataKey={provider}
                            stackId="a"
                            fill={getProviderColor(provider)}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>

                    {chartProviders.length > 0 && (
                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                        {chartProviders.map((provider) => (
                          <div
                            key={provider}
                            className="flex items-center gap-1.5"
                          >
                            <div
                              className="h-2.5 w-2.5 rounded"
                              style={{ background: getProviderColor(provider) }}
                            />
                            <span className="text-[10px] text-text-2">
                              {formatAgentType(provider)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CollapsibleSection>

                <CollapsibleSection title={t("market:wallet.usageHistory")}>
                  <SettingsTable<UsageItem>
                    columns={usageColumns}
                    rows={timelineUsage}
                    getRowKey={(item) => item.id}
                    headerHeight="tall"
                    pageSize={50}
                    maxHeight="min(420px, calc(100vh - 280px))"
                    emptyTitle={t("market:usageHistory.noTransactions")}
                    expandable={{ expandedRowRender: renderExpandedRow }}
                  />
                </CollapsibleSection>
              </>
            )}
          </div>
        </ScrollFadeContainer>

        {isFilterSidebarVisible && (
          <UsageHistoryFilterSidebar
            filters={filters}
            onChange={setFilters}
            providers={providers}
            providerStats={providerStats}
            onDateRangeChange={(range) =>
              setFilters((prev) => ({ ...prev, dateRange: range }))
            }
            customStartDate={customDates?.startDate}
            customEndDate={customDates?.endDate}
            onCustomDatesChange={(startDate, endDate) =>
              setCustomDates({ startDate, endDate })
            }
          />
        )}
      </div>
    </div>
  );
};

export default UsageHistory;
