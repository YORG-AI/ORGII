/**
 * Sidebar session ↔ org-selector matching.
 *
 * Cloud imports / forks stamp `Session.orgId` with the BARE cloud org id,
 * while the selector registers cloud orgs under the namespaced
 * `cloud:<orgId>` value — a cloud selection must accept both. Sessions with
 * no `orgId` (personal work, guest share-imports) group under
 * DEFAULT_SESSION_ORG_ID ("Personal").
 */
import { parseCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { DEFAULT_SESSION_ORG_ID, type Session } from "@src/store/session";

/** Org ids a session may carry to match the current selector value. */
export function buildSessionOrgFilterIds(
  selectedOrgId: string
): ReadonlySet<string> {
  const ids = new Set([selectedOrgId]);
  // Cloud scope (`cloud:<id>`): imports/forks are stamped with the BARE
  // cloud org id, so a cloud selection accepts it alongside the namespaced
  // selector value. Explicitly-tagged sessions are matched separately (by
  // session id) via UseSessionMenuItemsParams.extraSessionIds.
  const cloudOrgId = parseCloudOrgSelectorValue(selectedOrgId);
  if (cloudOrgId) {
    ids.add(cloudOrgId);
  }
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
