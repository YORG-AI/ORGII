import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { isHostedKey } from "@src/api/tauri/session";
import { useKeyVault } from "@src/hooks/keyVault";
import { buildGroupByModel } from "@src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/modelSection";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import {
  formatReasoningLevel,
  parseModelVariant,
  resolveModelVariantFields,
} from "@src/util/modelVariants";
import { buildVariantEditOptions } from "@src/util/variantEditOptions";

import { resolveModelDisplaySelection } from "./resolveModelDisplaySelection";
import {
  accountHasModel,
  useModelAccountLookup,
} from "./useModelAccountLookup";

export interface UseModelEffortSegmentParams {
  selection: LastModelSelection | null | undefined;
  isActiveSession?: boolean;
  onApply?: (nextModelId: string) => void;
}

export interface ModelEffortSegmentState {
  editable: boolean;
  effortLabel: string;
  effortAriaLabel: string;
  modelId: string | undefined;
  variantOptions: ReturnType<typeof buildVariantEditOptions>;
  handleApply: (nextModelId: string) => void;
}

export function useModelEffortSegment({
  selection,
  isActiveSession = false,
  onApply,
}: UseModelEffortSegmentParams): ModelEffortSegmentState {
  const { t } = useTranslation();
  const { accounts, accountLookup } = useModelAccountLookup();
  const { saveKey } = useKeyVault();

  const displaySelection = useMemo(
    () => resolveModelDisplaySelection(selection, accounts, isActiveSession),
    [accounts, isActiveSession, selection]
  );

  const modelId = displaySelection?.model;
  const isHosted = displaySelection
    ? isHostedKey(displaySelection.keySource)
    : true;

  const { groupModelIds, selectedAccountId, editable } = useMemo(() => {
    if (!modelId || isHosted || !onApply) {
      return {
        groupModelIds: [] as string[],
        selectedAccountId: undefined as string | undefined,
        editable: false,
      };
    }

    const groupByModel = buildGroupByModel(accountLookup.keys());
    const family = groupByModel.get(modelId) ?? [modelId];

    const selectedAccount = accounts.find((account) => {
      if (displaySelection?.selectedAccountId) {
        return account.id === displaySelection.selectedAccountId;
      }
      if (
        displaySelection?.selectedSourceModelType &&
        account.modelType !== displaySelection.selectedSourceModelType
      ) {
        return false;
      }
      if (displaySelection?.selectedSourceLabel) {
        return account.name === displaySelection.selectedSourceLabel;
      }
      return family.some((candidateId) =>
        accountHasModel(account, candidateId)
      );
    });

    const accountFamilyIds = selectedAccount
      ? family.filter((candidateId) =>
          accountHasModel(selectedAccount, candidateId)
        )
      : family;

    return {
      groupModelIds: accountFamilyIds,
      selectedAccountId: selectedAccount?.id,
      editable: accountFamilyIds.length > 1,
    };
  }, [accountLookup, accounts, displaySelection, isHosted, modelId, onApply]);

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

  const persistDefaultVariant = useCallback(
    (nextModelId: string) => {
      if (!selectedAccountId) return;
      const account = accounts.find((entry) => entry.id === selectedAccountId);
      if (!account) return;

      const baseModel = resolveModelVariantFields(nextModelId).base_model;
      const nextDefaults = (account.defaultVariants ?? []).filter(
        (entry) => entry.base_model !== baseModel
      );
      nextDefaults.push({ base_model: baseModel, model: nextModelId });

      void saveKey({
        id: account.id,
        agent_type: account.modelType,
        default_variants: nextDefaults,
      });
    },
    [accounts, saveKey, selectedAccountId]
  );

  const handleApply = useCallback(
    (nextModelId: string) => {
      if (!nextModelId || nextModelId === modelId || !onApply) return;
      persistDefaultVariant(nextModelId);
      onApply(nextModelId);
    },
    [modelId, onApply, persistDefaultVariant]
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
