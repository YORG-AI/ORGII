import { OrgDefinitionSchema } from "@src/api/tauri/rpc/schemas/agentOrgs";

/**
 * Cached tab snapshots are untrusted across app upgrades. Only reuse a Team
 * snapshot when it still matches the current RPC shape; otherwise the tab
 * renderer must reload the canonical definition by entityId.
 */
export function parseCurrentAgentOrgSnapshot(value: unknown) {
  const result = OrgDefinitionSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

type CurrentAgentOrgSnapshot = NonNullable<
  ReturnType<typeof parseCurrentAgentOrgSnapshot>
>;

export function resolveAgentOrgDefinition(
  orgs: readonly CurrentAgentOrgSnapshot[],
  entityId: string,
  entitySnapshot: unknown
): CurrentAgentOrgSnapshot | undefined {
  const canonicalOrg = orgs.find((org) => org.id === entityId);
  if (canonicalOrg) return canonicalOrg;

  const cachedOrg = parseCurrentAgentOrgSnapshot(entitySnapshot);
  return cachedOrg?.id === entityId ? cachedOrg : undefined;
}
