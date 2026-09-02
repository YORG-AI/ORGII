import type { TFunction } from "i18next";
import { useMemo } from "react";

import type {
  LearningCategoryValue,
  LearningRecord,
  LearningSourceValue,
  LearningStatusValue,
} from "@src/api/tauri/rpc/schemas/learning";
import Button from "@src/components/Button";
import type { SelectOption } from "@src/components/Select";
import {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import type { LearningsBrowserFilters } from "@src/hooks/settings/useLearningsBrowser";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";

import {
  CATEGORY_SELECT_ORDER,
  PANEL_COLUMN_KEYS,
  READ_ONLY_LEARNING_STATUSES,
  SOURCE_SELECT_ORDER,
  STATUS_FILTER_ALL,
  STATUS_SELECT_ORDER,
  STATUS_SELECT_ORDER_FULL,
} from "./constants";
import { formatRelativeTime, truncate } from "./formatters";
import type { LearningsBrowserVariant } from "./types";

interface UseLearningsTableConfigParams {
  variant: LearningsBrowserVariant;
  filters: LearningsBrowserFilters;
  setFilters: (next: LearningsBrowserFilters) => void;
  actioningId: string | null;
  t: TFunction;
  getAgentLabel: (row: LearningRecord) => string;
  getCategoryLabel: (row: LearningRecord) => string;
  handlePromote: (row: LearningRecord) => void;
  handleDeprecate: (row: LearningRecord) => void;
  handleReactivate: (row: LearningRecord) => void;
  handleDelete: (row: LearningRecord) => void;
}

interface UseLearningsTableConfigReturn {
  columns: SettingsTableColumn<LearningRecord>[];
  selectFilters: SettingsTableSelectFilter[];
}

const PANEL_COLUMNS = new Set<string>(PANEL_COLUMN_KEYS);

export function useLearningsTableConfig({
  variant,
  filters,
  setFilters,
  actioningId,
  t,
  getAgentLabel,
  getCategoryLabel,
  handlePromote,
  handleDeprecate,
  handleReactivate,
  handleDelete,
}: UseLearningsTableConfigParams): UseLearningsTableConfigReturn {
  const allColumns: SettingsTableColumn<LearningRecord>[] = useMemo(
    () => [
      {
        key: "takeaway",
        label: t("learningsBrowser.columns.takeaway"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} block max-w-full min-w-0 truncate`}
          >
            {row.takeaway ?? truncate(row.content, 80)}
          </span>
        ),
      },
      {
        key: "agent",
        label: t("common:terminology.agent"),
        width: SETTINGS_TABLE_COL.valueLg,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {getAgentLabel(row)}
          </span>
        ),
      },
      {
        key: "category",
        label: t("learningsBrowser.filterLabels.category"),
        width: SETTINGS_TABLE_COL.valueLg,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {getCategoryLabel(row)}
          </span>
        ),
      },
      {
        key: "status",
        label: t("learningsBrowser.columns.status"),
        width: "110px",
        renderCell: (row) => (
          <span className="rounded bg-fill-2 px-2 py-0.5 text-xs text-text-2">
            {t(`learningsBrowser.status.${row.status}`, row.status)}
          </span>
        ),
      },
      {
        key: "source",
        label: t("learningsBrowser.columns.source"),
        width: "140px",
        renderCell: (row) => (
          <span className="text-xs text-text-3">
            {t(`learningsBrowser.source.${row.source}`, row.source)}
          </span>
        ),
      },
      {
        key: "reinforcement",
        label: t("learningsBrowser.columns.reinforcement"),
        width: "90px",
        renderCell: (row) => (
          <span className="text-xs text-text-3">
            ×{row.reinforcement_count}
          </span>
        ),
      },
      {
        key: "lastRecalled",
        label: t("learningsBrowser.columns.lastRecalled"),
        width: "100px",
        renderCell: (row) => (
          <span className="text-xs text-text-3">
            {row.last_recalled_at
              ? formatRelativeTime(row.last_recalled_at)
              : "—"}
          </span>
        ),
      },
      {
        key: "updated",
        label: t("learningsBrowser.columns.updatedAt"),
        width: "100px",
        renderCell: (row) => (
          <span className="text-xs text-text-3">
            {formatRelativeTime(row.updated_at)}
          </span>
        ),
      },
      {
        key: "actions",
        label: t("learningsBrowser.columns.actions"),
        width: "170px",
        renderCell: (row) => {
          const busy = actioningId === row.id;
          return (
            <div className="flex items-center gap-1">
              {row.status === "pending" && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => handlePromote(row)}
                >
                  {t("learningsBrowser.actions.promote")}
                </Button>
              )}
              {row.status === "active" && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => handleDeprecate(row)}
                >
                  {t("learningsBrowser.actions.deprecate")}
                </Button>
              )}
              {row.status === "deprecated" && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => handleReactivate(row)}
                >
                  {t("learningsBrowser.actions.reactivate")}
                </Button>
              )}
              {!READ_ONLY_LEARNING_STATUSES.includes(row.status) && (
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() => handleDelete(row)}
                  icon={
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      data-icon="trash-2"
                      size={14}
                    />
                  }
                  iconOnly
                  title={t("learningsBrowser.actions.delete")}
                />
              )}
            </div>
          );
        },
      },
    ],
    [
      actioningId,
      getAgentLabel,
      getCategoryLabel,
      handleDelete,
      handleDeprecate,
      handlePromote,
      handleReactivate,
      t,
    ]
  );

  const columns = useMemo(
    () =>
      variant === "integrationsPanel"
        ? allColumns.filter((column) => PANEL_COLUMNS.has(column.key))
        : allColumns,
    [variant, allColumns]
  );

  const statusFilterOptions = useMemo<SelectOption[]>(
    () =>
      (variant === "integrationsPanel"
        ? STATUS_SELECT_ORDER
        : STATUS_SELECT_ORDER_FULL
      ).map((key) => ({
        value: key,
        label: t(`learningsBrowser.tabs.${key}`),
      })),
    [variant, t]
  );

  const sourceFilterOptions = useMemo<SelectOption[]>(
    () =>
      SOURCE_SELECT_ORDER.map((key) => ({
        value: key,
        label: t(`learningsBrowser.source.${key}`),
      })),
    [t]
  );

  const categoryFilterOptions = useMemo<SelectOption[]>(
    () =>
      CATEGORY_SELECT_ORDER.map((key) => ({
        value: key,
        label: t(`learningsBrowser.category.${key}`),
      })),
    [t]
  );

  const selectFilters = useMemo<SettingsTableSelectFilter[]>(() => {
    const base: SettingsTableSelectFilter[] = [
      {
        key: "status",
        value: filters.status ?? STATUS_FILTER_ALL,
        defaultValue: STATUS_FILTER_ALL,
        options: statusFilterOptions,
        minWidth: 160,
        onChange: (value) => {
          const nextValue = String(value);
          setFilters({
            ...filters,
            status:
              nextValue === STATUS_FILTER_ALL
                ? undefined
                : (nextValue as LearningStatusValue),
          });
        },
      },
      {
        key: "category",
        value: filters.category ?? STATUS_FILTER_ALL,
        defaultValue: STATUS_FILTER_ALL,
        options: categoryFilterOptions,
        minWidth: 160,
        onChange: (value) => {
          const nextValue = String(value);
          setFilters({
            ...filters,
            category:
              nextValue === STATUS_FILTER_ALL
                ? undefined
                : (nextValue as LearningCategoryValue),
          });
        },
      },
    ];

    if (variant !== "integrationsPanel") {
      base.splice(1, 0, {
        key: "source",
        value: filters.source ?? STATUS_FILTER_ALL,
        defaultValue: STATUS_FILTER_ALL,
        options: sourceFilterOptions,
        minWidth: 180,
        onChange: (value) => {
          const nextValue = String(value);
          setFilters({
            ...filters,
            source:
              nextValue === STATUS_FILTER_ALL
                ? undefined
                : (nextValue as LearningSourceValue),
          });
        },
      });
    }

    return base;
  }, [
    variant,
    filters,
    setFilters,
    statusFilterOptions,
    sourceFilterOptions,
    categoryFilterOptions,
  ]);

  return { columns, selectFilters };
}
