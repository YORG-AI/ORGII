import {
  CaseSensitive,
  CircleDot,
  GitBranch,
  GitPullRequest,
  Hash,
  Loader2,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { DROPDOWN_SEARCH } from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
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

const SMART_INPUT_ID = "worktree-source-smart-input";

function smartIcon(kind: SmartSuggestionKind): ReactNode {
  switch (kind) {
    case "pr":
      return <GitPullRequest size={14} strokeWidth={1.75} />;
    case "issue":
      return <CircleDot size={14} strokeWidth={1.75} />;
    case "branch":
      return <GitBranch size={14} strokeWidth={1.75} />;
    case "customRef":
      return <Hash size={14} strokeWidth={1.75} />;
    case "name":
      return <CaseSensitive size={14} strokeWidth={1.75} />;
    default:
      return <Sparkles size={14} strokeWidth={1.75} />;
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
    <div className="flex min-h-[250px] flex-col gap-2">
      <label
        htmlFor={SMART_INPUT_ID}
        className="text-[12px] font-medium text-text-3"
      >
        {t("creator.worktreeSource.smartLabel", {
          defaultValue: "Name, number, branch, or URL",
        })}
      </label>
      <Input
        id={SMART_INPUT_ID}
        type="search"
        value={query}
        onChange={onQueryChange}
        allowClear
        prefix={<Sparkles size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />}
        placeholder={t("creator.worktreeSource.smartPlaceholder", {
          defaultValue: "Name, #1234, branch, or GitHub/GitLab URL",
        })}
        aria-label={t("creator.worktreeSource.smartAria", {
          defaultValue: "Enter a name, PR number, branch, or GitHub/GitLab URL",
        })}
      />
      <WorktreeSourceList>
        {loading && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <Loader2 size={16} className="animate-spin" />
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
                title={suggestion.title}
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
