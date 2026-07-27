/**
 * Org → endpoint directory resolvers (design §7 step 3, the client half of
 * the org-sharding lever). A 0007+ `list_my_orgs` row may carry a
 * `homeEndpoint`: the Supabase origin hosting that org's data plane. These
 * pure helpers resolve it against the active endpoint and group a roster by
 * home project. NOT wired into any call site yet — the hook's contract is
 * that a future cutover flips the data and a later PR wires the routing.
 */
import type { CloudEndpoint } from "./config";

function asHttpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.origin !== value) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveOrgEndpoint(
  org: { homeEndpoint?: string },
  official: CloudEndpoint
): CloudEndpoint {
  const home = asHttpsOrigin(org.homeEndpoint);
  if (!home || home === official.supabaseUrl) return official;
  return { ...official, supabaseUrl: home };
}

export interface OrgEndpointGroup<T extends { homeEndpoint?: string }> {
  endpoint: CloudEndpoint;
  orgs: T[];
}

/** Roster partitioned by resolved home project, keyed by `supabaseUrl`. */
export function orgsGroupedByEndpoint<T extends { homeEndpoint?: string }>(
  orgs: readonly T[],
  official: CloudEndpoint
): Map<string, OrgEndpointGroup<T>> {
  const groups = new Map<string, OrgEndpointGroup<T>>();
  for (const org of orgs) {
    const endpoint = resolveOrgEndpoint(org, official);
    const group = groups.get(endpoint.supabaseUrl);
    if (group) {
      group.orgs.push(org);
    } else {
      groups.set(endpoint.supabaseUrl, { endpoint, orgs: [org] });
    }
  }
  return groups;
}
