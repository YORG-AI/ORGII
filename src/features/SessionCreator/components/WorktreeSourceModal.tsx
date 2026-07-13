import {
  CaseSensitive,
  Check,
  CircleDot,
  Cloud,
  GitBranch,
  GitFork,
  GitPullRequest,
  Github,
  Hash,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolvePrWorktreeBase } from "@src/api/tauri/github";
import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";
import Button from "@src/components/Button";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH,
} from "@src/components/Dropdown/tokens";
import Input from "@src/components/Input";
import { useWorktreeMap } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap";
import Modal from "@src/scaffold/ModalSystem";
import type {
  WorktreeCreateSourceKind,
  WorktreeLaunchSource,
} from "@src/store/session/worktreeLaunchSourceAtom";

import { useWorktreeSourceData } from "./useWorktreeSourceData";
import {
  type WorktreeBranchOption,
  branchToLaunchSource,
  compactText,
  customRefToLaunchSource,
  filterBranchOptions,
  formatBranchTimestamp,
  groupBranchOptions,
  shouldOfferCustomRef,
} from "./worktreeBranchSource";
import {
  type PrResolveMeta,
  type SmartIssueInput,
  type SmartPrInput,
  type SmartSuggestionKind,
  type SmartSuggestionSources,
  buildSmartSuggestions,
  nameToLaunchSource,
} from "./worktreeSmartInput";
import {
  isPrSource,
  mergeResolvedPrBase,
  prNumberFromSourceRef,
} from "./worktreeSourceResolve";

export interface WorktreeSourceModalProps {
  open: boolean;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branchName?: string;
  onClose: () => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}

interface GitHubWorktreeItem {
  id: string;
  icon: React.ReactNode;
  source: WorktreeLaunchSource;
  detail: string;
  searchableText: string;
  /** Present only for PR rows — drives `worktree_resolve_pr_base` on confirm. */
  pr?: PrResolveMeta;
}

interface SourceTab {
  id: WorktreeCreateSourceKind;
  label: string;
  icon: React.ReactNode;
}

/** English fallbacks for the Branch-tab section labels (common-ns i18n keys). */
const BRANCH_GROUP_LABEL_FALLBACK: Record<
  "recent" | "worktrees" | "otherBranches",
  string
> = {
  recent: "Recent",
  worktrees: "Worktrees",
  otherBranches: "Other Branches",
};

/** Stable ids so the visible `<label>`s associate with their DS `Input`s. */
const SMART_INPUT_ID = "worktree-source-smart-input";
const BRANCH_SEARCH_INPUT_ID = "worktree-source-branch-search";
const NAME_INPUT_ID = "worktree-source-name-input";

function normalizeBaseBranch(branchName?: string): string | undefined {
  const trimmed = branchName?.trim();
  return trimmed || undefined;
}

function smartIcon(kind: SmartSuggestionKind): React.ReactNode {
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

function sourceKey(source: WorktreeLaunchSource): string {
  return [
    source.kind,
    source.sourceRef ?? "",
    source.baseBranch ?? "",
    source.label,
  ].join(":");
}

function githubPrToItem(pr: OpenPRItem): GitHubWorktreeItem {
  const label = compactText(`#${pr.number} ${pr.title}`);
  const detail = `${pr.head_branch} -> ${pr.base_branch}`;
  return {
    id: `pr:${pr.number}`,
    icon: <GitPullRequest size={14} strokeWidth={1.75} />,
    source: {
      kind: "github",
      label,
      baseBranch: pr.head_branch || pr.base_branch,
      sourceRef: `pr:${pr.number}`,
      title: pr.title,
    },
    detail,
    searchableText: `${label} ${detail}`,
    pr: {
      prNumber: pr.number,
      headBranch: pr.head_branch || undefined,
      baseBranch: pr.base_branch || undefined,
    },
  };
}

function githubIssueToItem(
  issue: GitHubIssue,
  baseBranch?: string
): GitHubWorktreeItem {
  const label = compactText(`#${issue.number} ${issue.title}`);
  const detail = baseBranch ? `Issue - Base: ${baseBranch}` : "Issue";
  return {
    id: `issue:${issue.number}`,
    icon: <CircleDot size={14} strokeWidth={1.75} />,
    source: {
      kind: "github",
      label,
      baseBranch,
      sourceRef: `issue:${issue.number}`,
      title: issue.title,
    },
    detail,
    searchableText: `${label} ${detail}`,
  };
}

/**
 * Shared list-container classes for every tab's result list. A single
 * token-backed bordered scroll region (border + `bg-bg-2` + `max-h` cap +
 * internal scroll) so all four tabs render their `SourceRow`s inside the
 * exact same wrapper — no per-tab drift. Consumed via `SourceList`.
 */
const SOURCE_LIST_CLASS = `min-h-0 flex-1 ${DROPDOWN_PANEL.optionsMaxHeightClass} overflow-y-auto rounded-lg border border-border-2 bg-bg-2 p-1`;

/** Bordered, height-capped, internally-scrolling list wrapper shared by all tabs. */
const SourceList: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className={SOURCE_LIST_CLASS}>{children}</div>
);

/** Refresh control rendered inside DS `Input` suffix — matches input row height. */
const SourceRefreshSuffix: React.FC<{
  disabled?: boolean;
  refreshing?: boolean;
  ariaLabel: string;
  onClick: () => void;
}> = ({ disabled, refreshing, ariaLabel, onClick }) => (
  <button
    type="button"
    className="inline-flex shrink-0 items-center justify-center border-none bg-transparent p-0 text-text-3 transition-colors hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
    disabled={disabled}
    aria-label={ariaLabel}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
  >
    <RefreshCw
      size={DROPDOWN_SEARCH.iconSize}
      strokeWidth={1.75}
      className={refreshing ? "animate-spin" : undefined}
    />
  </button>
);

const SourceRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  detail?: string;
  /** Optional right-aligned metadata (e.g. relative "last commit" timestamp). */
  meta?: string;
  selected: boolean;
  onClick: () => void;
}> = ({ icon, title, detail, meta, selected, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center py-1 text-left ${DROPDOWN_ITEM.minHeightClass} ${DROPDOWN_ITEM.gapClass} ${DROPDOWN_ITEM.paddingXClass} ${DROPDOWN_ITEM.borderRadiusClass} ${DROPDOWN_ITEM.transitionClass} ${
      selected
        ? "bg-surface-hover text-text-1"
        : "text-text-2 hover:bg-surface-hover hover:text-text-1"
    }`}
  >
    <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
      {icon}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium leading-5 text-text-1">
        {title}
      </span>
      {detail && (
        <span className="block truncate text-[12px] leading-4 text-text-3">
          {detail}
        </span>
      )}
    </span>
    {meta && (
      <span className="shrink-0 text-[12px] tabular-nums leading-4 text-text-3">
        {meta}
      </span>
    )}
    {selected && (
      <Check size={14} strokeWidth={1.75} className="shrink-0 text-primary-6" />
    )}
  </button>
);

/**
 * Icon for a branch row — distinguishes worktree / remote (origin) / local by
 * glyph instead of a "Local branch" / "Remote branch" text subtitle, matching
 * the Spotlight branch selector's icon-first rows.
 */
function branchRowIcon(option: WorktreeBranchOption): React.ReactNode {
  if (option.worktreePath) return <GitFork size={14} strokeWidth={1.75} />;
  if (option.isRemote) return <Cloud size={14} strokeWidth={1.75} />;
  return <GitBranch size={14} strokeWidth={1.75} />;
}

const WorktreeSourceModal: React.FC<WorktreeSourceModalProps> = ({
  open,
  repoId,
  repoName,
  repoPath,
  branchName,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation("sessions");
  const [activeTab, setActiveTab] = useState<WorktreeCreateSourceKind>("smart");
  const [selectedSource, setSelectedSource] =
    useState<WorktreeLaunchSource | null>(null);
  const [nameInput, setNameInput] = useState("");
  const [smartQuery, setSmartQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const { github: githubData, branch: branchData } = useWorktreeSourceData({
    open,
    repoId,
    repoPath,
  });

  const githubItems = useMemo(() => {
    const base = normalizeBaseBranch(branchName);
    return [
      ...githubData.prs.map(githubPrToItem),
      ...githubData.issues.map((issue) => githubIssueToItem(issue, base)),
    ];
  }, [branchName, githubData.issues, githubData.prs]);

  const githubState = githubData.state;
  const githubError = githubData.error;
  const repoFullName = githubData.repoFullName;
  const branchOptions = branchData.options;
  const branchState = branchData.state;
  const branchError = branchData.error;

  const tabs = useMemo<SourceTab[]>(
    () => [
      {
        id: "smart",
        label: t("creator.worktreeSource.tabs.smart", {
          defaultValue: "Smart",
        }),
        icon: <Sparkles size={14} strokeWidth={1.75} />,
      },
      {
        id: "github",
        label: t("creator.worktreeSource.tabs.github", {
          defaultValue: "GitHub",
        }),
        icon: <Github size={14} strokeWidth={1.75} />,
      },
      {
        id: "branch",
        label: t("creator.worktreeSource.tabs.branch", {
          defaultValue: "Branch",
        }),
        icon: <GitBranch size={14} strokeWidth={1.75} />,
      },
      {
        id: "name",
        label: t("creator.worktreeSource.tabs.name", {
          defaultValue: "Name",
        }),
        icon: <CaseSensitive size={14} strokeWidth={1.75} />,
      },
    ],
    [t]
  );

  const filteredGithubItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return githubItems;
    return githubItems.filter((item) =>
      item.searchableText.toLowerCase().includes(query)
    );
  }, [githubItems, searchQuery]);

  // Branch→worktree-path map (local repos), reused from the Spotlight branch
  // selector so the Branch tab can surface a Worktrees section. Best-effort:
  // an empty map just means no Worktrees group is shown.
  const worktreeMap = useWorktreeMap({
    enabled: open && Boolean(repoPath),
    repoId: repoId || "default",
    repoPath,
    isLocalRepo: true,
  });

  const filteredBranchOptions = useMemo(
    () => filterBranchOptions(branchOptions, branchQuery),
    [branchOptions, branchQuery]
  );

  // Recent / Worktrees / Other sections, categorised exactly like the
  // Spotlight branch selector (`categorizeBranches`), with worktree paths
  // merged onto matching local branches.
  const branchGroups = useMemo(
    () => groupBranchOptions(filteredBranchOptions, worktreeMap),
    [filteredBranchOptions, worktreeMap]
  );

  // Visual order across all sections — drives the default (fallback) selection.
  const orderedBranchOptions = useMemo(
    () => branchGroups.flatMap((group) => group.options),
    [branchGroups]
  );

  const offerCustomRef = useMemo(
    () => shouldOfferCustomRef(branchQuery, branchOptions),
    [branchOptions, branchQuery]
  );

  const customRefSource = useMemo(
    () => customRefToLaunchSource(branchQuery),
    [branchQuery]
  );

  // Confirm target for the Branch tab: an explicit click wins; otherwise the
  // first branch in the grouped list; otherwise the typed custom ref; otherwise
  // the current branch (as a ref) so the tab is never dead on open.
  const branchFallback = useMemo<WorktreeLaunchSource | null>(() => {
    if (orderedBranchOptions.length > 0) {
      return branchToLaunchSource(orderedBranchOptions[0]);
    }
    if (offerCustomRef && customRefSource) return customRefSource;
    const base = normalizeBaseBranch(branchName);
    return base ? customRefToLaunchSource(base) : null;
  }, [branchName, customRefSource, orderedBranchOptions, offerCustomRef]);

  const nameSource = useMemo<WorktreeLaunchSource | null>(
    () => nameToLaunchSource(nameInput, branchName),
    [branchName, nameInput]
  );

  // Feed the loaded GitHub PRs/issues + branches (already fetched by the
  // effects above) into the pure smart-suggestion builder. Reusing the same
  // `githubItems`/`branchOptions` avoids a second fetch.
  const smartSuggestionSources = useMemo<SmartSuggestionSources>(() => {
    const prs: SmartPrInput[] = [];
    const issues: SmartIssueInput[] = [];
    for (const item of githubItems) {
      if (item.pr) {
        prs.push({
          number: item.pr.prNumber,
          title: item.source.title ?? "",
          headBranch: item.pr.headBranch ?? "",
          baseBranch: item.pr.baseBranch ?? "",
        });
      } else if (item.source.sourceRef?.startsWith("issue:")) {
        const number = Number.parseInt(
          item.source.sourceRef.slice("issue:".length),
          10
        );
        if (Number.isInteger(number)) {
          issues.push({ number, title: item.source.title ?? "" });
        }
      }
    }
    return {
      prs,
      issues,
      branches: branchOptions,
      branchName: normalizeBaseBranch(branchName),
      repoName,
      repoFullName: repoFullName ?? undefined,
    };
  }, [branchName, branchOptions, githubItems, repoFullName, repoName]);

  const smartSuggestions = useMemo(
    () => buildSmartSuggestions(smartQuery, smartSuggestionSources),
    [smartQuery, smartSuggestionSources]
  );

  // Tab switching resets `selectedSource` to null, so a non-null selection
  // always belongs to the active tab — no kind check needed (the Smart tab's
  // selection can be any kind: pr / branch / name / customRef).
  const selectedForActiveTab = selectedSource;

  const fallbackSource = useMemo<WorktreeLaunchSource | null>(() => {
    if (selectedForActiveTab) return selectedForActiveTab;
    if (activeTab === "smart") return smartSuggestions[0]?.source ?? null;
    if (activeTab === "github") return filteredGithubItems[0]?.source ?? null;
    if (activeTab === "branch") return branchFallback;
    return nameSource;
  }, [
    activeTab,
    branchFallback,
    filteredGithubItems,
    nameSource,
    selectedForActiveTab,
    smartSuggestions,
  ]);

  const prMetaBySourceRef = useMemo(() => {
    const map = new Map<string, PrResolveMeta>();
    for (const item of githubItems) {
      if (item.pr && item.source.sourceRef) {
        map.set(item.source.sourceRef, item.pr);
      }
    }
    // Smart PR suggestions carry their own resolve meta (including generic
    // `#<n>` rows not in the fetched list) — merge so confirm can resolve them.
    for (const suggestion of smartSuggestions) {
      if (suggestion.pr && suggestion.source.sourceRef) {
        map.set(suggestion.source.sourceRef, suggestion.pr);
      }
    }
    return map;
  }, [githubItems, smartSuggestions]);

  const handleConfirm = async () => {
    if (!fallbackSource || isResolving) return;
    setResolveError(null);

    // PR sources must be resolved to a concrete, git-resolvable base ref
    // (the PR head SHA) before launch — the synthetic `pr:<n>` ref and the
    // head branch name alone cannot create a worktree for fork PRs.
    const meta = fallbackSource.sourceRef
      ? prMetaBySourceRef.get(fallbackSource.sourceRef)
      : undefined;

    if (isPrSource(fallbackSource) && meta && repoPath) {
      const prNumber =
        prNumberFromSourceRef(fallbackSource.sourceRef) ?? meta.prNumber;
      setIsResolving(true);
      try {
        const resolution = await resolvePrWorktreeBase({
          repoPath,
          prNumber,
          headBranch: meta.headBranch,
          baseBranch: meta.baseBranch,
        });
        onSelect(mergeResolvedPrBase(fallbackSource, resolution));
      } catch (error) {
        setResolveError(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setIsResolving(false);
      }
      return;
    }

    onSelect(fallbackSource);
  };

  const renderSmartTab = () => {
    // Suggestions always include a "name" fallback once the user types and the
    // two smart default rows whenever a branch/repo is known, so the list is
    // effectively never empty except in the zero-data + zero-query corner.
    const smartLoading =
      smartSuggestions.length === 0 &&
      ((githubState === "loading" && githubItems.length === 0) ||
        (branchState === "loading" && branchOptions.length === 0));

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
          value={smartQuery}
          onChange={(value) => {
            setSmartQuery(value);
            setSelectedSource(null);
            setResolveError(null);
          }}
          allowClear
          prefix={
            <Sparkles size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />
          }
          placeholder={t("creator.worktreeSource.smartPlaceholder", {
            defaultValue: "Name, #1234, branch, or GitHub/GitLab URL",
          })}
          aria-label={t("creator.worktreeSource.smartAria", {
            defaultValue:
              "Enter a name, PR number, branch, or GitHub/GitLab URL",
          })}
        />

        <SourceList>
          {smartLoading && (
            <div className="flex h-[180px] items-center justify-center text-text-3">
              <Loader2 size={16} className="animate-spin" />
            </div>
          )}

          {!smartLoading && smartSuggestions.length === 0 && (
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

          {!smartLoading && smartSuggestions.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {smartSuggestions.map((suggestion) => (
                <SourceRow
                  key={suggestion.id}
                  icon={smartIcon(suggestion.kind)}
                  title={suggestion.title}
                  selected={
                    sourceKey(fallbackSource ?? suggestion.source) ===
                    sourceKey(suggestion.source)
                  }
                  onClick={() => {
                    setSelectedSource(suggestion.source);
                    setResolveError(null);
                  }}
                />
              ))}
            </div>
          )}
        </SourceList>
      </div>
    );
  };

  const renderGithubTab = () => (
    <div className="flex min-h-[250px] flex-col gap-2">
      <Input
        type="search"
        value={searchQuery}
        onChange={(value) => setSearchQuery(value)}
        allowClear
        prefix={<Search size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />}
        suffix={
          <SourceRefreshSuffix
            disabled={!repoPath || githubState === "loading"}
            refreshing={githubData.refreshing}
            ariaLabel={t("creator.worktreeSource.refreshGithub", {
              defaultValue: "Refresh GitHub list",
            })}
            onClick={() => githubData.refresh()}
          />
        }
        placeholder={t("creator.worktreeSource.githubSearch", {
          defaultValue: "Search GitHub PRs and issues",
        })}
        aria-label={t("creator.worktreeSource.githubSearchAria", {
          defaultValue: "Search GitHub PRs and issues",
        })}
      />

      <SourceList>
        {githubState === "loading" && githubItems.length === 0 && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}

        {githubState === "error" && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3"
          >
            {githubError ||
              t("creator.worktreeSource.githubError", {
                defaultValue: "GitHub items could not be loaded.",
              })}
          </div>
        )}

        {githubState === "empty" && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {t("creator.worktreeSource.githubEmpty", {
              defaultValue: "No open GitHub PRs or issues.",
            })}
          </div>
        )}

        {githubState === "ready" && filteredGithubItems.length === 0 && (
          <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
            {t("creator.worktreeSource.githubNoMatches", {
              defaultValue: "No matches.",
            })}
          </div>
        )}

        {githubState === "ready" && filteredGithubItems.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {filteredGithubItems.map((item) => (
              <SourceRow
                key={item.id}
                icon={item.icon}
                title={item.source.label}
                selected={
                  sourceKey(fallbackSource ?? item.source) ===
                  sourceKey(item.source)
                }
                onClick={() => {
                  setSelectedSource(item.source);
                  setResolveError(null);
                }}
              />
            ))}
          </div>
        )}
      </SourceList>
    </div>
  );

  const renderCustomRefRow = () => {
    if (!offerCustomRef || !customRefSource) return null;
    return (
      <SourceRow
        icon={<Hash size={14} strokeWidth={1.75} />}
        title={t("creator.worktreeSource.branchUseAsRef", {
          value: customRefSource.baseBranch ?? "",
          defaultValue: `Use "${customRefSource.baseBranch}" as ref`,
        })}
        detail={t("creator.worktreeSource.branchCustomRefHint", {
          defaultValue: "Tag, commit, or any git ref",
        })}
        selected={
          sourceKey(fallbackSource ?? customRefSource) ===
          sourceKey(customRefSource)
        }
        onClick={() => setSelectedSource(customRefSource)}
      />
    );
  };

  const renderBranchTab = () => (
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
        value={branchQuery}
        onChange={(value) => {
          setBranchQuery(value);
          setSelectedSource(null);
        }}
        allowClear
        prefix={<Search size={DROPDOWN_SEARCH.iconSize} strokeWidth={1.75} />}
        suffix={
          <SourceRefreshSuffix
            disabled={!repoPath || branchState === "loading"}
            refreshing={branchData.refreshing}
            ariaLabel={t("creator.worktreeSource.refreshBranches", {
              defaultValue: "Refresh branch list",
            })}
            onClick={() => branchData.refresh()}
          />
        }
        placeholder={t("creator.worktreeSource.branchSearch", {
          defaultValue: "Search branches or enter a ref",
        })}
        aria-label={t("creator.worktreeSource.branchSearchAria", {
          defaultValue: "Search branches or enter a base ref",
        })}
      />

      <SourceList>
        {branchState === "loading" && branchOptions.length === 0 && (
          <div className="flex h-[180px] items-center justify-center text-text-3">
            <Loader2 size={16} className="animate-spin" />
          </div>
        )}

        {branchState === "error" && (
          <div
            role="alert"
            aria-live="assertive"
            className="flex h-[180px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-text-3"
          >
            <span>
              {branchError ||
                t("creator.worktreeSource.branchError", {
                  defaultValue: "Branches could not be loaded.",
                })}
            </span>
            {renderCustomRefRow()}
          </div>
        )}

        {branchState === "empty" && (
          <div className="flex h-[180px] flex-col items-center justify-center gap-2 px-4 text-center text-[13px] text-text-3">
            <span>
              {t("creator.worktreeSource.branchEmpty", {
                defaultValue: "No branches found in this repository.",
              })}
            </span>
            {renderCustomRefRow()}
          </div>
        )}

        {branchState === "ready" &&
          branchGroups.length === 0 &&
          !offerCustomRef && (
            <div className="flex h-[180px] items-center justify-center px-4 text-center text-[13px] text-text-3">
              {t("creator.worktreeSource.branchNoMatches", {
                defaultValue: "No matching branches.",
              })}
            </div>
          )}

        {branchState === "ready" &&
          (branchGroups.length > 0 || offerCustomRef) && (
            <div className="flex flex-col gap-0.5">
              {renderCustomRefRow()}
              {branchGroups.map((group) => (
                <React.Fragment key={group.key}>
                  <div className={DROPDOWN_CLASSES.sectionLabel}>
                    {t(`common:selectors.branch.labels.${group.labelKey}`, {
                      defaultValue: BRANCH_GROUP_LABEL_FALLBACK[group.labelKey],
                    })}
                  </div>
                  {group.options.map((option) => {
                    const source = branchToLaunchSource(option);
                    return (
                      <SourceRow
                        key={`branch:${option.name}`}
                        icon={branchRowIcon(option)}
                        title={option.name}
                        meta={formatBranchTimestamp(option)}
                        selected={
                          sourceKey(fallbackSource ?? source) ===
                          sourceKey(source)
                        }
                        onClick={() => setSelectedSource(source)}
                      />
                    );
                  })}
                </React.Fragment>
              ))}
            </div>
          )}
      </SourceList>
    </div>
  );

  const renderNameTab = () => (
    <div className="flex min-h-[250px] flex-col gap-2">
      <label
        htmlFor={NAME_INPUT_ID}
        className="text-[12px] font-medium text-text-3"
      >
        {t("creator.worktreeSource.worktreeLabel", {
          defaultValue: "Worktree label",
        })}
      </label>
      <Input
        id={NAME_INPUT_ID}
        value={nameInput}
        onChange={(value) => setNameInput(value)}
        prefix={
          <CaseSensitive size={DROPDOWN_ITEM.iconSize} strokeWidth={1.75} />
        }
        placeholder={t("creator.worktreeSource.namePlaceholder", {
          defaultValue: "feature-name",
        })}
      />
      {nameSource && (
        <SourceList>
          <div className="flex flex-col gap-0.5">
            <SourceRow
              icon={<CaseSensitive size={14} strokeWidth={1.75} />}
              title={nameSource.title ?? nameSource.label}
              detail={
                nameSource.baseBranch
                  ? `Base: ${nameSource.baseBranch}`
                  : "Base: HEAD"
              }
              selected={
                sourceKey(fallbackSource ?? nameSource) ===
                sourceKey(nameSource)
              }
              onClick={() => setSelectedSource(nameSource)}
            />
          </div>
        </SourceList>
      )}
    </div>
  );

  return (
    <Modal
      visible={open}
      onClose={onClose}
      title={t("creator.worktreeSource.title", {
        defaultValue: "Create worktree",
      })}
      width={560}
      radius={14}
      bodyClassName="p-0"
      footer={
        <div className="flex h-14 items-center justify-end gap-2 border-t border-border-2 px-4">
          {resolveError && (
            <span
              role="alert"
              aria-live="assertive"
              className="mr-auto min-w-0 flex-1 truncate text-[12px] text-danger-6"
            >
              {resolveError}
            </span>
          )}
          <Button
            variant="secondary"
            size="small"
            onClick={onClose}
            disabled={isResolving}
          >
            {t("common:cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={!fallbackSource}
            loading={isResolving}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {isResolving
              ? t("creator.worktreeSource.resolving", {
                  defaultValue: "Resolving PR...",
                })
              : t("creator.worktreeSource.confirm", {
                  defaultValue: "Use worktree",
                })}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <div
          role="tablist"
          className="flex items-center gap-1 border-b border-border-2"
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`worktree-source-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`worktree-source-tabpanel-${tab.id}`}
              onClick={() => {
                setActiveTab(tab.id);
                setSelectedSource(null);
                setResolveError(null);
              }}
              className={`flex h-9 items-center gap-1.5 border-b-2 px-2 text-[13px] font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-text-1 text-text-1"
                  : "border-transparent text-text-3 hover:text-text-1"
              }`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div
          role="tabpanel"
          id={`worktree-source-tabpanel-${activeTab}`}
          aria-labelledby={`worktree-source-tab-${activeTab}`}
          className="min-h-[250px]"
        >
          {activeTab === "smart" && renderSmartTab()}
          {activeTab === "github" && renderGithubTab()}
          {activeTab === "branch" && renderBranchTab()}
          {activeTab === "name" && renderNameTab()}
        </div>
      </div>
    </Modal>
  );
};

export default WorktreeSourceModal;
