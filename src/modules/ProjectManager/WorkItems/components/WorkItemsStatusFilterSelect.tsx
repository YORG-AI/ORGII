import { List } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { getWorkItemStatusConfig } from "@src/modules/ProjectManager/config/manage";

import { FILTER_TO_STATUS, STATUS_FILTER_KEYS } from "../types";
import type { StatusFilterType } from "../types";

type StatusCountMap = Record<StatusFilterType, number> & Record<string, number>;

interface WorkItemsStatusFilterSelectProps {
  value: StatusFilterType;
  onChange: (value: StatusFilterType) => void;
  statusCounts: StatusCountMap;
  filterKeys?: readonly StatusFilterType[];
  dropdownAlign?: "left" | "right";
}

const WorkItemsStatusFilterSelect: React.FC<
  WorkItemsStatusFilterSelectProps
> = ({
  value,
  onChange,
  statusCounts,
  filterKeys = STATUS_FILTER_KEYS,
  dropdownAlign = "right",
}) => {
  const { t } = useTranslation("projects");

  const getStatusFilterIcon = useCallback((key: StatusFilterType) => {
    if (key === "all") {
      return <List size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />;
    }

    const status = FILTER_TO_STATUS[key];
    const option = status ? getWorkItemStatusConfig(status) : undefined;
    if (!option?.icon) {
      return <List size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />;
    }

    return (
      <span style={option.color ? { color: option.color } : undefined}>
        {option.icon}
      </span>
    );
  }, []);

  const effectiveValue = filterKeys.includes(value) ? value : "all";

  const statusFilterOptions = useMemo<SelectOption[]>(
    () =>
      filterKeys.map((key) => {
        const count = statusCounts[key] ?? 0;
        const label = t(`workItems.statusFilters.${key}`);
        return {
          value: key,
          label: (
            <span className="flex items-center gap-2 whitespace-nowrap">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
                {getStatusFilterIcon(key)}
              </span>
              <span>{label}</span>
              <span className="tabular-nums text-text-3">{count}</span>
            </span>
          ),
          triggerLabel: label,
        };
      }),
    [filterKeys, getStatusFilterIcon, statusCounts, t]
  );

  return (
    <Select
      value={effectiveValue}
      onChange={(nextValue) => {
        if (Array.isArray(nextValue)) return;
        onChange(nextValue.toString() as StatusFilterType);
      }}
      options={statusFilterOptions}
      size="small"
      appearance="ghost"
      radius="lg"
      dropdownWidthMode="match"
      dropdownMinWidth={172}
      dropdownAlign={dropdownAlign}
      className="w-auto"
    />
  );
};

export default WorkItemsStatusFilterSelect;
