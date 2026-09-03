import type { ReactNode } from "react";

import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";

import { IssuePersonalFilterDropdown } from "./GitHubWorkItemControls";
import {
  GitHubWorkItemStateTabs,
  GitHubWorkItemToolbarActions,
} from "./GitHubWorkItemList";
import type { IssueRepoFilter, RepoFilterOption } from "./githubWorkItemsTypes";

interface GitHubWorkItemsHeaderControlsProps {
  stateTabs: Array<{ key: string; label: string }>;
  activeState: string;
  searchQuery: string;
  personalFilterOptions?: SelectOption[];
  selectedPersonalFilters?: string[];
  personalFilterLabel?: string;
  refreshLabel: string;
  refreshing: boolean;
  createAction?: {
    label: string;
    disabled: boolean;
    onClick: () => void;
  };
  onStateChange: (state: string) => void;
  onSearchQueryChange: (query: string) => void;
  onPersonalFiltersSelect?: (values: (string | number)[]) => void;
  onRefresh: () => void;
  placement?: "header" | "list";
}

interface GitHubWorkItemsRepositorySelectProps {
  repoOptions: RepoFilterOption[];
  selectedRepo: IssueRepoFilter;
  onRepoSelect: (repo: IssueRepoFilter) => void;
}

/** Repository scope published beside the GitHub PR/issues dataset selector. */
export function GitHubWorkItemsRepositorySelect({
  repoOptions,
  selectedRepo,
  onRepoSelect,
}: GitHubWorkItemsRepositorySelectProps): ReactNode {
  return (
    <Select
      value={selectedRepo}
      options={repoOptions.map((option) => ({
        value: option.key,
        label: option.label,
        triggerLabel: option.label,
      }))}
      onChange={(value) => {
        if (Array.isArray(value)) return;
        onRepoSelect(String(value));
      }}
      size="small"
      appearance="ghost"
      radius="lg"
      dropdownWidthMode="auto"
      dropdownMinWidth={190}
      dropdownAlign="left"
      className="w-auto"
      dataTestId="github-work-items-repository"
    />
  );
}

/** Filters and actions published at the trailing end of the shared header. */
export function GitHubWorkItemsHeaderControls({
  stateTabs,
  activeState,
  searchQuery,
  personalFilterOptions = [],
  selectedPersonalFilters = [],
  personalFilterLabel,
  refreshLabel,
  refreshing,
  createAction,
  onStateChange,
  onSearchQueryChange,
  onPersonalFiltersSelect,
  onRefresh,
  placement = "header",
}: GitHubWorkItemsHeaderControlsProps): ReactNode {
  const showPersonalFilters =
    personalFilterOptions.length > 0 &&
    personalFilterLabel !== undefined &&
    onPersonalFiltersSelect !== undefined;

  return (
    <div
      className={`flex min-w-0 items-center gap-1 overflow-visible ${
        placement === "list" ? "flex-1" : ""
      }`.trim()}
      data-testid="github-work-items-header-controls"
    >
      <GitHubWorkItemStateTabs
        tabs={stateTabs}
        activeTab={activeState}
        onChange={onStateChange}
      />
      {showPersonalFilters ? (
        <IssuePersonalFilterDropdown
          options={personalFilterOptions}
          selectedFilters={selectedPersonalFilters}
          filterLabel={personalFilterLabel}
          onSelect={onPersonalFiltersSelect}
        />
      ) : null}
      <WorkManagementSearchInput
        value={searchQuery}
        onChange={onSearchQueryChange}
        placement={placement}
        dataTestId="github-work-items-search"
      />
      <HeaderSectionSeparator className="mx-0.5" />
      <GitHubWorkItemToolbarActions
        refreshLabel={refreshLabel}
        refreshing={refreshing}
        createAction={createAction}
        onRefresh={onRefresh}
      />
    </div>
  );
}
