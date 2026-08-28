import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import SearchInput from "@src/components/SearchInput";
import {
  CaseSensitiveIcon,
  CircleDotIcon,
  GitPullRequestIcon,
  HashtagIcon,
  HugeiconsIcon,
  Loading03Icon,
  SparklesIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceList,
  WorktreeSourceRow,
} from "./WorktreeSourceModalRows";
import type { WorktreeLoadState } from "./useWorktreeSourceData";
import { sourceKey } from "./worktreeBranchSource";
import type {
  SmartSuggestion,
  SmartSuggestionKind,
} from "./worktreeSmartInput";

function smartIcon(kind: SmartSuggestionKind): ReactNode {
  switch (kind) {
    case "pr":
      return (
        <HugeiconsIcon
          icon={GitPullRequestIcon}
          data-icon="git-pull-request"
          size={14}
          strokeWidth={1.75}
        />
      );
    case "issue":
      return (
        <HugeiconsIcon
          icon={CircleDotIcon}
          data-icon="circle-dot"
          size={14}
          strokeWidth={1.75}
        />
      );
    case "branch":
      return (
        <HugeiconsIcon
          icon={WorkflowCircle05Icon}
          data-icon="git-branch"
          size={14}
          strokeWidth={1.75}
        />
      );
    case "customRef":
      return (
        <HugeiconsIcon
          icon={HashtagIcon}
          data-icon="hash"
          size={14}
          strokeWidth={1.75}
        />
      );
    case "name":
      return (
        <HugeiconsIcon
          icon={CaseSensitiveIcon}
          data-icon="case-sensitive"
          size={14}
          strokeWidth={1.75}
        />
      );
    default:
      return (
        <HugeiconsIcon
          icon={SparklesIcon}
          data-icon="sparkles"
          size={14}
          strokeWidth={1.75}
        />
      );
  }
}

export function WorktreeSmartTab({
  query,
  suggestions,
  loading,
  branchState,
  branchError,
  fallbackSource,
  onQueryChange,
  onSelect,
}: {
  query: string;
  suggestions: SmartSuggestion[];
  loading: boolean;
  branchState: WorktreeLoadState;
  branchError: string | null;
  fallbackSource: WorktreeLaunchSource | null;
  onQueryChange: (query: string) => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}) {
  const { t } = useTranslation("sessions");
  return (
    <div className="flex min-h-72 flex-col gap-2">
      <SearchInput
        variant="sidebar"
        value={query}
        onChange={onQueryChange}
        showClearButton
        placeholder={t("creator.worktreeSource.smartPlaceholder", {
          defaultValue: "Name, #1234, branch, or GitHub/GitLab URL",
        })}
        ariaLabel={t("creator.worktreeSource.smartAria", {
          defaultValue: "Enter a name, PR number, branch, or GitHub/GitLab URL",
        })}
      />
      <WorktreeSourceList>
        {loading && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
              size={16}
              className="animate-spin"
            />
          </div>
        )}
        {!loading && suggestions.length === 0 && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {branchState === "error"
              ? branchError ||
                t("creator.worktreeSource.branchError", {
                  defaultValue: "Branches could not be loaded.",
                })
              : t("creator.worktreeSource.smartHint", {
                  defaultValue:
                    "Type a name, PR number, branch, or paste a PR/MR URL.",
                })}
          </div>
        )}
        {!loading && suggestions.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {suggestions.map((suggestion) => (
              <WorktreeSourceRow
                key={suggestion.id}
                icon={smartIcon(suggestion.kind)}
                title={
                  suggestion.kind === "customRef"
                    ? t("creator.worktreeSource.branchUseAsRef", {
                        value: suggestion.source.baseBranch ?? "",
                        defaultValue: `Use "${suggestion.source.baseBranch ?? ""}" as ref`,
                      })
                    : suggestion.title
                }
                selected={
                  sourceKey(fallbackSource ?? suggestion.source) ===
                  sourceKey(suggestion.source)
                }
                onClick={() => onSelect(suggestion.source)}
              />
            ))}
          </div>
        )}
      </WorktreeSourceList>
    </div>
  );
}
