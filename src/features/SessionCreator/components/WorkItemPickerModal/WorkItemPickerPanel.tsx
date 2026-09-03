import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import PrCiStatusIndicator from "@src/components/PrCiStatusIndicator";
import {
  Add01Icon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  type IconSvgElement,
  ListFilterIcon,
  ListTodoIcon,
  Refresh04Icon,
} from "@src/icons";
import { SpotlightPinnedActionSection } from "@src/scaffold/GlobalSpotlight/components/SpotlightPinnedActionSection";
import { SpotlightTabs } from "@src/scaffold/GlobalSpotlight/components/SpotlightTabs";
import { useSelectorKernel } from "@src/scaffold/GlobalSpotlight/palettes/core";
import { PaletteBody } from "@src/scaffold/GlobalSpotlight/shell";
import type { SpotlightItem } from "@src/scaffold/GlobalSpotlight/types";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";

import type {
  WorkItemPickerFilter,
  WorkItemPickerOption,
} from "./workItemPickerModel";

interface WorkItemPickerPanelProps {
  error: string | null;
  filteredOptions: readonly WorkItemPickerOption[];
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onFilterChange: (filter: WorkItemPickerFilter) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onSelectionChange: (key: string, selected: boolean) => void;
  searchQuery: string;
  refreshing: boolean;
  selectedKeys: readonly string[];
  selectedCount: number;
  sourceFilter: WorkItemPickerFilter;
  sourceFilters: readonly WorkItemPickerFilter[];
}

// Stable icon component identities preserve source/status colors in shared rows.
function optionIcon(icon: IconSvgElement, className: string) {
  return function WorkItemIcon({ size, strokeWidth }: Record<string, unknown>) {
    return (
      <HugeiconsIcon
        icon={icon}
        className={className}
        size={typeof size === "number" ? size : 16}
        strokeWidth={typeof strokeWidth === "number" ? strokeWidth : 2}
      />
    );
  };
}
const WORK_ITEM_ICON = optionIcon(ListTodoIcon, "text-text-2");
const ISSUE_ICON = optionIcon(CircleDotIcon, "text-success-6");
const PR_ICONS: Record<string, React.ComponentType<Record<string, unknown>>> = {
  open: optionIcon(GitPullRequestIcon, getPrStatusVariant("open").textClass),
  draft: optionIcon(
    GitPullRequestDraftIcon,
    getPrStatusVariant("draft").textClass
  ),
  closed: optionIcon(
    GitPullRequestClosedIcon,
    getPrStatusVariant("closed").textClass
  ),
  merged: optionIcon(GitMergeIcon, getPrStatusVariant("merged").textClass),
  unknown: optionIcon(
    GitPullRequestIcon,
    getPrStatusVariant("unknown").textClass
  ),
};

const WorkItemPickerPanel: React.FC<WorkItemPickerPanelProps> = ({
  error,
  filteredOptions,
  loading,
  onClose,
  onConfirm,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onSelectionChange,
  searchQuery,
  refreshing,
  selectedKeys,
  selectedCount,
  sourceFilter,
  sourceFilters,
}) => {
  const { t } = useTranslation(["sessions", "projects", "common"]);
  const filters = useMemo(
    () =>
      [
        {
          value: "all" as const,
          label: t("common:actions.all"),
          icon: ListFilterIcon,
        },
        {
          value: "workitem" as const,
          label: t("projects:workItems.label"),
          icon: ListTodoIcon,
        },
        {
          value: "github_issue" as const,
          label: t("sessions:kanban.sidebar.githubIssues"),
          icon: CircleDotIcon,
        },
        {
          value: "github_pr" as const,
          label: t("sessions:kanban.sidebar.githubPrs"),
          icon: GitPullRequestIcon,
        },
      ]
        .filter((option) => sourceFilters.includes(option.value))
        .map(({ label, icon, ...option }) => ({
          ...option,
          ariaLabel: label,
          label: (
            <>
              <HugeiconsIcon
                icon={icon}
                size={14}
                strokeWidth={1.8}
                aria-hidden
              />
              {label}
            </>
          ),
        })),
    [sourceFilters, t]
  );
  const items = useMemo<SpotlightItem[]>(
    () =>
      filteredOptions.map((option) => {
        const checked = selectedKeys.includes(option.key);
        const toggle = () => onSelectionChange(option.key, !checked);
        const ciLabel =
          option.ciStatus === "success"
            ? t("common:git.pr.checks.passedShort")
            : option.ciStatus === "failure"
              ? t("common:git.pr.checks.failedShort")
              : option.ciStatus === "pending"
                ? t("common:git.pr.checks.runningShort")
                : t("common:git.pr.checks.noneShort");
        return {
          id: option.key,
          type: "option",
          label: `${option.identifier} ${option.title}`,
          desc: [
            option.detail,
            option.openedBy ? `@${option.openedBy}` : null,
            option.statusLabel,
          ]
            .filter(Boolean)
            .join(" · "),
          icon:
            option.kind === "github_pr"
              ? (PR_ICONS[option.prStatus ?? "open"] ?? PR_ICONS.unknown)
              : option.kind === "workitem"
                ? WORK_ITEM_ICON
                : ISSUE_ICON,
          data: {
            isSelector: true,
            testId: `work-item-picker-option-${option.key}`,
            selectionState: {
              ariaLabel: `${option.identifier} ${option.title}`,
              checked,
              onToggle: toggle,
            },
            rightContent:
              option.kind === "github_pr" &&
              option.ciStatus &&
              option.ciStatus !== "unavailable" ? (
                <PrCiStatusIndicator
                  appearance="simple"
                  status={option.ciStatus}
                  label={ciLabel}
                  showLabel={false}
                  size={13}
                  dataTestId={`work-item-picker-ci-${option.key}`}
                />
              ) : undefined,
          },
          action: toggle,
        };
      }),
    [filteredOptions, onSelectionChange, selectedKeys, t]
  );
  const pinnedActions = useMemo<SpotlightItem[]>(
    () => [
      {
        id: "work-item-picker-add",
        type: "action",
        label:
          selectedCount > 0
            ? t("projects:workItems.addSelected", { count: selectedCount })
            : t("common:actions.add"),
        icon: Add01Icon,
        data: {
          disabled: selectedCount === 0,
          testId: "work-item-picker-add",
        },
        action: onConfirm,
      },
      {
        id: "work-item-picker-refresh",
        type: "action",
        label: t("common:actions.refresh"),
        icon: Refresh04Icon,
        data: {
          disabled: refreshing,
          testId: "session-creator-work-item-picker-refresh",
        },
        action: onRefresh,
      },
    ],
    [onConfirm, onRefresh, refreshing, selectedCount, t]
  );
  const navigationItems = useMemo(
    () => [...items, ...pinnedActions],
    [items, pinnedActions]
  );
  const kernel = useSelectorKernel({
    isOpen: true,
    onClose,
    items: navigationItems,
    isItemSelectable: (item) => !item.data?.disabled,
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: onSearchChange,
  });

  return (
    <div data-testid="work-item-picker-panel">
      <PaletteBody
        kernel={kernel}
        items={items}
        placeholder={t("projects:workItems.searchPlaceholder")}
        inputAriaLabel={t("projects:workItems.searchPlaceholder")}
        isLoading={loading}
        containerHeight={350}
        fixedHeight
        topSlot={
          filters.length > 1 ? (
            <SpotlightTabs
              format="attached"
              ariaLabel={t("common:actions.filter")}
              dataTestId="work-item-picker-tabs"
              value={sourceFilter}
              options={filters}
              onChange={onFilterChange}
            />
          ) : undefined
        }
        contentOverride={
          items.length === 0 ? (
            <div className="flex h-[350px] flex-col justify-center">
              <Placeholder
                variant={loading ? "loading" : error ? "error" : "no-results"}
                title={
                  loading
                    ? t("common:status.loading")
                    : (error ?? t("projects:workItems.noResults"))
                }
                placement="sidebar"
              />
            </div>
          ) : undefined
        }
        afterListSlot={
          <>
            {error && items.length > 0 && (
              <div role="status" className="px-4 py-2 text-xs text-text-3">
                {error}
              </div>
            )}
            <SpotlightPinnedActionSection
              items={pinnedActions}
              startIndex={items.length}
              selectedIndex={kernel.selectedIndex}
              onItemSelect={kernel.handleItemClick}
              onItemHover={kernel.setSelectedIndex}
              searchQuery={searchQuery}
              layout="twoColumn"
            />
          </>
        }
      />
    </div>
  );
};

export default WorkItemPickerPanel;
