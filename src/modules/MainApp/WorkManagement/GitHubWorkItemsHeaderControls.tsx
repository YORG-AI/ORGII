import type { ReactNode } from "react";

import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import { WorkManagementSearchInput } from "@src/modules/shared/components/WorkManagementSearchInput";
import { compactRepositoryLabel } from "@src/modules/shared/githubRepositoryLabel";

import { IssuePersonalFilterDropdown } from "./GitHubWorkItemControls";
import {
  GitHubWorkItemStateTabs,
  GitHubWorkItemToolbarActions,
} from "./GitHubWorkItemList";
import type { IssueRepoFilter, RepoFilterOption } from "./githubWorkItemsTypes";

export interface GitHubWorkItemsHeaderControlsProps {
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
}

export function GitHubWorkItemsFilterControls({
  stateTabs,
  activeState,
  personalFilterOptions = [],
  selectedPersonalFilters = [],
  personalFilterLabel,
  onStateChange,
  onPersonalFiltersSelect,
}: Pick<
  GitHubWorkItemsHeaderControlsProps,
  | "stateTabs"
  | "activeState"
  | "personalFilterOptions"
  | "selectedPersonalFilters"
  | "personalFilterLabel"
  | "onStateChange"
  | "onPersonalFiltersSelect"
>): ReactNode {
  const showPersonalFilters =
    personalFilterOptions.length > 0 &&
    personalFilterLabel !== undefined &&
    onPersonalFiltersSelect !== undefined;

  return (
    <div className="flex shrink-0 items-center gap-px">
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
    </div>
  );
}

export function GitHubWorkItemsSearchAndActions({
  searchQuery,
  refreshLabel,
  refreshing,
  createAction,
  onSearchQueryChange,
  onRefresh,
  fillSearch = false,
}: Pick<
  GitHubWorkItemsHeaderControlsProps,
  | "searchQuery"
  | "refreshLabel"
  | "refreshing"
  | "createAction"
  | "onSearchQueryChange"
  | "onRefresh"
> & {
  /** A split-list header search grows before the action buttons. */
  fillSearch?: boolean;
}): ReactNode {
  return (
    <div
      className={`flex min-w-0 items-center gap-1 ${
        fillSearch ? "flex-1" : ""
      }`.trim()}
    >
      <WorkManagementSearchInput
        value={searchQuery}
        onChange={onSearchQueryChange}
        placement="header"
        fillWidth={fillSearch}
        dataTestId="github-work-items-search"
      />
      <GitHubWorkItemToolbarActions
        refreshLabel={refreshLabel}
        refreshing={refreshing}
        createAction={createAction}
        onRefresh={onRefresh}
      />
    </div>
  );
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
        label: compactRepositoryLabel(option.label),
        triggerLabel: compactRepositoryLabel(option.label),
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
