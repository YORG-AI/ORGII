import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { UsageTrendPoint } from "@src/api/tauri/usageDashboard";
import {
  CHART_AXIS_TICK,
  CHART_GRID_STROKE,
  CHART_MARGIN,
  CHART_TOOLTIP,
} from "@src/components/Chart";
import { SECTION_SUBHEADING_CLASSES } from "@src/modules/shared/layouts/SectionLayout";

import { formatCompactHour, formatTokensShort, formatUsd } from "./usageFormat";
import { fillHourlyUsageTrend } from "./usageTrendData";

/** Series colors, drawn from the semantic token palette (theme-aware). */
const SERIES = {
  input: "var(--color-primary-6)",
  output: "var(--color-success-6)",
  cacheCreate: "var(--color-warning-6)",
  cacheRead: "var(--color-primary-4)",
  cost: "var(--color-danger-5)",
} as const;

interface UsageTrendChartProps {
  points: UsageTrendPoint[];
  /** Hourly x-axis labels (else daily). */
  hourly: boolean;
  /** Inclusive bounds used to render missing hourly buckets. */
  startMs: number | null;
  endMs: number | null;
  /** Last instant that may contain data; later buckets remain visually empty. */
  dataEndMs: number | null;
  language: string;
}

interface ChartDatum {
  label: string;
  input: number | null;
  output: number | null;
  cacheCreate: number | null;
  cacheRead: number | null;
  cost: number | null;
}

function formatBucketLabel(
  ms: number,
  hourly: boolean,
  locale: string
): string {
  const date = new Date(ms);
  return hourly
    ? formatCompactHour(date)
    : date.toLocaleDateString(locale, { month: "2-digit", day: "2-digit" });
}

export default function UsageTrendChart({
  points,
  hourly,
  startMs,
  endMs,
  dataEndMs,
  language,
}: UsageTrendChartProps) {
  const { t } = useTranslation("sessions", { keyPrefix: "kanban.dataSource" });

  const data = useMemo<ChartDatum[]>(() => {
    const chartPoints =
      hourly && startMs !== null && endMs !== null
        ? fillHourlyUsageTrend(points, startMs, endMs)
        : points;

    return chartPoints.map((point) => {
      const future = hourly && dataEndMs !== null && point.bucketMs > dataEndMs;
      const value = (amount: number) => (future ? null : amount);

      return {
        label: formatBucketLabel(point.bucketMs, hourly, language),
        input: value(point.inputTokens),
        output: value(point.outputTokens),
        cacheCreate: value(point.cacheWriteTokens),
        cacheRead: value(point.cacheReadTokens),
        cost: value(point.costUsd),
      };
    });
  }, [points, hourly, startMs, endMs, dataEndMs, language]);

  return (
    <>
      <h3 className={SECTION_SUBHEADING_CLASSES}>{t("usage.trends.title")}</h3>
      <div className="rounded-xl border border-border-1 bg-primary-container p-4">
        <div className="h-[300px] w-full [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none [&_svg:focus]:outline-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={CHART_MARGIN}>
              <defs>
                {(["input", "output", "cacheCreate", "cacheRead"] as const).map(
                  (key) => (
                    <linearGradient
                      key={key}
                      id={`usageTrend-${key}`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor={SERIES[key]}
                        stopOpacity={0.25}
                      />
                      <stop
                        offset="95%"
                        stopColor={SERIES[key]}
                        stopOpacity={0}
                      />
                    </linearGradient>
                  )
                )}
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke={CHART_GRID_STROKE}
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={CHART_AXIS_TICK}
                interval={hourly ? 3 : "preserveEnd"}
                dy={8}
              />
              <YAxis
                yAxisId="tokens"
                axisLine={false}
                tickLine={false}
                tick={CHART_AXIS_TICK}
                tickFormatter={(value) => formatTokensShort(value)}
                width={48}
              />
              <YAxis
                yAxisId="cost"
                orientation="right"
                axisLine={false}
                tickLine={false}
                tick={CHART_AXIS_TICK}
                tickFormatter={(value) => `$${value}`}
                width={44}
              />
              <Tooltip
                contentStyle={CHART_TOOLTIP.content}
                labelStyle={CHART_TOOLTIP.label}
                itemStyle={CHART_TOOLTIP.item}
                formatter={(value, _name, item) =>
                  item?.dataKey === "cost"
                    ? formatUsd(Number(value), 4)
                    : formatTokensShort(Number(value))
                }
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="input"
                name={t("usage.trends.input")}
                stroke={SERIES.input}
                fill="url(#usageTrend-input)"
                strokeWidth={2}
              />
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="output"
                name={t("usage.trends.output")}
                stroke={SERIES.output}
                fill="url(#usageTrend-output)"
                strokeWidth={2}
              />
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="cacheCreate"
                name={t("usage.trends.cacheCreate")}
                stroke={SERIES.cacheCreate}
                fill="url(#usageTrend-cacheCreate)"
                strokeWidth={2}
              />
              <Area
                yAxisId="tokens"
                type="monotone"
                dataKey="cacheRead"
                name={t("usage.trends.cacheRead")}
                stroke={SERIES.cacheRead}
                fill="url(#usageTrend-cacheRead)"
                strokeWidth={2}
              />
              <Area
                yAxisId="cost"
                type="monotone"
                dataKey="cost"
                name={t("usage.trends.cost")}
                stroke={SERIES.cost}
                fill="none"
                strokeWidth={2}
                strokeDasharray="4 4"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
