import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import SearchInput from "@src/components/SearchInput";
import { HugeiconsIcon, Loading03Icon, Refresh04Icon } from "@src/icons";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
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
    <div className="flex min-h-72 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <SearchInput
          variant="sidebar"
          value={query}
          onChange={onQueryChange}
          showClearButton
          className="min-w-0 flex-1"
          placeholder={t("creator.worktreeSource.githubSearch", {
            defaultValue: "Search GitHub PRs and issues",
          })}
          ariaLabel={t("creator.worktreeSource.githubSearchAria", {
            defaultValue: "Search GitHub PRs and issues",
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
          title={t("creator.worktreeSource.refreshGithub", {
            defaultValue: "Refresh GitHub list",
          })}
          aria-label={t("creator.worktreeSource.refreshGithub", {
            defaultValue: "Refresh GitHub list",
          })}
          disabled={!repoPath || state === "loading" || refreshing}
          onClick={onRefresh}
        />
      </div>
      <WorktreeSourceList>
        {state === "loading" && loadedItemCount === 0 && (
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
          <div className="flex flex-col gap-px">
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
