/**
 * SessionCreatorInstall Variant
 *
 * Lightweight SessionCreator variant for the Import Agent wizard.
 * Renders only the model selector pill + UnifiedModelPalette,
 * without ComposerInput, file upload, repo selection, or draft management.
 *
 * The parent provides an "Analyze" action that creates a real agent session.
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelTypeSchema } from "@src/api/tauri/rpc/schemas/validation";
import { PILL_SM_ICON_SIZE } from "@src/components/CompoundPill/config";
import ModelIcon from "@src/components/ModelIcon";
import ModelPillTooltipContent from "@src/components/ModelPillTooltipContent";
import SelectorPill from "@src/components/SelectorPill";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import { useModelPillLabel } from "@src/hooks/models";
import { AiSettingIcon, HugeiconsIcon } from "@src/icons";
import { UnifiedModelPalette } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette";

interface SessionCreatorInstallProps {
  advancedConfig: AdvancedConfig;
  onConfigChange: (config: AdvancedConfig) => void;
  className?: string;
}

function resolveModelType(value: string | undefined) {
  const result = ModelTypeSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

const SessionCreatorInstall: React.FC<SessionCreatorInstallProps> = memo(
  ({ advancedConfig, onConfigChange, className }) => {
    const { t: tSessions } = useTranslation("sessions");

    const [isModelOpen, setIsModelOpen] = useState(false);

    const iconSize = PILL_SM_ICON_SIZE;
    const defaultModelLabel = tSessions("creator.model");

    const {
      label: modelLabel,
      title: modelTitle,
      accountName,
    } = useModelPillLabel(advancedConfig, defaultModelLabel);

    const modelIconName = useMemo(
      () => advancedConfig.listingModel || advancedConfig.model || undefined,
      [advancedConfig.listingModel, advancedConfig.model]
    );
    const modelIconAgent = useMemo(
      () =>
        advancedConfig.listingModelType ??
        advancedConfig.selectedSourceModelType,
      [advancedConfig.listingModelType, advancedConfig.selectedSourceModelType]
    );
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

    return (
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
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
                icon={AiSettingIcon}
                data-icon="ai-setting"
                size={iconSize}
                strokeWidth={1.75}
                className="text-primary-6"
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
          danger={!hasModelSelection}
          onClick={handleOpenModelSelector}
        />

        {isModelOpen && (
          <UnifiedModelPalette
            isOpen={isModelOpen}
            onClose={handleCloseSelector}
            advancedConfig={advancedConfig}
            onConfigChange={onConfigChange}
          />
        )}
      </div>
    );
  }
);

SessionCreatorInstall.displayName = "SessionCreatorInstall";

export default SessionCreatorInstall;
