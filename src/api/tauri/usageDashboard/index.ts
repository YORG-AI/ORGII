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
  if (!pending) {
    pending = invoke<ModelPricing>("usage_dashboard_model_pricing", {
      model: model ?? null,
    });
    modelPricingCache.set(key, pending);
  }
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
  }
): Promise<UsageOverview> {
  return invoke("usage_dashboard_overview", {
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
