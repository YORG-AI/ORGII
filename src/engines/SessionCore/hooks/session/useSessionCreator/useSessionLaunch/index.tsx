/**
 * useSessionLaunch Hook
 *
 * Validates input, resolves keys, calls the unified launchSession() pipeline,
 * then handles state updates and navigation.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { sessionLaunch } from "@src/api/tauri/agent/session";
import { DISPATCH_CATEGORY, KEY_SOURCE } from "@src/api/tauri/session";
import { beginOptimisticTurn } from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { markTurnRunning } from "@src/engines/SessionCore/control/turnLifecycle";
import {
  loadSessionAtom,
  pendingSyntheticEventAtom,
} from "@src/engines/SessionCore/core/atoms";
import { SESSION_CREATOR_LAUNCH_MODE } from "@src/features/SessionCreator/types";
import { autoTagLaunchedSessionToActiveCloudOrg } from "@src/features/TeamCollaboration/autoTagNewSession";
import { createLogger } from "@src/hooks/logger";
import { useSecretScanGuard } from "@src/hooks/security/useSecretScanGuard";
import { collectAdeContext } from "@src/services/context/collectors";
import {
  activeSessionIdAtom,
  dispatchCategoryAtom,
  loadSidebarSessions,
  selectedAgentDefinitionIdAtom,
  selectedAgentOrgIdAtom,
  sessionCreatorDraftAtom,
  sessionSourceAtom,
  sessionTargetKindAtom,
  upsertSession,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { lastUserMessageAtom } from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { creatorDefaultProductModeAtom } from "@src/store/session/creatorDefaultProductModeAtom";
import { runningLocationAtom } from "@src/store/session/runningLocationAtom";
import { worktreeLaunchSelectionAtom } from "@src/store/session/worktreeLaunchSourceAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { triggerSessionExpired } from "@src/store/ui/uiAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { emitOpenWorkspace } from "@src/util/ui/window/windowManager";

import { prepareLaunchInput } from "./inputPreparation";
import { handleNonCursorLaunchError } from "./launchErrorHandling";
import { handleSessionNavigation } from "./launchHelpers";
import { isBackgroundLaunchMode } from "./launchMode";
import {
  buildSessionFromLaunchResult,
  buildSessionLaunchPayload,
} from "./launchPayload";
import {
  confirmShortInputIfNeeded,
  showValidationErrors,
} from "./launchValidation";
import { resolveKeys } from "./resolveKeys";
import { injectSyntheticUserEventIfNeeded } from "./syntheticEvents";
import type { UseSessionLaunchOptions, UseSessionLaunchReturn } from "./types";
import { useWalletModalState } from "./walletModalState";

export type { UseSessionLaunchOptions, UseSessionLaunchReturn } from "./types";

const log = createLogger("useSessionLaunch");

export function useSessionLaunch(
  options: UseSessionLaunchOptions
): UseSessionLaunchReturn {
  const {
    effectiveSource,
    editorContent,
    sessionName,
    advancedConfig,
    isContentEmpty,
    validateSessionConfig,
    composerInputRef,
    onLaunchSuccess,
    launchMode = SESSION_CREATOR_LAUNCH_MODE.START_FOREGROUND,
    workItemContext,
    resolveWorkItemContext,
    imageDataUrls,
    clearImages,
  } = options;

  const { t } = useTranslation("sessions");
  const guardAgainstSecrets = useSecretScanGuard();
  const [isLoading, setIsLoading] = useState(false);
  const {
    closeAddFundsModal,
    closeBuyCreditsModal,
    setShowAddFundsModal,
    setShowBuyCreditsModal,
    showAddFundsModal,
    showBuyCreditsModal,
  } = useWalletModalState();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatchCategory = useAtomValue(dispatchCategoryAtom);
  const targetKind = useAtomValue(sessionTargetKindAtom);
  const selectedAgentDefId = useAtomValue(selectedAgentDefinitionIdAtom);
  const selectedAgentOrgId = useAtomValue(selectedAgentOrgIdAtom);
  const agentExecMode = useAtomValue(creatorDefaultExecModeAtom);
  const creatorProductMode = useAtomValue(creatorDefaultProductModeAtom);
  const runningLocation = useAtomValue(runningLocationAtom);
  const worktreeLaunchSelection = useAtomValue(worktreeLaunchSelectionAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const clearDraft = useSetAtom(sessionCreatorDraftAtom);
  const dispatchLoadSession = useSetAtom(loadSessionAtom);
  const setPendingSyntheticEvent = useSetAtom(pendingSyntheticEventAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const setWorkstationActiveSessionId = useSetAtom(
    workstationActiveSessionIdAtom
  );
  const setStationMode = useSetAtom(stationModeAtom);
  const setLastUserMessage = useSetAtom(lastUserMessageAtom);
  const setSessionSource = useSetAtom(sessionSourceAtom);
  const showAuthError = useCallback(() => {
    triggerSessionExpired();
  }, []);

  const navigateToLaunchedSession = useCallback(
    (sessionId: string, forceNavigate: boolean) => {
      handleSessionNavigation({
        sessionId,
        locationPathname: location.pathname,
        navigate,
        setActiveSessionId,
        setWorkstationActiveSessionId,
        clearDraft,
        setStationMode,
        forceNavigate,
        onLaunchSuccess,
      });
    },
    [
      clearDraft,
      location.pathname,
      navigate,
      onLaunchSuccess,
      setActiveSessionId,
      setStationMode,
      setWorkstationActiveSessionId,
    ]
  );

  const handleLaunch = useCallback(async () => {
    if (isLoading) return false;

    const validation = validateSessionConfig();
    if (!validation.valid) {
      showValidationErrors(validation);
      return false;
    }

    const confirmedShortInput = await confirmShortInputIfNeeded(
      editorContent,
      t
    );
    if (!confirmedShortInput) return false;

    const clearedSecretScan = await guardAgainstSecrets(editorContent);
    if (!clearedSecretScan) return false;

    const { agentInput, userInput } = await prepareLaunchInput({
      editorContent,
      effectiveSource,
      composerInputRef,
    });

    const isBackgroundLaunch = isBackgroundLaunchMode(launchMode);

    setIsLoading(true);

    try {
      const keySource = advancedConfig.keySource ?? KEY_SOURCE.OWN;
      const resolvedKeys = await resolveKeys(keySource, advancedConfig, {
        onAuthError: () => {
          clearDraft(null);
          showAuthError();
        },
      });

      if (!resolvedKeys) return false;

      const resolvedWorkItemContext = resolveWorkItemContext
        ? await resolveWorkItemContext()
        : workItemContext;
      if (resolveWorkItemContext && !resolvedWorkItemContext) return false;

      const adeContext = collectAdeContext({
        expectedRepoPath: effectiveSource?.repoPath || null,
      });
      const { hasImages, launchParams, sessionUsesHostedKey } =
        buildSessionLaunchPayload({
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
        });

      const result = await sessionLaunch({
        ...launchParams,
        // Creator-selected Project mode (§5.2): stamp the product axis on
        // kinds that carry it. An explicit work-item context wins below.
        ...(creatorProductMode &&
        !resolvedWorkItemContext?.productMode &&
        (dispatchCategory === "rust_agent" || dispatchCategory === "cli_agent")
          ? { productMode: creatorProductMode }
          : {}),
        ...(resolvedWorkItemContext
          ? {
              orgId: resolvedWorkItemContext.orgId,
              projectId: resolvedWorkItemContext.projectId,
              projectName: resolvedWorkItemContext.projectName,
              ...(resolvedWorkItemContext.workItemId
                ? { workItemId: resolvedWorkItemContext.workItemId }
                : {}),
              ...(resolvedWorkItemContext.productMode
                ? { productMode: resolvedWorkItemContext.productMode }
                : {}),
              ...(resolvedWorkItemContext.agentDefinitionId
                ? {
                    agentDefinitionId:
                      resolvedWorkItemContext.agentDefinitionId,
                  }
                : {}),
              ...(resolvedWorkItemContext.agentExecMode
                ? { mode: resolvedWorkItemContext.agentExecMode }
                : {}),
              agentRole: resolvedWorkItemContext.agentRole,
              projectSlug: resolvedWorkItemContext.projectSlug,
            }
          : {}),
      });

      if (imageDataUrls && imageDataUrls.length > 0) {
        clearImages?.();
      }

      upsertSession(
        buildSessionFromLaunchResult({
          agentExecMode,
          effectiveSource,
          isBackgroundLaunch,
          launchCliAgentType: launchParams.platform,
          launchOrgContext: resolvedWorkItemContext ?? undefined,
          result,
        })
      );
      void autoTagLaunchedSessionToActiveCloudOrg({
        sessionId: result.sessionId,
        repoPath: effectiveSource?.repoPath ?? null,
        launchOrgId: resolvedWorkItemContext?.orgId ?? null,
      }).catch((error: unknown) => {
        log.warn("Failed to auto-tag launched session to cloud org", error);
      });
      if (selectedAgentOrgId) {
        void loadSidebarSessions({ forceRefresh: true }).catch(
          (error: unknown) => {
            log.warn(
              "Failed to refresh sidebar after Agent Team launch",
              error
            );
          }
        );
      }

      injectSyntheticUserEventIfNeeded({
        dispatchLoadSession,
        hasImages,
        imageDataUrls,
        isBackgroundLaunch,
        isContentEmpty,
        sessionId: result.sessionId,
        setLastUserMessage,
        setPendingSyntheticEvent,
        userInput,
      });

      // The launch dispatched this session's first turn — open it in the
      // turn-lifecycle FSM so follow-up submits queue until the provider
      // delivers the turn's terminal.
      markTurnRunning(result.sessionId);

      if (isBackgroundLaunch) {
        clearDraft(null);
        onLaunchSuccess?.({
          sessionId: result.sessionId,
          workItemContext: resolvedWorkItemContext ?? undefined,
        });
      } else {
        if (
          dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT &&
          !sessionUsesHostedKey
        ) {
          void emitOpenWorkspace(
            result.sessionId,
            effectiveSource?.repoId ?? "",
            "Quick"
          );
        }
        navigateToLaunchedSession(result.sessionId, sessionUsesHostedKey);
        // After navigation: the pipeline atom now points at the launched
        // session, so the session-gated status write is accepted and the
        // planning indicator covers the gap until Rust's first status event.
        // `beginOptimisticTurn` (not a raw status write) also records a
        // session-scoped "recently started" marker so the session-switch
        // effect that `setActiveSessionId` just scheduled does NOT reset this
        // session's running back to idle — that reset used to erase the
        // launch's running and leave slow providers (deepseek) showing no
        // footer / no Stop until the first stream event arrived seconds later.
        beginOptimisticTurn(result.sessionId, "launch");
      }

      setSessionSource(null);
      return true;
    } catch (error) {
      log.error("Error creating session:", error);
      handleNonCursorLaunchError({
        advancedConfig,
        clearDraft,
        error,
        setShowAddFundsModal,
        setShowBuyCreditsModal,
        showAuthError,
        t,
      });
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [
    isLoading,
    validateSessionConfig,
    editorContent,
    t,
    guardAgainstSecrets,
    creatorProductMode,
    effectiveSource,
    composerInputRef,
    launchMode,
    dispatchCategory,
    advancedConfig,
    clearDraft,
    showAuthError,
    agentExecMode,
    imageDataUrls,
    isContentEmpty,
    runningLocation,
    selectedAgentDefId,
    selectedAgentOrgId,
    sessionName,
    targetKind,
    workspaceFolders,
    worktreeLaunchSelection,
    clearImages,
    dispatchLoadSession,
    setLastUserMessage,
    setPendingSyntheticEvent,
    onLaunchSuccess,
    workItemContext,
    resolveWorkItemContext,
    navigateToLaunchedSession,
    setSessionSource,
    setShowAddFundsModal,
    setShowBuyCreditsModal,
  ]);

  return {
    isLoading,
    handleLaunch,
    showAddFundsModal,
    closeAddFundsModal,
    showBuyCreditsModal,
    closeBuyCreditsModal,
  };
}
