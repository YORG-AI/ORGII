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

/** Resolve a namespaced picker value to the local project-org backing id. */
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
 * Canonical cloud/local organization picker entries. Local cloud aliases are
 * hidden, personal scope is emitted once, and duplicate labels are qualified.
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
