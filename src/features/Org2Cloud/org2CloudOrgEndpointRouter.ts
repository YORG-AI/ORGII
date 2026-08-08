/**
 * Org → data-plane endpoint router (sharding Phase A — wires the 0007
 * directory that `org2CloudEndpointDirectory` resolves but nothing
 * consumed). The engine publishes the roster's resolved endpoints here
 * each pass; org-scoped data-plane calls ask `endpointForOrg` instead of
 * assuming the official project.
 *
 * Fallback posture: an org with no entry — or whose `homeEndpoint` failed
 * the https-origin validation upstream — routes to the official endpoint,
 * so a pre-0007 backend or an empty directory behaves exactly as before.
 * The directory is process-local state, not persisted: it is rebuilt from
 * the roster on every pass, so a cutover (or rollback) takes effect on
 * the next pass without restart.
 */
import type { CloudEndpoint } from "./config";
import { getCloudEndpoint } from "./config";

const orgEndpoints = new Map<string, CloudEndpoint>();
/** Shard anon keys by https origin — per-project, not per-org. Empty until
 * a Phase B cutover publishes real shard keys; a routed origin with no key
 * falls back to the official anon key (harmless: the shard rejects it,
 * which fails closed rather than silently mixing projects). */
const anonKeyByOrigin = new Map<string, string>();

export function setAnonKeyDirectory(
  entries: ReadonlyArray<readonly [origin: string, anonKey: string]>
): void {
  anonKeyByOrigin.clear();
  for (const [origin, anonKey] of entries) anonKeyByOrigin.set(origin, anonKey);
}

export function setOrgEndpointDirectory(
  entries: ReadonlyArray<readonly [orgId: string, endpoint: CloudEndpoint]>
): void {
  orgEndpoints.clear();
  for (const [orgId, endpoint] of entries) {
    orgEndpoints.set(orgId, endpoint);
  }
}

export function endpointForOrg(orgId: string): CloudEndpoint {
  const endpoint = orgEndpoints.get(orgId) ?? getCloudEndpoint();
  const shardKey = anonKeyByOrigin.get(endpoint.supabaseUrl);
  return shardKey ? { ...endpoint, anonKey: shardKey } : endpoint;
}

/**
 * Endpoint for a connection that is already pinned to an https origin (the
 * realtime socket follows `auth.supabaseUrl`, not an org id). Falls back to
 * the official endpoint when the origin is not a routed shard.
 */
export function endpointForOrigin(supabaseUrl: string): CloudEndpoint {
  const official = getCloudEndpoint();
  const anonKey = anonKeyByOrigin.get(supabaseUrl);
  if (supabaseUrl === official.supabaseUrl) return official;
  return { ...official, supabaseUrl, anonKey: anonKey ?? official.anonKey };
}

export function resetOrgEndpointDirectory(): void {
  orgEndpoints.clear();
  anonKeyByOrigin.clear();
}
