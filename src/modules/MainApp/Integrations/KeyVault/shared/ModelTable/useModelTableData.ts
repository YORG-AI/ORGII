/**
 * useModelTableData — Data and filter logic for ModelTable
 *
 * Encapsulates all model grouping, family/status filtering, search,
 * and group expand state so the component stays under the 600-line limit.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import type { SettingsTableSelectFilter } from "@src/components/SettingsTable";
import type {
  ModelTableModelAlias,
  ModelTableVariantInfo,
  ModelTableViewMode,
} from "@src/types/modelTable";
import {
  getModelFamily,
  groupModels,
  isLegacyGroup,
  modelNameHasSnapshotDate,
} from "@src/util/modelGrouping";
import type { ModelGroup } from "@src/util/modelGrouping";
import { normalizedIncludes } from "@src/util/search/fuzzy";

// ── Constants ─────────────────────────────────────────────────────────────────

export const ALL_FILTER = "all";
export const OTHER_FILTER = "Other";
export const MIN_FAMILY_SIZE = 3;

export const OLDER_SCOPE = {
  CURRENT: "current",
  INCLUDE_OLDER: "includeOlder",
} as const;

export type OlderScope = (typeof OLDER_SCOPE)[keyof typeof OLDER_SCOPE];

export const STATUS_FILTER = {
  ALL: "all",
  ENABLED: "enabled",
  DISABLED: "disabled",
} as const;

export type StatusFilter = (typeof STATUS_FILTER)[keyof typeof STATUS_FILTER];

function mergeGroupsByLabel(groups: ModelGroup[]): ModelGroup[] {
  const merged = new Map<string, ModelGroup>();
  for (const group of groups) {
    const existing = merged.get(group.label);
    if (existing) {
      existing.models.push(...group.models);
      existing.sortVersion = Math.max(existing.sortVersion, group.sortVersion);
      continue;
    }
    merged.set(group.label, { ...group, models: [...group.models] });
  }
  return Array.from(merged.values()).sort(
    (groupA, groupB) => groupB.sortVersion - groupA.sortVersion
  );
}

// ── Row types ─────────────────────────────────────────────────────────────────

export interface FlatRow {
  model: string;
  /** Catalog = API-detected; custom = user-added (wizard unified table). */
  source: "catalog" | "custom";
  rowId?: string;
}

export interface GroupRow {
  key: string;
  /** "custom" = synthetic group of user-added rows (Key Vault wizard). */
  type: "current" | "older" | "custom";
  groupLabel: string;
  group: ModelGroup;
  rowId?: string;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseModelTableDataOptions {
  models: string[];
  enabledModelsProp: string[] | Set<string>;
  defaultView?: ModelTableViewMode;
  /** User-added model ids after catalog rows (Key Vault wizard). */
  customModels?: string[];
  modelAliases?: ModelTableModelAlias[];
  modelVariants?: ModelTableVariantInfo[];
}

export function useModelTableData({
  models,
  enabledModelsProp,
  defaultView = "flat",
  customModels = [],
  modelAliases = [],
  modelVariants = [],
}: UseModelTableDataOptions) {
  const { t } = useTranslation("integrations");

  const [viewMode, setViewMode] = useState<ModelTableViewMode>(defaultView);
  const [searchQuery, setSearchQuery] = useState("");
  // Default to showing all models (latest + older). The dropdown filter lets
  // the user narrow to "Latest only" — there is no separate older-only mode.
  const [olderScope, setOlderScope] = useState<OlderScope>(
    OLDER_SCOPE.INCLUDE_OLDER
  );
  const [familyFilter, setFamilyFilter] = useState(ALL_FILTER);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    STATUS_FILTER.ALL
  );
  const [expandedGroupRowKeys, setExpandedGroupRowKeys] = useState<string[]>(
    []
  );
  const customRowIdByModel = useMemo(() => {
    const ids = new Map<string, string>();
    for (const model of customModels) {
      const alias = modelAliases.find((entry) => entry.alias === model);
      ids.set(model, alias?.rowId ?? model);
    }
    return ids;
  }, [customModels, modelAliases]);

  const variantBaseByModel = useMemo(() => {
    const bases = new Map(
      modelVariants.map((variant) => [variant.model, variant.base_model])
    );
    const variantBaseModels = new Set(
      modelVariants.map((variant) => variant.base_model)
    );
    for (const model of models) {
      if (variantBaseModels.has(model)) bases.set(model, model);
    }
    return bases;
  }, [models, modelVariants]);

  // ── Normalised enabled set / array ────────────────────────────────────────

  const enabledSet = useMemo(
    () =>
      enabledModelsProp instanceof Set
        ? enabledModelsProp
        : new Set(enabledModelsProp),
    [enabledModelsProp]
  );

  const enabledArray = useMemo(
    () =>
      Array.isArray(enabledModelsProp)
        ? enabledModelsProp
        : [...enabledModelsProp],
    [enabledModelsProp]
  );

  // ── Scoped models (older scope gate) ─────────────────────────────────────

  const includeOlder = olderScope === OLDER_SCOPE.INCLUDE_OLDER;

  const scopedModels = useMemo(() => {
    if (includeOlder) return models;
    return models.filter((model) => !modelNameHasSnapshotDate(model));
  }, [models, includeOlder]);

  // ── Shared model grouping ─────────────────────────────────────────────────

  const groups = useMemo(() => {
    if (variantBaseByModel.size === 0) return groupModels(scopedModels);

    const grouped = new Map<string, ModelGroup>();
    for (const model of scopedModels) {
      const baseModel = variantBaseByModel.get(model);
      if (!baseModel) continue;
      const [baseGroup] = groupModels([baseModel]);
      if (!baseGroup) continue;
      const existing = grouped.get(baseModel);
      if (existing) {
        existing.models.push(model);
      } else {
        grouped.set(baseModel, {
          label: baseGroup.label,
          sortVersion: baseGroup.sortVersion,
          models: [model],
        });
      }
    }

    const remaining = scopedModels.filter(
      (model) => !variantBaseByModel.has(model)
    );
    return mergeGroupsByLabel([
      ...Array.from(grouped.values()),
      ...groupModels(remaining),
    ]);
  }, [scopedModels, variantBaseByModel]);

  // ── Dynamic provider family tabs ──────────────────────────────────────────

  const { displayFamilies, otherFamilySet } = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of scopedModels) {
      const family = getModelFamily(model);
      counts.set(family, (counts.get(family) ?? 0) + 1);
    }

    const main: string[] = [];
    const other = new Set<string>();

    for (const [family, count] of counts) {
      if (family === "Other" || count < MIN_FAMILY_SIZE) {
        other.add(family);
      } else {
        main.push(family);
      }
    }

    main.sort(
      (famA, famB) => (counts.get(famB) ?? 0) - (counts.get(famA) ?? 0)
    );

    return { displayFamilies: main, otherFamilySet: other };
  }, [scopedModels]);

  const tabCount = displayFamilies.length + (otherFamilySet.size > 0 ? 1 : 0);
  const showFamilyFilter = tabCount > 1;

  // ── Filter option arrays ──────────────────────────────────────────────────

  const familyFilterOptions = useMemo<SelectOption[]>(() => {
    if (!showFamilyFilter) return [];
    return [
      {
        value: ALL_FILTER,
        label: t("modelsTable.filterAllProvider"),
      },
      ...displayFamilies.map((family) => ({ value: family, label: family })),
      ...(otherFamilySet.size > 0
        ? [
            {
              value: OTHER_FILTER,
              label: t("modelsTable.filterOther"),
            },
          ]
        : []),
    ];
  }, [showFamilyFilter, displayFamilies, otherFamilySet, t]);

  const statusFilterOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: STATUS_FILTER.ALL,
        label: t("modelsTable.statusAll"),
      },
      {
        value: STATUS_FILTER.ENABLED,
        label: t("modelsTable.statusEnabled"),
      },
      {
        value: STATUS_FILTER.DISABLED,
        label: t("modelsTable.statusDisabled"),
      },
    ],
    [t]
  );

  const modelScopeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: OLDER_SCOPE.INCLUDE_OLDER,
        label: t("modelsTable.scopeSelectIncludeOlder"),
      },
      {
        value: OLDER_SCOPE.CURRENT,
        label: t("modelsTable.scopeSelectCurrentModels"),
      },
    ],
    [t]
  );

  // Show the model-scope filter only when the catalog actually contains older
  // (snapshot-dated) models — no point asking the user to pick an era when
  // there's only one era to pick.
  const hasOlderModels = useMemo(
    () => models.some((model) => modelNameHasSnapshotDate(model)),
    [models]
  );

  const selectFilters = useMemo<SettingsTableSelectFilter[]>(() => {
    const filters: SettingsTableSelectFilter[] = [];
    if (showFamilyFilter) {
      filters.push({
        key: "family",
        value: familyFilter,
        defaultValue: ALL_FILTER,
        options: familyFilterOptions,
        onChange: (val) => setFamilyFilter(val as string),
      });
    }
    filters.push({
      key: "status",
      value: statusFilter,
      defaultValue: STATUS_FILTER.ALL,
      options: statusFilterOptions,
      onChange: (val) => setStatusFilter(val as StatusFilter),
    });
    if (hasOlderModels) {
      filters.push({
        key: "modelScope",
        value: olderScope,
        defaultValue: OLDER_SCOPE.INCLUDE_OLDER,
        options: modelScopeOptions,
        minWidth: 160,
        onChange: (val) => setOlderScope(val as OlderScope),
      });
    }
    return filters;
  }, [
    showFamilyFilter,
    familyFilterOptions,
    familyFilter,
    statusFilter,
    statusFilterOptions,
    hasOlderModels,
    olderScope,
    modelScopeOptions,
  ]);

  // ── Flat view data ────────────────────────────────────────────────────────

  const catalogFlatRows = useMemo<FlatRow[]>(() => {
    const mapped = scopedModels.map((model) => ({
      model,
      source: "catalog" as const,
    }));
    return mapped.sort(
      (rowA, rowB) =>
        Number(!enabledSet.has(rowA.model)) -
        Number(!enabledSet.has(rowB.model))
    );
  }, [scopedModels, enabledSet]);

  const customFlatRows = useMemo<FlatRow[]>(
    () =>
      customModels.map((model) => ({
        model,
        source: "custom" as const,
        rowId: customRowIdByModel.get(model),
      })),
    [customModels, customRowIdByModel]
  );

  const filteredCatalogFlatRows = useMemo(() => {
    let rows = catalogFlatRows;
    if (familyFilter === OTHER_FILTER) {
      rows = rows.filter((row) =>
        otherFamilySet.has(getModelFamily(row.model))
      );
    } else if (familyFilter !== ALL_FILTER) {
      rows = rows.filter((row) => getModelFamily(row.model) === familyFilter);
    }
    if (statusFilter === STATUS_FILTER.ENABLED) {
      rows = rows.filter((row) => enabledSet.has(row.model));
    } else if (statusFilter === STATUS_FILTER.DISABLED) {
      rows = rows.filter((row) => !enabledSet.has(row.model));
    }
    return rows;
  }, [catalogFlatRows, familyFilter, otherFamilySet, statusFilter, enabledSet]);

  const filteredCustomFlatRows = useMemo(() => {
    let rows = customFlatRows;
    if (statusFilter === STATUS_FILTER.ENABLED) {
      rows = rows.filter((row) => enabledSet.has(row.model));
    } else if (statusFilter === STATUS_FILTER.DISABLED) {
      rows = rows.filter((row) => !enabledSet.has(row.model));
    }
    return rows;
  }, [customFlatRows, statusFilter, enabledSet]);

  const mergedFlatRowsBeforeSearch = useMemo(
    () => [...filteredCatalogFlatRows, ...filteredCustomFlatRows],
    [filteredCatalogFlatRows, filteredCustomFlatRows]
  );

  const visibleFlatRows = useMemo(() => {
    if (!searchQuery.trim()) return mergedFlatRowsBeforeSearch;
    const query = searchQuery.toLowerCase();
    return mergedFlatRowsBeforeSearch.filter(
      (row) =>
        row.source === "custom" ||
        normalizedIncludes(row.model.toLowerCase(), query)
    );
  }, [mergedFlatRowsBeforeSearch, searchQuery]);

  // ── Group view data ───────────────────────────────────────────────────────

  const groupRows = useMemo<GroupRow[]>(() => {
    const currentGroups = groups.filter((group) => !isLegacyGroup(group));
    const olderGroups = groups.filter((group) => isLegacyGroup(group));
    const rows: GroupRow[] = [
      ...currentGroups.map((group) => ({
        key: `current-${group.label}`,
        type: "current" as const,
        groupLabel: group.label,
        group,
      })),
      ...olderGroups.map((group) => ({
        key: `older-${group.label}`,
        type: "older" as const,
        groupLabel: group.label,
        group,
      })),
      // Custom rows are surfaced as flat top-level entries (no grouping),
      // so each custom model is its own GroupRow with a single-model group.
      ...customModels.map((model) => {
        const rowId = customRowIdByModel.get(model) ?? model;
        return {
          key: `custom:${rowId}`,
          type: "custom" as const,
          groupLabel: model,
          group: { label: model, sortVersion: 0, models: [model] },
          rowId,
        };
      }),
    ];
    return rows;
  }, [groups, customModels, customRowIdByModel]);

  const familyFilteredGroupRows = useMemo(() => {
    let rows = groupRows;
    if (familyFilter === OTHER_FILTER) {
      rows = rows.filter(
        (row) =>
          row.type === "custom" ||
          row.group.models.some((model) =>
            otherFamilySet.has(getModelFamily(model))
          )
      );
    } else if (familyFilter !== ALL_FILTER) {
      rows = rows.filter(
        (row) =>
          row.type === "custom" ||
          row.group.models.some(
            (model) => getModelFamily(model) === familyFilter
          )
      );
    }
    if (statusFilter === STATUS_FILTER.ENABLED) {
      rows = rows.filter((row) =>
        row.group.models.some((model) => enabledSet.has(model))
      );
    } else if (statusFilter === STATUS_FILTER.DISABLED) {
      rows = rows.filter((row) =>
        row.group.models.some((model) => !enabledSet.has(model))
      );
    }
    return rows;
  }, [groupRows, familyFilter, otherFamilySet, statusFilter, enabledSet]);

  const filteredGroupRows = useMemo(() => {
    if (!searchQuery.trim()) return familyFilteredGroupRows;
    const query = searchQuery.toLowerCase();
    return familyFilteredGroupRows.filter(
      (row) =>
        row.type === "custom" ||
        normalizedIncludes(row.groupLabel.toLowerCase(), query) ||
        row.group.models.some((model) =>
          normalizedIncludes(model.toLowerCase(), query)
        )
    );
  }, [familyFilteredGroupRows, searchQuery]);

  const visibleGroupRows = useMemo<GroupRow[]>(() => {
    if (searchQuery.trim()) return filteredGroupRows;
    return familyFilteredGroupRows;
  }, [searchQuery, filteredGroupRows, familyFilteredGroupRows]);

  const visibleGroupRowKeys = useMemo(
    () => visibleGroupRows.map((row) => row.key),
    [visibleGroupRows]
  );

  const expandedGroupRowKeysInView = useMemo(() => {
    const valid = new Set(visibleGroupRowKeys);
    return expandedGroupRowKeys.filter((key) => valid.has(key));
  }, [expandedGroupRowKeys, visibleGroupRowKeys]);

  const handleExpandedGroupRowsChange = useCallback(
    (keys: string[]) => {
      setExpandedGroupRowKeys((prev) => {
        const valid = new Set(visibleGroupRowKeys);
        const rest = prev.filter((key) => !valid.has(key));
        return [...rest, ...keys];
      });
    },
    [visibleGroupRowKeys]
  );

  // ── Derived flags ─────────────────────────────────────────────────────────

  const searchOrFamilyFiltered =
    searchQuery.length > 0 ||
    familyFilter !== ALL_FILTER ||
    statusFilter !== STATUS_FILTER.ALL;

  const emptyStateIsFiltered = searchOrFamilyFiltered;

  return {
    // View state
    viewMode,
    setViewMode,
    searchQuery,
    setSearchQuery,
    olderScope,
    setOlderScope,
    familyFilter,
    setFamilyFilter,
    statusFilter,
    setStatusFilter,

    // Derived data
    enabledSet,
    enabledArray,
    scopedModels,
    selectFilters,

    // Flat view
    visibleFlatRows,

    // Group view
    visibleGroupRows,
    visibleGroupRowKeys,
    expandedGroupRowKeysInView,
    handleExpandedGroupRowsChange,

    // Flags
    searchOrFamilyFiltered,
    emptyStateIsFiltered,
  };
}
