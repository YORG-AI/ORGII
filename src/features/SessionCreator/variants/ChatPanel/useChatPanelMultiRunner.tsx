/**
 * Multi-runner wiring for the launchpad composer.
 *
 * Multi-runner is its own launcher surface — the **Compare runners** entry in
 * the launchpad's More menu — not a mode the Session launcher toggles into.
 * This hook owns everything that surface adds: the runner list in place of the
 * agent hero, the seeding that guarantees it is never empty, the
 * forced-worktree interception, and the launch handler that fans out instead
 * of launching one session.
 */
import type { TFunction } from "i18next";
import { useSetAtom } from "jotai";
import { ChevronLeft } from "lucide-react";
import React, { useCallback, useEffect, useMemo } from "react";

import type { DispatchCategory } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import { useMultiRunnerLaunch } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useMultiRunnerLaunch";
import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import type {
  AgentDefinition,
  AvailableCliAgent,
  OrgMemberRuntimeConfig,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import type { SessionSource } from "@src/store/session/creatorStateAtom";
import {
  addRunnerAtom,
  clearRunnersAtom,
  removeRunnerAtom,
  setRunnerAgentAtom,
  setRunnerRuntimeConfigAtom,
} from "@src/store/session/multiRunnerAtom";
import { triggerSessionExpired } from "@src/store/ui/uiAtom";

import { toAgentRuntimeConfig } from "../../agentRuntimeConfig";
import RunnerListPanel from "../../components/RunnerListPanel";
import type { RunningLocation } from "../../config";
import {
  MULTI_RUNNER_MIN,
  canRemoveRunner,
  isMultiRunnerCategory,
} from "../../multiRunner/contract";
import type { AdvancedConfig } from "../../types";

interface UseChatPanelMultiRunnerOptions {
  /** True only for the Compare-runners launcher surface. */
  enabled: boolean;
  advancedConfig: AdvancedConfig;
  allAgents: AgentDefinition[];
  cliAgents: AvailableCliAgent[];
  cliAgentType: CliAgentType | null;
  composerInputRef: React.RefObject<ComposerInputRef | null>;
  dispatchCategory: DispatchCategory;
  editorContent: string;
  effectiveSource: SessionSource | null;
  imageDataUrls?: string[];
  clearImages?: () => void;
  selectedAgentDefinitionId: string | null;
  sessionName: string;
  workItemContext?: SessionLaunchWorkItemContext;
  resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
  onWorktreeLocationChange: (location: RunningLocation) => void;
  /** Leave the Compare-runners surface for the single-agent launcher. */
  onExit: () => void;
  t: TFunction<"sessions">;
}

interface UseChatPanelMultiRunnerResult {
  isActive: boolean;
  /** Middle-slot content replacing the agent hero and launchpad cards. */
  middleContent: React.ReactNode;
  canLaunch: boolean;
  isLaunching: boolean;
  launchGroup: () => Promise<boolean>;
  /** Location-change handler that refuses to leave worktree while active. */
  handleWorktreeLocationChange: (location: RunningLocation) => void;
  /** Label for the locked location pill, or undefined in single mode. */
  worktreeSourceLabel: string | undefined;
}

export function useChatPanelMultiRunner({
  enabled,
  advancedConfig,
  allAgents,
  cliAgents,
  cliAgentType,
  composerInputRef,
  dispatchCategory,
  editorContent,
  effectiveSource,
  imageDataUrls,
  clearImages,
  selectedAgentDefinitionId,
  sessionName,
  workItemContext,
  resolveWorkItemContext,
  onWorktreeLocationChange,
  onExit,
  t,
}: UseChatPanelMultiRunnerOptions): UseChatPanelMultiRunnerResult {
  const addRunner = useSetAtom(addRunnerAtom);
  const removeRunner = useSetAtom(removeRunnerAtom);
  const clearRunners = useSetAtom(clearRunnersAtom);
  const setRunnerAgent = useSetAtom(setRunnerAgentAtom);
  const setRunnerRuntimeConfig = useSetAtom(setRunnerRuntimeConfigAtom);

  const handleAuthError = useCallback(() => {
    triggerSessionExpired();
  }, []);

  // Wrapped: the raw atom setter takes a seed, and a bare `onClick` handler
  // would hand it the React event as that seed.
  const handleAddRunner = useCallback(() => {
    addRunner();
  }, [addRunner]);

  const { runners, blockers, canLaunch, isLaunching, launchGroup } =
    useMultiRunnerLaunch({
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
      onAuthError: handleAuthError,
      t,
    });

  /**
   * Seed the first row from whatever the launcher is already pointed at, so
   * turning the mode on never throws away the selection the user just made.
   * Cursor IDE and Work log cannot fan out, so those start from an empty row.
   */
  const seedFromCurrentSelection = useCallback(() => {
    if (!isMultiRunnerCategory(dispatchCategory)) {
      addRunner();
      return;
    }
    addRunner({
      dispatchCategory,
      cliAgentType: cliAgentType ?? undefined,
      agentDefinitionId: selectedAgentDefinitionId ?? undefined,
      runtimeConfig: toAgentRuntimeConfig(advancedConfig),
    });
  }, [
    addRunner,
    advancedConfig,
    cliAgentType,
    dispatchCategory,
    selectedAgentDefinitionId,
  ]);

  /**
   * Arriving on an empty list seeds it. The first row mirrors whatever the
   * Session launcher was pointed at, so switching over never throws away a
   * selection; the second is deliberately empty — an empty row asks "compare
   * it against what?", where a duplicate would quietly run the same config
   * twice.
   */
  useEffect(() => {
    if (!enabled || runners.length > 0) return;
    seedFromCurrentSelection();
    for (let index = 1; index < MULTI_RUNNER_MIN; index += 1) handleAddRunner();
  }, [enabled, handleAddRunner, runners.length, seedFromCurrentSelection]);

  /**
   * Leaving drops the rows as well as the surface. Keeping them would silently
   * re-open a stale comparison the next time Compare runners is picked, when
   * the honest default is to seed from whatever the launcher is pointed at now.
   */
  const handleExit = useCallback(() => {
    clearRunners();
    onExit();
  }, [clearRunners, onExit]);

  const handleAgentSelect = useCallback(
    (runnerId: string, selection: AgentSelection) => {
      setRunnerAgent({ runnerId, selection });
    },
    [setRunnerAgent]
  );

  const handleRuntimeConfigChange = useCallback(
    (runnerId: string, runtimeConfig: OrgMemberRuntimeConfig) => {
      setRunnerRuntimeConfig({ runnerId, runtimeConfig });
    },
    [setRunnerRuntimeConfig]
  );

  const handleWorktreeLocationChange = useCallback(
    (location: RunningLocation) => {
      if (enabled && location !== "worktree") {
        Message.info(t("creator.multiRunner.worktreeForced"));
        return;
      }
      onWorktreeLocationChange(location);
    },
    [enabled, onWorktreeLocationChange, t]
  );

  const middleContent = useMemo(
    () =>
      enabled ? (
        <div className="flex w-full flex-col items-center gap-4">
          <div className="flex w-full items-center justify-center gap-1">
            <Button
              variant="tertiary"
              size="small"
              shape="round"
              icon={
                <ChevronLeft size={16} strokeWidth={1.9} className="block" />
              }
              iconOnly
              title={t("creator.multiRunner.exit")}
              aria-label={t("creator.multiRunner.exit")}
              onClick={handleExit}
              className="shrink-0"
              data-testid="session-creator-multi-runner-exit"
            />
            <h1 className="min-w-0 text-center text-[18px] font-normal leading-relaxed tracking-tight text-text-1 sm:text-[20px]">
              {t("creator.multiRunner.launchpadQuestion", {
                count: runners.length,
              })}
            </h1>
          </div>
          <RunnerListPanel
            runners={runners}
            allAgents={allAgents}
            cliAgents={cliAgents}
            blockers={blockers}
            onAddRunner={handleAddRunner}
            canRemoveRunner={canRemoveRunner(runners)}
            onRemoveRunner={removeRunner}
            onAgentSelect={handleAgentSelect}
            onRuntimeConfigChange={handleRuntimeConfigChange}
          />
        </div>
      ) : null,
    [
      allAgents,
      blockers,
      cliAgents,
      enabled,
      handleAddRunner,
      handleAgentSelect,
      handleExit,
      handleRuntimeConfigChange,
      removeRunner,
      runners,
      t,
    ]
  );

  return {
    isActive: enabled,
    middleContent,
    canLaunch,
    isLaunching,
    launchGroup,
    handleWorktreeLocationChange,
    worktreeSourceLabel: enabled
      ? t("creator.multiRunner.worktreePerRunner")
      : undefined,
  };
}
