import { parseCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { DEFAULT_SESSION_ORG_ID, type Session } from "@src/store/session";

/** Org ids a session may carry to match one namespaced org-selector value. */
export function buildSessionOrgFilterIds(
  selectedOrgId: string
): ReadonlySet<string> {
  const ids = new Set([selectedOrgId]);
  // Cloud imports/forks persist the bare cloud id while the selector uses
  // `cloud:<id>`. Accept both representations at this one shared boundary.
  const cloudOrgId = parseCloudOrgSelectorValue(selectedOrgId);
  if (cloudOrgId) ids.add(cloudOrgId);
  return ids;
}

/** True when the session belongs to the selected org scope (or no scope). */
export function sessionMatchesOrgFilter(
  session: Pick<Session, "orgId">,
  selectedOrgIds: ReadonlySet<string> | undefined
): boolean {
  if (!selectedOrgIds || selectedOrgIds.size === 0) return true;
  return selectedOrgIds.has(session.orgId ?? DEFAULT_SESSION_ORG_ID);
}
