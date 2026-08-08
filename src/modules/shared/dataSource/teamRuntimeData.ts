/**
 * Pure helpers for the Runtime → Team section (member-runtime sharing).
 *
 * Everything here is client-side folding of the frozen wire shapes in
 * `features/Org2Cloud/memberRuntime/types.ts` into the props the existing
 * usage components already accept (`UsageTrendPoint`, `UsageSummary`), plus
 * the org-record accessors the Team panel and the org-settings row share.
 *
 * All `day` values are UTC dates (`YYYY-MM-DD`); folding happens by day-string
 * match, never through a local-timezone `Date`, so a member in UTC+13 and one
 * in UTC-8 bucket a row into the same "today".
 */
import type {
  UsageSummary,
  UsageTrendPoint,
} from "@src/api/tauri/usageDashboard";
import type {
  MemberInstalledAgent,
  MemberRuntimeListEntry,
  MemberUsageDay,
  OrgRuntimeTelemetry,
  TeamUsageBucket,
  UtcDay,
} from "@src/features/Org2Cloud/memberRuntime/types";
import {
  RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES,
  RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
  RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES,
  TEAM_USAGE_BUCKETS,
  utcDayFromMs,
} from "@src/features/Org2Cloud/memberRuntime/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Org record accessor (safe against the pre-plumbing orgs atom)
// ---------------------------------------------------------------------------

/**
 * Read `runtimeTelemetry` off a cloud-org record without depending on the
 * field existing in `Org2CloudOrg` yet — the orgs-atom addition lands with the
 * plumbing change. Shape-validates so a partial/legacy payload degrades to
 * `null` (= feature disabled, the server default) instead of a crash.
 */
export function readOrgRuntimeTelemetry(
  org: unknown
): OrgRuntimeTelemetry | null {
  if (!org || typeof org !== "object") return null;
  const raw = (
    org as {
      runtimeTelemetry?: {
        enabled?: unknown;
        intervalMinutes?: unknown;
      } | null;
    }
  ).runtimeTelemetry;
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.enabled !== "boolean") return null;
  if (typeof raw.intervalMinutes !== "number") return null;
  return { enabled: raw.enabled, intervalMinutes: raw.intervalMinutes };
}

// ---------------------------------------------------------------------------
// Interval clamp + settings-row select values
// ---------------------------------------------------------------------------

/** The presets the org-settings Select offers (minutes). */
export const RUNTIME_TELEMETRY_INTERVAL_OPTIONS: readonly number[] = [
  15, 30, 60, 180, 360, 1440,
];

export const RUNTIME_TELEMETRY_OFF_VALUE = "off";

/** Mirror of the server-authoritative `[15, 1440]` clamp. */
export function clampTelemetryInterval(minutes: number): number {
  if (!Number.isFinite(minutes))
    return RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES;
  return Math.min(
    RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
    Math.max(RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES, Math.round(minutes))
  );
}

/**
 * Select value for the current org telemetry: `"off"` when unset/disabled,
 * otherwise the clamped interval snapped to the nearest preset (a value the
 * server accepted but the Select does not offer — e.g. one written by another
 * client — still displays as a real option instead of a blank control).
 */
export function telemetrySelectValue(
  telemetry: OrgRuntimeTelemetry | null | undefined
): string {
  if (!telemetry?.enabled) return RUNTIME_TELEMETRY_OFF_VALUE;
  const clamped = clampTelemetryInterval(telemetry.intervalMinutes);
  let nearest = RUNTIME_TELEMETRY_INTERVAL_OPTIONS[0];
  for (const option of RUNTIME_TELEMETRY_INTERVAL_OPTIONS) {
    if (Math.abs(option - clamped) < Math.abs(nearest - clamped)) {
      nearest = option;
    }
  }
  return String(nearest);
}

/** Parse a settings-row Select value back into RPC arguments. */
export function parseTelemetryOption(value: string): {
  enabled: boolean;
  intervalMinutes: number | null;
} {
  if (value === RUNTIME_TELEMETRY_OFF_VALUE) {
    return { enabled: false, intervalMinutes: null };
  }
  const minutes = Number.parseInt(value, 10);
  return {
    enabled: true,
    intervalMinutes: Number.isFinite(minutes)
      ? clampTelemetryInterval(minutes)
      : RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/** Freshness threshold: a report older than 2× the org interval is stale. */
export function staleAfterMs(telemetry: OrgRuntimeTelemetry | null): number {
  const interval = clampTelemetryInterval(
    telemetry?.intervalMinutes ?? RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES
  );
  return 2 * interval * 60_000;
}

/** Whether a member's last status report is stale (never-reported counts). */
export function isRuntimeStale(
  reportedAt: string | null,
  telemetry: OrgRuntimeTelemetry | null,
  nowMs: number
): boolean {
  if (!reportedAt) return true;
  const reportedMs = Date.parse(reportedAt);
  if (!Number.isFinite(reportedMs)) return true;
  return nowMs - reportedMs > staleAfterMs(telemetry);
}

// ---------------------------------------------------------------------------
// recentDays → today / 7d headline
// ---------------------------------------------------------------------------

export interface RecentUsageHeadline {
  todayTokens: number;
  todayCostUsd: number;
  weekTokens: number;
  weekCostUsd: number;
}

/**
 * Fold a member's inline `recentDays` window into "today" and "7d" totals.
 * Days match by UTC day-string; the 7d window is today plus the six previous
 * UTC days. Tokens use the cache-inclusive `totalTokens` (same semantics as
 * the local dashboard's headline).
 */
export function foldRecentDays(
  recentDays: readonly MemberUsageDay[],
  nowMs: number
): RecentUsageHeadline {
  const todayDay = utcDayFromMs(nowMs);
  const weekDays = new Set<UtcDay>();
  for (let offset = 0; offset < 7; offset += 1) {
    weekDays.add(utcDayFromMs(nowMs - offset * DAY_MS));
  }

  const headline: RecentUsageHeadline = {
    todayTokens: 0,
    todayCostUsd: 0,
    weekTokens: 0,
    weekCostUsd: 0,
  };
  for (const row of recentDays) {
    if (row.day === todayDay) {
      headline.todayTokens += row.totalTokens;
      headline.todayCostUsd += row.costUsd;
    }
    if (weekDays.has(row.day)) {
      headline.weekTokens += row.totalTokens;
      headline.weekCostUsd += row.costUsd;
    }
  }
  return headline;
}

/**
 * Whether a member has meaningful usage in the current UTC day.
 *
 * This is the shared definition behind both the overview's active-member
 * count and the Members breakdown groups. A zero-valued day row is not
 * activity; any request, session, token, or cost is.
 */
export function hasMemberActivityToday(
  recentDays: readonly MemberUsageDay[],
  nowMs: number
): boolean {
  const today = utcDayFromMs(nowMs);
  return recentDays.some(
    (row) =>
      row.day === today &&
      (row.requests > 0 ||
        row.sessions > 0 ||
        row.totalTokens > 0 ||
        row.costUsd > 0)
  );
}

// ---------------------------------------------------------------------------
// Today org snapshot + recent shared sessions
// ---------------------------------------------------------------------------

export interface OrgRuntimeTodaySnapshot {
  usage: UsageSummary;
  activeMembers: number;
  memberCount: number;
  currentSystems: number;
  averageCpuPercent: number | null;
  averageRamPercent: number | null;
}

function safeAverage(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Fold the selected members into one UTC-today dashboard snapshot.
 *
 * Machine averages intentionally include only current reports. Mixing an
 * hours-old sample into "average CPU/RAM" makes a sleeping laptop look like
 * live org capacity, so stale or malformed samples are excluded rather than
 * represented as zero.
 */
export function buildOrgRuntimeTodaySnapshot(
  members: readonly MemberRuntimeListEntry[],
  telemetry: OrgRuntimeTelemetry | null,
  nowMs: number
): OrgRuntimeTodaySnapshot {
  const today = utcDayFromMs(nowMs);
  const usageRows: MemberUsageDay[] = [];
  const cpuPercents: number[] = [];
  const ramPercents: number[] = [];
  let activeMembers = 0;
  let currentSystems = 0;

  for (const member of members) {
    for (const row of member.recentDays) {
      if (row.day !== today) continue;
      usageRows.push(row);
    }
    if (hasMemberActivityToday(member.recentDays, nowMs)) activeMembers += 1;

    if (isRuntimeStale(member.reportedAt, telemetry, nowMs)) continue;
    currentSystems += 1;
    const sample = member.sample;
    if (!sample) continue;
    if (Number.isFinite(sample.cpuPercent)) {
      cpuPercents.push(Math.min(100, Math.max(0, sample.cpuPercent)));
    }
    if (
      Number.isFinite(sample.memUsedMb) &&
      Number.isFinite(sample.memTotalMb) &&
      sample.memTotalMb > 0
    ) {
      ramPercents.push(
        Math.min(100, Math.max(0, (sample.memUsedMb / sample.memTotalMb) * 100))
      );
    }
  }

  return {
    usage: foldMemberUsageSummary(usageRows),
    activeMembers,
    memberCount: members.length,
    currentSystems,
    averageCpuPercent: safeAverage(cpuPercents),
    averageRamPercent: safeAverage(ramPercents),
  };
}

/**
 * Merge members' latest rolling-24h hourly series for the viewer's current
 * display window. Member reports can land at slightly different instants, so
 * the chart clips by hour bucket and adds matching buckets rather than
 * assuming every peer reported on the same boundary.
 */
export function aggregateMemberRecentUsageTrends(
  members: readonly MemberRuntimeListEntry[],
  startMs: number,
  endMs: number
): UsageTrendPoint[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return [];
  }
  const firstBucketMs = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  const lastBucketMs = Math.floor(endMs / HOUR_MS) * HOUR_MS;
  const byHour = new Map<number, UsageTrendPoint>();

  for (const member of members) {
    for (const point of member.stats?.recentUsage24h?.trends ?? []) {
      if (
        !Number.isFinite(point.bucketMs) ||
        point.bucketMs < firstBucketMs ||
        point.bucketMs > lastBucketMs
      ) {
        continue;
      }
      let aggregate = byHour.get(point.bucketMs);
      if (!aggregate) {
        aggregate = {
          bucketMs: point.bucketMs,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        };
        byHour.set(point.bucketMs, aggregate);
      }
      aggregate.inputTokens += point.inputTokens;
      aggregate.outputTokens += point.outputTokens;
      aggregate.cacheReadTokens += point.cacheReadTokens;
      aggregate.cacheWriteTokens += point.cacheWriteTokens;
      aggregate.costUsd += point.costUsd;
    }
  }

  return [...byHour.values()].sort(
    (left, right) => left.bucketMs - right.bucketMs
  );
}

/**
 * Return the newest visible shared sessions for the selected member scope.
 * The remote-session coordinator already bounds and identity-keys its cache;
 * this pure projection retains at most `limit` rows for rendering.
 */
export function recentSharedSessions(
  rows: readonly RemoteTeammateSessionMetadata[],
  ownerUserId: string | null,
  limit = 5
): RemoteTeammateSessionMetadata[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const newest: RemoteTeammateSessionMetadata[] = [];
  const compareNewestFirst = (
    left: RemoteTeammateSessionMetadata,
    right: RemoteTeammateSessionMetadata
  ): number => {
    const leftMs = left.lastActivityAt
      ? Date.parse(left.lastActivityAt)
      : Number.NEGATIVE_INFINITY;
    const rightMs = right.lastActivityAt
      ? Date.parse(right.lastActivityAt)
      : Number.NEGATIVE_INFINITY;
    const normalizedLeft = Number.isFinite(leftMs)
      ? leftMs
      : Number.NEGATIVE_INFINITY;
    const normalizedRight = Number.isFinite(rightMs)
      ? rightMs
      : Number.NEGATIVE_INFINITY;
    if (normalizedLeft !== normalizedRight) {
      return normalizedRight - normalizedLeft;
    }
    return right.id.localeCompare(left.id);
  };

  // Keep only the requested top-k while scanning. The shared Team Sessions
  // cache can hold a large bounded org listing; sorting a full copy merely to
  // render five rows creates avoidable O(n log n) work and O(n) allocation.
  for (const row of rows) {
    if (
      row.deletedAt ||
      (ownerUserId !== null && row.ownerUserId !== ownerUserId)
    ) {
      continue;
    }
    const insertAt = newest.findIndex(
      (existing) => compareNewestFirst(row, existing) < 0
    );
    if (insertAt >= 0) newest.splice(insertAt, 0, row);
    else if (newest.length < boundedLimit) newest.push(row);
    if (newest.length > boundedLimit) newest.pop();
  }
  return newest;
}

// ---------------------------------------------------------------------------
// MemberUsageDay[] → UsageTrendPoint[] / UsageSummary (drilldown)
// ---------------------------------------------------------------------------

/** Epoch ms of a UTC day's midnight — the chart's bucket key. */
export function utcDayStartMs(day: UtcDay): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function filterByBucket(
  days: readonly MemberUsageDay[],
  bucket: TeamUsageBucket | null
): readonly MemberUsageDay[] {
  return bucket ? days.filter((row) => row.bucket === bucket) : days;
}

/**
 * Map usage-day rows onto the existing `UsageTrendChart` point shape: one
 * point per UTC day (buckets summed unless one is selected), ascending.
 */
export function memberUsageDaysToTrendPoints(
  days: readonly MemberUsageDay[],
  bucket: TeamUsageBucket | null = null
): UsageTrendPoint[] {
  const byDay = new Map<number, UsageTrendPoint>();
  for (const row of filterByBucket(days, bucket)) {
    const bucketMs = utcDayStartMs(row.day);
    if (!Number.isFinite(bucketMs)) continue;
    let point = byDay.get(bucketMs);
    if (!point) {
      point = {
        bucketMs,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      };
      byDay.set(bucketMs, point);
    }
    point.inputTokens += row.inputTokens;
    point.outputTokens += row.outputTokens;
    point.cacheReadTokens += row.cacheReadTokens;
    point.cacheWriteTokens += row.cacheWriteTokens;
    point.costUsd += row.costUsd;
  }
  return [...byDay.values()].sort((a, b) => a.bucketMs - b.bucketMs);
}

/**
 * Fold usage-day rows into the `UsageSummary` shape `UsageStatCards` renders.
 *
 * Caveats inherent to the synced aggregates:
 * - `sessionCount` sums per-(day, bucket) distinct counts, so a session active
 *   on several days counts once per day — an upper bound, not a distinct count.
 * - the split between estimated and recorded cost does not survive the sync;
 *   the whole cost lands in `estimatedCostUsd`.
 */
export function foldMemberUsageSummary(
  days: readonly MemberUsageDay[],
  bucket: TeamUsageBucket | null = null
): UsageSummary {
  const rows = filterByBucket(days, bucket);
  const summary: UsageSummary = {
    sessionCount: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    realTotalTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimatedCostUsd: 0,
    recordedCostUsd: 0,
    cacheHitRate: 0,
    byBucket: [],
  };
  const perBucket = new Map<
    string,
    { sessionCount: number; realTotalTokens: number; costUsd: number }
  >();
  for (const row of rows) {
    summary.sessionCount += row.sessions;
    summary.requestCount += row.requests;
    summary.inputTokens += row.inputTokens;
    summary.outputTokens += row.outputTokens;
    summary.cacheReadTokens += row.cacheReadTokens;
    summary.cacheWriteTokens += row.cacheWriteTokens;
    summary.totalTokens += row.totalTokens;
    summary.costUsd += row.costUsd;

    let bucketTotals = perBucket.get(row.bucket);
    if (!bucketTotals) {
      bucketTotals = { sessionCount: 0, realTotalTokens: 0, costUsd: 0 };
      perBucket.set(row.bucket, bucketTotals);
    }
    bucketTotals.sessionCount += row.sessions;
    bucketTotals.realTotalTokens += row.totalTokens;
    bucketTotals.costUsd += row.costUsd;
  }
  summary.realTotalTokens =
    summary.inputTokens +
    summary.outputTokens +
    summary.cacheReadTokens +
    summary.cacheWriteTokens;
  summary.estimatedCostUsd = summary.costUsd;
  const cacheDenominator =
    summary.inputTokens + summary.cacheWriteTokens + summary.cacheReadTokens;
  summary.cacheHitRate =
    cacheDenominator > 0 ? summary.cacheReadTokens / cacheDenominator : 0;
  summary.byBucket = TEAM_USAGE_BUCKETS.flatMap((bucketId) => {
    const totals = perBucket.get(bucketId);
    return totals ? [{ bucket: bucketId, ...totals }] : [];
  });
  return summary;
}

/** Inclusive UTC day range ending today, `spanDays` days long. */
export function memberUsageDayRange(
  nowMs: number,
  spanDays: number
): { fromDay: UtcDay; toDay: UtcDay } {
  const span = Math.max(1, Math.floor(spanDays));
  return {
    fromDay: utcDayFromMs(nowMs - (span - 1) * DAY_MS),
    toDay: utcDayFromMs(nowMs),
  };
}

// ---------------------------------------------------------------------------
// Installed agents
// ---------------------------------------------------------------------------

/**
 * Detection statuses (see `status_for` in `external_cli_detection.rs`) that
 * assert the provider is NOT present. Anything else — including future
 * statuses — is shown, since the member's push already chose to include it.
 */
const AGENT_ABSENT_STATUSES = new Set([
  "not_detected",
  "importable_no_history_found",
]);

export function isInstalledAgentPresent(agent: MemberInstalledAgent): boolean {
  return !AGENT_ABSENT_STATUSES.has(agent.status);
}

// ---------------------------------------------------------------------------
// Machine chips
// ---------------------------------------------------------------------------

/** Megabytes → approximate whole gigabytes (`12800` → `"13"`, `32768` →
 * `"32"`) — the roster deliberately shows "13/32 GB", never "12.5/31.6".
 * Non-zero inputs floor at "1" so a lightly-loaded machine doesn't read as
 * using nothing. */
export function formatMemGb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "0";
  return String(Math.max(1, Math.round(mb / 1024)));
}
