/**
 * Endpoint-level backend capability probe (0005+). `get_cloud_capabilities`
 * is additive: a pre-0005 backend answers PGRST202/404 and the probe resolves
 * to the legacy shape with every flag false. Cached per endpoint for the app
 * session (the 0004 remember-per-endpoint pattern); a restart re-probes, so
 * a live backend upgrade is picked up without client logic.
 */
import { z } from "zod/v4";

import { getCloudEndpoint } from "./config";
import { getCloudCapabilitiesRaw } from "./org2CloudClient";
import { runCloudRequestWithTimeout } from "./org2CloudFetchRetry";

const CLOUD_CAPABILITIES_TIMEOUT_MS = 15_000;

const CloudCapabilitiesWireSchema = z.object({
  broadcastSignals: z.boolean().nullish().catch(undefined),
  storageSegments: z.boolean().nullish().catch(undefined),
  homeEndpoints: z.boolean().nullish().catch(undefined),
  teamInboxMentions: z.boolean().nullish().catch(undefined),
  memberRuntime: z.boolean().nullish().catch(undefined),
});

export interface CloudCapabilities {
  broadcastSignals: boolean;
  storageSegments: boolean;
  homeEndpoints: boolean;
  teamInboxMentions: boolean;
  /** 0010 member-runtime sharing tables/RPCs are present. */
  memberRuntime: boolean;
}

const LEGACY_CAPABILITIES: CloudCapabilities = {
  broadcastSignals: false,
  storageSegments: false,
  homeEndpoints: false,
  teamInboxMentions: false,
  memberRuntime: false,
};

const capabilitiesByEndpoint = new Map<string, CloudCapabilities>();
const inFlightByEndpoint = new Map<string, Promise<CloudCapabilities>>();

export async function getCloudCapabilities(
  accessToken: string
): Promise<CloudCapabilities> {
  const endpointKey = getCloudEndpoint().supabaseUrl;
  const cached = capabilitiesByEndpoint.get(endpointKey);
  if (cached) return cached;
  const inFlight = inFlightByEndpoint.get(endpointKey);
  if (inFlight) return inFlight;
  const probe = (async () => {
    const payload = await runCloudRequestWithTimeout(
      (signal) => getCloudCapabilitiesRaw(accessToken, signal),
      CLOUD_CAPABILITIES_TIMEOUT_MS
    );
    const parsed = CloudCapabilitiesWireSchema.safeParse(payload);
    if (payload === null || !parsed.success) {
      // 404 (pre-0005) and transient failures are indistinguishable here, so
      // answer legacy but do NOT cache — the next connection generation
      // re-probes instead of pinning a healthy backend to the legacy path.
      return LEGACY_CAPABILITIES;
    }
    const capabilities: CloudCapabilities = {
      broadcastSignals: parsed.data.broadcastSignals ?? false,
      storageSegments: parsed.data.storageSegments ?? false,
      homeEndpoints: parsed.data.homeEndpoints ?? false,
      teamInboxMentions: parsed.data.teamInboxMentions ?? false,
      memberRuntime: parsed.data.memberRuntime ?? false,
    };
    capabilitiesByEndpoint.set(endpointKey, capabilities);
    return capabilities;
  })();
  inFlightByEndpoint.set(endpointKey, probe);
  try {
    return await probe;
  } finally {
    inFlightByEndpoint.delete(endpointKey);
  }
}

export const __CAPABILITIES_INTERNALS = {
  reset: () => {
    capabilitiesByEndpoint.clear();
    inFlightByEndpoint.clear();
  },
};
