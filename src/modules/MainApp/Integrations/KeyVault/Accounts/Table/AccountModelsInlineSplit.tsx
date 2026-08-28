import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import ModelIcon from "@src/components/ModelIcon";
import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { accountModelIds } from "@src/hooks/models/useModelAccountLookup";
import {
  ArrangeByLettersZAIcon,
  ArrangeByNumbersOneNineIcon,
} from "@src/icons";
import {
  applyModelGroupToEnabledSet,
  getModelGroupEnableSummary,
} from "@src/modules/MainApp/Integrations/KeyVault/Models/Table/integrationsModelGroups";
import { InlineCardSplit } from "@src/modules/MainApp/Integrations/KeyVault/shared/InlineCardPrimitives";
import {
  InlineSplitDefaultVersionHeaderRow,
  InlineSplitHeaderRow,
  InlineSplitSelectableRow,
} from "@src/modules/MainApp/Integrations/KeyVault/shared/InlineSplitRows";
import ModelVariantInlineCard from "@src/modules/MainApp/Integrations/KeyVault/shared/ModelTable/ModelVariantInlineCard";
import type { ModelTableVariantInfo } from "@src/types/modelTable";
import { formatModelNameFull } from "@src/util/formatModelName";
import {
  MODEL_GROUP_SORT_MODE,
  type ModelGroup,
  type ModelGroupSortMode,
  groupModels,
  sortModelGroups,
} from "@src/util/modelGrouping";
import { groupHasParsedModelVariants } from "@src/util/modelVariants";

interface AccountModelsInlineSplitProps {
  account: KeyVaultAccount;
  enabledSet: Set<string>;
  isAccountEnabled: boolean;
  variantsByModel: Map<string, ModelTableVariantInfo>;
  onSetModelEnabled: (model: string, enabled: boolean) => void;
  onUpdateEnabledModels: (enabledModels: readonly string[]) => void;
  onUpdateAccountDefaultVariant?: (
    accountId: string,
    baseModel: string,
    model: string
  ) => void;
}

function getGroupKey(group: ModelGroup): string {
  return `${group.label}|${group.models.join("|")}`;
}

const AccountModelsInlineSplit: React.FC<AccountModelsInlineSplitProps> = ({
  account,
  enabledSet,
  isAccountEnabled,
  variantsByModel,
  onSetModelEnabled: _onSetModelEnabled,
  onUpdateEnabledModels,
  onUpdateAccountDefaultVariant,
}) => {
  const { t } = useTranslation("integrations");
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<ModelGroupSortMode>(
    MODEL_GROUP_SORT_MODE.ENABLED_FIRST
  );

  const availableModels = useMemo(() => accountModelIds(account), [account]);

  const groups = useMemo(() => groupModels(availableModels), [availableModels]);

  const sortedGroups = useMemo(
    () => sortModelGroups(groups, sortMode, enabledSet),
    [enabledSet, groups, sortMode]
  );

  const effectiveGroupKey = useMemo(() => {
    if (
      selectedGroupKey &&
      sortedGroups.some((group) => getGroupKey(group) === selectedGroupKey)
    ) {
      return selectedGroupKey;
    }
    return sortedGroups[0] ? getGroupKey(sortedGroups[0]) : null;
  }, [selectedGroupKey, sortedGroups]);

  const selectedGroup = useMemo(
    () =>
      sortedGroups.find((group) => getGroupKey(group) === effectiveGroupKey) ??
      null,
    [effectiveGroupKey, sortedGroups]
  );

  const commitEnabledModels = useCallback(
    (nextEnabledModels: readonly string[]) => {
      onUpdateEnabledModels(nextEnabledModels);
    },
    [onUpdateEnabledModels]
  );

  const defaultVariantByBaseModel = useMemo(() => {
    const map = new Map<string, string>();
    for (const variant of account.defaultVariants ?? []) {
      map.set(variant.base_model, variant.model);
    }
    return map;
  }, [account.defaultVariants]);

  const handleChangeDefaultVariant = useCallback(
    (baseModel: string, model: string) => {
      if (!onUpdateAccountDefaultVariant) return;
      onUpdateAccountDefaultVariant(account.id, baseModel, model);
    },
    [account.id, onUpdateAccountDefaultVariant]
  );

  const handleToggleGroup = useCallback(
    (group: ModelGroup, checked: boolean) => {
      const targetModels = [
        ...new Set(
          group.models.map(
            (model) => variantsByModel.get(model)?.base_model ?? model
          )
        ),
      ];
      const baseAvailableModels = [
        ...new Set(
          availableModels.map(
            (model) => variantsByModel.get(model)?.base_model ?? model
          )
        ),
      ];
      const nextEnabledModels = applyModelGroupToEnabledSet(
        enabledSet,
        targetModels,
        baseAvailableModels,
        checked
      );
      commitEnabledModels(nextEnabledModels);
    },
    [availableModels, commitEnabledModels, enabledSet, variantsByModel]
  );

  const handleToggleAllGroups = useCallback(
    (checked: boolean) => {
      const baseAvailableModels = [
        ...new Set(
          availableModels.map(
            (model) => variantsByModel.get(model)?.base_model ?? model
          )
        ),
      ];
      commitEnabledModels(checked ? baseAvailableModels : []);
    },
    [availableModels, commitEnabledModels, variantsByModel]
  );

  const allModelsSummary = useMemo(
    () => getModelGroupEnableSummary(availableModels, enabledSet),
    [availableModels, enabledSet]
  );

  const enabledGroupCount = useMemo(
    () =>
      sortedGroups.filter(
        (group) =>
          getModelGroupEnableSummary(group.models, enabledSet).anyEnabled
      ).length,
    [enabledSet, sortedGroups]
  );

  const renderAllModelsRow = () => {
    const SortModeIcon =
      sortMode === MODEL_GROUP_SORT_MODE.ENABLED_FIRST
        ? ArrangeByNumbersOneNineIcon
        : ArrangeByLettersZAIcon;
    const sortLabel =
      sortMode === MODEL_GROUP_SORT_MODE.ENABLED_FIRST
        ? t("modelsTable.sortEnabledFirst")
        : t("modelsTable.sortAlphabetical");

    return (
      <InlineSplitHeaderRow
        withSeparator
        label={t("modelsTable.availableModels", {
          enabled: enabledGroupCount,
          total: sortedGroups.length,
        })}
        trailing={
          <>
            <Tooltip content={sortLabel} position="top">
              <button
                type="button"
                className="table-sorter shrink-0 cursor-pointer border-0 bg-transparent p-0 text-text-3 hover:text-text-2"
                aria-label={sortLabel}
                onClick={() =>
                  setSortMode((current) =>
                    current === MODEL_GROUP_SORT_MODE.ENABLED_FIRST
                      ? MODEL_GROUP_SORT_MODE.ALPHABETICAL
                      : MODEL_GROUP_SORT_MODE.ENABLED_FIRST
                  )
                }
              >
                <AnyIcon icon={SortModeIcon} size={14} strokeWidth={2} />
              </button>
            </Tooltip>
            <Switch
              size="small"
              checked={allModelsSummary.allEnabled}
              mixed={allModelsSummary.mixed}
              type={allModelsSummary.mixed ? "warning" : "primary"}
              onCheckedChange={handleToggleAllGroups}
            />
          </>
        }
      />
    );
  };

  const renderGroupRow = useCallback(
    (group: ModelGroup) => {
      const groupKey = getGroupKey(group);
      const isSelected = groupKey === effectiveGroupKey;
      const groupSummary = getModelGroupEnableSummary(group.models, enabledSet);
      const checked = isAccountEnabled && groupSummary.anyEnabled;
      const primaryModel = group.models[0];

      return (
        <InlineSplitSelectableRow
          key={groupKey}
          selected={isSelected}
          onSelect={() => setSelectedGroupKey(groupKey)}
          label={
            <>
              {primaryModel ? (
                <ModelIcon
                  modelName={primaryModel}
                  size="small"
                  className="shrink-0"
                />
              ) : null}
              <span className="min-w-0 truncate font-medium leading-none text-text-1">
                {group.label}
              </span>
            </>
          }
          switchChecked={checked}
          onToggle={(nextChecked) => handleToggleGroup(group, nextChecked)}
        />
      );
    },
    [effectiveGroupKey, enabledSet, handleToggleGroup, isAccountEnabled]
  );

  const rightContent = useMemo(() => {
    if (!selectedGroup) {
      return (
        <span className="text-xs text-text-3">
          {t("keyVault.info.noModelsConfigured")}
        </span>
      );
    }

    const versionInfos = selectedGroup.models.map(
      (model) =>
        variantsByModel.get(model) ?? {
          model,
          base_model: model,
          fast: false,
        }
    );
    const hasParsedVariants = groupHasParsedModelVariants(selectedGroup.models);
    const showVersionPicker =
      selectedGroup.models.length > 1 || hasParsedVariants;

    if (!showVersionPicker && selectedGroup.models.length === 1) {
      const model = selectedGroup.models[0];
      return (
        <InlineSplitDefaultVersionHeaderRow
          label={t("modelsTable.keyDefaultVersionOnly", {
            model: formatModelNameFull(model),
          })}
          pillLabel={t("modelsTable.variantDefault")}
        />
      );
    }

    return (
      <ModelVariantInlineCard
        variants={versionInfos}
        forceModelList={!hasParsedVariants}
        defaultVariantByBaseModel={defaultVariantByBaseModel}
        onChangeDefaultVariant={
          onUpdateAccountDefaultVariant ? handleChangeDefaultVariant : undefined
        }
        defaultRowLabel={() => t("modelsTable.currentKeySelectedVersion")}
        embedded
      />
    );
  }, [
    defaultVariantByBaseModel,
    handleChangeDefaultVariant,
    onUpdateAccountDefaultVariant,
    selectedGroup,
    t,
    variantsByModel,
  ]);

  return (
    <InlineCardSplit
      left={
        <>
          {groups.length > 0 ? renderAllModelsRow() : null}
          {sortedGroups.map((group) => renderGroupRow(group))}
        </>
      }
      right={
        <div className="flex min-w-0 flex-col gap-0.5">{rightContent}</div>
      }
    />
  );
};

export default AccountModelsInlineSplit;
