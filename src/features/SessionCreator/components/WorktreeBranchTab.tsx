import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import SearchInput from "@src/components/SearchInput";
import {
  CloudIcon,
  FolderClosedIcon,
  HugeiconsIcon,
  Loading03Icon,
  Refresh04Icon,
  WorkflowCircle05Icon,
} from "@src/icons";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
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

const BRANCH_GROUP_LABEL_FALLBACK = {
  recent: "Recent",
  worktrees: "Worktrees",
  otherBranches: "Other Branches",
} as const;

function branchRowIcon(option: WorktreeBranchOption): ReactNode {
  if (option.worktreePath)
    return (
      <HugeiconsIcon
        icon={FolderClosedIcon}
        data-icon="folder"
        size={14}
        strokeWidth={1.75}
      />
    );
  if (option.isRemote)
    return (
      <HugeiconsIcon
        icon={CloudIcon}
        data-icon="cloud"
        size={14}
        strokeWidth={1.75}
      />
    );
  return (
    <HugeiconsIcon
      icon={WorkflowCircle05Icon}
      data-icon="git-branch"
      size={14}
      strokeWidth={1.75}
    />
  );
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
  const { t } = useTranslation(["sessions", "common"]);
  return (
    <div className="flex min-h-72 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <SearchInput
          variant="sidebar"
          value={query}
          onChange={onQueryChange}
          showClearButton
          className="min-w-0 flex-1"
          placeholder={t("creator.worktreeSource.branchSearch", {
            defaultValue: "Search branches or enter a ref",
          })}
          ariaLabel={t("creator.worktreeSource.branchSearchAria", {
            defaultValue: "Search branches or enter a base ref",
          })}
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
          title={t("creator.worktreeSource.refreshBranches", {
            defaultValue: "Refresh branch list",
          })}
          aria-label={t("creator.worktreeSource.refreshBranches", {
            defaultValue: "Refresh branch list",
          })}
          disabled={!repoPath || state === "loading" || refreshing}
          onClick={onRefresh}
        />
      </div>

      <WorktreeSourceList>
        {state === "loading" && branchOptionCount === 0 && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={16}
              className="animate-spin"
            />
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
          <div className="flex flex-col gap-px">
            {customRefRow}
            {groups.map((group) => (
              <div key={group.key}>
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {t(`common:selectors.branch.labels.${group.labelKey}`, {
                    defaultValue: BRANCH_GROUP_LABEL_FALLBACK[group.labelKey],
                  })}
                </div>
                <div className="flex flex-col gap-px">
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
              </div>
            ))}
          </div>
        )}
      </WorktreeSourceList>
    </div>
  );
}
