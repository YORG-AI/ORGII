/**
 * Runner list — the multi-runner launcher's middle slot.
 *
 * Each row owns a complete launch config; the composer below owns only the
 * prompt, which is why the composer's own model pill is suppressed here.
 *
 * A row is filled in **harness first**: its model pill only appears once a
 * harness is chosen, because the harness is what scopes the model list. The
 * launcher's global model never leaks into a row for the same reason — it was
 * picked for a different harness and may be one this row cannot serve.
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CliAgentType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  MULTI_RUNNER_MAX,
  RUNNER_BLOCKER,
  type Runner,
  type RunnerBlocker,
  canAddRunner,
  hasAgentSelected,
  resolveRunnerConfig,
} from "@src/features/SessionCreator/multiRunner/contract";
import { Add01Icon, HugeiconsIcon } from "@src/icons";
import type {
  AgentDefinition,
  AvailableCliAgent,
  OrgMemberRuntimeConfig,
} from "@src/modules/MainApp/AgentOrgs/types";
import {
  type AgentSelection,
  DispatchCategoryPalette,
} from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";

import { toAgentRuntimeConfig } from "../../agentRuntimeConfig";
import type { AdvancedConfig } from "../../types";
import RunnerRow from "./RunnerRow";
import { resolveRunnerAgentDisplay } from "./resolveRunnerAgent";

export interface RunnerListPanelProps {
  runners: Runner[];
  allAgents: AgentDefinition[];
  cliAgents: AvailableCliAgent[];
  /** Why each runner cannot launch, keyed by runner id. */
  blockers: Record<string, RunnerBlocker | null>;
  /** False at the floor: one runner is not a comparison. */
  canRemoveRunner: boolean;
  onAddRunner: () => void;
  onRemoveRunner: (runnerId: string) => void;
  onAgentSelect: (runnerId: string, selection: AgentSelection) => void;
  onRuntimeConfigChange: (
    runnerId: string,
    runtimeConfig: OrgMemberRuntimeConfig
  ) => void;
  className?: string;
}

const RunnerListPanel: React.FC<RunnerListPanelProps> = memo(
  ({
    runners,
    allAgents,
    cliAgents,
    blockers,
    canRemoveRunner,
    onAddRunner,
    onRemoveRunner,
    onAgentSelect,
    onRuntimeConfigChange,
    className = "",
  }) => {
    const { t } = useTranslation("sessions");
    const [agentPickerRunnerId, setAgentPickerRunnerId] = useState<
      string | null
    >(null);
    const [modelPickerRunnerId, setModelPickerRunnerId] = useState<
      string | null
    >(null);

    const unselectedAgentLabel = t("creator.multiRunner.pickHarness");

    const rows = useMemo(
      () =>
        runners.map((runner, index) => ({
          runner,
          ordinal: index + 1,
          agentDisplay: resolveRunnerAgentDisplay(
            runner,
            allAgents,
            cliAgents,
            unselectedAgentLabel
          ),
          modelSelection: resolveRunnerConfig(runner),
          canPickModel: hasAgentSelected(runner),
        })),
      [allAgents, cliAgents, runners, unselectedAgentLabel]
    );

    const describeBlocker = useCallback(
      (blocker: RunnerBlocker | null, cliLabel: string): string | null => {
        if (blocker === null) return null;
        switch (blocker) {
          case RUNNER_BLOCKER.NO_AGENT:
            return t("creator.multiRunner.blocker.noHarness");
          case RUNNER_BLOCKER.NO_MODEL:
            return t("creator.multiRunner.blocker.noModel");
          case RUNNER_BLOCKER.CLI_NOT_INSTALLED:
            return t("creator.multiRunner.blocker.cliNotInstalled", {
              cli: cliLabel,
            });
          case RUNNER_BLOCKER.CLI_NO_GUI:
            return t("creator.multiRunner.blocker.cliNoGui", {
              cli: cliLabel,
            });
        }
      },
      [t]
    );

    const agentPickerRunner = runners.find(
      (runner) => runner.id === agentPickerRunnerId
    );
    const modelPickerRunner = runners.find(
      (runner) => runner.id === modelPickerRunnerId
    );
    const modelPickerConfig = modelPickerRunner
      ? resolveRunnerConfig(modelPickerRunner)
      : undefined;

    const handleAgentSelect = useCallback(
      (selection: AgentSelection) => {
        if (agentPickerRunnerId === null) return;
        onAgentSelect(agentPickerRunnerId, selection);
        setAgentPickerRunnerId(null);
      },
      [agentPickerRunnerId, onAgentSelect]
    );

    const handleModelConfigChange = useCallback(
      (config: AdvancedConfig) => {
        if (modelPickerRunnerId === null) return;
        onRuntimeConfigChange(
          modelPickerRunnerId,
          toAgentRuntimeConfig(config)
        );
      },
      [modelPickerRunnerId, onRuntimeConfigChange]
    );

    const handleVariantApply = useCallback(
      (
        runnerId: string,
        currentConfig: AdvancedConfig,
        nextModelId: string
      ) => {
        onRuntimeConfigChange(
          runnerId,
          toAgentRuntimeConfig({ ...currentConfig, model: nextModelId })
        );
      },
      [onRuntimeConfigChange]
    );

    const addDisabled = !canAddRunner(runners);

    return (
      <div
        data-testid="session-creator-runner-list"
        className={`flex w-full flex-col gap-1 rounded-[12px] border border-solid border-border-2 ${SURFACE_TOKENS.surface} p-1 ${className}`}
      >
        <ul className="flex flex-col gap-0.5">
          {rows.map(
            ({
              runner,
              ordinal,
              agentDisplay,
              modelSelection,
              canPickModel,
            }) => (
              <RunnerRow
                key={runner.id}
                ordinal={ordinal}
                agentDisplay={agentDisplay}
                modelSelection={modelSelection}
                modelLabel={t("creator.model")}
                canPickModel={canPickModel}
                blocker={blockers[runner.id] ?? null}
                blockerNote={describeBlocker(
                  blockers[runner.id] ?? null,
                  agentDisplay.label
                )}
                isAgentPickerOpen={agentPickerRunnerId === runner.id}
                isModelPickerOpen={modelPickerRunnerId === runner.id}
                agentPickerLabel={t("creator.multiRunner.selectHarness")}
                modelPickerLabel={t("creator.selectModel")}
                removeLabel={t("creator.multiRunner.removeRunner")}
                canRemove={canRemoveRunner}
                onOpenAgentPicker={() => setAgentPickerRunnerId(runner.id)}
                onOpenModelPicker={() => setModelPickerRunnerId(runner.id)}
                onVariantApply={(nextModelId) =>
                  handleVariantApply(runner.id, modelSelection, nextModelId)
                }
                onRemove={() => onRemoveRunner(runner.id)}
              />
            )
          )}
        </ul>

        <div
          className="mt-0.5 flex items-center gap-2 border-t border-border-2 px-2 pb-0.5 pt-1.5"
          data-testid="session-creator-runner-list-footer"
        >
          <Button
            variant="tertiary"
            size="small"
            shape="round"
            icon={
              <HugeiconsIcon
                icon={Add01Icon}
                data-icon="plus"
                size={14}
                strokeWidth={1.85}
              />
            }
            disabled={addDisabled}
            onClick={onAddRunner}
            data-testid="session-creator-runner-add"
          >
            {t("creator.multiRunner.addRunner")}
          </Button>
          <span className="ml-auto text-[12px] text-text-3">
            {t("creator.multiRunner.parallelCount", {
              count: runners.length,
              max: MULTI_RUNNER_MAX,
            })}
          </span>
        </div>

        <DispatchCategoryPalette
          isOpen={agentPickerRunner !== undefined}
          onClose={() => setAgentPickerRunnerId(null)}
          hideOrgs
          includeHumanSession={false}
          placeholderLabel={t("creator.multiRunner.selectHarness")}
          currentCategory={agentPickerRunner?.dispatchCategory}
          currentAgentDefinitionId={agentPickerRunner?.agentDefinitionId}
          currentCliAgentType={agentPickerRunner?.cliAgentType}
          onSelect={handleAgentSelect}
        />

        {modelPickerRunner && modelPickerConfig && (
          <UnifiedModelPalette
            isOpen
            onClose={() => setModelPickerRunnerId(null)}
            advancedConfig={modelPickerConfig}
            onConfigChange={handleModelConfigChange}
            dispatchCategoryOverride={modelPickerRunner.dispatchCategory}
            cliAgentTypeOverride={
              modelPickerRunner.cliAgentType as CliAgentType | undefined
            }
          />
        )}
      </div>
    );
  }
);

RunnerListPanel.displayName = "RunnerListPanel";

export default RunnerListPanel;
