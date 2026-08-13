import { RefreshCw, X } from "lucide-react";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import {
  CollapsibleSection,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";

import UsageRoundsTable, {
  USAGE_ROUNDS_DEFAULT_PAGE_SIZE,
} from "./UsageRoundsTable";
import UsageStatCards from "./UsageStatCards";
import { bucketLabelKey } from "./usageBuckets";
import {
  USAGE_RANGE_PRESETS,
  type UsageRangePreset,
  resolveUsageRange,
} from "./usageRange";

const SOURCE_ALL = "all";
const UsageTrendChart = lazy(() => import("./UsageTrendChart"));

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
  const [trendsOpen, setTrendsOpen] = useState(true);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [loadedTrendQueryKey, setLoadedTrendQueryKey] = useState<string | null>(
    null
  );
  const [loadedRoundQueryKey, setLoadedRoundQueryKey] = useState<string | null>(
    null
  );
  const [headlineLoading, setHeadlineLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(false);
  const [roundLoading, setRoundLoading] = useState(false);
  const [headlineError, setHeadlineError] = useState<string | null>(null);
  const [trendError, setTrendError] = useState<string | null>(null);
  const [roundError, setRoundError] = useState<string | null>(null);

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
  const headlineRequestRef = useRef(0);
  const trendRequestRef = useRef(0);
  const roundRequestRef = useRef(0);
  const trendRequestedQueryKeyRef = useRef<string | null>(null);
  const roundInFlightRef = useRef<{
    queryKey: string;
    request: ReturnType<typeof usageDashboardOverview>;
  } | null>(null);
  useEffect(
    () => () => {
      // Tauri invokes are not abortable, so invalidate their generation. Late
      // completions cannot apply state after this tab unmounts.
      headlineRequestRef.current += 1;
      trendRequestRef.current += 1;
      roundRequestRef.current += 1;
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

  const roundQueryKey = JSON.stringify({
    appliedRoundSearchQuery,
    bucket: scope.bucket ?? null,
    endMs: scope.endMs ?? null,
    modelFilter:
      roundModelFilter === undefined
        ? { kind: "all" }
        : roundModelFilter === null
          ? { kind: "unknown" }
          : { kind: "model", value: roundModelFilter },
    pageIndex: roundPageIndex,
    pageSize: roundPageSize,
    sessionId: scope.sessionId ?? null,
    sort,
    startMs: scope.startMs ?? null,
  });
  const trendQueryKey = JSON.stringify({
    bucket: scope.bucket ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
    startMs: scope.startMs ?? null,
  });
  const trendDataLoaded = loadedTrendQueryKey === trendQueryKey;
  const roundDataLoaded = loadedRoundQueryKey === roundQueryKey;

  const loadHeadline = useCallback(async () => {
    const requestId = ++headlineRequestRef.current;
    const includeTrends = trendsOpen;
    const trendRequestId = includeTrends
      ? ++trendRequestRef.current
      : undefined;
    if (includeTrends) {
      trendRequestedQueryKeyRef.current = trendQueryKey;
      setTrendLoading(true);
      setTrendError(null);
    }
    setHeadlineLoading(true);
    setHeadlineError(null);
    try {
      // The initially-open trend shares the headline's round-store scan.
      // Request-table facets, sorting, pagination, and row transfer remain
      // deferred until the collapsed Requests section is opened.
      const overview = await usageDashboardOverview(scope, {
        includeTrends,
        includeRounds: false,
      });
      if (requestId !== headlineRequestRef.current) return;
      setSummary(overview.summary);
      if (includeTrends && trendRequestId === trendRequestRef.current) {
        setTrends(overview.trends);
        setLoadedTrendQueryKey(trendQueryKey);
      }
    } catch (err) {
      if (requestId === headlineRequestRef.current) {
        setHeadlineError(String(err));
      }
      if (includeTrends && trendRequestId === trendRequestRef.current) {
        setTrendError(String(err));
      }
    } finally {
      if (requestId === headlineRequestRef.current) setHeadlineLoading(false);
      if (includeTrends && trendRequestId === trendRequestRef.current) {
        setTrendLoading(false);
      }
    }
  }, [scope, trendQueryKey, trendsOpen]);

  const loadTrends = useCallback(async () => {
    const requestId = ++trendRequestRef.current;
    const requestedQueryKey = trendQueryKey;
    trendRequestedQueryKeyRef.current = requestedQueryKey;
    setTrendLoading(true);
    setTrendError(null);
    try {
      const overview = await usageDashboardOverview(scope, {
        includeHeadline: false,
        includeTrends: true,
        includeRounds: false,
      });
      if (requestId !== trendRequestRef.current) return;
      setTrends(overview.trends);
      setLoadedTrendQueryKey(requestedQueryKey);
    } catch (err) {
      if (requestId === trendRequestRef.current) setTrendError(String(err));
    } finally {
      if (requestId === trendRequestRef.current) setTrendLoading(false);
    }
  }, [scope, trendQueryKey]);

  const loadRounds = useCallback(async () => {
    const requestId = ++roundRequestRef.current;
    const requestedQueryKey = roundQueryKey;
    setRoundLoading(true);
    setRoundError(null);
    let inFlight = roundInFlightRef.current;
    if (!inFlight || inFlight.queryKey !== requestedQueryKey) {
      inFlight = {
        queryKey: requestedQueryKey,
        request: usageDashboardOverview(scope, {
          sort,
          offset: roundPageIndex * roundPageSize,
          limit: roundPageSize,
          model:
            typeof roundModelFilter === "string" ? roundModelFilter : undefined,
          unknownModel: roundModelFilter === null,
          search: appliedRoundSearchQuery.trim() || undefined,
          includeHeadline: false,
          includeTrends: false,
          includeRounds: true,
        }),
      };
      roundInFlightRef.current = inFlight;
    }
    try {
      const overview = await inFlight.request;
      if (requestId !== roundRequestRef.current) return;
      setRoundTotal(overview.roundTotal);
      setRoundModels(overview.roundModels);
      setHasUnknownRoundModel(overview.hasUnknownRoundModel);
      setLoadedRoundQueryKey(requestedQueryKey);

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
      if (requestId === roundRequestRef.current) setRoundError(String(err));
    } finally {
      if (roundInFlightRef.current === inFlight) {
        roundInFlightRef.current = null;
      }
      if (requestId === roundRequestRef.current) setRoundLoading(false);
    }
  }, [
    appliedRoundSearchQuery,
    roundModelFilter,
    roundPageIndex,
    roundPageSize,
    scope,
    sort,
    roundQueryKey,
  ]);

  useEffect(() => {
    void loadHeadline();
  }, [loadHeadline]);

  useEffect(() => {
    if (
      trendsOpen &&
      !trendDataLoaded &&
      trendRequestedQueryKeyRef.current !== trendQueryKey
    ) {
      void loadTrends();
    }
  }, [loadTrends, trendDataLoaded, trendQueryKey, trendsOpen]);

  useEffect(() => {
    if (roundsOpen && !roundDataLoaded) void loadRounds();
  }, [loadRounds, roundDataLoaded, roundsOpen]);

  const handleTrendsOpenChange = useCallback((open: boolean) => {
    setTrendsOpen(open);
    if (open) return;

    trendRequestRef.current += 1;
    trendRequestedQueryKeyRef.current = null;
    setTrends([]);
    setLoadedTrendQueryKey(null);
    setTrendLoading(false);
    setTrendError(null);
  }, []);

  const handleRoundsOpenChange = useCallback((open: boolean) => {
    setRoundsOpen(open);
    if (open) return;

    // A collapsed request log retains no rows/facets and ignores any late IPC
    // completion. Reopening performs one fresh, bounded page load.
    roundRequestRef.current += 1;
    setRows([]);
    setRoundTotal(0);
    setRoundModels([]);
    setHasUnknownRoundModel(false);
    setLoadedRoundQueryKey(null);
    setRoundLoading(false);
    setRoundError(null);
  }, []);

  const handleRoundsRefresh = useCallback(
    () => void loadRounds(),
    [loadRounds]
  );

  const handleUsageRefresh = useCallback(() => {
    void loadHeadline();
    if (roundsOpen) void loadRounds();
  }, [loadHeadline, loadRounds, roundsOpen]);
  const usageRefreshing =
    headlineLoading ||
    (trendsOpen && trendLoading) ||
    (roundsOpen && roundLoading);
  const { spinClass, handleClick: handleUsageRefreshClick } = useRefreshSpin(
    handleUsageRefresh,
    usageRefreshing
  );

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

  const isEmpty =
    !headlineLoading && !headlineError && (summary?.sessionCount ?? 0) === 0;

  return (
    <div className={SECTION_GAP_CLASSES}>
      <div
        className="sticky top-0 z-20 -mx-4 bg-chat-pane px-4 pb-1"
        data-testid="usage-source-controls"
      >
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          <div
            className="flex min-w-0 items-center gap-2"
            data-testid="usage-source-range-controls"
          >
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
              appearance="ghost"
              fillWidth={false}
            />
            <span
              aria-hidden
              className="pointer-events-none h-4 w-px shrink-0 bg-border-2"
            />
            <Select
              value={range}
              onChange={(value) => {
                setRange(value as UsageRangePreset);
                setRoundModelFilter(undefined);
                setRoundPageIndex(0);
              }}
              options={rangeOptions}
              appearance="ghost"
              size="small"
            />
          </div>
        </div>
      </div>

      <div
        className="flex min-h-9 items-center justify-between gap-3"
        data-testid="usage-title-controls"
      >
        <h3 className={SECTION_SUBHEADING_CLASSES}>{t("usage.title")}</h3>
        <Button
          htmlType="button"
          variant="tertiary"
          appearance="ghost"
          size="small"
          disabled={usageRefreshing}
          aria-label={t("usage.refresh")}
          title={t("usage.refresh")}
          onClick={handleUsageRefreshClick}
          icon={<RefreshCw size={14} className={spinClass} />}
          data-testid="usage-refresh"
        >
          {t("usage.refresh")}
        </Button>
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

      {headlineError ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("usage.loadError")}
          subtitle={headlineError}
        />
      ) : isEmpty ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("usage.empty.title")}
          subtitle={t("usage.empty.subtitle")}
        />
      ) : headlineLoading && !summary ? (
        <Placeholder variant="loading" placement="detail-panel" />
      ) : summary ? (
        <>
          <UsageStatCards summary={summary} language={language} />
          <CollapsibleSection
            title={t("usage.trends.title")}
            defaultOpen
            compact
            onOpenChange={handleTrendsOpenChange}
            titleButtonTestId="usage-trends-toggle"
            titleClassName={SECTION_SUBHEADING_CLASSES}
          >
            {trendError ? (
              <Placeholder
                variant="error"
                placement="detail-panel"
                title={t("usage.loadError")}
                subtitle={trendError}
                onRetry={loadTrends}
              />
            ) : trendLoading || !trendDataLoaded ? (
              <Placeholder variant="loading" placement="detail-panel" />
            ) : (
              <Suspense
                fallback={
                  <Placeholder variant="loading" placement="detail-panel" />
                }
              >
                <UsageTrendChart
                  points={trends}
                  hourly={hourly}
                  startMs={scope.startMs ?? null}
                  endMs={trendEndMs}
                  dataEndMs={scope.endMs ?? null}
                  language={language}
                />
              </Suspense>
            )}
          </CollapsibleSection>
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
            loaded={roundDataLoaded}
            error={roundError}
            onOpenChange={handleRoundsOpenChange}
            onRefresh={handleRoundsRefresh}
            loading={roundLoading}
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
