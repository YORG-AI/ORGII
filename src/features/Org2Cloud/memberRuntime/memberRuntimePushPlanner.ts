/**
 * Pure planning math for the member-runtime push scheduler: due-time /
 * launch-jitter / backoff computation, rollup-row → `MemberUsageDay`
 * mapping, and the fingerprint-based usage delta. Kept side-effect free so
 * the scheduler's timing behavior is unit-testable with an injected clock —
 * no real timers, no storage, no network.
 */
import type { DailyRollupRow } from "@src/api/tauri/usageDashboard";

import type {
  MemberBuilderProfile,
  MemberInstalledAgent,
  MemberUsageDay,
  OrgRuntimeTelemetry,
  TeamUsageBucket,
} from "./types";
import {
  MEMBER_RUNTIME_CATCHUP_JITTER_MAX_MS,
  MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS,
  MEMBER_USAGE_DAYS_MAX_PER_PUSH,
  RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES,
  RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
  RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES,
  TEAM_USAGE_BUCKETS,
  utcDayFromMs,
} from "./types";

export const UTC_DAY_MS = 24 * 60 * 60 * 1000;

/** Exponential per-org failure backoff: 5 → 10 → 20 → 30 → 30 … minutes. */
export const MEMBER_RUNTIME_BACKOFF_BASE_MS = 5 * 60_000;
export const MEMBER_RUNTIME_BACKOFF_CAP_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Cadence math
// ---------------------------------------------------------------------------

/** Client mirror of the server's authoritative [15, 1440] interval clamp. */
export function clampRuntimeTelemetryIntervalMinutes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES;
  }
  return Math.min(
    RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
    Math.max(RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES, Math.round(value))
  );
}

export function memberRuntimeBackoffDelayMs(
  consecutiveFailures: number
): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const exponent = Math.min(failures - 1, 30); // 2**30 guard before the cap
  return Math.min(
    MEMBER_RUNTIME_BACKOFF_BASE_MS * 2 ** exponent,
    MEMBER_RUNTIME_BACKOFF_CAP_MS
  );
}

/** Launch catch-up jitter in [30s, 120s] so an org's members coming online
 * together don't stampede the upsert RPC. `random` is injected for tests. */
export function drawMemberRuntimeCatchupJitterMs(
  random: () => number = Math.random
): number {
  const span =
    MEMBER_RUNTIME_CATCHUP_JITTER_MAX_MS - MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS;
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS + unit * span);
}

export interface ComputeOrgDueAtInput {
  /** Epoch ms of the last successful push; 0 = never pushed. */
  lastPushAtMs: number;
  /** Raw org record interval (clamped here). */
  intervalMinutes: number;
  /** When this scheduler instance started (epoch ms). */
  schedulerStartAtMs: number;
  /** Jitter drawn once per scheduler start. */
  catchupJitterMs: number;
  /** Per-org failure backoff floor; 0/absent = none. */
  backoffNotBeforeMs?: number;
}

/**
 * Absolute epoch-ms deadline of the org's next push. A push already overdue
 * when the scheduler starts (including "never pushed") lands at
 * `schedulerStartAtMs + catchupJitterMs`; one that comes due while the app
 * runs keeps its exact deadline. The failure backoff floor always wins.
 */
export function computeOrgDueAtMs(input: ComputeOrgDueAtInput): number {
  const intervalMs =
    clampRuntimeTelemetryIntervalMinutes(input.intervalMinutes) * 60_000;
  const raw =
    input.lastPushAtMs > 0
      ? input.lastPushAtMs + intervalMs
      : input.schedulerStartAtMs;
  const dueAt =
    raw <= input.schedulerStartAtMs
      ? input.schedulerStartAtMs + input.catchupJitterMs
      : raw;
  return Math.max(dueAt, input.backoffNotBeforeMs ?? 0);
}

// ---------------------------------------------------------------------------
// Rollup → MemberUsageDay mapping
// ---------------------------------------------------------------------------

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function isTeamUsageBucket(value: string): value is TeamUsageBucket {
  return (TEAM_USAGE_BUCKETS as readonly string[]).includes(value);
}

/**
 * Map `usage_dashboard_daily_rollup` rows to wire `MemberUsageDay`s: UTC day
 * strings via `utcDayFromMs`, numerics clamped to >= 0 (mirroring the server
 * clamp). Rows with a bucket outside the contract's five are dropped —
 * defensive only; the command emits exactly the five.
 */
export function mapRollupRowsToMemberUsageDays(
  rows: readonly DailyRollupRow[]
): MemberUsageDay[] {
  const days: MemberUsageDay[] = [];
  for (const row of rows) {
    if (!isTeamUsageBucket(row.bucket)) continue;
    days.push({
      day: utcDayFromMs(row.dayStartMs),
      bucket: row.bucket,
      inputTokens: nonNegative(row.inputTokens),
      outputTokens: nonNegative(row.outputTokens),
      cacheReadTokens: nonNegative(row.cacheReadTokens),
      cacheWriteTokens: nonNegative(row.cacheWriteTokens),
      totalTokens: nonNegative(row.totalTokens),
      costUsd: nonNegative(row.costUsd),
      sessions: nonNegative(row.sessions),
      requests: nonNegative(row.requests),
    });
  }
  return days;
}

/** UTC midnight (epoch ms) of the day containing `ms` — epoch days ARE UTC
 * days, so a plain floor matches `utcDayFromMs`. */
export function utcDayFloorMs(ms: number): number {
  return Math.floor(ms / UTC_DAY_MS) * UTC_DAY_MS;
}

// ---------------------------------------------------------------------------
// Usage delta (fingerprint-gated rows)
// ---------------------------------------------------------------------------

export function usageDayRowKey(day: MemberUsageDay): string {
  return `${day.day}|${day.bucket}`;
}

export function usageDayRowFingerprint(day: MemberUsageDay): string {
  return [
    day.inputTokens,
    day.outputTokens,
    day.cacheReadTokens,
    day.cacheWriteTokens,
    day.totalTokens,
    day.costUsd,
    day.sessions,
    day.requests,
  ].join("|");
}

export interface UsageDaysPushPlan {
  /** Rows to send this tick (changed since the last successful push, capped,
   * newest days first). */
  days: MemberUsageDay[];
  /**
   * Fingerprint map to PERSIST AFTER the push succeeds: sent rows get their
   * new fingerprint, unsent rows keep their previous one (so a row squeezed
   * out by the cap stays "changed" next tick), and keys for days that fell
   * out of the rollup window are pruned so the map stays bounded.
   */
  fingerprintsAfterPush: Record<string, string>;
}

export function planUsageDaysPush(
  currentRows: readonly MemberUsageDay[],
  previousFingerprints: Record<string, string>,
  cap: number = MEMBER_USAGE_DAYS_MAX_PER_PUSH
): UsageDaysPushPlan {
  const bucketOrder = new Map<string, number>(
    TEAM_USAGE_BUCKETS.map((bucket, index) => [bucket, index])
  );
  const changed = currentRows.filter(
    (row) =>
      previousFingerprints[usageDayRowKey(row)] !== usageDayRowFingerprint(row)
  );
  // Newest day first; deterministic bucket order within a day.
  const sorted = [...changed].sort((left, right) => {
    if (left.day !== right.day) return left.day < right.day ? 1 : -1;
    return (
      (bucketOrder.get(left.bucket) ?? 0) - (bucketOrder.get(right.bucket) ?? 0)
    );
  });
  const days = sorted.slice(0, Math.max(0, cap));
  const sentKeys = new Set(days.map(usageDayRowKey));

  const fingerprintsAfterPush: Record<string, string> = {};
  for (const row of currentRows) {
    const key = usageDayRowKey(row);
    if (sentKeys.has(key)) {
      fingerprintsAfterPush[key] = usageDayRowFingerprint(row);
    } else if (previousFingerprints[key] !== undefined) {
      fingerprintsAfterPush[key] = previousFingerprints[key];
    }
  }
  return { days, fingerprintsAfterPush };
}

// ---------------------------------------------------------------------------
// Profile / installed-agent / org-record fingerprints
// ---------------------------------------------------------------------------

/** Change detector for the builder profile: the code plus each axis's
 * letter/score/clarity. Blurbs and evidence prose are presentation-only and
 * deliberately excluded. */
export function builderProfileFingerprint(
  profile: MemberBuilderProfile
): string {
  return JSON.stringify([
    profile.code,
    profile.axes.map((axis) => [
      axis.key,
      axis.letter,
      axis.score,
      axis.clarity,
    ]),
  ]);
}

export function installedAgentsFingerprint(
  agents: readonly MemberInstalledAgent[]
): string {
  return JSON.stringify(
    [...agents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((agent) => [agent.id, agent.status])
  );
}

/**
 * Identity of an org's `runtimeTelemetry` record, used to hold an
 * `ORG2_RUNTIME_DISABLED` verdict "until its org record changes": the
 * disabled mark is keyed to this fingerprint and cleared the moment the
 * roster delivers a different record.
 */
export function runtimeTelemetryRecordFingerprint(
  record: OrgRuntimeTelemetry | null | undefined
): string {
  return record ? `${record.enabled}|${record.intervalMinutes}` : "off";
}
