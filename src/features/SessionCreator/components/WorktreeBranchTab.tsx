import { Cloud, GitBranch, GitFork, Loader2, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_SEARCH,
} from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
  WorktreeSourceRefreshSuffix,
  WorktreeSourceRow,
} from "./WorktreeSourceModalRows";
import type { WorktreeLoadState } from "./useWorktreeSourceData";
import {
  branchToLaunchSource,
  formatBranchTimestamp,
  sourceKey,
} from "./worktreeBranchSource";
import type {
  BranchOptionGroup,
  WorktreeBranchOption,
} from "./worktreeBranchSource";

const BRANCH_SEARCH_INPUT_ID = "worktree-source-branch-search";
const BRANCH_GROUP_LABEL_FALLBACK = {
  recent: "Recent",
  worktrees: "Worktrees",
  otherBranches: "Other Branches",
} as const;

function branchRowIcon(option: WorktreeBranchOption): ReactNode {
  if (option.worktreePath) return <GitFork size={14} strokeWidth={1.75} />;
  if (option.isRemote) return <Cloud size={14} strokeWidth={1.75} />;
  return <GitBranch size={14} strokeWidth={1.75} />;
}

export function WorktreeBranchTab({
  query,
  repoPath,
  state,
  error,
  refreshing,
  branchOptionCount,
  groups,
  offerCustomRef,
  customRefRow,
  fallbackSource,
  onQueryChange,
  onRefresh,
  onSelect,
}: {
  query: string;
  repoPath: string | null;
  state: WorktreeLoadState;
  error: string | null;
  refreshing: boolean;
  branchOptionCount: number;
  groups: BranchOptionGroup[];
  offerCustomRef: boolean;
  customRefRow: ReactNode;
  fallbackSource: WorktreeLaunchSource | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}) {
  const { t } = useTranslation(["translation", "common"]);
  return (
    <div className="flex min-h-[250px] flex-col gap-2">
      <label
        htmlFor={BRANCH_SEARCH_INPUT_ID}
        className="text-[12px] font-medium text-text-3"
      >
        {t("creator.worktreeSource.baseBranch", {
          defaultValue: "Base branch or ref",
        })}
      </label>
      <Input
        id={BRANCH_SEARCH_INPUT_ID}
        type="search"
        value={query}
        onChange={onQueryChange}
        allowClear
        prefix={<Search size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />}
        suffix={
          <WorktreeSourceRefreshSuffix
            disabled={!repoPath || state === "loading"}
            refreshing={refreshing}
            ariaLabel={t("creator.worktreeSource.refreshBranches", {
              defaultValue: "Refresh branch list",
            })}
            onClick={onRefresh}
          />
        }
        placeholder={t("creator.worktreeSource.branchSearch", {
          defaultValue: "Search branches or enter a ref",
        })}
        aria-label={t("creator.worktreeSource.branchSearchAria", {
          defaultValue: "Search branches or enter a base ref",
        })}
      />

      <WorktreeSourceList>
        {state === "loading" && branchOptionCount === 0 && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {state === "error" && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex h-[180px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-text-3"
          >
            <span>
              {error ||
                t("creator.worktreeSource.branchError", {
                  defaultValue: "Branches could not be loaded.",
                })}
            </span>
            {customRefRow}
          </div>
        )}
        {state === "empty" && (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-text-3">
            <span>
              {t("creator.worktreeSource.branchEmpty", {
                defaultValue: "No branches found in this repository.",
              })}
            </span>
            {customRefRow}
          </div>
        )}
        {state === "ready" && groups.length === 0 && !offerCustomRef && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {t("creator.worktreeSource.branchNoMatches", {
              defaultValue: "No matching branches.",
            })}
          </div>
        )}
        {state === "ready" && (groups.length > 0 || offerCustomRef) && (
          <div className="flex flex-col gap-0.5">
            {customRefRow}
            {groups.map((group) => (
              <div key={group.key}>
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t(`common:selectors.branch.labels.${group.labelKey}`, {
                    defaultValue: BRANCH_GROUP_LABEL_FALLBACK[group.labelKey],
                  })}
                </div>
                {group.options.map((option) => {
                  const source = branchToLaunchSource(option);
                  return (
                    <WorktreeSourceRow
                      key={`branch:${option.name}`}
                      icon={branchRowIcon(option)}
                      title={option.name}
                      meta={formatBranchTimestamp(option)}
                      selected={
                        sourceKey(fallbackSource ?? source) ===
                        sourceKey(source)
                      }
                      onClick={() => onSelect(source)}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </WorktreeSourceList>
    </div>
  );
}
