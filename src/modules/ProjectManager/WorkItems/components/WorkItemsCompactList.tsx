import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { Placeholder } from "@src/components/Placeholder";
import { HugeiconsIcon, ListChecksIcon } from "@src/icons";
import {
  GITHUB_ISSUE_STATUS_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import CompactListPanel, {
  type CompactListPanelEntry,
} from "@src/modules/shared/components/CompactListPanel";
import type { WorkItem } from "@src/types/core/workItem";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  formatWorkItemShortId,
  getWorkItemSourceIntegration,
} from "../workItemIdentity";
import { getWorkItemStatus } from "../workItemsViewModel";

type CompactWorkItem = WorkItem & {
  workspaceSource?: string | { source?: string | null } | null;
};

interface WorkItemsCompactListProps<TWorkItem extends CompactWorkItem> {
  items: readonly TWorkItem[];
  selectedWorkItemId: string | null;
  onSelectWorkItem: (workItemId: string) => void;
  title?: string;
  workItemPrefix?: string;
  loading?: boolean;
  testId?: string;
}

/** Domain adapter from Work Items to the shared Inbox compact-list format. */
const WorkItemsCompactList = <TWorkItem extends CompactWorkItem>({
  items,
  selectedWorkItemId,
  onSelectWorkItem,
  title,
  workItemPrefix,
  loading = false,
  testId = "work-items-compact-list",
}: WorkItemsCompactListProps<TWorkItem>): React.ReactNode => {
  const { t } = useTranslation("projects");
  const resolvedTitle = title ?? t("projects.columns.workItems");
  const entries = useMemo<CompactListPanelEntry[]>(
    () =>
      items.map((item) => {
        const status = getWorkItemStatus(item);
        const workspaceSource =
          typeof item.workspaceSource === "string"
            ? item.workspaceSource
            : item.workspaceSource?.source;
        const integration = getWorkItemSourceIntegration(
          status,
          workspaceSource
        );
        const statusOption = [
          ...GITHUB_ISSUE_STATUS_OPTIONS,
          ...WORK_ITEM_STATUS_OPTIONS,
        ].find((option) => option.value === status);
        const statusLabel = statusOption
          ? t(`workItems.statusLabels.${statusOption.value}`, {
              defaultValue: statusOption.label,
            })
          : status;
        const displayId = formatWorkItemShortId(
          item.shortId,
          status,
          workItemPrefix ?? item.project?.name
        );
        const metadataParts = [item.project?.name, item.assignee?.name].filter(
          Boolean
        );
        return {
          key: item.session_id,
          title: item.name || t("workItems.untitledWorkItem"),
          titlePrefix: displayId ?? undefined,
          time: formatRelativeTime(item.updated_time, "nano"),
          metadata: (
            <>
              {item.assignee?.avatar ? (
                <Avatar size={16} src={item.assignee.avatar} hideOnError />
              ) : null}
              <span className="truncate">
                {metadataParts.join(" · ") || statusLabel}
              </span>
            </>
          ),
          leading: integration ? (
            <IntegrationIcon type={integration} size={14} />
          ) : (
            (statusOption?.icon ?? (
              <HugeiconsIcon
                icon={ListChecksIcon}
                data-icon="list-checks"
                size={14}
                strokeWidth={1.8}
              />
            ))
          ),
          leadingClassName: integration ? "text-text-2" : "text-primary-6",
          ariaLabel: [displayId, item.name, ...metadataParts]
            .filter(Boolean)
            .join(", "),
          dataAttributes: {
            "data-testid": "work-item-compact-row",
            "data-work-item-id": item.session_id,
          },
          onSelect: () => onSelectWorkItem(item.session_id),
        };
      }),
    [items, onSelectWorkItem, t, workItemPrefix]
  );

  return (
    <CompactListPanel
      ariaLabel={resolvedTitle}
      entries={entries}
      selectedEntryKey={selectedWorkItemId}
      loading={loading}
      testId={testId}
      emptyContent={
        <Placeholder
          variant="no-results"
          placement="sidebar"
          fillParentHeight
        />
      }
    />
  );
};

export default WorkItemsCompactList;
