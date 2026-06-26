import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { CursorSession } from "@src/api/tauri/orgtrackHistory/types";
import {
  CHART_AXIS_TICK,
  CHART_MARGIN,
  CHART_TOOLTIP,
  ChartAxisTick,
  ChartTooltip,
} from "@src/components/Chart";
import ModelIcon from "@src/components/ModelIcon";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import type { TabPillItem } from "@src/components/TabPill";
import TabPill from "@src/components/TabPill";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  Placeholder,
  STAT_GRID_TOKENS,
} from "@src/modules/shared/layouts/blocks";

import StatCard from "../../components/StatCard";
import { STAT_CARD_CONFIG } from "../../statCardConfig";
import { IDE_COLORS, formatModelNameFull } from "../CodingProfileView/config";
import type { ModelStats } from "./config";

// ============================================
// Model pie tooltip
// ============================================

const ModelPieTooltip: React.FC<{
  active?: boolean;
  payload?: { name: string; value: number; fill?: string }[];
  modelChartData: { model: string; tokens: number }[];
}> = ({ active, payload, modelChartData }) => {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  if (!entry?.value) return null;
  const index = modelChartData.findIndex((row) => row.model === entry.name);
  const color =
    index >= 0
      ? IDE_COLORS[index % IDE_COLORS.length]
      : (entry.fill ?? "var(--color-text-2)");
  return (
    <div
      style={{
        ...CHART_TOOLTIP.content,
        display: "flex",
        alignItems: "center",
      }}
    >
      <div
        className="flex items-center gap-1.5"
        style={{ fontSize: 11, lineHeight: "20px" }}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span style={{ color: "var(--color-text-2)" }}>{entry.name}</span>
        <span
          className="shrink-0 tabular-nums"
          style={{ color: "var(--color-text-1)" }}
        >
          {entry.value.toLocaleString()}
        </span>
      </div>
    </div>
  );
};

// ============================================
// Pie legend
// ============================================

const PieLegend: React.FC<{
  modelChartData: { model: string; tokens: number }[];
  modelNameMap: Map<string, string>;
}> = memo(({ modelChartData, modelNameMap }) => (
  <div className="flex flex-col gap-2">
    {modelChartData.map((entry, index) => (
      <div key={entry.model} className="flex items-center gap-2">
        <div
          className="h-2.5 w-2.5 shrink-0 rounded"
          style={{
            background: IDE_COLORS[index % IDE_COLORS.length],
          }}
        />
        <ModelIcon
          modelName={modelNameMap.get(entry.model) ?? entry.model}
          size="small"
        />
        <span className="text-[12px] text-text-2">{entry.model}</span>
        <span className="text-[11px] tabular-nums text-text-2">
          {entry.tokens.toLocaleString()}
        </span>
      </div>
    ))}
  </div>
));

PieLegend.displayName = "PieLegend";

// ============================================
// Overview tab
// ============================================

interface OverviewTabProps {
  sessions: CursorSession[];
  modelStats: ModelStats[];
  modelChartData: { model: string; tokens: number }[];
  modelNameMap: Map<string, string>;
  modelBreakdownView: "bar" | "pie";
  onModelBreakdownViewChange: (view: "bar" | "pie") => void;
  loading: boolean;
}

const OverviewTab: React.FC<OverviewTabProps> = ({
  sessions,
  modelStats,
  modelChartData,
  modelNameMap,
  modelBreakdownView,
  onModelBreakdownViewChange,
  loading,
}) => {
  const { t } = useTranslation();

  const renderModelIcon = useCallback(
    (value: string | number) => {
      const rawName = modelNameMap.get(String(value)) ?? String(value);
      return <ModelIcon modelName={rawName} size="small" />;
    },
    [modelNameMap]
  );

  const modelTableColumns = useMemo<SettingsTableColumn<ModelStats>[]>(
    () => [
      {
        key: "model",
        label: t("devActivity.cursorTopModel"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.statusRow} whitespace-nowrap`}
          >
            <ModelIcon modelName={row.model} size="small" />
            <span className={SETTINGS_TABLE_CELL.primary}>
              {formatModelNameFull(row.model)}
            </span>
          </span>
        ),
      },
      {
        key: "sessions",
        label: t("otherUsage.sessions"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (rowA, rowB) => rowA.sessionCount - rowB.sessionCount,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
            {row.sessionCount}
          </span>
        ),
      },
      {
        key: "tokens",
        label: t("devActivity.tokensUsed"),
        width: "160px",
        sorter: (rowA, rowB) => rowA.tokensUsed - rowB.tokensUsed,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
            {row.tokensUsed.toLocaleString()}
          </span>
        ),
      },
    ],
    [t]
  );

  const totalTokensUsed = useMemo(
    () => sessions.reduce((sum, session) => sum + session.tokensUsed, 0),
    [sessions]
  );

  const modelBreakdownViewOptions = useMemo<TabPillItem[]>(
    () => [
      { key: "bar", label: t("otherUsage.viewBar") },
      { key: "pie", label: t("otherUsage.viewPie") },
    ],
    [t]
  );

  if (loading) {
    return <Placeholder variant="loading" placement="detail-panel" />;
  }

  return (
    <>
      <div
        className={`${DETAIL_PANEL_TOKENS.sectionGap} ${STAT_GRID_TOKENS.cols3}`}
      >
        <StatCard
          icon={STAT_CARD_CONFIG.sessions.icon}
          label={t(STAT_CARD_CONFIG.sessions.labelKey)}
        >
          {sessions.length > 0
            ? sessions.length.toLocaleString()
            : t("common:status.unknown")}
        </StatCard>
        <StatCard
          icon={STAT_CARD_CONFIG.tokensUsed.icon}
          label={t("devActivity.tokensUsed")}
        >
          {sessions.length > 0
            ? totalTokensUsed.toLocaleString()
            : t("common:status.unknown")}
        </StatCard>
        <StatCard
          icon={STAT_CARD_CONFIG.modelsUsed.icon}
          label={t(STAT_CARD_CONFIG.modelsUsed.labelKey)}
        >
          {sessions.length > 0 ? modelStats.length : t("common:status.unknown")}
        </StatCard>
      </div>

      <CollapsibleSection
        title={t("otherUsage.modelBreakdown")}
        actions={
          <TabPill
            tabs={modelBreakdownViewOptions}
            activeTab={modelBreakdownView}
            onChange={(tab) => onModelBreakdownViewChange(tab as "bar" | "pie")}
            variant="pill"
            fillWidth={false}
            size="small"
          />
        }
      >
        <div className="rounded-lg bg-fill-2 p-4">
          {modelChartData.length > 0 ? (
            modelBreakdownView === "bar" ? (
              <ResponsiveContainer
                width="100%"
                height={Math.max(modelChartData.length * 44, 120)}
              >
                <BarChart
                  data={modelChartData}
                  layout="vertical"
                  margin={CHART_MARGIN}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border-1)"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    axisLine={false}
                    tickLine={false}
                    tick={CHART_AXIS_TICK}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="model"
                    axisLine={false}
                    tickLine={false}
                    tick={
                      <ChartAxisTick
                        axis="y"
                        allBold
                        iconRenderer={renderModelIcon}
                      />
                    }
                    width={220}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={false} />
                  <Bar
                    dataKey="tokens"
                    name={t("devActivity.tokensUsed")}
                    fill="var(--color-primary-6)"
                    isAnimationActive={false}
                    radius={[0, 4, 4, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center gap-6">
                <ResponsiveContainer width={180} height={180}>
                  <PieChart>
                    <Pie
                      data={modelChartData}
                      dataKey="tokens"
                      nameKey="model"
                      cx="50%"
                      cy="50%"
                      outerRadius={70}
                      innerRadius={45}
                      isAnimationActive={false}
                    >
                      {modelChartData.map((_entry, index) => (
                        <Cell
                          key={index}
                          fill={IDE_COLORS[index % IDE_COLORS.length]}
                        />
                      ))}
                    </Pie>
                    <Tooltip
                      content={
                        <ModelPieTooltip modelChartData={modelChartData} />
                      }
                    />
                  </PieChart>
                </ResponsiveContainer>
                <PieLegend
                  modelChartData={modelChartData}
                  modelNameMap={modelNameMap}
                />
              </div>
            )
          ) : (
            <Placeholder variant="empty" title={t("otherUsage.noData")} />
          )}
        </div>
      </CollapsibleSection>

      <CollapsibleSection title={t("devActivity.tokensUsed")}>
        {modelStats.length > 0 ? (
          <SettingsTable<ModelStats>
            columns={modelTableColumns}
            rows={modelStats}
            getRowKey={(row) => formatModelNameFull(row.model)}
            headerHeight="tall"
            pageSize={50}
            maxHeight="min(420px, calc(100vh - 280px))"
          />
        ) : (
          <div className="rounded-lg bg-fill-2 py-6">
            <Placeholder variant="empty" title={t("otherUsage.noData")} />
          </div>
        )}
      </CollapsibleSection>
    </>
  );
};

export default memo(OverviewTab);
