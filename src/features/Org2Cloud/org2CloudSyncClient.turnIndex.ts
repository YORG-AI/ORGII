/**
 * Session turn index (0012): the owner-published per-round summary and the
 * viewer-side read, both progressive enhancement — a backend without the
 * signatures degrades to a quiet no-op, never a push failure.
 */
import { z } from "zod/v4";

import type { CloudEndpoint } from "./config";
import { getCloudCapabilities } from "./org2CloudCapabilities";
import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import {
  callSyncRpc,
  isRpcSignatureUnsupported,
} from "./org2CloudSyncClient.rpc";

/**
 * One owner-published round summary. The wire is an opaque jsonb array on
 * the server; this is the client-side contract both the pusher and the
 * viewer speak. `turnId` is the SOURCE event id of the round's user message
 * (viewers namespace it into their local copy's id space).
 */
export interface CloudSessionTurnSummary {
  turnId: string;
  /** Truncated user-prompt preview — content, gated by the events ladder. */
  prompt: string;
  eventCount: number;
  bodyEventCount: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  nextTurnId?: string;
}

const CloudSessionTurnSummarySchema = z.object({
  turnId: z.string().min(1),
  prompt: z.string().catch(""),
  eventCount: z.number().int().nonnegative().catch(0),
  bodyEventCount: z.number().int().nonnegative().catch(0),
  startedAt: z.string().nullish().catch(undefined),
  endedAt: z.string().nullish().catch(undefined),
  durationMs: z.number().nullish().catch(undefined),
  nextTurnId: z.string().nullish().catch(undefined),
});

const CloudSessionTurnIndexWireSchema = z.object({
  epoch: z.number().nullish().default(null),
  turns: z.array(z.unknown()).nullish().default(null),
});

export interface CloudSessionTurnIndex {
  epoch: number | null;
  /** null ⇒ no usable index (absent, stale epoch, or legacy backend). */
  turns: CloudSessionTurnSummary[] | null;
}

const NO_TURN_INDEX: CloudSessionTurnIndex = { epoch: null, turns: null };

/** supabaseUrl set of backends that rejected the 0012 signatures. */
const turnIndexUnsupportedEndpoints = new Set<string>();

export const __TURN_INDEX_INTERNALS = {
  resetTurnIndexSupport: () => turnIndexUnsupportedEndpoints.clear(),
};

/**
 * Owner-only: publish the compact per-round index for the session's current
 * epoch. Returns false (a quiet no-op) on backends without 0012 — the
 * feature is progressive enhancement, never a push failure.
 */
export async function upsertSessionTurnIndex(
  accessToken: string,
  orgId: string,
  sessionId: string,
  epoch: number,
  turns: CloudSessionTurnSummary[]
): Promise<boolean> {
  const endpoint = endpointForOrg(orgId);
  if (turnIndexUnsupportedEndpoints.has(endpoint.supabaseUrl)) return false;
  if (!(await getCloudCapabilities(accessToken, endpoint)).sessionTurnIndex) {
    return false;
  }
  try {
    await callSyncRpc(
      "cloud_upsert_session_turn_index",
      accessToken,
      {
        p_org_id: orgId,
        p_session_id: sessionId,
        p_epoch: epoch,
        p_turns: turns,
      },
      endpoint
    );
    return true;
  } catch (error) {
    if (isRpcSignatureUnsupported(error)) {
      turnIndexUnsupportedEndpoints.add(endpoint.supabaseUrl);
      return false;
    }
    throw error;
  }
}

/**
 * Viewer: fetch the owner-published round index. Gated server-side by the
 * exact events-read ladder; absence (no index, stale epoch, legacy backend)
 * is an advisory `turns: null`, never an error — callers fall back to the
 * plain streamed download. Malformed individual rounds are skipped rather
 * than failing the whole index.
 */
export async function getSessionTurnIndex(
  accessToken: string,
  orgId: string,
  sessionId: string,
  options?: {
    shareToken?: string;
    endpoint?: CloudEndpoint;
    signal?: AbortSignal;
  }
): Promise<CloudSessionTurnIndex> {
  const endpoint = options?.endpoint ?? endpointForOrg(orgId);
  if (turnIndexUnsupportedEndpoints.has(endpoint.supabaseUrl)) {
    return NO_TURN_INDEX;
  }
  if (!(await getCloudCapabilities(accessToken, endpoint)).sessionTurnIndex) {
    return NO_TURN_INDEX;
  }
  let payload: unknown;
  try {
    payload = await callSyncRpc(
      "cloud_get_session_turn_index",
      accessToken,
      {
        p_org_id: orgId,
        p_session_id: sessionId,
        ...(options?.shareToken !== undefined
          ? { p_share_token: options.shareToken }
          : {}),
      },
      endpoint,
      options?.signal
    );
  } catch (error) {
    if (isRpcSignatureUnsupported(error)) {
      turnIndexUnsupportedEndpoints.add(endpoint.supabaseUrl);
      return NO_TURN_INDEX;
    }
    throw error;
  }
  const parsed = CloudSessionTurnIndexWireSchema.safeParse(payload);
  if (!parsed.success) return NO_TURN_INDEX;
  if (parsed.data.turns === null) {
    return { epoch: parsed.data.epoch, turns: null };
  }
  const turns: CloudSessionTurnSummary[] = [];
  for (const entry of parsed.data.turns) {
    const turn = CloudSessionTurnSummarySchema.safeParse(entry);
    if (!turn.success) continue;
    turns.push({
      turnId: turn.data.turnId,
      prompt: turn.data.prompt,
      eventCount: turn.data.eventCount,
      bodyEventCount: turn.data.bodyEventCount,
      ...(turn.data.startedAt != null
        ? { startedAt: turn.data.startedAt }
        : {}),
      ...(turn.data.endedAt != null ? { endedAt: turn.data.endedAt } : {}),
      ...(turn.data.durationMs != null
        ? { durationMs: turn.data.durationMs }
        : {}),
      ...(turn.data.nextTurnId != null
        ? { nextTurnId: turn.data.nextTurnId }
        : {}),
    });
  }
  return { epoch: parsed.data.epoch, turns };
}
