import { ChevronRight, Plus } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";
import {
  HEADER_BUTTON,
  HEADER_ICON_SIZE,
} from "@src/config/workstation/tokens";
import type { DropdownOption } from "@src/types/core/shared";

interface WorkItemSectionProps {
  status?: string;
  statusConfig: DropdownOption;
  count: number;
  children?: React.ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  label?: React.ReactNode;
  addButtonTitle?: string;
  onAddItem?: () => void;
  compact?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** The virtualizer owns stickiness and row spacing in this mode. */
  virtualizedHeader?: boolean;
}

const WorkItemSection: React.FC<WorkItemSectionProps> = ({
  statusConfig,
  count,
  children,
  defaultExpanded = true,
  expanded,
  label,
  addButtonTitle,
  onAddItem,
  compact = false,
  onExpandedChange,
  virtualizedHeader = false,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? internalExpanded;
  const sectionLabel =
    label ?? t(`workItems.statusLabels.${statusConfig.value}`);
  const addTitle =
    addButtonTitle ??
    t("workItems.addStatusItem", {
      status: sectionLabel,
    });
  const toggleExpanded = () => {
    const nextExpanded = !isExpanded;
    if (expanded === undefined) {
      setInternalExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  };
  return (
    <div
      className={`${
        virtualizedHeader
          ? compact
            ? "px-0"
            : "px-2 pt-2"
          : compact
            ? "mb-2 px-0"
            : "mb-3 px-2 first:pt-2"
      } flex flex-col gap-1`}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        className={`group ${virtualizedHeader ? "" : "sticky top-0 z-10"} flex w-full cursor-pointer items-center gap-1 rounded-lg border-[0.5px] border-border-1 text-left transition-colors ${compact ? "h-8 bg-fill-2 px-1.5 hover:bg-fill-3" : "h-9 bg-workstation-bg px-2 hover:bg-surface-hover"}`}
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            toggleExpanded();
          }
        }}
      >
        {/* Chevron — actionCompactTreeRow inside 28×28 container to align with checkbox column */}
        <div className="flex h-7 w-7 shrink-0 items-center justify-center">
          <div
            className={`${HEADER_BUTTON.actionMdTreeRow} [&>svg]:transition-transform [&>svg]:duration-150 ${isExpanded ? "[&>svg]:rotate-90" : ""}`}
          >
            <ChevronRight size={HEADER_ICON_SIZE.sm} />
          </div>
        </div>

        {/* Status icon - aligned with priority column */}
        <Tooltip content={sectionLabel} position="top" mouseEnterDelay={300}>
          <div className="flex h-7 w-7 shrink-0 items-center justify-center">
            <div
              className="flex h-6 w-6 items-center justify-center"
              style={{ color: statusConfig.color }}
            >
              {statusConfig.icon}
            </div>
          </div>
        </Tooltip>

        {/* Label - hug text, left aligned */}
        <span className="whitespace-nowrap text-[13px] font-medium text-text-1">
          {sectionLabel}
        </span>

        <span
          className="ml-2.5 text-[13px] font-semibold tabular-nums leading-none"
          style={{ color: statusConfig.color }}
        >
          {count}
        </span>

        {/* Spacer to push add button to right */}
        <div className="flex-1" />

        {onAddItem && (
          <Tooltip content={addTitle} position="top" mouseEnterDelay={300}>
            <button
              type="button"
              className={`${HEADER_BUTTON.actionTreeRow} mr-2 shrink-0 opacity-0 transition-opacity group-hover:opacity-100`}
              onClick={(event) => {
                event.stopPropagation();
                onAddItem();
              }}
            >
              <Plus size={HEADER_ICON_SIZE.sm} />
            </button>
          </Tooltip>
        )}
      </div>
      {!virtualizedHeader && isExpanded && (
        <div className="flex flex-col gap-1">{children}</div>
      )}
    </div>
  );
};

export default WorkItemSection;
