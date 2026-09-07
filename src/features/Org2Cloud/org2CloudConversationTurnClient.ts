import { z } from "zod/v4";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import {
  fetchWithTransportRetry,
  runCloudRequestWithTimeout,
} from "./org2CloudFetchRetry";

const CONVERSATION_TURN_RPC_TIMEOUT_MS = 15_000;

const TurnStatusSchema = z.enum([
  "queued",
  "claimed",
  "accepted",
  "completed",
  "failed",
  "cancelled",
]);
const TerminalTurnStatusSchema = z.enum(["completed", "failed", "cancelled"]);

const AdmitConversationTurnSchema = z.object({
  turnId: z.string(),
  enqueueSeq: z.number().int().safe().positive(),
  status: TurnStatusSchema,
  firstSeq: z.number().int().safe().positive(),
  lastSeq: z.number().int().safe().positive(),
});

const ClaimConversationTurnSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    turnId: z.string(),
    status: z.literal("claimed"),
    enqueueSeq: z.number().int().safe().positive(),
    leaseExpiresAt: z.string(),
  }),
  z.object({
    outcome: z.literal("accepted"),
    turnId: z.string(),
    status: z.literal("accepted"),
    enqueueSeq: z.number().int().safe().positive(),
    leaseExpiresAt: z.string(),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    outcome: z.literal("waiting"),
    turnId: z.string(),
    status: TurnStatusSchema,
    enqueueSeq: z.number().int().safe().positive(),
    headTurnId: z.string().optional(),
    headStatus: TurnStatusSchema.optional(),
    leaseExpiresAt: z.string().optional(),
    retryAfterMs: z.number().int().nonnegative(),
  }),
  z.object({
    outcome: z.literal("terminal"),
    turnId: z.string(),
    status: TerminalTurnStatusSchema,
    enqueueSeq: z.number().int().safe().positive(),
  }),
]);

const RenewConversationTurnSchema = z.object({
  turnId: z.string(),
  status: z.enum(["claimed", "accepted"]),
  leaseExpiresAt: z.string(),
});

const AcceptConversationTurnSchema = z.object({
  turnId: z.string(),
  status: z.literal("accepted"),
  acceptedAt: z.string(),
  leaseExpiresAt: z.string(),
});

const FinishConversationTurnSchema = z.object({
  turnId: z.string(),
  status: TerminalTurnStatusSchema,
  finishedAt: z.string(),
});

export type CloudConversationTurnClaim = z.output<
  typeof ClaimConversationTurnSchema
>;
export type CloudConversationTurnTerminalStatus = z.output<
  typeof TerminalTurnStatusSchema
>;

export class Org2CloudConversationTurnError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudConversationTurnError";
    this.status = status;
  }
}

async function callConversationTurnRpc<T>(
  functionName: string,
  schema: z.ZodType<T>,
  accessToken: string,
  body: Record<string, unknown>,
  endpoint: Pick<CloudEndpoint, "supabaseUrl" | "anonKey"> = getCloudEndpoint()
): Promise<T> {
  const payload = await runCloudRequestWithTimeout(async (signal) => {
    const response = await fetchWithTransportRetry(
      `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`,
      {
        method: "POST",
        headers: {
          apikey: endpoint.anonKey,
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
        },
        body: JSON.stringify(body),
        signal,
      }
    );
    const text = await response.text();
    let decoded: unknown = null;
    try {
      decoded = text ? JSON.parse(text) : null;
    } catch {
      decoded = null;
    }
    if (!response.ok) {
      const message =
        decoded && typeof decoded === "object" && "message" in decoded
          ? String((decoded as { message: unknown }).message)
          : `org2_cloud rpc ${functionName} failed with ${response.status}`;
      throw new Org2CloudConversationTurnError(message, response.status);
    }
    return decoded;
  }, CONVERSATION_TURN_RPC_TIMEOUT_MS);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Org2CloudConversationTurnError(
      `unparseable ${functionName} payload`
    );
  }
  return parsed.data;
}

interface ConversationTurnIdentity {
  orgId: string;
  rootSessionId: string;
  turnId: string;
}

interface ClaimedConversationTurnIdentity extends ConversationTurnIdentity {
  deviceId: string;
}

export function admitCloudConversationTurn(
  accessToken: string,
  params: ConversationTurnIdentity & { event: SessionEvent },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
) {
  return callConversationTurnRpc(
    "cloud_admit_conversation_turn",
    AdmitConversationTurnSchema,
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_event: params.event,
    },
    endpoint
  );
}

export function claimCloudConversationTurn(
  accessToken: string,
  params: ClaimedConversationTurnIdentity & { leaseSeconds: number },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
): Promise<CloudConversationTurnClaim> {
  return callConversationTurnRpc(
    "cloud_claim_conversation_turn",
    ClaimConversationTurnSchema,
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_device_id: params.deviceId,
      p_lease_seconds: params.leaseSeconds,
    },
    endpoint
  );
}

export function renewCloudConversationTurn(
  accessToken: string,
  params: ClaimedConversationTurnIdentity & { leaseSeconds: number },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
) {
  return callConversationTurnRpc(
    "cloud_renew_conversation_turn",
    RenewConversationTurnSchema,
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_device_id: params.deviceId,
      p_lease_seconds: params.leaseSeconds,
    },
    endpoint
  );
}

export function markCloudConversationTurnAccepted(
  accessToken: string,
  params: ClaimedConversationTurnIdentity & { leaseSeconds: number },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
) {
  return callConversationTurnRpc(
    "cloud_mark_conversation_turn_accepted",
    AcceptConversationTurnSchema,
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_device_id: params.deviceId,
      p_lease_seconds: params.leaseSeconds,
    },
    endpoint
  );
}

export function finishCloudConversationTurn(
  accessToken: string,
  params: ClaimedConversationTurnIdentity & {
    status: CloudConversationTurnTerminalStatus;
  },
  endpoint?: Pick<CloudEndpoint, "supabaseUrl" | "anonKey">
) {
  return callConversationTurnRpc(
    "cloud_finish_conversation_turn",
    FinishConversationTurnSchema,
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_turn_id: params.turnId,
      p_device_id: params.deviceId,
      p_status: params.status,
    },
    endpoint
  );
}
