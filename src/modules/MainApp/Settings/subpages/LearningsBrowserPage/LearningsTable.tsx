import type { TFunction } from "i18next";
import React, { useMemo } from "react";

import type { LearningRecord } from "@src/api/tauri/rpc/schemas/learning";
import SettingsTable, {
  type SettingsTableColumn,
  SettingsTableLoadMoreFooter,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";

import { LEARNINGS_PAGE_SIZE } from "./constants";
import type { LearningsBrowserVariant } from "./types";

interface LearningsTableProps {
  variant: LearningsBrowserVariant;
  loading?: boolean;
  filtersSearch?: string;
  columns: SettingsTableColumn<LearningRecord>[];
  selectFilters: SettingsTableSelectFilter[];
  visibleItems: LearningRecord[];
  filteredItemCount: number;
  expandedLearningKeys: string[];
  t: TFunction;
  onSearchChange: (value: string) => void;
  onExpandedRowsChange: (keys: string[]) => void;
  onLoadMore: () => void;
  renderExpandedLearningCard: (row: LearningRecord) => React.ReactNode;
}

export const LearningsTable: React.FC<LearningsTableProps> = ({
  loading = false,
  filtersSearch,
  columns,
  selectFilters,
  visibleItems,
  filteredItemCount,
  expandedLearningKeys,
  t,
  onSearchChange,
  onExpandedRowsChange,
  onLoadMore,
  renderExpandedLearningCard,
}) => {
  const searchBar = useMemo(
    () => ({
      searchValue: filtersSearch ?? "",
      searchPlaceholder: t("learningsBrowser.searchPlaceholder"),
      onSearchChange,
      allowSearchClear: true,
    }),
    [filtersSearch, onSearchChange, t]
  );

  const hasMoreItems = visibleItems.length < filteredItemCount;

  return (
    <SettingsTable<LearningRecord>
      hover
      loading={loading}
      searchBar={searchBar}
      selectFilters={selectFilters}
      columns={columns}
      rows={visibleItems}
      getRowKey={(row) => row.id}
      headerHeight="tall"
      className="table-expanded-no-hover table-layout-fixed"
      expandable={{
        expandedRowRender: renderExpandedLearningCard,
        rowExpandable: () => true,
        expandedRowKeys: expandedLearningKeys,
        onExpandedRowsChange,
      }}
      footer={
        hasMoreItems ? (
          <SettingsTableLoadMoreFooter
            label={t("common:actions.loadMore")}
            onClick={onLoadMore}
          />
        ) : null
      }
      emptyTitle={t("learningsBrowser.empty.title")}
      emptySubtitle={
        filtersSearch
          ? t("learningsBrowser.empty.searchSubtitle")
          : t("learningsBrowser.empty.subtitle")
      }
    />
  );
};

export function getNextLearningsLimit(currentLimit: number): number {
  return currentLimit + LEARNINGS_PAGE_SIZE;
}
