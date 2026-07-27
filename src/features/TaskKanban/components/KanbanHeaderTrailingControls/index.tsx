import { RefreshCw } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { useRefreshSpin } from "@src/hooks/ui";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";

import {
  KANBAN_AUTO_ARCHIVE_TTLS,
  KANBAN_TIME_FILTERS,
  type KanbanAutoArchiveTtl,
  type KanbanTimeFilter,
} from "../../config";

export interface KanbanHeaderTrailingControlsProps {
  autoArchiveTtl: KanbanAutoArchiveTtl;
  onAutoArchiveTtlChange: (ttl: KanbanAutoArchiveTtl) => void;
  timeFilter: KanbanTimeFilter;
  onTimeFilterChange: (filter: KanbanTimeFilter) => void;
  refreshing: boolean;
  onRefresh: () => void;
}

const KanbanHeaderTrailingControls: React.FC<
  KanbanHeaderTrailingControlsProps
> = ({
  autoArchiveTtl,
  onAutoArchiveTtlChange,
  timeFilter,
  onTimeFilterChange,
  refreshing,
  onRefresh,
}) => {
  const { t } = useTranslation("sessions");
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh,
    refreshing,
    "task-kanban:manual-refresh"
  );

  const timeFilterOptions = useMemo<SelectOption[]>(
    () =>
      KANBAN_TIME_FILTERS.map((filter) => {
        const label = t(filter.labelKey);
        return {
          label,
          value: filter.key,
          triggerLabel: `${t("kanban.timeFilter.label")}: ${label}`,
        };
      }),
    [t]
  );

  const autoArchiveOptions = useMemo<SelectOption[]>(
    () =>
      KANBAN_AUTO_ARCHIVE_TTLS.map((ttl) => {
        const label = t(ttl.labelKey);
        return {
          label,
          value: ttl.key,
          triggerLabel: `${t("kanban.autoArchive.label")}: ${label}`,
        };
      }),
    [t]
  );

  return (
    <div className="flex min-w-0 items-center gap-2 overflow-visible">
      <WorkstationToolbarTooltip label={t("common:actions.refresh")}>
        <Button
          variant="tertiary"
          appearance="ghost"
          size="mini"
          icon={<RefreshCw size={13} className={spinClass} aria-hidden />}
          disabled={refreshing}
          aria-label={t("common:actions.refresh")}
          data-testid="task-kanban-refresh"
          onClick={handleRefreshClick}
        />
      </WorkstationToolbarTooltip>
      <Select
        value={autoArchiveTtl}
        options={autoArchiveOptions}
        onChange={(value) =>
          onAutoArchiveTtlChange(value as KanbanAutoArchiveTtl)
        }
        size="small"
        radius="lg"
        variant="ghost"
        dropdownAlign="right"
        dropdownWidthMode="min-match"
        className="w-auto text-[12px]"
      />
      <Select
        value={timeFilter}
        options={timeFilterOptions}
        onChange={(value) => onTimeFilterChange(value as KanbanTimeFilter)}
        size="small"
        radius="lg"
        variant="ghost"
        dropdownAlign="right"
        dropdownWidthMode="min-match"
        className="w-auto text-[12px]"
      />
    </div>
  );
};

export default KanbanHeaderTrailingControls;
