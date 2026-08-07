import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  ChevronRight,
  Info,
  Trash2,
} from "lucide-react";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

interface WorkItemDetailHeaderProps {
  workItem: WorkItemExtended;
  pendingUpdates: Partial<WorkItemExtended>;
  breadcrumbProjectName?: string;
  shortId?: string | null;
  propertiesOpen: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onNavigate: (direction: "prev" | "next") => void;
  onDeleteWorkItem?: (id: string) => void;
  onExpandToTab?: (pendingUpdates: Partial<WorkItemExtended>) => void;
  onToggleProperties?: () => void;
  t: (key: string) => string;
}

export function WorkItemDetailHeader({
  workItem,
  pendingUpdates,
  breadcrumbProjectName,
  shortId,
  propertiesOpen,
  hasPrev,
  hasNext,
  onClose,
  onNavigate,
  onDeleteWorkItem,
  onExpandToTab,
  onToggleProperties,
  t,
}: WorkItemDetailHeaderProps) {
  const title = shortId ? `${shortId} · ${workItem.name}` : workItem.name;

  return (
    <>
      <div className="flex min-w-0 flex-shrink items-center gap-1.5">
        {breadcrumbProjectName ? (
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              onClick={onClose}
              className="whitespace-nowrap text-[12px] text-text-2 hover:text-text-1 hover:underline"
              title={t("common:actions.back")}
            >
              {breadcrumbProjectName}
            </button>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className="mx-1 flex-shrink-0 text-fill-4"
              aria-hidden
            />
            <span
              className="min-w-0 truncate text-[12px] font-medium text-text-1"
              title={title}
            >
              {workItem.name || t("workItems.untitled")}
            </span>
          </div>
        ) : (
          <span
            className="min-w-0 truncate text-[12px] font-medium text-text-1"
            title={title}
          >
            {workItem.name || t("workItems.untitled")}
          </span>
        )}
      </div>
      <div className="ml-auto flex flex-shrink-0 items-center gap-px">
        <WorkstationToolbarTooltip label={t("common:actions.previous")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onNavigate("prev")}
            disabled={!hasPrev}
            aria-label={t("common:actions.previous")}
            icon={<ArrowUp size={HEADER_ICON_SIZE.sm} />}
          />
        </WorkstationToolbarTooltip>
        <WorkstationToolbarTooltip label={t("common:actions.next")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onNavigate("next")}
            disabled={!hasNext}
            aria-label={t("common:actions.next")}
            icon={<ArrowDown size={HEADER_ICON_SIZE.sm} />}
          />
        </WorkstationToolbarTooltip>
        {(onExpandToTab || onDeleteWorkItem || onToggleProperties) && (
          <div
            className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
            role="separator"
            aria-hidden
          />
        )}
        {onExpandToTab && (
          <WorkstationToolbarTooltip label={t("common:actions.openInNewTab")}>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={() => onExpandToTab(pendingUpdates)}
              aria-label={t("common:actions.openInNewTab")}
              icon={<ArrowUpRight size={HEADER_ICON_SIZE.md} />}
            />
          </WorkstationToolbarTooltip>
        )}
        {onDeleteWorkItem && (
          <WorkstationToolbarTooltip label={t("workItems.deleteWorkItem")}>
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={() => onDeleteWorkItem(workItem.session_id)}
              aria-label={t("workItems.deleteWorkItem")}
              data-testid="work-item-delete"
              icon={<Trash2 size={HEADER_ICON_SIZE.sm} />}
            />
          </WorkstationToolbarTooltip>
        )}
        {onToggleProperties && (
          <WorkstationToolbarTooltip
            label={
              propertiesOpen
                ? t("workItems.hideProperties")
                : t("workItems.showProperties")
            }
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={
                propertiesOpen ? "!bg-surface-selected !text-primary-6" : ""
              }
              onClick={onToggleProperties}
              aria-label={
                propertiesOpen
                  ? t("workItems.hideProperties")
                  : t("workItems.showProperties")
              }
              icon={<Info size={HEADER_ICON_SIZE.sm} />}
            />
          </WorkstationToolbarTooltip>
        )}
      </div>
    </>
  );
}
