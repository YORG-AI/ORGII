import type { CloudEndpoint } from "./config";
import { getCloudEndpoint, getOfficialCloudEndpoint } from "./config";
import type { CloudShareEndpointProvenance } from "./org2CloudOrgManagement";

/**
 * A custom-cloud share is safe to resolve only when the receiver has already
 * configured that same deployment (including its own publishable key).
 * Share links never provide credentials and never mutate global endpoint or
 * auth state.
 */
export class CloudShareEndpointMismatchError extends Error {
  readonly expectedSupabaseUrl: string;
  readonly currentSupabaseUrl: string;

  constructor(expectedSupabaseUrl: string, currentSupabaseUrl: string) {
    super("Cloud share belongs to a different endpoint");
    this.name = "CloudShareEndpointMismatchError";
    this.expectedSupabaseUrl = expectedSupabaseUrl;
    this.currentSupabaseUrl = currentSupabaseUrl;
  }
}

function normalizedSupabaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * A JWT is scoped to the GoTrue deployment that issued it. Verify that the
 * endpoint selected from share provenance is the endpoint represented by the
 * current auth state before sending the token across a backend boundary.
 */
export function requireCloudShareAuthEndpoint(
  endpoint: CloudEndpoint,
  authSupabaseUrl: string
): CloudEndpoint {
  if (
    normalizedSupabaseUrl(endpoint.supabaseUrl) !==
    normalizedSupabaseUrl(authSupabaseUrl)
  ) {
    throw new CloudShareEndpointMismatchError(
      endpoint.supabaseUrl,
      authSupabaseUrl
    );
  }
  return endpoint;
}

/** Resolve and snapshot the endpoint for the complete resolve → import flow. */
export function resolveCloudShareEndpoint(
  provenance: CloudShareEndpointProvenance
): CloudEndpoint {
  if (provenance.kind === "official") return getOfficialCloudEndpoint();

  const current = getCloudEndpoint();
  if (provenance.kind === "current") return current;
  if (!current.isOfficial && current.supabaseUrl === provenance.supabaseUrl) {
    return current;
  }
  throw new CloudShareEndpointMismatchError(
    provenance.supabaseUrl,
    current.supabaseUrl
  );
}

/** Resolve endpoint provenance persisted beside an imported share token. */
export function resolvePersistedCloudShareEndpoint(
  supabaseUrl?: string
): CloudEndpoint {
  if (!supabaseUrl) return resolveCloudShareEndpoint({ kind: "current" });
  if (supabaseUrl === getOfficialCloudEndpoint().supabaseUrl) {
    return resolveCloudShareEndpoint({ kind: "official" });
  }
  return resolveCloudShareEndpoint({ kind: "custom", supabaseUrl });
}
