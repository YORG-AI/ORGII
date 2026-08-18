import {
  getIdentityErrorCode,
  identityClient,
} from "@src/features/Identity/identityClient";
import { readIdentitySnapshot } from "@src/features/Identity/identitySnapshotAtom";
import { getActiveIdentitySession } from "@src/features/Identity/identityTypes";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("API");

/**
 * Obtain one short-lived Hosted access lease. Refresh, retry classification,
 * rotation CAS, and single-flight ownership all live in the native Broker.
 */
export async function getOrRefreshHostedToken(): Promise<string | null> {
  const session = getActiveIdentitySession(
    readIdentitySnapshot(),
    "hosted_service_legacy"
  );
  if (!session || session.status === "reauth_required") return null;

  try {
    const lease = await identityClient.getHostedServiceAccessLease({
      sessionId: session.sessionId,
      generation: session.generation,
    });
    return lease.accessToken;
  } catch (error) {
    const code = getIdentityErrorCode(error);
    if (
      code !== "identity_session_not_found" &&
      code !== "identity_reauth_required" &&
      code !== "identity_access_refresh_rejected"
    ) {
      log.warn("Hosted access lease unavailable:", code ?? "unknown");
    }
    return null;
  }
}
