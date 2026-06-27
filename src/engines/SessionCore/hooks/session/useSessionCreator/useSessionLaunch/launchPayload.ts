import type {
  SessionLaunchParams,
  SessionLaunchResult,
} from "@src/api/tauri/agent/session";
import {
  DISPATCH_CATEGORY,
  type DispatchCategory,
  isHostedKey,
} from "@src/api/tauri/session";
import type {
  AgentExecMode,
  RunningLocation,
} from "@src/config/sessionCreatorConfig";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { isSystemPathSource } from "@src/features/SessionCreator/utils/systemPathSource";
import type { WorkspaceSnapshot } from "@src/services/context/workspaceSnapshot";
import {
  SESSION_TARGET_KIND,
  type Session,
  type SessionStatus,
  type SessionTargetKind,
} from "@src/store/session";
import type {
  SessionLaunchOrgContext,
  SessionSource,
} from "@src/store/session/creatorStateAtom";

import type { ResolvedKeys } from "./resolveKeys";

export interface WorkspaceFolderRef {
  path: string;
}

export interface BuildSessionLaunchParamsOptions {
  agentExecMode: AgentExecMode;
  agentInput: string;
  advancedConfig: AdvancedConfig;
  dispatchCategory: DispatchCategory;
  effectiveSource: SessionSource | null;
  adeContext: WorkspaceSnapshot | undefined;
  imageDataUrls: string[] | undefined;
  isBackgroundLaunch: boolean;
  resolvedKeys: ResolvedKeys;
  runningLocation: RunningLocation;
  selectedAgentDefId: string | null;
  selectedAgentOrgId: string | null;
  selectedWorktreePath: string | null;
  sessionName: string;
  targetKind: SessionTargetKind;
  workspaceFolders: WorkspaceFolderRef[];
}

interface BuildLaunchPayloadResult {
  launchParams: SessionLaunchParams;
  hasImages: boolean;
  sessionUsesHostedKey: boolean;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * Loose comparison key for matching the session repo path against ADE
 * workspace folder paths: trailing slashes stripped + case-insensitive
 * (macOS default filesystems are case-insensitive, and the two sides
 * may come from differently-cased sources). Canonical-path comparison
 * is the backend's job — this only guards launch-time seeding against
 * trivial formatting drift.
 */
function looseMatchKey(path: string): string {
  return normalizePath(path).toLowerCase();
}

function getAdditionalDirectories(
  sessionRepoPath: string,
  workspaceFolders: WorkspaceFolderRef[]
): string[] {
  const normalizedProject = sessionRepoPath
    ? normalizePath(sessionRepoPath)
    : "";
  if (!normalizedProject || workspaceFolders.length === 0) {
    return [];
  }

  const exactMatch = workspaceFolders.some(
    (folder) => normalizePath(folder.path) === normalizedProject
  );

  const projectKey = looseMatchKey(normalizedProject);
  const looseMatch =
    exactMatch ||
    workspaceFolders.some(
      (folder) => looseMatchKey(folder.path) === projectKey
    );

  if (!exactMatch && looseMatch) {
    // Raw console.warn kept intentionally: asserted by launchPayload.test.ts.
    console.warn(
      "[launchPayload] session repoPath only loose-matched a workspace folder (trailing slash / case drift) — proceeding with loose match",
      {
        sessionRepoPath,
        workspaceFolderPaths: workspaceFolders.map((folder) => folder.path),
      }
    );
  }

  if (!looseMatch) {
    const dropped = workspaceFolders
      .map((folder) => normalizePath(folder.path))
      .filter((path) => path && looseMatchKey(path) !== projectKey);
    if (dropped.length > 0) {
      // Raw console.warn kept intentionally: asserted by launchPayload.test.ts.
      console.warn(
        "[launchPayload] session repoPath is not among the ADE workspace folders — dropping additional directories",
        { sessionRepoPath, droppedDirectories: dropped }
      );
    }
    return [];
  }

  return workspaceFolders
    .map((folder) => normalizePath(folder.path))
    .filter((path) => path && looseMatchKey(path) !== projectKey);
}

function getRustAgentIdentityFields(options: {
  isRustAgent: boolean;
  selectedAgentDefId: string | null;
  selectedAgentOrgId: string | null;
  targetKind: SessionTargetKind;
}): Partial<SessionLaunchParams> {
  const { isRustAgent, selectedAgentDefId, selectedAgentOrgId, targetKind } =
    options;

  if (
    isRustAgent &&
    targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
    selectedAgentOrgId
  ) {
    return { agentOrgId: selectedAgentOrgId };
  }

  if (isRustAgent && selectedAgentDefId) {
    return { agentDefinitionId: selectedAgentDefId };
  }

  return {};
}

function getWorktreeFields(options: {
  runningLocation: RunningLocation;
  selectedWorktreePath: string | null;
}): Partial<SessionLaunchParams> {
  const { runningLocation, selectedWorktreePath } = options;
  if (runningLocation !== "worktree") {
    return {};
  }

  return selectedWorktreePath
    ? { worktreePath: selectedWorktreePath }
    : { isolate: true };
}

export function buildSessionLaunchPayload(
  options: BuildSessionLaunchParamsOptions
): BuildLaunchPayloadResult {
  const {
    agentExecMode,
    agentInput,
    advancedConfig,
    dispatchCategory,
    effectiveSource,
    adeContext,
    imageDataUrls,
    isBackgroundLaunch,
    resolvedKeys,
    runningLocation,
    selectedAgentDefId,
    selectedAgentOrgId,
    selectedWorktreePath,
    sessionName,
    targetKind,
    workspaceFolders,
  } = options;

  const sessionRepoPath = effectiveSource?.repoPath ?? "";
  const sessionBranch = isSystemPathSource(effectiveSource)
    ? undefined
    : (resolvedKeys.branch ?? effectiveSource?.branch ?? undefined);
  const sessionUsesHostedKey = isHostedKey(resolvedKeys.keySource);
  const hasImages = !!imageDataUrls && imageDataUrls.length > 0;
  const isRustAgent = dispatchCategory === DISPATCH_CATEGORY.RUST_AGENT;
  const additionalDirectories = getAdditionalDirectories(
    sessionRepoPath,
    workspaceFolders
  );

  const launchParams: SessionLaunchParams = {
    category: dispatchCategory,
    content: agentInput,
    workspacePath: sessionRepoPath || undefined,
    keySource: resolvedKeys.keySource,
    accountId: resolvedKeys.accountId,
    model: resolvedKeys.model,
    platform: resolvedKeys.cliAgentType,
    branch: sessionBranch,
    hostedToken: resolvedKeys.hostedToken,
    tier: resolvedKeys.tier,
    name: sessionName || undefined,
    background: isBackgroundLaunch,
    ...(hasImages ? { images: imageDataUrls } : {}),
    ...(adeContext ? { ideContext: adeContext } : {}),
    ...getRustAgentIdentityFields({
      isRustAgent,
      selectedAgentDefId,
      selectedAgentOrgId,
      targetKind,
    }),
    ...(selectedAgentOrgId && advancedConfig.agentOrgMemberOverrides
      ? { agentOrgMemberOverrides: advancedConfig.agentOrgMemberOverrides }
      : {}),
    ...(selectedAgentOrgId &&
    advancedConfig.applyAgentOrgMemberOverridesForFuture !== false
      ? { applyAgentOrgMemberOverridesForFuture: true }
      : {}),
    ...(dispatchCategory === DISPATCH_CATEGORY.RUST_AGENT ||
    dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT
      ? { mode: agentExecMode }
      : {}),
    ...(isRustAgent && resolvedKeys.nativeHarnessType
      ? { nativeHarnessType: resolvedKeys.nativeHarnessType }
      : {}),
    ...getWorktreeFields({ runningLocation, selectedWorktreePath }),
    ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
  };

  return {
    launchParams,
    hasImages,
    sessionUsesHostedKey,
  };
}

const AGENT_ORG_ICON_ID = "network";

export function buildSessionFromLaunchResult(options: {
  agentExecMode: AgentExecMode;
  effectiveSource: SessionSource | null;
  isBackgroundLaunch: boolean;
  launchCliAgentType?: SessionLaunchResult["cliAgentType"];
  launchOrgContext?: Partial<SessionLaunchOrgContext>;
  result: SessionLaunchResult;
}): Session {
  const {
    agentExecMode,
    effectiveSource,
    isBackgroundLaunch,
    launchCliAgentType,
    launchOrgContext,
    result,
  } = options;

  return {
    session_id: result.sessionId,
    status: result.status as SessionStatus,
    created_at: result.createdAt,
    updated_at: result.createdAt,
    user_input: result.userInput || result.name,
    repo_name: effectiveSource?.repoName ?? "",
    name: result.name,
    branch: result.branch || effectiveSource?.branch || "",
    is_active: !isBackgroundLaunch,
    category: result.category as
      | typeof DISPATCH_CATEGORY.RUST_AGENT
      | typeof DISPATCH_CATEGORY.CLI_AGENT,
    model: result.model ?? undefined,
    cliAgentType: result.cliAgentType ?? launchCliAgentType ?? undefined,
    agentExecMode,
    ...(result.agentOrgId
      ? { agentIconId: AGENT_ORG_ICON_ID, agentOrgId: result.agentOrgId }
      : {}),
    ...(result.accountId ? { accountId: result.accountId } : {}),
    ...((result.orgId ?? launchOrgContext?.orgId)
      ? { orgId: result.orgId ?? launchOrgContext?.orgId }
      : {}),
    ...((result.projectId ?? launchOrgContext?.projectId)
      ? { projectId: result.projectId ?? launchOrgContext?.projectId }
      : {}),
    ...((result.projectName ?? launchOrgContext?.projectName)
      ? { projectName: result.projectName ?? launchOrgContext?.projectName }
      : {}),
    ...((result.projectSlug ?? launchOrgContext?.projectSlug)
      ? { projectSlug: result.projectSlug ?? launchOrgContext?.projectSlug }
      : {}),
    ...((result.workItemId ?? launchOrgContext?.workItemId)
      ? { workItemId: result.workItemId ?? launchOrgContext?.workItemId }
      : {}),
    ...((result.agentRole ?? launchOrgContext?.agentRole)
      ? { agentRole: result.agentRole ?? launchOrgContext?.agentRole }
      : {}),
    ...(result.background ? { background: true } : {}),
    ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
    ...(result.workspacePath ? { repoPath: result.workspacePath } : {}),
  };
}
