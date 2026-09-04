import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Select, { type SelectOption } from "@src/components/Select";
import {
  CircleDotIcon,
  DeliveryBox01Icon,
  GitPullRequestIcon,
  HugeiconsIcon,
  InboxIcon,
  ListTodoIcon,
} from "@src/icons";

import {
  WORK_MANAGEMENT_DATASET,
  type WorkManagementDataset,
} from "./workManagementDataset";

interface WorkManagementDatasetSwitchProps {
  activeDataset: WorkManagementDataset;
  onChange: (dataset: WorkManagementDataset) => void;
  /** Hide the dataset name when the switch is hosted in a split list header. */
  compact?: boolean;
}

export const WORK_MANAGEMENT_DATASET_MENU_ORDER = [
  WORK_MANAGEMENT_DATASET.GITHUB_ISSUES,
  WORK_MANAGEMENT_DATASET.REVIEWS,
  WORK_MANAGEMENT_DATASET.INBOX,
  WORK_MANAGEMENT_DATASET.PROJECTS,
  WORK_MANAGEMENT_DATASET.WORK_ITEMS,
] as const satisfies readonly WorkManagementDataset[];

export function WorkManagementDatasetSwitch({
  activeDataset,
  onChange,
  compact = false,
}: WorkManagementDatasetSwitchProps): React.ReactNode {
  const { t } = useTranslation(["projects", "sessions", "navigation"]);
  const projectsLabel = t("projects:workspace.projects");
  const workItemsLabel = t("projects:workspace.workItems");
  const inboxLabel = t("navigation:labels.inbox");
  const issuesLabel = t("sessions:kanban.sidebar.githubIssues");
  const reviewsLabel = t("sessions:kanban.sidebar.githubPrs");
  const activeDatasetLabel: Record<WorkManagementDataset, string> = {
    [WORK_MANAGEMENT_DATASET.INBOX]: inboxLabel,
    [WORK_MANAGEMENT_DATASET.PROJECTS]: projectsLabel,
    [WORK_MANAGEMENT_DATASET.WORK_ITEMS]: workItemsLabel,
    [WORK_MANAGEMENT_DATASET.GITHUB_ISSUES]: issuesLabel,
    [WORK_MANAGEMENT_DATASET.REVIEWS]: reviewsLabel,
  };
  const options = useMemo<SelectOption[]>(() => {
    const optionsByDataset: Record<WorkManagementDataset, SelectOption> = {
      [WORK_MANAGEMENT_DATASET.INBOX]: {
        value: WORK_MANAGEMENT_DATASET.INBOX,
        label: inboxLabel,
        triggerLabel: compact ? "" : inboxLabel,
        icon: (
          <HugeiconsIcon
            icon={InboxIcon}
            data-icon="inbox"
            size={14}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ),
        dataTestId: "work-dataset-inbox",
      },
      [WORK_MANAGEMENT_DATASET.PROJECTS]: {
        value: WORK_MANAGEMENT_DATASET.PROJECTS,
        label: projectsLabel,
        triggerLabel: compact ? "" : projectsLabel,
        icon: (
          <HugeiconsIcon
            icon={DeliveryBox01Icon}
            data-icon="box"
            size={14}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ),
        dataTestId: "work-dataset-projects",
      },
      [WORK_MANAGEMENT_DATASET.WORK_ITEMS]: {
        value: WORK_MANAGEMENT_DATASET.WORK_ITEMS,
        label: workItemsLabel,
        triggerLabel: compact ? "" : workItemsLabel,
        icon: (
          <HugeiconsIcon
            icon={ListTodoIcon}
            data-icon="list-todo"
            size={14}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ),
        dataTestId: "work-dataset-work-items",
      },
      [WORK_MANAGEMENT_DATASET.GITHUB_ISSUES]: {
        value: WORK_MANAGEMENT_DATASET.GITHUB_ISSUES,
        label: issuesLabel,
        triggerLabel: compact ? "" : issuesLabel,
        icon: (
          <HugeiconsIcon
            icon={CircleDotIcon}
            data-icon="circle-dot"
            size={14}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ),
        dataTestId: "work-dataset-github-issues",
      },
      [WORK_MANAGEMENT_DATASET.REVIEWS]: {
        value: WORK_MANAGEMENT_DATASET.REVIEWS,
        label: reviewsLabel,
        triggerLabel: compact ? "" : reviewsLabel,
        icon: (
          <HugeiconsIcon
            icon={GitPullRequestIcon}
            data-icon="git-pull-request"
            size={14}
            strokeWidth={1.9}
            aria-hidden="true"
          />
        ),
        dataTestId: "work-dataset-reviews",
      },
    };

    return WORK_MANAGEMENT_DATASET_MENU_ORDER.map(
      (dataset) => optionsByDataset[dataset]
    );
  }, [
    compact,
    inboxLabel,
    issuesLabel,
    projectsLabel,
    reviewsLabel,
    workItemsLabel,
  ]);

  return (
    <Select
      value={activeDataset}
      options={options}
      onChange={(value) => {
        if (Array.isArray(value)) return;
        onChange(value as WorkManagementDataset);
      }}
      size="small"
      appearance="ghost"
      radius="lg"
      dropdownWidthMode="auto"
      dropdownMinWidth={180}
      dropdownAlign="left"
      className="w-fit! shrink-0"
      selectorClassName={
        compact
          ? "h-7 [&_.select-value]:flex-none [&_.select-value]:gap-0 [&_.select-suffix]:ml-1"
          : "h-7"
      }
      style={{ width: "fit-content" }}
      dataTestId="work-dataset-select"
      ariaLabel={activeDatasetLabel[activeDataset]}
    />
  );
}
