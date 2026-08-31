import React from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import { getListItemClasses } from "@src/components/ListPanel";
import PrCiStatusIndicator from "@src/components/PrCiStatusIndicator";
import SearchInput from "@src/components/SearchInput";
import {
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  ListFilterIcon,
  ListTodoIcon,
  Refresh04Icon,
} from "@src/icons";
import {
  getPrStatusIconName,
  getPrStatusVariant,
} from "@src/shared/pr/prStatus";

import type {
  WorkItemPickerFilter,
  WorkItemPickerOption,
} from "./workItemPickerModel";

interface WorkItemPickerPanelProps {
  error: string | null;
  filteredOptions: readonly WorkItemPickerOption[];
  loading: boolean;
  onFilterChange: (filter: WorkItemPickerFilter) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onSelectionChange: (key: string, selected: boolean) => void;
  searchQuery: string;
  refreshing: boolean;
  selectedKeys: readonly string[];
  sourceFilter: WorkItemPickerFilter;
  searchInputRef: React.RefObject<
    HTMLInputElement | HTMLTextAreaElement | null
  >;
}

const WorkItemPickerPanel: React.FC<WorkItemPickerPanelProps> = ({
  error,
  filteredOptions,
  loading,
  onFilterChange,
  onSearchChange,
  onRefresh,
  onSelectionChange,
  searchQuery,
  refreshing,
  selectedKeys,
  sourceFilter,
  searchInputRef,
}) => {
  const { t } = useTranslation(["sessions", "projects", "common"]);
  const filters: Array<{
    value: WorkItemPickerFilter;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      value: "all",
      label: t("common:actions.all"),
      icon: (
        <HugeiconsIcon
          icon={ListFilterIcon}
          data-icon="list-filter"
          size={14}
          strokeWidth={1.8}
        />
      ),
    },
    {
      value: "workitem",
      label: t("projects:workItems.label"),
      icon: (
        <HugeiconsIcon
          icon={ListTodoIcon}
          data-icon="list-todo"
          size={14}
          strokeWidth={1.8}
        />
      ),
    },
    {
      value: "github_issue",
      label: t("sessions:kanban.sidebar.githubIssues"),
      icon: (
        <HugeiconsIcon
          icon={CircleDotIcon}
          data-icon="circle-dot"
          size={14}
          strokeWidth={1.8}
        />
      ),
    },
    {
      value: "github_pr",
      label: t("sessions:kanban.sidebar.githubPrs"),
      icon: (
        <HugeiconsIcon
          icon={GitPullRequestIcon}
          data-icon="git-pull-request"
          size={14}
          strokeWidth={1.8}
        />
      ),
    },
  ];

  return (
    <div
      className="flex h-[min(60vh,520px)] min-h-0 w-full flex-col overflow-hidden"
      data-testid="work-item-picker-panel"
    >
      <div className="work-item-picker-toolbar flex shrink-0 items-center gap-2 px-2 pb-3 pt-2">
        <SearchInput
          inputRef={searchInputRef}
          variant="sidebar"
          value={searchQuery}
          onChange={onSearchChange}
          placeholder={t("projects:workItems.searchPlaceholder")}
          ariaLabel={t("projects:workItems.searchPlaceholder")}
          showClearButton
          className="min-w-0 flex-1"
        />
        <Button
          variant="secondary"
          size="small"
          icon={
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              size={14}
              strokeWidth={1.8}
              className={refreshing ? "animate-spin" : undefined}
            />
          }
          iconOnly
          title={t("common:actions.refresh")}
          aria-label={t("common:actions.refresh")}
          data-testid="session-creator-work-item-picker-refresh"
          disabled={refreshing}
          onClick={onRefresh}
        />
      </div>
      <div
        className="work-item-picker-tabs flex shrink-0 flex-nowrap items-end gap-px border-b border-border-2 px-2 @container/workitemtabs"
        role="tablist"
        aria-label={t("common:actions.filter")}
      >
        {filters.map((filter) => {
          const active = sourceFilter === filter.value;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => onFilterChange(filter.value)}
              role="tab"
              aria-selected={active}
              aria-label={filter.label}
              title={filter.label}
              className={`work-item-picker-tab relative -mb-px flex shrink-0 items-center gap-0 rounded-t-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors @[500px]/workitemtabs:gap-1.5 @[500px]/workitemtabs:px-3 ${
                active
                  ? "border-border-2 text-text-1 after:absolute after:-bottom-px after:left-0 after:right-0 after:h-px after:bg-bg-2"
                  : "border-transparent text-text-2 hover:bg-fill-1 hover:text-text-1"
              }`}
              data-testid={`work-item-picker-filter-${filter.value}`}
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center"
                aria-hidden
              >
                {filter.icon}
              </span>
              <span className="hidden @[500px]/workitemtabs:inline">
                {filter.label}
              </span>
            </button>
          );
        })}
      </div>
      <div
        className="work-item-picker-list flex min-h-0 flex-1 flex-col gap-px overflow-y-auto overscroll-contain p-1 scrollbar-hide"
        data-testid="work-item-picker-list"
      >
        {filteredOptions.length > 0 ? (
          filteredOptions.map((option) => {
            const checked = selectedKeys.includes(option.key);
            const prStatus = option.prStatus ?? "open";
            const prIconName = getPrStatusIconName(prStatus);
            const Icon =
              option.kind === "github_pr"
                ? prIconName === "draft"
                  ? GitPullRequestDraftIcon
                  : prIconName === "merge"
                    ? GitMergeIcon
                    : prIconName === "closed"
                      ? GitPullRequestClosedIcon
                      : GitPullRequestIcon
                : option.kind === "workitem"
                  ? ListTodoIcon
                  : CircleDotIcon;
            const iconColorClass =
              option.kind === "github_pr"
                ? getPrStatusVariant(prStatus).textClass
                : option.kind === "github_issue"
                  ? "text-success-6"
                  : "text-text-2";
            const ciLabel =
              option.ciStatus === "success"
                ? t("common:git.pr.checks.passedShort")
                : option.ciStatus === "failure"
                  ? t("common:git.pr.checks.failedShort")
                  : option.ciStatus === "pending"
                    ? t("common:git.pr.checks.runningShort")
                    : option.ciStatus === "none"
                      ? t("common:git.pr.checks.noneShort")
                      : t("common:git.pr.checks.unavailableShort");
            const visibleCiStatus =
              option.kind === "github_pr" &&
              option.ciStatus !== undefined &&
              option.ciStatus !== "unavailable"
                ? option.ciStatus
                : null;
            return (
              <div
                key={option.key}
                className={`work-item-picker-option ${getListItemClasses(checked)} !block w-full min-w-0 !py-1.5 text-left`}
                data-testid={`work-item-picker-option-${option.key}`}
              >
                <Checkbox
                  size="mini"
                  checked={checked}
                  onCheckedChange={(nextChecked) =>
                    onSelectionChange(option.key, nextChecked)
                  }
                  className="w-full min-w-0 flex-row-reverse items-start justify-between gap-2 [&_[data-checkbox-label]]:min-w-0 [&_[data-checkbox-label]]:flex-1"
                >
                  <span className="block min-w-0 flex-1 text-left">
                    <span className="flex h-4 min-w-0 items-center gap-2">
                      <span
                        className={`flex h-4 w-5 shrink-0 items-center justify-center ${iconColorClass}`}
                        aria-hidden
                        data-testid={`work-item-picker-kind-${option.key}`}
                      >
                        <AnyIcon icon={Icon} size={14} strokeWidth={1.8} />
                      </span>
                      <span className="shrink-0 text-xs font-semibold text-text-3">
                        {option.identifier}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-1">
                        {option.title}
                      </span>
                    </span>
                    <span className="work-item-picker-option-metadata mt-1 flex min-w-0 items-center gap-1.5 pl-7 text-xs font-normal text-text-2">
                      <span className="min-w-0 truncate">{option.detail}</span>
                      {option.openedBy && (
                        <>
                          <span className="shrink-0 text-text-3" aria-hidden>
                            ·
                          </span>
                          <span className="min-w-0 truncate">
                            @{option.openedBy}
                          </span>
                        </>
                      )}
                      {option.statusLabel && (
                        <>
                          <span className="shrink-0 text-text-3" aria-hidden>
                            ·
                          </span>
                          <span className="shrink-0">{option.statusLabel}</span>
                        </>
                      )}
                      {visibleCiStatus && (
                        <>
                          <span className="shrink-0 text-text-3" aria-hidden>
                            ·
                          </span>
                          <PrCiStatusIndicator
                            appearance="simple"
                            status={visibleCiStatus}
                            label={ciLabel}
                            showLabel={false}
                            size={13}
                            dataTestId={`work-item-picker-ci-${option.key}`}
                          />
                        </>
                      )}
                    </span>
                  </span>
                </Checkbox>
              </div>
            );
          })
        ) : loading ? (
          <div className="flex h-20 items-center justify-center text-xs text-text-3">
            {t("common:status.loading")}
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center px-4 text-center text-xs text-text-3">
            {error ?? t("projects:workItems.noResults")}
          </div>
        )}
      </div>
      {error && filteredOptions.length > 0 && (
        <div
          className="shrink-0 border-t border-border-1 px-3 py-2 text-xs text-text-3"
          role="status"
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default WorkItemPickerPanel;
