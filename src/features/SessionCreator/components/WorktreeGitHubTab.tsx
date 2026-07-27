import { Loader2, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_SEARCH } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
  WorktreeSourceRefreshSuffix,
  WorktreeSourceRow,
} from "./WorktreeSourceModalRows";
import type { WorktreeLoadState } from "./useWorktreeSourceData";
import { sourceKey } from "./worktreeBranchSource";
import type { GitHubWorktreeItem } from "./worktreeSourceModalTypes";

export function WorktreeGitHubTab({
  query,
  repoPath,
  state,
  error,
  refreshing,
  items,
  loadedItemCount,
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
  items: GitHubWorktreeItem[];
  loadedItemCount: number;
  fallbackSource: WorktreeLaunchSource | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}) {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex min-h-[250px] flex-col gap-2">
      <Input
        type="search"
        value={query}
        onChange={onQueryChange}
        allowClear
        prefix={<Search size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />}
        suffix={
          <WorktreeSourceRefreshSuffix
            disabled={!repoPath || state === "loading"}
            refreshing={refreshing}
            ariaLabel={t("creator.worktreeSource.refreshGithub", {
              defaultValue: "Refresh GitHub list",
            })}
            onClick={onRefresh}
          />
        }
        placeholder={t("creator.worktreeSource.githubSearch", {
          defaultValue: "Search GitHub PRs and issues",
        })}
        aria-label={t("creator.worktreeSource.githubSearchAria", {
          defaultValue: "Search GitHub PRs and issues",
        })}
      />
      <WorktreeSourceList>
        {state === "loading" && loadedItemCount === 0 && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}
        {state === "error" && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3"
          >
            {error ||
              t("creator.worktreeSource.githubError", {
                defaultValue: "GitHub items could not be loaded.",
              })}
          </div>
        )}
        {state === "empty" && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {t("creator.worktreeSource.githubEmpty", {
              defaultValue: "No open GitHub PRs or issues.",
            })}
          </div>
        )}
        {state === "ready" && items.length === 0 && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {t("creator.worktreeSource.githubNoMatches", {
              defaultValue: "No matches.",
            })}
          </div>
        )}
        {state === "ready" && items.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {items.map((item) => (
              <WorktreeSourceRow
                key={item.id}
                icon={item.icon}
                title={item.source.label}
                selected={
                  sourceKey(fallbackSource ?? item.source) ===
                  sourceKey(item.source)
                }
                onClick={() => onSelect(item.source)}
              />
            ))}
          </div>
        )}
      </WorktreeSourceList>
    </div>
  );
}
