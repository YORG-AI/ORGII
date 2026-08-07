import {
  buildCloudOrgSelectorValue,
  parseCloudOrgSelectorValue,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";

export interface OrgSelectorLocalOrg {
  id: string;
  name: string;
  external_org_id?: string;
}

export interface OrgSelectorCloudOrg {
  orgId: string;
  name: string;
}

export type OrgSelectorEntryKind = "personal" | "local" | "cloud";

export interface OrgSelectorEntry {
  value: string;
  label: string;
  kind: OrgSelectorEntryKind;
  cloudOrgId?: string;
}

export interface BuildOrgSelectorEntriesInput {
  personalOrgId: string;
  personalLabel: string;
  localOrgs: readonly OrgSelectorLocalOrg[];
  cloudOrgs: readonly OrgSelectorCloudOrg[];
  localSuffix: string;
}

/**
 * Translate a privacy-scoped sidebar value into the local project-org id used
 * by the Project API. Cloud selector values are deliberately namespaced, while
 * project rows belong to the durable local alias and therefore need an
 * explicit boundary mapping before filtering.
 */
export function resolveProjectOrgScopeId(
  selectorValue: string,
  localOrgs: readonly OrgSelectorLocalOrg[]
): string {
  const cloudOrgId = parseCloudOrgSelectorValue(selectorValue);
  if (!cloudOrgId) return selectorValue;
  return (
    localOrgs.find((org) => org.external_org_id === cloudOrgId)?.id ??
    localOrgs.find((org) => org.id === cloudOrgId)?.id ??
    cloudOrgId
  );
}

/**
 * Scope-selector entry list. Cloud scopes come ONLY from the live roster
 * (`cloudOrgs`); local project-orgs are a separate feature and render as
 * their own group.
 *
 * A local project-org row is hidden when it is merely the local backing row
 * for a cloud org (`external_org_id` set, or its OWN id is a roster org id —
 * the pre-alias era stored the cloud org id as the local id). Once the
 * roster HAS loaded, an aliased row absent from it means the cloud org no
 * longer exists — hidden too, so dead cloud-era orgs never linger as
 * selectable scopes. Aliased rows are never selector entries themselves:
 * while signed out / offline / mid-fetch, showing one as a local org would
 * leak a stale cloud workspace and grant it the wrong local semantics.
 *
 * Name collisions are disambiguated: a local org sharing a name with a cloud
 * org gets the local suffix; duplicate cloud names get a short org-id suffix.
 */
export function buildOrgSelectorEntries({
  personalOrgId,
  personalLabel,
  localOrgs,
  cloudOrgs,
  localSuffix,
}: BuildOrgSelectorEntriesInput): OrgSelectorEntry[] {
  const entries: OrgSelectorEntry[] = [
    { value: personalOrgId, label: personalLabel, kind: "personal" },
  ];
  const liveCloudOrgIds = new Set(cloudOrgs.map((org) => org.orgId));
  const cloudNames = new Set(cloudOrgs.map((org) => org.name));
  const cloudNameCounts = new Map<string, number>();
  for (const org of cloudOrgs) {
    cloudNameCounts.set(org.name, (cloudNameCounts.get(org.name) ?? 0) + 1);
  }

  const seenLocalIds = new Set([personalOrgId]);
  for (const org of localOrgs) {
    if (seenLocalIds.has(org.id)) continue;
    if (liveCloudOrgIds.has(org.id)) continue;
    if (org.external_org_id) continue;
    seenLocalIds.add(org.id);
    entries.push({
      value: org.id,
      label: cloudNames.has(org.name)
        ? `${org.name} · ${localSuffix}`
        : org.name,
      kind: "local",
    });
  }

  for (const org of cloudOrgs) {
    entries.push({
      value: buildCloudOrgSelectorValue(org.orgId),
      label:
        (cloudNameCounts.get(org.name) ?? 0) > 1
          ? `${org.name} · ${org.orgId.slice(0, 8)}`
          : org.name,
      kind: "cloud",
      cloudOrgId: org.orgId,
    });
  }

  return entries;
}
