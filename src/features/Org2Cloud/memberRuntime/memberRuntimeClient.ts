/**
 * Member-runtime RPC client — typed wrappers for the five
 * `0010_member_runtime` RPCs.
 *
 * Same raw-fetch idiom as `org2CloudSyncClient` (JWT Bearer +
 * `Content-Profile: org2_cloud`, no supabase-js), and like that client these
 * wrappers THROW on failure: the push scheduler needs the server's error
 * codes (`ORG2_RUNTIME_DISABLED`, `ORG2_RUNTIME_TOO_LARGE`) to decide
 * between "stop until the org record changes" and plain backoff. Requests
 * route through `endpointForOrg` so a sharded org talks to its home
 * project, with transport retry + a bounded timeout.
 *
 * Response validation is zod-based and tolerant of additive fields (zod
 * strips unknown keys); per-field `.catch(...)` degrades one member's
 * malformed jsonb blob to `null`/`[]` instead of failing the whole roster.
 */
import { z } from "zod/v4";

import { type CloudEndpoint, ORG2_CLOUD_POSTGREST_SCHEMA } from "../config";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "../org2CloudFetchRetry";
import { endpointForOrg } from "../org2CloudOrgEndpointRouter";
import type {
  MemberBuilderProfile,
  MemberRuntimeListEntry,
  MemberUsageDay,
  OrgRuntimeTelemetry,
  TeamUsageBucket,
  UpsertMemberRuntimeInput,
} from "./types";
import {
  MEMBER_RUNTIME_ERROR_CODES,
  MEMBER_RUNTIME_RPC,
  RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
  RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES,
  TEAM_USAGE_BUCKETS,
} from "./types";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export type MemberRuntimeErrorCode =
  (typeof MEMBER_RUNTIME_ERROR_CODES)[number];

/** RPC failure carrying the server's error code when recognizable. */
export class MemberRuntimeError extends Error {
  readonly code: MemberRuntimeErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "MemberRuntimeError";
    this.status = status;
    this.code =
      MEMBER_RUNTIME_ERROR_CODES.find((code) => message.includes(code)) ?? null;
  }
}

export function isMemberRuntimeErrorCode(
  error: unknown,
  code: MemberRuntimeErrorCode
): boolean {
  return error instanceof MemberRuntimeError && error.code === code;
}

// ---------------------------------------------------------------------------
// RPC plumbing (throwing variant of the org2CloudClient idiom)
// ---------------------------------------------------------------------------

/** Bound every member-runtime RPC below the managed statement timeout. */
const MEMBER_RUNTIME_RPC_TIMEOUT_MS = 15_000;

function rpcUrl(functionName: string, endpoint: CloudEndpoint): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

function rpcHeaders(
  accessToken: string,
  endpoint: CloudEndpoint
): Record<string, string> {
  const { anonKey } = endpoint;
  return {
    apikey: anonKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
  };
}

async function callMemberRuntimeRpc(
  functionName: string,
  accessToken: string,
  orgId: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const endpoint = endpointForOrg(orgId);
  const execute = async (requestSignal: AbortSignal): Promise<unknown> => {
    const response = await fetchWithTransportRetry(
      rpcUrl(functionName, endpoint),
      {
        method: "POST",
        headers: rpcHeaders(accessToken, endpoint),
        body: JSON.stringify(body),
        signal: requestSignal,
      }
    );
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `org2_cloud rpc ${functionName} failed with ${response.status}`;
      throw new MemberRuntimeError(message, response.status);
    }
    return payload;
  };
  return runCloudRequestWithTimeout(execute, MEMBER_RUNTIME_RPC_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Wire schemas (tolerant: unknown keys stripped, malformed blobs degrade)
// ---------------------------------------------------------------------------

const TeamUsageBucketWireSchema = z.custom<TeamUsageBucket>(
  (value) =>
    typeof value === "string" &&
    (TEAM_USAGE_BUCKETS as readonly string[]).includes(value)
);

const MemberUsageDayWireSchema = z.object({
  day: z.string(),
  bucket: TeamUsageBucketWireSchema,
  inputTokens: z.number().catch(0),
  outputTokens: z.number().catch(0),
  cacheReadTokens: z.number().catch(0),
  cacheWriteTokens: z.number().catch(0),
  totalTokens: z.number().catch(0),
  costUsd: z.number().catch(0),
  sessions: z.number().catch(0),
  requests: z.number().catch(0),
});

const NonNegativeNumberWireSchema = z.number().nonnegative().catch(0);

const UsageBucketSummaryWireSchema = z.object({
  bucket: z.string(),
  sessionCount: NonNegativeNumberWireSchema,
  realTotalTokens: NonNegativeNumberWireSchema,
  costUsd: NonNegativeNumberWireSchema,
});

const UsageSummaryWireSchema = z.object({
  sessionCount: NonNegativeNumberWireSchema,
  requestCount: NonNegativeNumberWireSchema,
  inputTokens: NonNegativeNumberWireSchema,
  outputTokens: NonNegativeNumberWireSchema,
  cacheReadTokens: NonNegativeNumberWireSchema,
  cacheWriteTokens: NonNegativeNumberWireSchema,
  realTotalTokens: NonNegativeNumberWireSchema,
  totalTokens: NonNegativeNumberWireSchema,
  costUsd: NonNegativeNumberWireSchema,
  estimatedCostUsd: NonNegativeNumberWireSchema,
  recordedCostUsd: NonNegativeNumberWireSchema,
  cacheHitRate: z.number().min(0).max(1).catch(0),
  byBucket: z
    .array(UsageBucketSummaryWireSchema)
    .max(TEAM_USAGE_BUCKETS.length)
    .catch([])
    .default([]),
});

const UsageTrendPointWireSchema = z.object({
  bucketMs: z.number().nonnegative(),
  inputTokens: NonNegativeNumberWireSchema,
  outputTokens: NonNegativeNumberWireSchema,
  cacheReadTokens: NonNegativeNumberWireSchema,
  cacheWriteTokens: NonNegativeNumberWireSchema,
  costUsd: NonNegativeNumberWireSchema,
});

const RecentUsageSnapshotWireSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  summary: UsageSummaryWireSchema,
  trends: z.array(UsageTrendPointWireSchema).max(25).catch([]).default([]),
});

const optionalString = z
  .string()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const optionalNumber = z
  .number()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);
const optionalBoolean = z
  .boolean()
  .nullish()
  .catch(undefined)
  .transform((value) => value ?? undefined);

const MemberRuntimeMachineWireSchema = z.object({
  deviceId: z.string(),
  machineLabel: z.string().catch(""),
  osName: z.string().catch(""),
  osVersion: z.string().catch(""),
  chipType: z.string().catch(""),
  cpuName: optionalString,
  cpuCores: optionalNumber,
  totalRamGb: optionalNumber,
  gpuName: optionalString,
  gpuVramGb: optionalNumber,
  unifiedMemory: optionalBoolean,
  appVersion: z.string().catch(""),
});

const MemberRuntimeSampleWireSchema = z.object({
  cpuPercent: z.number(),
  memUsedMb: z.number(),
  memTotalMb: z.number(),
  gpuPercent: z
    .number()
    .nullish()
    .transform((value) => value ?? null),
  sampledOverMs: z.number().catch(0),
  sampledAtMs: z.number().catch(0),
});

/** The builder profile is an opaque client-authored jsonb blob; require the
 * one field consumers key on (`code`) and pass the rest through untouched. */
const MemberBuilderProfileWireSchema = z.custom<MemberBuilderProfile>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string"
);

const MemberInstalledAgentWireSchema = z.object({
  id: z.string(),
  status: z.string().catch(""),
});

const MemberRuntimeListEntryWireSchema = z.object({
  userId: z.string(),
  displayName: z.string().nullish().catch(undefined),
  avatarUrl: z.string().nullish().catch(undefined),
  role: z.string().catch("member"),
  reportedAt: z.string().nullish().catch(undefined),
  machine: MemberRuntimeMachineWireSchema.nullish().catch(undefined),
  sample: MemberRuntimeSampleWireSchema.nullish().catch(undefined),
  stats: z
    .object({
      totalSessions: z.number(),
      recentUsage24h: RecentUsageSnapshotWireSchema.optional().catch(undefined),
    })
    .nullish()
    .catch(undefined),
  builderTypeCode: z.string().nullish().catch(undefined),
  profile: MemberBuilderProfileWireSchema.nullish().catch(undefined),
  installedAgents: z
    .array(MemberInstalledAgentWireSchema)
    .catch([])
    .default([]),
  profileUpdatedAt: z.string().nullish().catch(undefined),
  agentsUpdatedAt: z.string().nullish().catch(undefined),
  recentDays: z.array(MemberUsageDayWireSchema).catch([]).default([]),
});

const MemberRuntimeListWireSchema = z.object({
  members: z.array(MemberRuntimeListEntryWireSchema).default([]),
});

const MemberUsageDaysWireSchema = z.object({
  days: z.array(MemberUsageDayWireSchema).default([]),
});

const OrgRuntimeTelemetryWireSchema = z.object({
  runtimeTelemetry: z.object({
    enabled: z.boolean(),
    intervalMinutes: z.number(),
  }),
});

function toListEntry(
  entry: z.output<typeof MemberRuntimeListEntryWireSchema>
): MemberRuntimeListEntry {
  return {
    userId: entry.userId,
    displayName: entry.displayName ?? null,
    avatarUrl: entry.avatarUrl ?? null,
    role: entry.role,
    reportedAt: entry.reportedAt ?? null,
    machine: entry.machine ?? null,
    sample: entry.sample ?? null,
    stats: entry.stats ?? null,
    builderTypeCode: entry.builderTypeCode ?? null,
    profile: entry.profile ?? null,
    installedAgents: entry.installedAgents,
    profileUpdatedAt: entry.profileUpdatedAt ?? null,
    agentsUpdatedAt: entry.agentsUpdatedAt ?? null,
    recentDays: entry.recentDays,
  };
}

// ---------------------------------------------------------------------------
// The five wrappers (frozen signatures — UI consumers import these names)
// ---------------------------------------------------------------------------

/**
 * Member: push status / usage-day / profile parts for the CALLER (the server
 * derives user_id from the JWT). Raises `ORG2_RUNTIME_DISABLED` when the org
 * has telemetry off and `ORG2_RUNTIME_TOO_LARGE` when a part exceeds its
 * server-side cap.
 */
export async function upsertMemberRuntime(
  accessToken: string,
  orgId: string,
  input: UpsertMemberRuntimeInput
): Promise<void> {
  await callMemberRuntimeRpc(MEMBER_RUNTIME_RPC.upsert, accessToken, orgId, {
    p_org_id: orgId,
    ...(input.status !== undefined ? { p_status: input.status } : {}),
    ...(input.usageDays !== undefined ? { p_usage_days: input.usageDays } : {}),
    ...(input.profile !== undefined ? { p_profile: input.profile } : {}),
  });
}

/** Member: one roster entry per active membership, with inline recent days. */
export async function listMemberRuntime(
  accessToken: string,
  orgId: string
): Promise<MemberRuntimeListEntry[]> {
  const payload = await callMemberRuntimeRpc(
    MEMBER_RUNTIME_RPC.list,
    accessToken,
    orgId,
    { p_org_id: orgId }
  );
  return MemberRuntimeListWireSchema.parse(payload).members.map(toListEntry);
}

/** Member: one teammate's usage-day rows over an inclusive UTC-day span. */
export async function getMemberUsage(
  accessToken: string,
  orgId: string,
  userId: string,
  fromDay: string,
  toDay: string
): Promise<MemberUsageDay[]> {
  const payload = await callMemberRuntimeRpc(
    MEMBER_RUNTIME_RPC.getUsage,
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_user_id: userId,
      p_from_day: fromDay,
      p_to_day: toDay,
    }
  );
  return MemberUsageDaysWireSchema.parse(payload).days;
}

/** Member: delete the CALLER's rows from all three member_* tables. */
export async function clearMemberRuntime(
  accessToken: string,
  orgId: string
): Promise<void> {
  await callMemberRuntimeRpc(MEMBER_RUNTIME_RPC.clear, accessToken, orgId, {
    p_org_id: orgId,
  });
}

/**
 * Admin-only: enable/disable org runtime telemetry and set the push
 * interval. The server clamps the interval authoritatively; the returned
 * record is re-clamped locally only as a belt-and-braces mirror.
 */
export async function setOrgRuntimeTelemetry(
  accessToken: string,
  orgId: string,
  enabled: boolean,
  intervalMinutes: number
): Promise<OrgRuntimeTelemetry> {
  const payload = await callMemberRuntimeRpc(
    MEMBER_RUNTIME_RPC.setOrgTelemetry,
    accessToken,
    orgId,
    {
      p_org_id: orgId,
      p_enabled: enabled,
      p_interval_minutes: intervalMinutes,
    }
  );
  const parsed = OrgRuntimeTelemetryWireSchema.parse(payload).runtimeTelemetry;
  return {
    enabled: parsed.enabled,
    intervalMinutes: Math.min(
      RUNTIME_TELEMETRY_MAX_INTERVAL_MINUTES,
      Math.max(
        RUNTIME_TELEMETRY_MIN_INTERVAL_MINUTES,
        Math.round(parsed.intervalMinutes)
      )
    ),
  };
}
