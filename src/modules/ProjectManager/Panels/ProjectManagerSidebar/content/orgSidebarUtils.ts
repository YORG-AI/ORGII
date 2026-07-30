import type { LinearTeamSummary } from "@src/api/http/integrations";
import {
  PROJECT_ORG_SYNC_PROVIDER,
  type ProjectOrg,
} from "@src/api/http/project";
import type { TreeRowNode } from "@src/components/TreeRow";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs/factories/project";

export const ROW_ICON_SIZE = 14;
export const ROW_ICON_STROKE = 1.75;
export const PERSONAL_ORG_ID = "project-sidebar:org:personal";

export interface WorkspaceTreeNode extends TreeRowNode {
  kind:
    | "workspace-projects"
    | "workspace-work-items"
    | "workspace-project-tree"
    | "workspace-project-journey"
    | "workspace-views"
    | "workspace-more";
}

export interface OrgSidebarTreeNode extends TreeRowNode {
  kind:
    | "personal-org-row"
    | "project-org-row"
    | "linear-org-row"
    | "import-orgs-row"
    | "message";
  connectionId?: string;
  teamId?: string;
  teamName?: string;
  projectOrg?: ProjectOrg;
  orgHubId?: string;
}

export interface LinearTeamOrgRecord {
  connectionId: string;
  team: LinearTeamSummary;
}

export function getProjectOrgNodeId(orgId: string): string {
  return `project-sidebar:org:project:${orgId}`;
}

export function getLinearTeamOrgNodeId(
  connectionId: string,
  teamId: string
): string {
  return `project-sidebar:org:linear:${connectionId}:${teamId}`;
}

export function getLinearTeamOrgName(team: LinearTeamSummary): string {
  return `Linear / ${team.name}`;
}

export function isGitFolderSyncedOrg(org?: ProjectOrg): boolean {
  return org?.sync_provider === PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER;
}

export function isNativeProjectOrg(org: ProjectOrg): boolean {
  return org.id !== STORY_PERSONAL_ORG_FILTER_ID;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
