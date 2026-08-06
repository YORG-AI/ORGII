import type { SessionLaunchResult } from "@src/api/tauri/agent/session";

import type { Session } from "./types";

export type CreatedSessionContext = Partial<
  Pick<
    Session,
    | "orgId"
    | "projectId"
    | "projectName"
    | "projectSlug"
    | "workItemId"
    | "agentRole"
    | "productMode"
  >
>;

export interface BuildCreatedSessionRecordOptions {
  result: SessionLaunchResult;
  repoName?: string;
  fallbackRepoPath?: string;
  fallbackBranch?: string;
  fallbackCliAgentType?: Session["cliAgentType"];
  isActive?: boolean;
  agentExecMode?: string;
  agentDefinitionId?: string;
  agentIconId?: string;
  agentDisplayName?: string;
  parentSessionId?: string;
  context?: CreatedSessionContext;
}

/**
 * Convert the canonical `session_launch` response into the shared frontend
 * entity shape. Backend response fields win; caller context only fills values
 * that the launch response may omit.
 */
export function buildCreatedSessionRecord({
  result,
  repoName = "",
  fallbackRepoPath,
  fallbackBranch,
  fallbackCliAgentType,
  isActive = !result.background,
  agentExecMode,
  agentDefinitionId,
  agentIconId,
  agentDisplayName,
  parentSessionId,
  context,
}: BuildCreatedSessionRecordOptions): Session {
  const orgId = result.orgId ?? context?.orgId;
  const projectId = result.projectId ?? context?.projectId;
  const projectName = result.projectName ?? context?.projectName;
  const projectSlug = result.projectSlug ?? context?.projectSlug;
  const workItemId = result.workItemId ?? context?.workItemId;
  const agentRole = result.agentRole ?? context?.agentRole;
  const productMode = result.productMode ?? context?.productMode;

  return {
    session_id: result.sessionId,
    status: result.status,
    created_at: result.createdAt,
    updated_at: result.createdAt,
    user_input: result.userInput || result.name,
    repo_name: repoName,
    name: result.name,
    branch: result.worktreeBranch || result.branch || fallbackBranch || "",
    is_active: isActive,
    category: result.category as Session["category"],
    model: result.model ?? undefined,
    cliAgentType: result.cliAgentType ?? fallbackCliAgentType ?? undefined,
    ...(agentExecMode ? { agentExecMode } : {}),
    ...(agentDefinitionId ? { agentDefinitionId } : {}),
    ...(agentIconId ? { agentIconId } : {}),
    ...(agentDisplayName ? { agentDisplayName } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(result.agentOrgId ? { agentOrgId: result.agentOrgId } : {}),
    ...(result.accountId ? { accountId: result.accountId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(productMode ? { productMode } : {}),
    ...(result.background ? { background: true } : {}),
    ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
    ...(result.worktreeBranch ? { worktreeBranch: result.worktreeBranch } : {}),
    ...((result.workspacePath ?? fallbackRepoPath)
      ? { repoPath: result.workspacePath ?? fallbackRepoPath }
      : {}),
  };
}
