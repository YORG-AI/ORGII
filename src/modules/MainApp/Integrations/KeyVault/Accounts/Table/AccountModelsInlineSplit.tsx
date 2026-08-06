import { ArrowDown10, ArrowDownAZ } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import ModelIcon from "@src/components/ModelIcon";
import ModelVariantInlineCard from "@src/components/ModelTable/ModelVariantInlineCard";
import type { ModelTableVariantInfo } from "@src/components/ModelTable/types";
import Select, { type SelectOption } from "@src/components/Select";
import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import type { KeyVaultAccount } from "@src/hooks/keyVault";
import { mergeSharedLocalKeyModelRuntimeSettings } from "@src/hooks/keyVault/useLocalKeys";
import { accountModelIds } from "@src/hooks/models/useModelAccountLookup";
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
import ModelSlugEditor from "@src/modules/MainApp/Integrations/KeyVault/shared/ModelSlugEditor";
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
  onUpdateAccountModelSlug?: (
    accountId: string,
    model: string,
    slug: string
  ) => void;
}

function getGroupKey(group: ModelGroup): string {
  return `${group.label}|${group.models.join("|")}`;
}

const REASONING_EFFORT_OPTIONS: SelectOption[] = [
  { label: "Auto", value: "auto" },
  { label: "None", value: "none" },
  { label: "Baseline", value: "baseline" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high", value: "extra_high" },
  { label: "Max", value: "max" },
  { label: "Ultracode", value: "ultracode" },
];

type ReasoningEffort = Exclude<
  NonNullable<
    KeyVaultAccount["modelVariants"]
  >[number]["reasoning_effort_override"],
  null | undefined
>;

function RuntimeSettings({
  account,
  models,
}: {
  account: KeyVaultAccount;
  models: string[];
}) {
  const [contextDrafts, setContextDrafts] = useState<Record<string, string>>(
    {}
  );
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const updateContext = useCallback(
    async (model: string, context_window_override: number | null) => {
      const key = `${model}:context_window_override`;
      setPending((current) => new Set(current).add(key));
      setError(null);
      try {
        const updated = await rpc.validation.updateModelRuntimeSettings({
          request: { key_id: account.id, model, context_window_override },
        });
        mergeSharedLocalKeyModelRuntimeSettings(
          updated,
          model,
          "context_window_override"
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not update runtime settings."
        );
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [account.id]
  );
  const updateEffort = useCallback(
    async (
      model: string,
      reasoning_effort_override: ReasoningEffort | null
    ) => {
      const key = `${model}:reasoning_effort_override`;
      setPending((current) => new Set(current).add(key));
      setError(null);
      try {
        const updated = await rpc.validation.updateModelRuntimeSettings({
          request: { key_id: account.id, model, reasoning_effort_override },
        });
        mergeSharedLocalKeyModelRuntimeSettings(
          updated,
          model,
          "reasoning_effort_override"
        );
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not update runtime settings."
        );
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [account.id]
  );

  return (
    <section
      className="mt-2 border-t border-border-2 pt-2"
      aria-label="Runtime settings"
    >
      <p className="text-xs font-medium text-text-2">Runtime settings</p>
      {[
        ...new Set(
          models.map((model) => {
            const variant = account.modelVariants?.find(
              (item) => item.model === model
            );
            return account.availableModels?.includes(model)
              ? model
              : (variant?.base_model ?? model);
          })
        ),
      ].map((model) => {
        const variant =
          account.modelVariants?.find((item) => item.model === model) ??
          account.modelVariants?.find((item) => item.base_model === model);
        const contextValue =
          contextDrafts[model] ??
          variant?.context_window_override?.toString() ??
          "";
        const effortValue =
          efforts[model] ?? variant?.reasoning_effort_override ?? "auto";
        const contextPending = pending.has(`${model}:context_window_override`);
        const effortPending = pending.has(`${model}:reasoning_effort_override`);
        return (
          <div
            key={model}
            className="mt-2 grid gap-1 border-t border-border-2 pt-2 first:border-t-0 first:pt-0"
          >
            <span
              className="truncate text-xs font-medium text-text-1"
              title={model}
            >
              {formatModelNameFull(model)}
            </span>
            <span className="text-xs text-text-3">
              Provider context:{" "}
              {variant?.context_window
                ? variant.context_window.toLocaleString()
                : "not reported"}
            </span>
            <div className="flex items-center gap-1">
              <Input
                size="small"
                inputMode="numeric"
                value={contextValue}
                onChange={(value) =>
                  setContextDrafts((current) => ({
                    ...current,
                    [model]: value,
                  }))
                }
                placeholder="Context Auto"
                aria-label={`${model} context window`}
                disabled={contextPending}
                className="min-w-0 flex-1"
              />
              <Button
                size="small"
                onClick={() => {
                  const parsed = Number(contextValue);
                  if (Number.isSafeInteger(parsed) && parsed > 0)
                    void updateContext(model, parsed);
                  else
                    setError("Context window must be a positive whole number.");
                }}
                disabled={contextPending}
              >
                Set
              </Button>
              <Button
                size="small"
                variant="tertiary"
                onClick={() => {
                  setContextDrafts((current) => ({ ...current, [model]: "" }));
                  void updateContext(model, null);
                }}
                disabled={contextPending}
              >
                Reset
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Select
                size="small"
                value={effortValue}
                options={REASONING_EFFORT_OPTIONS}
                onChange={(value) => {
                  const next = String(value);
                  setEfforts((current) => ({ ...current, [model]: next }));
                  void updateEffort(
                    model,
                    next === "auto" ? null : (next as ReasoningEffort)
                  );
                }}
                disabled={effortPending}
                className="min-w-0 flex-1"
              />
              <Button
                size="small"
                variant="tertiary"
                onClick={() => {
                  setEfforts((current) => ({ ...current, [model]: "auto" }));
                  void updateEffort(model, null);
                }}
                disabled={effortPending}
              >
                Reset
              </Button>
            </div>
          </div>
        );
      })}
      {error ? (
        <p className="text-error mt-1 text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const AccountModelsInlineSplit: React.FC<AccountModelsInlineSplitProps> = ({
  account,
  enabledSet,
  isAccountEnabled,
  variantsByModel,
  onSetModelEnabled: _onSetModelEnabled,
  onUpdateEnabledModels,
  onUpdateAccountDefaultVariant,
  onUpdateAccountModelSlug,
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
        ? ArrowDown10
        : ArrowDownAZ;
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
                <SortModeIcon size={14} strokeWidth={2} />
              </button>
            </Tooltip>
            <Switch
              size="small"
              checked={allModelsSummary.allEnabled}
              mixed={allModelsSummary.mixed}
              type={allModelsSummary.mixed ? "warning" : "primary"}
              onChange={handleToggleAllGroups}
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
      const slugEntry = (account.modelSlugs ?? []).find(
        (entry) => entry.model === model
      );
      return (
        <>
          <InlineSplitDefaultVersionHeaderRow
            label={t("modelsTable.keyDefaultVersionOnly", {
              model: formatModelNameFull(model),
            })}
            pillLabel={t("modelsTable.variantDefault")}
          />
          {onUpdateAccountModelSlug ? (
            <ModelSlugEditor
              model={model}
              slug={slugEntry?.slug}
              onChange={(slug) =>
                onUpdateAccountModelSlug(account.id, model, slug)
              }
            />
          ) : null}
          <RuntimeSettings account={account} models={[model]} />
        </>
      );
    }

    return (
      <>
        <ModelVariantInlineCard
          variants={versionInfos}
          forceModelList={!hasParsedVariants}
          defaultVariantByBaseModel={defaultVariantByBaseModel}
          onChangeDefaultVariant={
            onUpdateAccountDefaultVariant
              ? handleChangeDefaultVariant
              : undefined
          }
          defaultRowLabel={() => t("modelsTable.currentKeySelectedVersion")}
          embedded
        />
        <RuntimeSettings account={account} models={selectedGroup.models} />
      </>
    );
  }, [
    account.id,
    account.modelSlugs,
    account.modelVariants,
    defaultVariantByBaseModel,
    handleChangeDefaultVariant,
    onUpdateAccountDefaultVariant,
    onUpdateAccountModelSlug,
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
