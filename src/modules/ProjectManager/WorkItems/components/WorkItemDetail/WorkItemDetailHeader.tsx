import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  Info,
  ListChecks,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

export interface WorkItemDetailHeaderProps {
  workItem: WorkItemExtended;
  pendingUpdates: Partial<WorkItemExtended>;
  breadcrumbProjectName?: string;
  breadcrumbIcon?: ReactNode;
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

type WorkItemDetailHeaderBreadcrumbProps = Pick<
  WorkItemDetailHeaderProps,
  | "workItem"
  | "breadcrumbProjectName"
  | "breadcrumbIcon"
  | "shortId"
  | "onClose"
  | "t"
>;

export function WorkItemDetailHeaderBreadcrumb({
  workItem,
  breadcrumbProjectName,
  breadcrumbIcon,
  shortId,
  onClose,
  t,
}: WorkItemDetailHeaderBreadcrumbProps) {
  const workItemName = workItem.name || t("workItems.untitled");
  const title = shortId ? `${shortId} · ${workItemName}` : workItemName;
  const segments = breadcrumbProjectName
    ? [
        {
          label: breadcrumbProjectName,
          onClick: onClose,
          title: `${t("common:actions.back")}: ${breadcrumbProjectName}`,
        },
        {
          label: title,
          icon: breadcrumbIcon ?? (
            <Box size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          ),
        },
      ]
    : [
        {
          label: title,
          icon: <ListChecks size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />,
        },
      ];

  return <ProjectManagerBreadcrumb segments={segments} />;
}

type WorkItemDetailHeaderActionsProps = Omit<
  WorkItemDetailHeaderProps,
  "breadcrumbProjectName" | "breadcrumbIcon" | "shortId" | "onClose"
>;

export function WorkItemDetailHeaderActions({
  workItem,
  pendingUpdates,
  propertiesOpen,
  hasPrev,
  hasNext,
  onNavigate,
  onDeleteWorkItem,
  onExpandToTab,
  onToggleProperties,
  t,
}: WorkItemDetailHeaderActionsProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-px">
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
  );
}

export function WorkItemDetailHeader(props: WorkItemDetailHeaderProps) {
  const {
    breadcrumbProjectName,
    breadcrumbIcon,
    shortId,
    onClose,
    workItem,
    t,
    ...actionProps
  } = props;

  return (
    <>
      <WorkItemDetailHeaderBreadcrumb
        workItem={workItem}
        breadcrumbProjectName={breadcrumbProjectName}
        breadcrumbIcon={breadcrumbIcon}
        shortId={shortId}
        onClose={onClose}
        t={t}
      />
      <WorkItemDetailHeaderActions {...actionProps} workItem={workItem} t={t} />
    </>
  );
}
