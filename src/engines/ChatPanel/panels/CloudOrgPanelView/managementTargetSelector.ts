import {
  buildCloudOrgSelectorValue,
  parseCloudOrgSelectorValue,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";

const LOCAL_REPO_SELECTOR_PREFIX = "local-repo:";
const LOCAL_WORKSPACE_SELECTOR_PREFIX = "local-workspace:";

export type ManagementTarget =
  | { kind: "cloud-org"; id: string }
  | { kind: "local-repo"; id: string }
  | { kind: "local-workspace"; id: string };

export { buildCloudOrgSelectorValue };

export function buildLocalRepoSelectorValue(repoId: string): string {
  return `${LOCAL_REPO_SELECTOR_PREFIX}${repoId}`;
}

export function buildLocalWorkspaceSelectorValue(workspaceId: string): string {
  return `${LOCAL_WORKSPACE_SELECTOR_PREFIX}${workspaceId}`;
}

function parsePrefixedId(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const id = value.slice(prefix.length);
  return id || null;
}

export function parseManagementTarget(value: string): ManagementTarget | null {
  const cloudOrgId = parseCloudOrgSelectorValue(value);
  if (cloudOrgId) return { kind: "cloud-org", id: cloudOrgId };

  const localRepoId = parsePrefixedId(value, LOCAL_REPO_SELECTOR_PREFIX);
  if (localRepoId) return { kind: "local-repo", id: localRepoId };

  const localWorkspaceId = parsePrefixedId(
    value,
    LOCAL_WORKSPACE_SELECTOR_PREFIX
  );
  return localWorkspaceId
    ? { kind: "local-workspace", id: localWorkspaceId }
    : null;
}
