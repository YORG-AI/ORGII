import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { KEY_SOURCE } from "@src/api/tauri/session";
import type { ModelEffortSegmentState } from "@src/hooks/models/useModelEffortSegment";
import type {
  MobileModelOption,
  MobileSessionModelConfig,
} from "@src/modules/MobileRemote/connection/types";
import { buildGroupByModel } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/modelSection";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import {
  formatReasoningLevel,
  parseModelVariant,
} from "@src/util/modelVariants";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

export function toMobileLastModelSelection(
  config: MobileSessionModelConfig
): LastModelSelection {
  const keySource =
    config.keySource === KEY_SOURCE.HOSTED ? KEY_SOURCE.HOSTED : KEY_SOURCE.OWN;

  if (keySource === KEY_SOURCE.HOSTED) {
    return {
      keySource,
      listingModel: config.model,
      cliAgentType: config.cliAgentType as LastModelSelection["cliAgentType"],
    };
  }

  return {
    keySource,
    model: config.model,
    selectedAccountId: config.accountId,
    cliAgentType: config.cliAgentType as LastModelSelection["cliAgentType"],
  };
}

export function useMobileModelEffortSegment(
  config: MobileSessionModelConfig | null,
  options: MobileModelOption[],
  onApply?: (modelId: string) => void
): ModelEffortSegmentState {
  const { t } = useTranslation();

  const modelId = config?.model;

  const { groupModelIds, editable } = useMemo(() => {
    if (!modelId || !onApply || !config) {
      return { groupModelIds: [] as string[], editable: false };
    }

    const accountModelIds = options
      .filter((option) => option.accountId === (config.accountId ?? ""))
      .map((option) => option.id);

    const groupByModel = buildGroupByModel(accountModelIds);
    const family = groupByModel.get(modelId) ?? [modelId];
    const accountFamilyIds = family.filter((candidateId) =>
      accountModelIds.includes(candidateId)
    );

    return {
      groupModelIds: accountFamilyIds,
      editable: accountFamilyIds.length > 1,
    };
  }, [config, modelId, onApply, options]);

  const variantOptions = useMemo(
    () =>
      buildVariantEditOptions(
        groupModelIds.length > 0 ? groupModelIds : modelId ? [modelId] : []
      ),
    [groupModelIds, modelId]
  );

  const variant = modelId ? parseModelVariant(modelId) : undefined;

  const effortLabel = useMemo(() => {
    const parts: string[] = [];
    if (variant?.reasoning) {
      parts.push(formatReasoningLevel(variant.reasoning));
    }
    if (variant?.fast) {
      parts.push("Fast");
    }
    if (parts.length > 0) return parts.join(" · ");
    if (!variant || (!variant.thinking && parts.length === 0)) {
      return t("common:selectors.modelProperties.default");
    }
    return t("common:selectors.modelProperties.effort");
  }, [variant, t]);

  const effortAriaLabel = t("common:selectors.modelProperties.effort");

  const handleApply = useCallback(
    (nextModelId: string) => {
      if (!nextModelId || nextModelId === modelId || !onApply) return;
      onApply(nextModelId);
    },
    [modelId, onApply]
  );

  return {
    editable,
    effortLabel,
    effortAriaLabel,
    modelId,
    variantOptions,
    handleApply,
  };
}
