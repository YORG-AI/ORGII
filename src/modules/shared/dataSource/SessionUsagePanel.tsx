import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  USAGE_BUCKETS,
  type UsageBucket,
  type UsageRoundRow,
  type UsageScope,
  type UsageSessionSort,
  type UsageSummary,
  type UsageTrendPoint,
  usageDashboardOverview,
} from "@src/api/tauri/usageDashboard";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { DEBOUNCE_DELAYS, useDebouncedCallback } from "@src/hooks/perf";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import UsageRoundsTable, {
  USAGE_ROUNDS_DEFAULT_PAGE_SIZE,
} from "./UsageRoundsTable";
import UsageStatCards from "./UsageStatCards";
import UsageTrendChart from "./UsageTrendChart";
import { bucketLabelKey } from "./usageBuckets";
import {
  USAGE_RANGE_PRESETS,
  type UsageRangePreset,
  resolveUsageRange,
} from "./usageRange";

const SOURCE_ALL = "all";

interface SelectedSession {
  id: string;
  name: string;
}

/** Chat pane → Runtime → Usage: the usage/cost dashboard (per-round request log). */
export default function SessionUsagePanel() {
  const { t, i18n } = useTranslation("sessions", {
    keyPrefix: "kanban.dataSource",
  });
  const language = i18n.resolvedLanguage || i18n.language || "en";

  const [bucket, setBucket] = useState<UsageBucket | null>(null);
  const [range, setRange] = useState<UsageRangePreset>("today");
  const [sort, setSort] = useState<UsageSessionSort>("recent");
  const [refreshTick, setRefreshTick] = useState(0);
  const [session, setSession] = useState<SelectedSession | null>(null);

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<UsageTrendPoint[]>([]);
  const [rows, setRows] = useState<UsageRoundRow[]>([]);
  const [roundTotal, setRoundTotal] = useState(0);
  const [roundModels, setRoundModels] = useState<string[]>([]);
  const [hasUnknownRoundModel, setHasUnknownRoundModel] = useState(false);
  // undefined = all models; null = unknown model; string = exact model.
  const [roundModelFilter, setRoundModelFilter] = useState<
    string | null | undefined
  >(undefined);
  const [roundSearchQuery, setRoundSearchQuery] = useState("");
  const [appliedRoundSearchQuery, setAppliedRoundSearchQuery] = useState("");
  const [roundPageIndex, setRoundPageIndex] = useState(0);
  const [roundPageSize, setRoundPageSize] = useState(
    USAGE_ROUNDS_DEFAULT_PAGE_SIZE
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scope = useMemo<UsageScope>(() => {
    const { startMs, endMs } = resolveUsageRange(range);
    return { bucket, startMs, endMs, sessionId: session?.id ?? null };
  }, [bucket, range, session]);

  const hourly = range === "today" || range === "24h";
  const trendEndMs = useMemo(() => {
    if (range !== "today" || scope.startMs == null) {
      return scope.endMs ?? null;
    }

    // Keep the full day visible; UsageTrendChart masks buckets after now so
    // the axis continues into the evening without plotting future zeroes.
    const nextDay = new Date(scope.startMs);
    nextDay.setDate(nextDay.getDate() + 1);
    return nextDay.getTime() - 1;
  }, [range, scope.startMs, scope.endMs]);

  // Monotonic request token so a slow response from a stale scope/sort can't
  // overwrite a newer one. setState lives in this callback (not the effect
  // body) to satisfy react-hooks/set-state-in-effect.
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      // Tauri invokes are not abortable, so invalidate their generation. Late
      // completions cannot apply state after this tab unmounts.
      requestRef.current += 1;
    },
    []
  );

  const applyRoundSearch = useDebouncedCallback((query: string) => {
    setAppliedRoundSearchQuery(query);
  }, DEBOUNCE_DELAYS.API);

  const handleRoundSearchChange = useCallback(
    (query: string) => {
      setRoundSearchQuery(query);
      setRoundPageIndex(0);
      applyRoundSearch(query);
    },
    [applyRoundSearch]
  );

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      // One backend call → one round-store scan (summary + trends + log).
      const overview = await usageDashboardOverview(scope, {
        sort,
        offset: roundPageIndex * roundPageSize,
        limit: roundPageSize,
        model:
          typeof roundModelFilter === "string" ? roundModelFilter : undefined,
        unknownModel: roundModelFilter === null,
        search: appliedRoundSearchQuery.trim() || undefined,
      });
      if (requestId !== requestRef.current) return;
      setSummary(overview.summary);
      setTrends(overview.trends);
      setRoundTotal(overview.roundTotal);
      setRoundModels(overview.roundModels);
      setHasUnknownRoundModel(overview.hasUnknownRoundModel);

      const lastPageIndex = Math.max(
        0,
        Math.ceil(overview.roundTotal / roundPageSize) - 1
      );
      if (roundPageIndex > lastPageIndex) {
        setRoundPageIndex(lastPageIndex);
        setRows([]);
      } else {
        setRows(overview.rounds);
      }
    } catch (err) {
      if (requestId === requestRef.current) setError(String(err));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [
    appliedRoundSearchQuery,
    roundModelFilter,
    roundPageIndex,
    roundPageSize,
    scope,
    sort,
  ]);

  useEffect(() => {
    void load();
  }, [load, refreshTick]);

  const handleRefresh = useCallback(() => {
    setRefreshTick((tick) => tick + 1);
  }, []);
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(handleRefresh, loading);

  const sourceTabs = useMemo<TabPillItem[]>(
    () => [
      { key: SOURCE_ALL, label: t("usage.allSources") },
      ...USAGE_BUCKETS.map((source) => ({
        key: source,
        label: t(bucketLabelKey(source)),
      })),
    ],
    [t]
  );

  const rangeOptions = useMemo(
    () =>
      USAGE_RANGE_PRESETS.map((preset) => ({
        value: preset,
        label: t(`usage.range.${preset}`),
      })),
    [t]
  );

  const isEmpty = !loading && !error && (summary?.sessionCount ?? 0) === 0;

  return (
    <div className={SECTION_GAP_CLASSES}>
      <div
        className="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"
        data-testid="usage-source-controls"
      >
        <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
          <TabPill
            activeTab={bucket ?? SOURCE_ALL}
            tabs={sourceTabs}
            onChange={(key) => {
              setBucket(key === SOURCE_ALL ? null : (key as UsageBucket));
              setRoundModelFilter(undefined);
              setRoundPageIndex(0);
            }}
            variant="pill"
            size="mini"
            colorScheme="ghost"
            fillWidth={false}
          />
          <div className="flex items-center gap-2">
            <Select
              value={range}
              onChange={(value) => {
                setRange(value as UsageRangePreset);
                setRoundModelFilter(undefined);
                setRoundPageIndex(0);
              }}
              options={rangeOptions}
              variant="ghost"
              size="mini"
            />
            <Button
              variant="tertiary"
              appearance="ghost"
              size="small"
              icon={<RefreshCw size={14} className={refreshSpinClass} />}
              disabled={loading}
              onClick={handleRefreshClick}
            >
              {t("usage.refresh")}
            </Button>
          </div>
        </div>
      </div>

      {session && (
        <button
          type="button"
          onClick={() => {
            setSession(null);
            setRoundModelFilter(undefined);
            setRoundPageIndex(0);
          }}
          className="flex w-fit items-center gap-1.5 rounded-full border border-border-1 bg-fill-2 px-2.5 py-1 text-[12px] text-text-2 hover:text-text-1"
        >
          <span className="text-text-3">{t("usage.roundsTable.session")}:</span>
          <span className="max-w-[260px] truncate">{session.name}</span>
          <X size={12} />
        </button>
      )}

      {error ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("usage.loadError")}
          subtitle={error}
        />
      ) : isEmpty ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("usage.empty.title")}
          subtitle={t("usage.empty.subtitle")}
        />
      ) : loading && !summary ? (
        <Placeholder variant="loading" placement="detail-panel" />
      ) : summary ? (
        <>
          <div className={SECTION_GAP_CLASSES}>
            <h3 className={SECTION_SUBHEADING_CLASSES}>{t("usage.title")}</h3>
            <UsageStatCards summary={summary} language={language} />
          </div>
          <UsageTrendChart
            points={trends}
            hourly={hourly}
            startMs={scope.startMs ?? null}
            endMs={trendEndMs}
            dataEndMs={scope.endMs ?? null}
            language={language}
          />
          <UsageRoundsTable
            rows={rows}
            total={roundTotal}
            availableModels={roundModels}
            hasUnknownModel={hasUnknownRoundModel}
            modelFilter={roundModelFilter}
            onModelFilterChange={(model) => {
              setRoundModelFilter(model);
              setRoundPageIndex(0);
            }}
            searchQuery={roundSearchQuery}
            onSearchQueryChange={handleRoundSearchChange}
            sort={sort}
            onSortChange={(nextSort) => {
              setSort(nextSort);
              setRoundPageIndex(0);
            }}
            pageIndex={roundPageIndex}
            pageSize={roundPageSize}
            onPageChange={setRoundPageIndex}
            onPageSizeChange={(pageSize) => {
              setRoundPageSize(pageSize);
              setRoundPageIndex(0);
            }}
            loading={loading}
            onSelectSession={(sessionId) => {
              const row = rows.find((item) => item.sessionId === sessionId);
              setSession({
                id: sessionId,
                name: row?.sessionName ?? sessionId,
              });
              setRoundModelFilter(undefined);
              setRoundPageIndex(0);
            }}
          />
        </>
      ) : null}
    </div>
  );
}
