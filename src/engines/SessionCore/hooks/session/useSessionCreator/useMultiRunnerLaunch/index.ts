/**
 * Multi-runner launch — the same prompt, started once per runner.
 *
 * This composes the ordinary launch path rather than replacing it:
 * `resolveKeys` and `buildSessionLaunchPayload` already take every per-call
 * input as a parameter (only `useSessionLaunch` reads the global creator
 * atoms), so a fan-out is a loop over the same two functions with a different
 * `AdvancedConfig` each time.
 *
 * The one thing it overrides is isolation: N agents sharing one working tree
 * corrupt each other's results, so every runner launches with
 * `runningLocation: "worktree"` regardless of the launcher's setting. The
 * backend names the branch `agent/<session>`, so N runners passing `isolate`
 * land on N distinct trees with no extra plumbing.
 */
import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import type { RefObject } from "react";

import { sessionLaunch } from "@src/api/tauri/agent/session";
import { KEY_SOURCE } from "@src/api/tauri/session";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import { markTurnRunning } from "@src/engines/SessionCore/control/turnLifecycle";
import { createCliAvailabilityResolver } from "@src/features/SessionCreator/components/RunnerListPanel/resolveRunnerAgent";
import {
  MULTI_RUNNER_LAUNCH_ERROR,
  MULTI_RUNNER_LAUNCH_STAGGER_MS,
  type MultiRunnerLaunchError,
  type Runner,
  type RunnerBlocker,
  canLaunchGroup,
  resolveRunnerBlocker,
  resolveRunnerConfig,
  validateMultiRunnerLaunch,
} from "@src/features/SessionCreator/multiRunner/contract";
import {
  RUN_OUTCOME,
  type RunGroup,
  resolveRunGroupTitle,
} from "@src/features/SessionCreator/multiRunner/runGroupContract";
import { createLogger } from "@src/hooks/logger";
import { useSecretScanGuard } from "@src/hooks/security/useSecretScanGuard";
import type { AvailableCliAgent } from "@src/modules/MainApp/AgentOrgs/types";
import { collectAdeContext } from "@src/services/context/collectors";
import { openRunGroupInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  SESSION_TARGET_KIND,
  loadSidebarSessions,
  sessionCreatorDraftAtom,
  upsertSession,
} from "@src/store/session";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { creatorDefaultProductModeAtom } from "@src/store/session/creatorDefaultProductModeAtom";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import { sessionCreatorRunnersAtom } from "@src/store/session/multiRunnerAtom";
import { upsertRunGroupAtom } from "@src/store/session/runGroupsAtom";
import { worktreeLaunchSelectionAtom } from "@src/store/session/worktreeLaunchSourceAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";

import { prepareLaunchInput } from "../useSessionLaunch/inputPreparation";
import {
  buildSessionFromLaunchResult,
  buildSessionLaunchPayload,
} from "../useSessionLaunch/launchPayload";
import { confirmShortInputIfNeeded } from "../useSessionLaunch/launchValidation";
import { resolveKeys } from "../useSessionLaunch/resolveKeys";
import type { SessionLaunchWorkItemContext } from "../useSessionLaunch/types";
import { fanOutRunners, sanitizeWorktreeSelectionForFanOut } from "./fanOut";

const log = createLogger("useMultiRunnerLaunch");

/**
 * Every runner runs isolated. Not a default the user can override: a shared
 * working tree makes the comparison meaningless AND destroys the work.
 */
const MULTI_RUNNER_RUNNING_LOCATION = "worktree" as const;

/** Explicit map so the i18n key checker can see every key this hook renders. */
const LAUNCH_ERROR_KEY: Record<MultiRunnerLaunchError, string> = {
  [MULTI_RUNNER_LAUNCH_ERROR.NO_PROMPT]:
    "creator.multiRunner.launchError.noPrompt",
  [MULTI_RUNNER_LAUNCH_ERROR.PROMPT_TOO_LONG]:
    "creator.multiRunner.launchError.promptTooLong",
  [MULTI_RUNNER_LAUNCH_ERROR.NO_REPO]: "creator.multiRunner.launchError.noRepo",
  [MULTI_RUNNER_LAUNCH_ERROR.NOT_ENOUGH_RUNNERS]:
    "creator.multiRunner.launchError.notEnoughRunners",
};

class RunnerKeyResolutionError extends Error {
  constructor() {
    super("Could not resolve a key for this runner");
    this.name = "RunnerKeyResolutionError";
  }
}

export interface UseMultiRunnerLaunchOptions {
  /** True only for the Compare-runners launcher surface. */
  enabled: boolean;
  cliAgents: AvailableCliAgent[];
  composerInputRef: RefObject<ComposerInputRef | null>;
  editorContent: string;
  effectiveSource: SessionSource | null;
  imageDataUrls?: string[];
  clearImages?: () => void;
  sessionName: string;
  workItemContext?: SessionLaunchWorkItemContext;
  resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
  onAuthError: () => void;
  t: TFunction;
}

export interface UseMultiRunnerLaunchReturn {
  runners: Runner[];
  blockers: Record<string, RunnerBlocker | null>;
  eligibleCount: number;
  canLaunch: boolean;
  isLaunching: boolean;
  /** Returns true when a group was created (even if some runners failed). */
  launchGroup: () => Promise<boolean>;
}

export function useMultiRunnerLaunch(
  options: UseMultiRunnerLaunchOptions
): UseMultiRunnerLaunchReturn {
  const {
    enabled,
    cliAgents,
    composerInputRef,
    editorContent,
    effectiveSource,
    imageDataUrls,
    clearImages,
    sessionName,
    workItemContext,
    resolveWorkItemContext,
    onAuthError,
    t,
  } = options;

  const runners = useAtomValue(sessionCreatorRunnersAtom);
  const agentExecMode = useAtomValue(creatorDefaultExecModeAtom);
  const creatorProductMode = useAtomValue(creatorDefaultProductModeAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const worktreeLaunchSelection = useAtomValue(worktreeLaunchSelectionAtom);
  const upsertRunGroup = useSetAtom(upsertRunGroupAtom);
  const openRunGroupTab = useSetAtom(openRunGroupInChatPanelTabAtom);
  const clearDraft = useSetAtom(sessionCreatorDraftAtom);
  const guardAgainstSecrets = useSecretScanGuard();
  const [isLaunching, setIsLaunching] = useState(false);

  const resolveCliAvailability = useMemo(
    () => createCliAvailabilityResolver(cliAgents),
    [cliAgents]
  );

  const resolveBlocker = useCallback(
    (runner: Runner) =>
      resolveRunnerBlocker({ runner, resolveCliAvailability }),
    [resolveCliAvailability]
  );

  const blockers = useMemo(() => {
    const byRunnerId: Record<string, RunnerBlocker | null> = {};
    for (const runner of runners) {
      byRunnerId[runner.id] = resolveBlocker(runner);
    }
    return byRunnerId;
  }, [resolveBlocker, runners]);

  const eligibleCount = useMemo(
    () => Object.values(blockers).filter((blocker) => blocker === null).length,
    [blockers]
  );

  const launchGroup = useCallback(async (): Promise<boolean> => {
    if (isLaunching) return false;

    const launchErrors = validateMultiRunnerLaunch({
      editorContent,
      repoId: effectiveSource?.repoId,
      eligibleCount,
    });
    if (launchErrors.length > 0) {
      Message.error(
        t(LAUNCH_ERROR_KEY[launchErrors[0] as MultiRunnerLaunchError])
      );
      return false;
    }
    if (!(await confirmShortInputIfNeeded(editorContent, t))) return false;
    if (!(await guardAgainstSecrets(editorContent))) return false;

    const { agentInput } = await prepareLaunchInput({
      editorContent,
      effectiveSource,
      composerInputRef,
    });

    setIsLaunching(true);
    try {
      const resolvedWorkItemContext = resolveWorkItemContext
        ? await resolveWorkItemContext()
        : workItemContext;
      if (resolveWorkItemContext && !resolvedWorkItemContext) return false;

      const adeContext = collectAdeContext({
        expectedRepoPath: effectiveSource?.repoPath || null,
      });
      const fanOutWorktreeSelection = sanitizeWorktreeSelectionForFanOut(
        worktreeLaunchSelection
      );

      const entries = await fanOutRunners({
        runners,
        resolveBlocker,
        stagger: () =>
          new Promise((resolve) =>
            window.setTimeout(resolve, MULTI_RUNNER_LAUNCH_STAGGER_MS)
          ),
        onLaunchError: (runner, error) =>
          log.warn(`Runner ${runner.id} failed to launch`, error),
        launchRunner: async (runner) => {
          const runnerConfig = resolveRunnerConfig(runner);
          const resolvedKeys = await resolveKeys(
            runnerConfig.keySource ?? KEY_SOURCE.OWN,
            runnerConfig,
            { onAuthError }
          );
          if (!resolvedKeys) throw new RunnerKeyResolutionError();

          const { launchParams } = buildSessionLaunchPayload({
            agentExecMode,
            agentInput,
            advancedConfig: runnerConfig,
            dispatchCategory: runner.dispatchCategory,
            effectiveSource,
            adeContext,
            imageDataUrls,
            isBackgroundLaunch: true,
            resolvedKeys,
            runningLocation: MULTI_RUNNER_RUNNING_LOCATION,
            selectedAgentDefId: runner.agentDefinitionId ?? null,
            selectedAgentOrgId: null,
            sessionName,
            targetKind: SESSION_TARGET_KIND.AGENT,
            workspaceFolders,
            worktreeLaunchSelection: fanOutWorktreeSelection,
          });

          const result = await sessionLaunch({
            ...launchParams,
            ...(creatorProductMode && !resolvedWorkItemContext?.productMode
              ? { productMode: creatorProductMode }
              : {}),
            ...(resolvedWorkItemContext
              ? {
                  orgId: resolvedWorkItemContext.orgId,
                  projectId: resolvedWorkItemContext.projectId,
                  projectName: resolvedWorkItemContext.projectName,
                  projectSlug: resolvedWorkItemContext.projectSlug,
                  ...(resolvedWorkItemContext.workItemId
                    ? { workItemId: resolvedWorkItemContext.workItemId }
                    : {}),
                  ...(resolvedWorkItemContext.productMode
                    ? { productMode: resolvedWorkItemContext.productMode }
                    : {}),
                }
              : {}),
          });

          upsertSession(
            buildSessionFromLaunchResult({
              agentExecMode,
              effectiveSource,
              isBackgroundLaunch: true,
              launchCliAgentType: launchParams.platform,
              launchOrgContext: resolvedWorkItemContext ?? undefined,
              result,
            })
          );
          markTurnRunning(result.sessionId);
          return result.sessionId;
        },
      });

      const group: RunGroup = {
        id: crypto.randomUUID(),
        prompt: agentInput,
        createdAt: new Date().toISOString(),
        repoPath: effectiveSource?.repoPath,
        repoName: effectiveSource?.repoName,
        baseBranch: effectiveSource?.branch,
        entries,
      };
      upsertRunGroup(group);

      if (imageDataUrls && imageDataUrls.length > 0) clearImages?.();
      clearDraft(null);
      composerInputRef.current?.clear();
      void loadSidebarSessions({ forceRefresh: true }).catch(
        (error: unknown) => {
          log.warn("Failed to refresh sidebar after fan-out", error);
        }
      );

      openRunGroupTab({
        runGroupId: group.id,
        title: resolveRunGroupTitle(group.prompt),
      });

      // A group with zero launched runners is still a group: showing it beats
      // a silent no-op, because the panel is where every failure reason is.
      return entries.some((entry) => entry.outcome === RUN_OUTCOME.LAUNCHED);
    } finally {
      setIsLaunching(false);
    }
  }, [
    agentExecMode,
    clearDraft,
    clearImages,
    composerInputRef,
    creatorProductMode,
    editorContent,
    effectiveSource,
    eligibleCount,
    guardAgainstSecrets,
    imageDataUrls,
    isLaunching,
    onAuthError,
    openRunGroupTab,
    resolveBlocker,
    resolveWorkItemContext,
    runners,
    sessionName,
    t,
    upsertRunGroup,
    workItemContext,
    workspaceFolders,
    worktreeLaunchSelection,
  ]);

  return {
    runners,
    blockers,
    eligibleCount,
    canLaunch: enabled && canLaunchGroup(eligibleCount),
    isLaunching,
    launchGroup,
  };
}
