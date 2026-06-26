import { ChevronDown, ChevronUp } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { ORGII_ORCHESTRATOR } from "@src/assets/providers/types";
import ModelIcon from "@src/components/ModelIcon";
import GroupRowEraTag from "@src/components/ModelTable/GroupRowEraTag";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/components/ModelTable/types";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import type { KeyVaultAccount } from "@src/hooks/keyVault";

import { EnabledFractionText } from "../../../shared/EnabledFractionText";
import ModelInlineExpandedCard from "./ModelInlineExpandedCard";
import {
  type IntegrationsModelGroupRow,
  aggregateGroupSources,
  applyModelGroupToEnabledSet,
  buildIntegrationsModelGroups,
  buildVariantsByModelFromAccounts,
  getIntegrationsGroupRowKey,
  groupSomeEnabled,
  sortIntegrationsModelGroups,
} from "./integrationsModelGroups";
import { INTEGRATIONS_MODELS_TABLE_COL_WIDTH } from "./integrationsModelsTableWidths";
import {
  MAX_SOURCE_ICONS,
  dedupeSourceTypes,
  getModelRowKey,
} from "./modelsTableUtils";
import { useModelsTableData } from "./useModelsTableData";

export { getModelRowKey };

function renderGroupSourcesCell(group: IntegrationsModelGroupRow) {
  if (group.isOrgiiGroup) return null;

  const sources = aggregateGroupSources(group.models);
  const totalSources = sources.length;
  const enabledSourceCount = sources.filter(
    (src) => src.enabledKeys > 0
  ).length;
  if (totalSources === 0) return null;

  const enabledSources = sources.filter((src) => src.enabledKeys > 0);
  const disabledSources = sources.filter((src) => src.enabledKeys === 0);
  const enabledTypes = dedupeSourceTypes(enabledSources);
  const disabledTypes = dedupeSourceTypes(disabledSources);
  const visibleEnabled = enabledTypes.slice(0, MAX_SOURCE_ICONS);
  const visibleDisabled = disabledTypes.slice(
    0,
    Math.max(0, MAX_SOURCE_ICONS - visibleEnabled.length)
  );
  const overflow =
    enabledTypes.length +
    disabledTypes.length -
    visibleEnabled.length -
    visibleDisabled.length;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <EnabledFractionText enabled={enabledSourceCount} total={totalSources} />
      {(visibleEnabled.length > 0 || visibleDisabled.length > 0) && (
        <span className="text-text-4">·</span>
      )}
      {visibleEnabled.map((modelType) => (
        <ModelIcon key={`on-${modelType}`} agentType={modelType} size="small" />
      ))}
      {visibleDisabled.map((modelType) => (
        <ModelIcon
          key={`off-${modelType}`}
          agentType={modelType}
          size="small"
          className="opacity-40"
        />
      ))}
      {overflow > 0 && (
        <span
          className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap tabular-nums`}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}

export default function ModelsTableSection({
  accounts,
  loading,
  onAdd,
  onToggleModel,
  onUpdateAccountEnabledModels,
  onUpdateAccountDefaultVariant,
  onToggleAccount,
  isAccountEnabled,
  t,
}: {
  accounts: KeyVaultAccount[];
  loading: boolean;
  onAdd: () => void;
  onToggleModel: (
    model: string,
    agentType: string,
    enabled: boolean,
    accountId?: string
  ) => void;
  onUpdateAccountEnabledModels: (
    accountId: string,
    agentType: string,
    enabledModels: readonly string[]
  ) => void;
  onUpdateAccountDefaultVariant?: (
    accountId: string,
    baseModel: string,
    model: string
  ) => void;
  onToggleAccount: (account: KeyVaultAccount, enabled: boolean) => void;
  isAccountEnabled?: (account: KeyVaultAccount) => boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<string[]>([]);

  const {
    modelsSearchQuery,
    setModelsSearchQuery,
    hideOlder,
    setHideOlder,
    olderCount,
    filteredRows,
    selectFilters,
  } = useModelsTableData(accounts, t);

  const variantsByModel = useMemo(
    () => buildVariantsByModelFromAccounts(accounts),
    [accounts]
  );

  const groupRows = useMemo(
    () =>
      sortIntegrationsModelGroups(buildIntegrationsModelGroups(filteredRows)),
    [filteredRows]
  );

  const handleToggleGroup = useCallback(
    (group: IntegrationsModelGroupRow, checked: boolean) => {
      const groupModelIds = group.models.map((row) => row.model);
      const associatedAccounts = accounts.filter((account) =>
        (account.availableModels ?? []).some((model) =>
          groupModelIds.includes(model)
        )
      );

      for (const account of associatedAccounts) {
        const nextEnabledModels = applyModelGroupToEnabledSet(
          account.enabledModels ?? [],
          groupModelIds,
          account.availableModels ?? [],
          checked
        );
        onUpdateAccountEnabledModels(
          account.id,
          account.modelType,
          nextEnabledModels
        );
      }
    },
    [accounts, onUpdateAccountEnabledModels]
  );

  const setSingleExpandedGroup = useCallback(
    (group: IntegrationsModelGroupRow) => {
      const rowKey = getIntegrationsGroupRowKey(group);
      setExpandedGroupKeys((currentKeys) =>
        currentKeys.includes(rowKey) ? [] : [rowKey]
      );
    },
    []
  );

  const isSearching = modelsSearchQuery.trim().length > 0;
  const expandControl =
    olderCount > 0 && !isSearching ? (
      <div className="flex justify-center border-t border-border-2 py-2.5">
        <button
          type="button"
          onClick={() => setHideOlder((prev) => !prev)}
          className="flex items-center gap-1.5 text-[13px] text-primary-6 hover:text-primary-5"
        >
          {hideOlder ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          {hideOlder
            ? t("modelsTable.showMoreOlder")
            : t("modelsTable.showLessOlder")}
        </button>
      </div>
    ) : null;

  const columns = useMemo<SettingsTableColumn<IntegrationsModelGroupRow>[]>(
    () => [
      {
        key: "model",
        label: t("common:labels.model"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.label.localeCompare(rowB.label),
        renderCell: (group) => {
          if (group.isOrgiiGroup) {
            return (
              <div className="flex w-full min-w-0 items-center gap-2">
                <ModelIcon
                  agentType={ORGII_ORCHESTRATOR}
                  size={14}
                  className="shrink-0 text-text-2"
                />
                <span
                  className={`${SETTINGS_TABLE_CELL.primary} truncate font-medium`}
                >
                  {t("modelsTable.orgiiMarketGroup")}
                </span>
              </div>
            );
          }

          const primaryModel = group.models[0]?.model;

          return (
            <div className="flex w-full min-w-0 items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {primaryModel ? (
                  <ModelIcon modelName={primaryModel} size="small" />
                ) : null}
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span
                    className={`${SETTINGS_TABLE_CELL.primary} truncate font-medium`}
                    title={group.label}
                  >
                    {group.label}
                  </span>
                </span>
              </div>
              {group.era === "older" ? <GroupRowEraTag era="older" /> : null}
            </div>
          );
        },
      },
      {
        key: "sources",
        label: t("common:labels.enabledSources"),
        width: INTEGRATIONS_MODELS_TABLE_COL_WIDTH.sources,
        sorter: (rowA, rowB) => {
          const enabledCount = (group: IntegrationsModelGroupRow) =>
            aggregateGroupSources(group.models).filter(
              (src) => src.enabledKeys > 0
            ).length;
          const diff = enabledCount(rowA) - enabledCount(rowB);
          if (diff !== 0) return diff;
          return (
            aggregateGroupSources(rowA.models).length -
            aggregateGroupSources(rowB.models).length
          );
        },
        renderCell: (group) => renderGroupSourcesCell(group),
      },
      {
        key: "status",
        label: <span className="sr-only">{t("common:labels.status")}</span>,
        width: INTEGRATIONS_MODELS_TABLE_COL_WIDTH.status,
        align: "right",
        sorter: (rowA, rowB) =>
          Number(groupSomeEnabled(rowB)) - Number(groupSomeEnabled(rowA)),
        renderCell: (group) => {
          if (group.isOrgiiGroup) return null;
          return (
            <div className="flex items-center justify-end">
              <Switch
                size={MODEL_TABLE_SWITCH_SIZE}
                checked={groupSomeEnabled(group)}
                onChange={(checked) => handleToggleGroup(group, checked)}
              />
            </div>
          );
        },
      },
    ],
    [t, handleToggleGroup]
  );

  const renderExpandedGroupCard = useCallback(
    (group: IntegrationsModelGroupRow) => (
      <ModelInlineExpandedCard
        group={group}
        accounts={accounts}
        variantsByModel={variantsByModel}
        onToggleModel={onToggleModel}
        onUpdateAccountEnabledModels={onUpdateAccountEnabledModels}
        onUpdateAccountDefaultVariant={onUpdateAccountDefaultVariant}
        onToggleAccount={onToggleAccount}
        isAccountEnabled={isAccountEnabled}
        onAddKey={onAdd}
      />
    ),
    [
      accounts,
      isAccountEnabled,
      onAdd,
      onToggleAccount,
      onToggleModel,
      onUpdateAccountDefaultVariant,
      onUpdateAccountEnabledModels,
      variantsByModel,
    ]
  );

  const expandable = useMemo(
    () => ({
      rowExpandable: () => true,
      expandedRowRender: renderExpandedGroupCard,
      expandedRowKeys: expandedGroupKeys,
      onExpandedRowsChange: (keys: string[]) => {
        setExpandedGroupKeys(keys.slice(-1));
      },
    }),
    [expandedGroupKeys, renderExpandedGroupCard]
  );

  return (
    <SettingsTable<IntegrationsModelGroupRow>
      hover
      loading={loading}
      selectFilters={selectFilters}
      columns={columns}
      rows={groupRows}
      getRowKey={getIntegrationsGroupRowKey}
      expandable={expandable}
      onRowClick={setSingleExpandedGroup}
      headerHeight="tall"
      className="table-expanded-no-hover table-settings-expanded-compact table-layout-fixed"
      searchBar={{
        searchValue: modelsSearchQuery,
        onSearchChange: setModelsSearchQuery,
        searchPlaceholder: t("modelsTable.searchPlaceholder"),
        allowSearchClear: true,
      }}
      emptyTitle={t("modelsTable.noModels")}
      emptyAction={{
        label: t("addOptions.addModel"),
        onClick: onAdd,
      }}
      footer={expandControl}
    />
  );
}
