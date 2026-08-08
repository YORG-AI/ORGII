import { invoke } from "@tauri-apps/api/core";

/**
 * Usage dashboard API — read-only rollups of the local session DB served by the
 * `usage_dashboard_*` Tauri commands (see
 * `src-tauri/src/orgtrack/usage_dashboard_commands.rs`). The Rust side already
 * emits camelCase, so the invoke result IS the typed shape — no wire mapping.
 *
 * Per-call drill-in is NOT here: it reuses `getSessionLlmUsageSpans` /
 * `getSessionToolUsageAttributions` from `@src/api/tauri/session/usage`.
 */

/** Source buckets the dashboard scopes to. */
export type UsageBucket = "claude" | "codex" | "cursor" | "org2";

export const USAGE_BUCKETS: readonly UsageBucket[] = [
  "claude",
  "codex",
  "cursor",
  "org2",
];

/** Per-session sort key for the table. */
export type UsageSessionSort = "recent" | "cost" | "tokens";

export interface UsageBucketSummary {
  bucket: string;
  sessionCount: number;
  realTotalTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  sessionCount: number;
  /** Native turns + one per imported session. */
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cache_read + cache_write. */
  realTotalTokens: number;
  totalTokens: number;
  costUsd: number;
  estimatedCostUsd: number;
  recordedCostUsd: number;
  /** cache_read / (input + cache_write + cache_read), range 0–1. */
  cacheHitRate: number;
  byBucket: UsageBucketSummary[];
}

export interface UsageTrendPoint {
  /** Start of the time bucket, epoch ms. */
  bucketMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** A bounded headline + trend snapshot captured at one instant. */
export interface RecentUsageSnapshot {
  startMs: number;
  endMs: number;
  summary: UsageSummary;
  trends: UsageTrendPoint[];
}

export interface UsageSessionRow {
  sessionId: string;
  name: string;
  bucket: string;
  source: string;
  model: string | null;
  tokensSource: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  realTotalTokens: number;
  costUsd: number;
  estimatedCostUsd: number;
  recordedCostUsd: number;
  cacheHitRate: number;
  /** Native per-turn count; 0 for imported sessions. */
  turnCount: number;
  /** Last activity, epoch ms (0 = unknown). */
  lastActiveMs: number;
}

/** One per-round request-log row. `inputTokens` is FRESH (cache excluded). */
export interface UsageRoundRow {
  roundId: string;
  sessionId: string;
  sessionName: string;
  bucket: string;
  source: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  realTotalTokens: number;
  costUsd: number;
  createdAtMs: number;
}

/** Per-Mtok list rates for a model (for the lazy cost-breakdown tooltip). */
export interface ModelPricing {
  model: string | null;
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheWritePerMtok: number;
}

const MODEL_PRICING_CACHE_CAPACITY = 100;
const modelPricingCache = new Map<string, Promise<ModelPricing>>();

/**
 * Resolve list-price rates for a model, lazily and cached per model — a cost
 * tooltip only calls this when it opens, and repeated hovers of the same model
 * reuse the in-flight/settled promise.
 */
export async function usageDashboardModelPricing(
  model: string | null
): Promise<ModelPricing> {
  const key = model ?? "";
  let pending = modelPricingCache.get(key);
  if (pending) {
    // Refresh insertion order so the capacity bound behaves as a tiny LRU.
    modelPricingCache.delete(key);
    modelPricingCache.set(key, pending);
    return pending;
  }

  pending = invoke<ModelPricing>("usage_dashboard_model_pricing", {
    model: model ?? null,
  });
  modelPricingCache.set(key, pending);
  if (modelPricingCache.size > MODEL_PRICING_CACHE_CAPACITY) {
    const oldestKey = modelPricingCache.keys().next().value;
    if (oldestKey !== undefined) modelPricingCache.delete(oldestKey);
  }
  pending.catch(() => {
    // Transient failures must not become permanent cached failures.
    if (modelPricingCache.get(key) === pending) modelPricingCache.delete(key);
  });
  return pending;
}

const USAGE_OVERVIEW_IN_FLIGHT_CAPACITY = 8;
const USAGE_SCOPE_TIME_KEY_MS = 5_000;
const usageOverviewInFlight = new Map<string, Promise<UsageOverview>>();

function overviewInFlightKey(args: Record<string, unknown>): string {
  return JSON.stringify({
    ...args,
    // Adjacent remounts resolve "today"/"24h" a few milliseconds apart. The
    // key alone is bucketed so those callers join the same active native scan;
    // the first caller's exact boundary is still sent to SQLite.
    endMs:
      typeof args.endMs === "number"
        ? Math.floor(args.endMs / USAGE_SCOPE_TIME_KEY_MS)
        : args.endMs,
  });
}

function invokeUsageOverview(
  args: Record<string, unknown>
): Promise<UsageOverview> {
  const key = overviewInFlightKey(args);
  const existing = usageOverviewInFlight.get(key);
  if (existing) return existing;

  const pending = invoke<UsageOverview>("usage_dashboard_overview", args);
  usageOverviewInFlight.set(key, pending);
  if (usageOverviewInFlight.size > USAGE_OVERVIEW_IN_FLIGHT_CAPACITY) {
    const oldestKey = usageOverviewInFlight.keys().next().value;
    if (oldestKey !== undefined) usageOverviewInFlight.delete(oldestKey);
  }
  const cleanup = () => {
    if (usageOverviewInFlight.get(key) === pending) {
      usageOverviewInFlight.delete(key);
    }
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

/** Summary + trends + request-log page from one backend call. */
export interface UsageOverview {
  summary: UsageSummary;
  trends: UsageTrendPoint[];
  rounds: UsageRoundRow[];
  /** Total request-log rows after table-only model/search filtering. */
  roundTotal: number;
  /** Known models in the dashboard scope, before table-only filtering. */
  roundModels: string[];
  hasUnknownRoundModel: boolean;
}

/** Common scope shared by every dashboard query. `bucket: null` = all four. */
export interface UsageScope {
  bucket?: UsageBucket | null;
  startMs?: number | null;
  endMs?: number | null;
  /** Restrict to a single session (request-log session filter). */
  sessionId?: string | null;
}

export async function usageDashboardSummary(
  scope: UsageScope = {}
): Promise<UsageSummary> {
  return invoke("usage_dashboard_summary", {
    bucket: scope.bucket ?? null,
    startMs: scope.startMs ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
  });
}

export async function usageDashboardTrends(
  scope: UsageScope = {},
  bucketUnit?: "hour" | "day"
): Promise<UsageTrendPoint[]> {
  return invoke("usage_dashboard_trends", {
    bucket: scope.bucket ?? null,
    startMs: scope.startMs ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
    bucketUnit: bucketUnit ?? null,
  });
}

export async function usageDashboardOverview(
  scope: UsageScope = {},
  options?: {
    sort?: UsageSessionSort;
    offset?: number;
    limit?: number;
    model?: string;
    unknownModel?: boolean;
    search?: string;
    /** Include headline summary aggregation. Default: true. */
    includeHeadline?: boolean;
    /** Include time-bucket trend aggregation. Default: true. */
    includeTrends?: boolean;
    /** Include request-table facets and the requested page. Default: true. */
    includeRounds?: boolean;
  }
): Promise<UsageOverview> {
  return invokeUsageOverview({
    bucket: scope.bucket ?? null,
    startMs: scope.startMs ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
    sort: options?.sort ?? "recent",
    offset: options?.offset ?? 0,
    limit: options?.limit ?? null,
    model: options?.model ?? null,
    unknownModel: options?.unknownModel ?? false,
    search: options?.search ?? null,
    bucketUnit: null,
    includeHeadline: options?.includeHeadline ?? true,
    includeTrends: options?.includeTrends ?? true,
    includeRounds: options?.includeRounds ?? true,
  });
}

export async function usageDashboardRounds(
  scope: UsageScope = {},
  options?: { sort?: UsageSessionSort; offset?: number; limit?: number }
): Promise<UsageRoundRow[]> {
  return invoke("usage_dashboard_rounds", {
    bucket: scope.bucket ?? null,
    startMs: scope.startMs ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
    sort: options?.sort ?? "recent",
    offset: options?.offset ?? 0,
    limit: options?.limit ?? null,
  });
}

/**
 * One (UTC-day-floor, bucket) aggregation row from
 * `usage_dashboard_daily_rollup`. Unlike the dashboard queries above this is
 * an `all_sources` rollup, so `bucket` may also be `"other"` (sources the
 * desktop view hides). `dayStartMs` is the UTC midnight of the day.
 */
export interface DailyRollupRow {
  dayStartMs: number;
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Distinct sessions observed in this (day, bucket). */
  sessions: number;
  /** Request-log round count in this (day, bucket). */
  requests: number;
}

export interface DailyRollupResult {
  days: DailyRollupRow[];
  /** Lifetime mirror-deduped session count — independent of the window. */
  totalSessions: number;
  /** Rolling 24h usage derived during the same local round scan. */
  recentUsage24h: RecentUsageSnapshot;
}

/**
 * Per-UTC-day, per-bucket rollup over `[startMs, endMs]` for the
 * member-runtime push (registered behind the same 1-permit semaphore as the
 * other dashboard scans, so a plain wrapper is enough — concurrent callers
 * queue in the backend). Also carries the lifetime session census and a
 * rolling-24h snapshot the push shares through its bounded status blob.
 */
export async function usageDashboardDailyRollup(
  startMs: number,
  endMs: number
): Promise<DailyRollupResult> {
  return invoke<DailyRollupResult>("usage_dashboard_daily_rollup", {
    startMs,
    endMs,
  });
}

export async function usageDashboardSessions(
  scope: UsageScope = {},
  options?: { sort?: UsageSessionSort; offset?: number; limit?: number }
): Promise<UsageSessionRow[]> {
  return invoke("usage_dashboard_sessions", {
    bucket: scope.bucket ?? null,
    startMs: scope.startMs ?? null,
    endMs: scope.endMs ?? null,
    sessionId: scope.sessionId ?? null,
    sort: options?.sort ?? "recent",
    offset: options?.offset ?? 0,
    limit: options?.limit ?? null,
  });
}
