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
import {
  type WorktreeLaunchSelection,
  resolveWorktreeSelectionRepoKey,
} from "@src/store/session/worktreeLaunchSourceAtom";

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
  sessionName: string;
  targetKind: SessionTargetKind;
  workspaceFolders: WorkspaceFolderRef[];
  worktreeLaunchSelection: WorktreeLaunchSelection | null;
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

/**
 * Resolve the worktree-related launch fields.
 *
 * Three shapes come out of here, matching the backend's three worktree modes
 * (`launch_rust_agent` in `state/commands/session/launch.rs`):
 *
 *  - Not a worktree launch → `{}` (plain local workspace).
 *  - Reusing an existing worktree path → `{ worktreePath }`. The base ref is
 *    already baked into that checkout, so the picked source metadata is moot.
 *  - Fresh isolated worktree → `{ isolate: true }`, plus `worktreeBaseRef`
 *    when the picked source carries a base ref. The backend's
 *    `create_session_worktree` runs `git worktree add -b agent/<session>
 *    <path> <base>`, so `branch` is literally the git base ref the isolated
 *    worktree is created from. Forwarding the picked source's base ref here
 *    makes the isolated worktree track the chosen PR head / branch / smart
 *    base explicitly, independent of the session's display branch.
 *
 * `resolvedBaseRef` wins over `baseBranch` when present: it is the concrete
 * commit-ish (PR head SHA) that `worktree_resolve_pr_base` fetched, which is
 * what lets fork / cross-repo PRs — whose head branch is not a local ref —
 * actually drive worktree creation. `baseBranch` remains the fallback for
 * branch / smart / same-repo sources that need no fetch.
 *
 * `sourceRef` / `kind` / PR number stay synthetic identifiers with no backend
 * field, so they cannot influence worktree creation and are not forwarded.
 */
export function getWorktreeFields(options: {
  runningLocation: RunningLocation;
  repoId?: string;
  repoPath?: string;
  worktreeLaunchSelection: WorktreeLaunchSelection | null;
}): Partial<SessionLaunchParams> {
  const { runningLocation, repoId, repoPath, worktreeLaunchSelection } =
    options;
  if (runningLocation !== "worktree") {
    return {};
  }

  const repoKey = resolveWorktreeSelectionRepoKey(repoId, repoPath);
  const source =
    repoKey && worktreeLaunchSelection?.repoKey === repoKey
      ? worktreeLaunchSelection.source
      : null;

  if (source?.existingWorktreePath) {
    return { worktreePath: source.existingWorktreePath };
  }

  const base = source?.resolvedBaseRef?.trim() || source?.baseBranch?.trim();
  return {
    isolate: true,
    ...(base ? { worktreeBaseRef: base } : {}),
  };
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
    sessionName,
    targetKind,
    workspaceFolders,
    worktreeLaunchSelection,
  } = options;

  const sessionRepoPath = effectiveSource?.repoPath ?? "";
  const sessionBranch = isSystemPathSource(effectiveSource)
    ? undefined
    : (resolvedKeys.branch ?? effectiveSource?.branch ?? undefined);
  const sessionUsesHostedKey = isHostedKey(resolvedKeys.keySource);
  const hasImages = !!imageDataUrls && imageDataUrls.length > 0;
  if (
    dispatchCategory !== DISPATCH_CATEGORY.RUST_AGENT &&
    dispatchCategory !== DISPATCH_CATEGORY.CLI_AGENT
  ) {
    throw new Error(
      `Unified session launch does not support category: ${dispatchCategory}`
    );
  }
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
    ...getWorktreeFields({
      runningLocation,
      repoId: effectiveSource?.repoId,
      repoPath: effectiveSource?.repoPath,
      worktreeLaunchSelection,
    }),
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
    branch:
      result.worktreeBranch || result.branch || effectiveSource?.branch || "",
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
    ...((result.productMode ?? launchOrgContext?.productMode)
      ? { productMode: result.productMode ?? launchOrgContext?.productMode }
      : {}),
    ...(result.background ? { background: true } : {}),
    ...(result.worktreePath ? { worktreePath: result.worktreePath } : {}),
    ...(result.worktreeBranch ? { worktreeBranch: result.worktreeBranch } : {}),
    ...(result.workspacePath ? { repoPath: result.workspacePath } : {}),
  };
}
