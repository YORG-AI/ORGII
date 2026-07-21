import {
  CaseSensitive,
  CircleDot,
  GitBranch,
  GitPullRequest,
  Github,
  Hash,
  Sparkles,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolvePrWorktreeBase } from "@src/api/tauri/github";
import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";
import Button from "@src/components/Button";
import { useWorktreeMap } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap";
import Modal from "@src/scaffold/ModalSystem";
import type {
  WorktreeCreateSourceKind,
  WorktreeLaunchSource,
} from "@src/store/session/worktreeLaunchSourceAtom";

import { WorktreeBranchTab } from "./WorktreeBranchTab";
import { WorktreeGitHubTab } from "./WorktreeGitHubTab";
import { WorktreeNameTab } from "./WorktreeNameTab";
import { WorktreeSmartTab } from "./WorktreeSmartTab";
import { WorktreeSourceRow as SourceRow } from "./WorktreeSourceModalRows";
import { useWorktreeSourceData } from "./useWorktreeSourceData";
import {
  branchToLaunchSource,
  compactText,
  customRefToLaunchSource,
  filterBranchOptions,
  groupBranchOptions,
  shouldOfferCustomRef,
  sourceKey,
} from "./worktreeBranchSource";
import {
  type PrResolveMeta,
  type SmartIssueInput,
  type SmartPrInput,
  type SmartSuggestionSources,
  buildSmartSuggestions,
  nameToLaunchSource,
} from "./worktreeSmartInput";
import type { GitHubWorktreeItem } from "./worktreeSourceModalTypes";
import {
  isPrSource,
  mergeResolvedPrBase,
  prNumberFromSourceRef,
} from "./worktreeSourceResolve";

interface WorktreeSourceModalProps {
  open: boolean;
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  branchName?: string;
  onClose: () => void;
  onSelect: (source: WorktreeLaunchSource) => void;
}

interface SourceTab {
  id: WorktreeCreateSourceKind;
  label: string;
  icon: React.ReactNode;
}

function normalizeBaseBranch(branchName?: string): string | undefined {
  const trimmed = branchName?.trim();
  return trimmed || undefined;
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
    const smartLoading =
      smartSuggestions.length === 0 &&
      ((githubState === "loading" && githubItems.length === 0) ||
        (branchState === "loading" && branchOptions.length === 0));

    return (
      <WorktreeSmartTab
        query={smartQuery}
        suggestions={smartSuggestions}
        loading={smartLoading}
        branchState={branchState}
        branchError={branchError}
        fallbackSource={fallbackSource}
        onQueryChange={(value) => {
          setSmartQuery(value);
          setSelectedSource(null);
          setResolveError(null);
        }}
        onSelect={(source) => {
          setSelectedSource(source);
          setResolveError(null);
        }}
      />
    );
  };

  const renderGithubTab = () => (
    <WorktreeGitHubTab
      query={searchQuery}
      repoPath={repoPath ?? null}
      state={githubState}
      error={githubError}
      refreshing={githubData.refreshing}
      items={filteredGithubItems}
      loadedItemCount={githubItems.length}
      fallbackSource={fallbackSource}
      onQueryChange={setSearchQuery}
      onRefresh={() => githubData.refresh()}
      onSelect={(source) => {
        setSelectedSource(source);
        setResolveError(null);
      }}
    />
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
    <WorktreeBranchTab
      query={branchQuery}
      repoPath={repoPath ?? null}
      state={branchState}
      error={branchError}
      refreshing={branchData.refreshing}
      branchOptionCount={branchOptions.length}
      groups={branchGroups}
      offerCustomRef={offerCustomRef}
      customRefRow={renderCustomRefRow()}
      fallbackSource={fallbackSource}
      onQueryChange={(value) => {
        setBranchQuery(value);
        setSelectedSource(null);
      }}
      onRefresh={() => branchData.refresh()}
      onSelect={setSelectedSource}
    />
  );

  const renderNameTab = () => (
    <WorktreeNameTab
      value={nameInput}
      source={nameSource}
      selected={
        nameSource
          ? sourceKey(fallbackSource ?? nameSource) === sourceKey(nameSource)
          : false
      }
      onChange={setNameInput}
      onSelect={setSelectedSource}
    />
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
