/**
 * Endpoint-level backend capability probe (0005+). `get_cloud_capabilities`
 * is additive: a pre-0005 backend answers PGRST202/404 and the probe resolves
 * to the legacy shape with every flag false. Cached per endpoint for the app
 * session (the 0004 remember-per-endpoint pattern); a restart re-probes, so
 * a live backend upgrade is picked up without client logic.
 */
import { z } from "zod/v4";

import { getCloudEndpoint } from "./config";
import {
  type CloudRpcEndpoint,
  getCloudCapabilitiesRaw,
} from "./org2CloudClient";
import { runCloudRequestWithTimeout } from "./org2CloudFetchRetry";

const CLOUD_CAPABILITIES_TIMEOUT_MS = 15_000;

const CloudCapabilitiesWireSchema = z.object({
  broadcastSignals: z.boolean().nullish().catch(undefined),
  storageSegments: z.boolean().nullish().catch(undefined),
  homeEndpoints: z.boolean().nullish().catch(undefined),
  teamInboxMentions: z.boolean().nullish().catch(undefined),
  memberRuntime: z.boolean().nullish().catch(undefined),
  sessionTurnIndex: z.boolean().nullish().catch(undefined),
  offlineSync: z.boolean().nullish().catch(undefined),
  orgChannels: z.boolean().nullish().catch(undefined),
  orgChannelMessages: z.boolean().nullish().catch(undefined),
  orgChannelMessagesIdempotency: z.boolean().nullish().catch(undefined),
  conversationEvents: z.boolean().nullish().catch(undefined),
});

export interface CloudCapabilities {
  broadcastSignals: boolean;
  storageSegments: boolean;
  homeEndpoints: boolean;
  teamInboxMentions: boolean;
  /** 0010 member-runtime sharing tables/RPCs are present. */
  memberRuntime: boolean;
  /** 0012 per-round turn-index table/RPCs are present. */
  sessionTurnIndex: boolean;
  /** 0013 legacy-named background-upload policy flag/setter are present. */
  offlineSync: boolean;
  /** 0014 org-channels tables/RPCs are present. */
  orgChannels: boolean;
  /** The org-channel MESSAGE plane (post/edit/delete/list/read-cursor). */
  orgChannelMessages: boolean;
  /** 0016 `p_client_key` on post — a WIRE change, so posts key only when set. */
  orgChannelMessagesIdempotency: boolean;
  /** 0024 multi-writer conversation-events plane (push/list RPCs). */
  conversationEvents: boolean;
}

const LEGACY_CAPABILITIES: CloudCapabilities = {
  broadcastSignals: false,
  storageSegments: false,
  homeEndpoints: false,
  teamInboxMentions: false,
  memberRuntime: false,
  sessionTurnIndex: false,
  offlineSync: false,
  orgChannels: false,
  orgChannelMessages: false,
  orgChannelMessagesIdempotency: false,
  conversationEvents: false,
};

export interface CloudCapabilitiesProbeResult {
  capabilities: CloudCapabilities;
  /**
   * True when the endpoint actually answered with a parseable payload (the
   * cached/happy path below) — a CONFIRMED read, including a confirmed
   * pre-0010 backend that legitimately lacks a flag. False when the probe
   * itself never got a usable answer (pre-0005 404, a transient transport
   * failure, or a hard timeout): the legacy shape returned in that case is
   * only an ASSUMPTION standing in for "we don't actually know yet", and
   * callers that gate long blackout periods on the result should treat it
   * very differently from a confirmed legacy backend.
   */
  confirmed: boolean;
}

const capabilitiesByEndpoint = new Map<string, CloudCapabilities>();
const inFlightByEndpoint = new Map<
  string,
  Promise<CloudCapabilitiesProbeResult>
>();

async function probeCloudCapabilities(
  accessToken: string,
  endpointKey: string,
  endpoint?: CloudRpcEndpoint
): Promise<CloudCapabilitiesProbeResult> {
  try {
    const payload = await runCloudRequestWithTimeout(
      (signal) => getCloudCapabilitiesRaw(accessToken, signal, endpoint),
      CLOUD_CAPABILITIES_TIMEOUT_MS
    );
    const parsed = CloudCapabilitiesWireSchema.safeParse(payload);
    if (payload === null || !parsed.success) {
      // 404 (pre-0005) and transient failures are indistinguishable here, so
      // answer legacy but do NOT cache — the next connection generation
      // re-probes instead of pinning a healthy backend to the legacy path.
      return { capabilities: LEGACY_CAPABILITIES, confirmed: false };
    }
    const capabilities: CloudCapabilities = {
      broadcastSignals: parsed.data.broadcastSignals ?? false,
      storageSegments: parsed.data.storageSegments ?? false,
      homeEndpoints: parsed.data.homeEndpoints ?? false,
      teamInboxMentions: parsed.data.teamInboxMentions ?? false,
      memberRuntime: parsed.data.memberRuntime ?? false,
      sessionTurnIndex: parsed.data.sessionTurnIndex ?? false,
      offlineSync: parsed.data.offlineSync ?? false,
      orgChannels: parsed.data.orgChannels ?? false,
      orgChannelMessages: parsed.data.orgChannelMessages ?? false,
      orgChannelMessagesIdempotency:
        parsed.data.orgChannelMessagesIdempotency ?? false,
      conversationEvents: parsed.data.conversationEvents ?? false,
    };
    capabilitiesByEndpoint.set(endpointKey, capabilities);
    return { capabilities, confirmed: true };
  } catch {
    // The probe never completed (e.g. `runCloudRequestWithTimeout`'s hard
    // deadline firing) — treat exactly like an absent/unparseable response:
    // legacy, unconfirmed, uncached.
    return { capabilities: LEGACY_CAPABILITIES, confirmed: false };
  }
}

/**
 * Endpoint capability probe that also reports whether the legacy shape is a
 * CONFIRMED read (the backend answered) or merely ASSUMED (the probe failed
 * to get an answer at all). Used by callers that need to react differently
 * to "this backend genuinely predates the feature" vs. "we couldn't reach it
 * this time" — see the member-runtime push scheduler's capability blackout.
 */
export async function getCloudCapabilitiesConfirmed(
  accessToken: string,
  endpoint?: CloudRpcEndpoint
): Promise<CloudCapabilitiesProbeResult> {
  // Per-endpoint routing: home-endpoint orgs answer for their OWN backend.
  // Probing the default endpoint for a per-org feature gate reads the wrong
  // server's capability set (fails toward "off", but wrongly).
  const endpointKey = (endpoint ?? getCloudEndpoint()).supabaseUrl;
  const cached = capabilitiesByEndpoint.get(endpointKey);
  if (cached) return { capabilities: cached, confirmed: true };
  const inFlight = inFlightByEndpoint.get(endpointKey);
  if (inFlight) return inFlight;
  const probe = probeCloudCapabilities(accessToken, endpointKey, endpoint);
  inFlightByEndpoint.set(endpointKey, probe);
  try {
    return await probe;
  } finally {
    inFlightByEndpoint.delete(endpointKey);
  }
}

export async function getCloudCapabilities(
  accessToken: string,
  endpoint?: CloudRpcEndpoint
): Promise<CloudCapabilities> {
  return (await getCloudCapabilitiesConfirmed(accessToken, endpoint))
    .capabilities;
}

export const __CAPABILITIES_INTERNALS = {
  reset: () => {
    capabilitiesByEndpoint.clear();
    inFlightByEndpoint.clear();
  },
};
