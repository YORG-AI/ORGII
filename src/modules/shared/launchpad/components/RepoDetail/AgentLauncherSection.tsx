/**
 * AgentLauncherSection — inline agent launcher for the Set up tab.
 *
 * Follows the SessionCreatorWorkItem pattern:
 * same container, textarea, bottom bar with CompoundPill + AddActionsDropdown.
 * Uses creatorDefaultModelSelectionAtom for model persistence (same as main session creator).
 */
import { useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelTypeSchema } from "@src/api/tauri/rpc/schemas/validation";
import { KEY_SOURCE, isHostedKey } from "@src/api/tauri/session";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import ModelPillTooltipContent from "@src/components/ModelPillTooltipContent";
import SelectorPill from "@src/components/SelectorPill";
import {
  INPUT_AREA,
  INPUT_AREA_PADDING_COMPACT,
} from "@src/config/inputAreaTokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  WORK_MANAGEMENT_SESSION_CREATOR_OVERLAY_CLASS,
  WORK_MANAGEMENT_SESSION_CREATOR_SURFACE_CLASS,
} from "@src/config/workManagementCardTokens";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useModelPillLabel } from "@src/hooks/models";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import {
  Cancel01Icon,
  GripIcon,
  HugeiconsIcon,
  SparklesIcon,
} from "@src/icons";
import {
  type RepoSetupContext,
  useRepoSetup,
} from "@src/modules/shared/launchpad/hooks";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes";
import {
  creatorDefaultModelSelectionAtom,
  extractModelPair,
} from "@src/store/session/creatorDefaultModelAtom";

interface AgentLauncherSectionProps {
  context: RepoSetupContext;
}

function resolveModelType(value: string | undefined) {
  const result = ModelTypeSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

const AgentLauncherSection: React.FC<AgentLauncherSectionProps> = ({
  context,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const { t: tSessions } = useTranslation("sessions");
  const [expanded, setExpanded] = useState(false);
  const [extraInstructions, setExtraInstructions] = useState("");
  const [trusted, setTrusted] = useState(false);
  const { launching, launchSetup } = useRepoSetup();

  // ============================================
  // Bridge: creatorDefaultModelSelectionAtom ↔ AdvancedConfig
  // ============================================

  const lastModel = useValidatedLastPair();
  const setLastModel = useSetAtom(creatorDefaultModelSelectionAtom);

  const advancedConfig: AdvancedConfig = useMemo(() => {
    if (!lastModel) return {};

    if (isHostedKey(lastModel.keySource)) {
      return {
        keySource: KEY_SOURCE.HOSTED,
        cliAgentType: lastModel.cliAgentType,
        tier: lastModel.tier,
        listingModel: lastModel.listingModel,
        listingModelDisplay: lastModel.listingModelDisplay,
        listingModelType: lastModel.listingModelType,
        listingName: lastModel.listingName,
        selectedSourceLabel: lastModel.selectedSourceLabel,
        selectedSourceModelType: lastModel.selectedSourceModelType,
      };
    }

    return {
      keySource: KEY_SOURCE.OWN,
      provider: lastModel.provider,
      model: lastModel.model,
      selectedAccountId: lastModel.selectedAccountId,
      selectedSourceLabel: lastModel.selectedSourceLabel,
      selectedSourceModelType: lastModel.selectedSourceModelType,
    };
  }, [lastModel]);

  const handleConfigChange = useCallback(
    (config: AdvancedConfig) => {
      const pair = extractModelPair(config);
      setLastModel(pair);
    },
    [setLastModel]
  );

  // ============================================
  // Model Selector State
  // ============================================

  const [isModelOpen, setIsModelOpen] = useState(false);

  const iconSize = PILL_SM_ICON_SIZE;
  const defaultModelLabel = tSessions("creator.model");

  const {
    label: modelLabel,
    title: modelTitle,
    accountName,
  } = useModelPillLabel(advancedConfig, defaultModelLabel);

  const modelIconName = advancedConfig.listingModel || advancedConfig.model;
  const modelIconAgent =
    advancedConfig.listingModelType ?? advancedConfig.selectedSourceModelType;
  const modelTooltipType = useMemo(
    () => resolveModelType(modelIconAgent),
    [modelIconAgent]
  );
  const hasModelSelection = Boolean(modelIconName);

  const handleOpenModelSelector = useCallback(() => {
    setIsModelOpen(true);
  }, []);

  const handleCloseSelector = useCallback(() => {
    setIsModelOpen(false);
  }, []);

  // ============================================
  // Launch
  // ============================================

  const handleStart = useCallback(() => {
    launchSetup(context, {
      extraInstructions,
      trusted,
      keySource: lastModel?.keySource,
      model: lastModel?.model,
      accountId: lastModel?.selectedAccountId,
      cliAgentType: lastModel?.cliAgentType,
      listingModel: lastModel?.listingModel,
      listingModelType: lastModel?.listingModelType,
      tier: lastModel?.tier,
    });
  }, [context, extraInstructions, trusted, lastModel, launchSetup]);

  const isDisabled = !context.repoPath || launching;

  // ============================================
  // Render
  // ============================================

  return (
    <>
      {!expanded && (
        <div className="pointer-events-none absolute bottom-2 left-0 right-0 z-30 flex justify-center px-2">
          <button
            type="button"
            onClick={() => setExpanded(true)}
            aria-label={t("launchpad.preview.setupWithAI")}
            title={t("launchpad.preview.setupWithAI")}
            className="pointer-events-auto flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-primary-6 px-3 text-[12px] font-medium text-white shadow-md transition-colors hover:bg-primary-7"
          >
            <HugeiconsIcon
              icon={SparklesIcon}
              data-icon="sparkles"
              size={14}
              strokeWidth={1.75}
            />
            <span>{t("launchpad.preview.setupWithAI")}</span>
          </button>
        </div>
      )}

      {expanded && (
        <div className={WORK_MANAGEMENT_SESSION_CREATOR_OVERLAY_CLASS}>
          <div
            className={`${WORK_MANAGEMENT_SESSION_CREATOR_SURFACE_CLASS} relative flex flex-col gap-1 rounded-[12px] px-2 shadow-2xl`}
            style={{
              paddingTop: INPUT_AREA_PADDING_COMPACT.paddingTop,
              paddingBottom: INPUT_AREA_PADDING_COMPACT.paddingBottom,
              background: INPUT_AREA.backgroundChatPanel,
              border: `1px solid ${INPUT_AREA.borderColorVar}`,
            }}
          >
            <button
              type="button"
              onClick={() => setExpanded(false)}
              aria-label={t("common:actions.close")}
              title={t("common:actions.close")}
              className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={13}
                strokeWidth={1.75}
              />
            </button>

            <div className="flex items-center px-1 pr-8">
              <Checkbox
                checked={trusted}
                onCheckedChange={(checked) => setTrusted(checked)}
                size="small"
              >
                <span className="text-[12px] text-text-2">
                  {t("launchpad.preview.trustRepo")}
                </span>
              </Checkbox>
            </div>

            <textarea
              value={extraInstructions}
              onChange={(event) => setExtraInstructions(event.target.value)}
              placeholder={t("launchpad.preview.launchpadPlaceholder")}
              className="min-h-[60px] w-full resize-none bg-transparent px-1 text-[13px] text-text-1 outline-none placeholder:text-text-4"
              rows={2}
            />

            <div className="flex h-9 items-center justify-between">
              <div className="flex min-w-0 items-center gap-1">
                <SelectorPill
                  icon={
                    hasModelSelection ? (
                      <ModelIcon
                        modelName={modelIconName}
                        agentType={modelIconAgent}
                        size={iconSize}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={GripIcon}
                        data-icon="grip"
                        size={iconSize}
                        strokeWidth={1.75}
                        className="text-text-1"
                      />
                    )
                  }
                  label={modelLabel}
                  title={modelTitle}
                  tooltip={
                    <ModelPillTooltipContent
                      accountName={accountName}
                      modelLabel={modelTitle}
                      modelId={modelIconName}
                      modelType={modelTooltipType}
                      shortcut={getShortcutKeys("open_model_selector")}
                    />
                  }
                  tooltipFramed
                  className="max-w-[220px] shrink-0"
                  ariaLabel={tSessions("creator.selectModel")}
                  active={isModelOpen}
                  onClick={handleOpenModelSelector}
                />
              </div>

              <Button
                variant="primary"
                size="small"
                icon={
                  <HugeiconsIcon
                    icon={SparklesIcon}
                    data-icon="sparkles"
                    size={13}
                  />
                }
                disabled={isDisabled}
                loading={launching}
                onClick={handleStart}
              >
                {t("launchpad.preview.launchpadLaunch")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {isModelOpen && (
        <UnifiedModelPalette
          isOpen={isModelOpen}
          onClose={handleCloseSelector}
          advancedConfig={advancedConfig}
          onConfigChange={handleConfigChange}
        />
      )}
    </>
  );
};

export default AgentLauncherSection;
