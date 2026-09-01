/**
 * Member-runtime sharing — shared wire/domain contract.
 *
 * Org members push coarse runtime aggregates (hourly), a one-time builder
 * profile, and their installed-agent inventory to `org2_cloud`, so teammates
 * can view a "Runtime tab for the team". This module is the single source of
 * truth for the wire shapes and names spanning four surfaces:
 *
 *   1. cloud RPCs (orgii-cloud-infra migration 0010_member_runtime.sql)
 *   2. Tauri collector commands (src-tauri: perf-utils + orgtrack)
 *   3. the push scheduler + RPC client (features/Org2Cloud/memberRuntime/)
 *   4. the Team section of the Runtime tab (modules/shared/dataSource/)
 *
 * FROZEN CONTRACT: the exported names/shapes here are pinned so the four
 * implementation sites can land independently. Additive evolution only.
 *
 * Conventions:
 * - All `day` values are **UTC dates** (`YYYY-MM-DD`), derived from UTC
 *   day-floored epoch ms (`TrendBucket::floor` semantics). Every member
 *   reports in UTC days so team aggregation is consistent across timezones.
 * - Buckets extend the local dashboard's `UsageBucket` with `"other"` so the
 *   synced totals are complete (the local desktop view hides `other`; the
 *   team rollup must not silently drop it).
 * - Usage aggregates only: no session titles, repo paths, models, or
 *   per-request rows ever leave the machine. That said, this contract DOES
 *   ship several other things off-machine that a reader of "aggregates only"
 *   could easily miss:
 *     - the machine's hostname (`machineLabel`) and hardware specs (CPU/GPU
 *       name and core/VRAM counts, total RAM, OS name+version) — see
 *       `MemberRuntimeMachine`;
 *     - the full installed-agent inventory (which CLI providers are present
 *       and their detection status) — see `MemberInstalledAgent`;
 *     - per-day cost and token figures broken out by bucket — see
 *       `MemberUsageDay`;
 *     - a rolling 24-hour token/cost series at hourly resolution, aggregated
 *       across sources — see `MemberRuntimeStats.recentUsage24h`.
 *   These are exactly what let a teammate see "who's running low on RAM" or
 *   "who's spending the most on Claude this week"; they are not incidental
 *   leakage, but they are NOT covered by the "no session titles/repo
 *   paths/models" framing above and must be disclosed alongside it.
 */
import type { BuilderProfile } from "@src/api/tauri/builderProfile";
import type {
  RecentUsageSnapshot,
  UsageBucket,
} from "@src/api/tauri/usageDashboard";

// ---------------------------------------------------------------------------
// Buckets & days
// ---------------------------------------------------------------------------

export type TeamUsageBucket = UsageBucket | "other";

export const TEAM_USAGE_BUCKETS: readonly TeamUsageBucket[] = [
  "claude",
  "codex",
  "cursor",
  "org2",
  "other",
];

/** UTC calendar date, `YYYY-MM-DD`. */
export type UtcDay = string;

export function utcDayFromMs(ms: number): UtcDay {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Wire shapes (camelCase JSON, stored as jsonb / RPC payloads)
// ---------------------------------------------------------------------------

/** Static machine identity. Composed client-side from cached hardware
 * detection (`detectLocalModelHardware` — never re-probed per push) plus
 * `cloud_device_identity`. */
export interface MemberRuntimeMachine {
  /** Persisted per-install id from `cloud_device_identity` (NOT the
   * diagnostics install_id — deliberately unlinkable from telemetry). */
  deviceId: string;
  machineLabel: string;
  osName: string;
  osVersion: string;
  chipType: string;
  cpuName?: string;
  cpuCores?: number;
  /** Approximate whole GB (rounded at collection — "32", never "31.6"). */
  totalRamGb?: number;
  gpuName?: string;
  gpuVramGb?: number;
  unifiedMemory?: boolean;
  appVersion: string;
}

/** Point-in-time burst sample taken at push time (avg over ~1–2s), from the
 * `system_runtime_snapshot` Tauri command. */
export interface MemberRuntimeSample {
  /** Whole-machine CPU utilization, 0–100. */
  cpuPercent: number;
  memUsedMb: number;
  memTotalMb: number;
  /** GPU utilization 0–100; null when the platform has no cheap sudo-free
   * probe (macOS) — GPU identity still ships via `machine`. */
  gpuPercent: number | null;
  /** Duration of the sampling burst. */
  sampledOverMs: number;
  /** Client clock at sampling, epoch ms (server also stamps reported_at). */
  sampledAtMs: number;
}

/** Bounded usage metadata pushed with every status update. The lifetime
 * census must come from the client because cloud daily rows are retained only
 * for a window; the rolling snapshot powers team hourly charts without
 * storing per-request rows. */
interface MemberRuntimeStats {
  totalSessions: number;
  /** Latest rolling 24h headline + hourly trend. Additive inside the opaque
   * cloud status blob, so pre-feature peers simply omit it. */
  recentUsage24h?: RecentUsageSnapshot;
}

/** One (UTC day, bucket) usage rollup row. */
export interface MemberUsageDay {
  day: UtcDay;
  bucket: TeamUsageBucket;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache-inclusive total (same semantics as the local dashboard). */
  totalTokens: number;
  costUsd: number;
  sessions: number;
  requests: number;
}

/** Installed-agent inventory entry: detection status per provider id from
 * `external_cli_sources_detect`. Labels/icons are resolved client-side from
 * the local detection catalog (ids are stable across machines). */
export interface MemberInstalledAgent {
  id: string;
  status: string;
}

/** Builder-profile payload — the already-cached `BuilderProfile` from
 * `builder_profile_overview` (code, axes, confidence, sessions, …). Opaque
 * jsonb to the server. Pushed only on change / explicit refresh, never on
 * the hourly tick, and extraction is never triggered automatically. */
export type MemberBuilderProfile = BuilderProfile;

export interface MemberProfilePayload {
  profile?: MemberBuilderProfile;
  installedAgents?: MemberInstalledAgent[];
}

export interface UpsertMemberRuntimeInput {
  status?: {
    machine: MemberRuntimeMachine;
    sample: MemberRuntimeSample;
    stats?: MemberRuntimeStats;
  };
  usageDays?: MemberUsageDay[];
  profile?: MemberProfilePayload;
}

/** One roster entry from `cloud_list_member_runtime`. */
export interface MemberRuntimeListEntry {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  role: string;
  /** Server-stamped time of the last status push (ISO); null = never. */
  reportedAt: string | null;
  machine: MemberRuntimeMachine | null;
  sample: MemberRuntimeSample | null;
  stats: MemberRuntimeStats | null;
  builderTypeCode: string | null;
  profile: MemberBuilderProfile | null;
  installedAgents: MemberInstalledAgent[];
  profileUpdatedAt: string | null;
  agentsUpdatedAt: string | null;
  /** Last `RECENT_DAYS_WINDOW` UTC days of usage rows (all buckets), newest
   * first — viewers fold these into "today" / "7d" locally. */
  recentDays: MemberUsageDay[];
}

export interface OrgRuntimeTelemetry {
  enabled: boolean;
  intervalMinutes: number;
}

// ---------------------------------------------------------------------------
// Names (RPCs, Tauri commands, capability flag, signal kind)
// ---------------------------------------------------------------------------

export const MEMBER_RUNTIME_RPC = {
  upsert: "cloud_upsert_member_runtime",
  list: "cloud_list_member_runtime",
  getUsage: "cloud_get_member_usage",
  clear: "cloud_clear_member_runtime",
  setOrgTelemetry: "cloud_set_org_runtime_telemetry",
} as const;

// ---------------------------------------------------------------------------
// Error codes (parsed from RPC failure messages, sync-client idiom)
// ---------------------------------------------------------------------------

export const MEMBER_RUNTIME_ERROR_CODES = [
  /** Org has runtime telemetry disabled (or unset — disabled is the default);
   * pushers stop until the org record says enabled again. */
  "ORG2_RUNTIME_DISABLED",
  /** A jsonb payload exceeded its server-side cap. */
  "ORG2_RUNTIME_TOO_LARGE",
] as const;

// ---------------------------------------------------------------------------
// Cadence / clamps (server clamps authoritatively; client mirrors)
// ---------------------------------------------------------------------------

export const RUNTIME_TELEMETRY_DEFAULT_INTERVAL_MINUTES = 60;
export const RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES = 15;
export const RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES = 1440;

/** Usage-day rows accepted per upsert call (35-day window + slack). */
export const MEMBER_USAGE_DAYS_MAX_PER_PUSH = 40;
/** Days of local rollup recomputed and delta-pushed each tick. */
export const MEMBER_USAGE_ROLLUP_WINDOW_DAYS = 35;
/** Server-side jsonb caps (bytes of ::text). */
export const MEMBER_STATUS_MAX_BYTES = 8_192;
/** Rolling window carried in `stats.recentUsage24h`. */
export const MEMBER_RECENT_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Launch catch-up jitter so an org coming online together doesn't stampede. */
export const MEMBER_RUNTIME_CATCHUP_JITTER_MIN_MS = 30_000;
export const MEMBER_RUNTIME_CATCHUP_JITTER_MAX_MS = 120_000;
/** Installed-agent detection re-probe floor (fingerprint-gated push). */
export const MEMBER_AGENTS_DETECT_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** localStorage key prefix (zodStorage) for per-(identity, org) push state:
 * `${prefix}:${identityKey}:${orgId}` → { lastPushAtMs, usageFingerprint,
 * profileFingerprint, agentsFingerprint, lastAgentsDetectAtMs }. */
export const MEMBER_RUNTIME_PUSH_STATE_KEY_PREFIX =
  "orgii:org2-cloud-v1:memberRuntimePush";

/** Local privacy opt-out settings key (registry: privacy category). When
 * false, the scheduler never pushes; the Team panel offers a "remove my
 * data" action that calls the clear RPC. */
export const SHARE_RUNTIME_SETTING_KEY = "privacy.shareRuntimeWithOrg";
