import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolvePrWorktreeBase } from "@src/api/tauri/github";
import type { GitHubIssue, OpenPRItem } from "@src/api/tauri/github";
import GitHubIcon from "@src/assets/channelIcons/github.svg";
import {
  CircleDotIcon,
  GitPullRequestIcon,
  HashtagIcon,
  HugeiconsIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import { useWorktreeMap } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap";
import Modal from "@src/scaffold/ModalSystem";
import type {
  WorktreeLaunchSelection,
  WorktreeLaunchSource,
} from "@src/store/session/worktreeLaunchSourceAtom";
import { resolveWorktreeSelectionRepoKey } from "@src/store/session/worktreeLaunchSourceAtom";

import { WorktreeBranchTab } from "./WorktreeBranchTab";
import { WorktreeGitHubTab } from "./WorktreeGitHubTab";
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
import { prToWorktreeOption } from "./worktreePrSource";
import { type PrResolveMeta } from "./worktreeSmartInput";
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
  onSelect: (selection: WorktreeLaunchSelection) => void;
}

type SourceTabId = "branch" | "github";

interface SourceTab {
  id: SourceTabId;
  label: string;
  icon: React.ReactNode;
}

function normalizeBaseBranch(branchName?: string): string | undefined {
  const trimmed = branchName?.trim();
  return trimmed || undefined;
}

function githubPrToItem(pr: OpenPRItem): GitHubWorktreeItem {
  const option = prToWorktreeOption(pr);
  return {
    id: option.id,
    icon: (
      <HugeiconsIcon
        icon={GitPullRequestIcon}
        data-icon="git-pull-request"
        size={14}
        strokeWidth={1.75}
      />
    ),
    source: option.source,
    detail: option.detail,
    searchableText: option.searchableText,
    pr: option.resolveMeta,
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
    icon: (
      <HugeiconsIcon
        icon={CircleDotIcon}
        data-icon="circle-dot"
        size={14}
        strokeWidth={1.75}
      />
    ),
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
  repoPath,
  branchName,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation("sessions");
  const selectionRepoKey = resolveWorktreeSelectionRepoKey(repoId, repoPath);
  const [activeTab, setActiveTab] = useState<SourceTabId>("branch");
  const [selectedSource, setSelectedSource] =
    useState<WorktreeLaunchSource | null>(null);
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
  const branchOptions = branchData.options;
  const branchState = branchData.state;
  const branchError = branchData.error;

  const tabs = useMemo<SourceTab[]>(
    () => [
      {
        id: "branch",
        label: t("creator.worktreeSource.tabs.branch", {
          defaultValue: "Branch",
        }),
        icon: (
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={14}
            strokeWidth={1.75}
          />
        ),
      },
      {
        id: "github",
        label: t("creator.worktreeSource.tabs.github", {
          defaultValue: "GitHub",
        }),
        icon: <GitHubIcon width={14} height={14} />,
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
  // Spotlight branch selector (`categorizeBranches`), with the current/default
  // branches promoted and worktree paths merged onto matching local branches.
  const branchGroups = useMemo(
    () =>
      groupBranchOptions(
        filteredBranchOptions,
        worktreeMap,
        normalizeBaseBranch(branchName)
      ),
    [branchName, filteredBranchOptions, worktreeMap]
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

  // Tab switching resets `selectedSource` to null, so a non-null selection
  // always belongs to the active tab — no kind check needed.
  const selectedForActiveTab = selectedSource;

  const fallbackSource = useMemo<WorktreeLaunchSource | null>(() => {
    if (selectedForActiveTab) return selectedForActiveTab;
    if (activeTab === "github") return filteredGithubItems[0]?.source ?? null;
    return branchFallback;
  }, [activeTab, branchFallback, filteredGithubItems, selectedForActiveTab]);

  const prMetaBySourceRef = useMemo(() => {
    const map = new Map<string, PrResolveMeta>();
    for (const item of githubItems) {
      if (item.pr && item.source.sourceRef) {
        map.set(item.source.sourceRef, item.pr);
      }
    }
    return map;
  }, [githubItems]);

  const handleConfirm = async () => {
    if (!fallbackSource || isResolving) return;
    setResolveError(null);

    if (!selectionRepoKey) {
      setResolveError(
        t("creator.worktreeSource.selectRepository", {
          defaultValue:
            "Select a repository before choosing a worktree source.",
        })
      );
      return;
    }

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
        onSelect({
          repoKey: selectionRepoKey,
          source: mergeResolvedPrBase(fallbackSource, resolution),
        });
      } catch (error) {
        setResolveError(error instanceof Error ? error.message : String(error));
        return;
      } finally {
        setIsResolving(false);
      }
      return;
    }

    onSelect({ repoKey: selectionRepoKey, source: fallbackSource });
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
        icon={
          <HugeiconsIcon
            icon={HashtagIcon}
            data-icon="hash"
            size={14}
            strokeWidth={1.75}
          />
        }
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

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      onOk={handleConfirm}
      title={t("creator.worktreeSource.title", {
        defaultValue: "Create worktree",
      })}
      size="large"
      bodyClassName="p-0"
      okText={
        isResolving
          ? t("creator.worktreeSource.resolving", {
              defaultValue: "Resolving PR...",
            })
          : t("common:actions.create")
      }
      cancelText={t("common:actions.cancel")}
      okButtonProps={{ disabled: !fallbackSource, loading: isResolving }}
      cancelButtonProps={{ disabled: isResolving }}
      closable={!isResolving}
      maskClosable={!isResolving}
      escToExit={!isResolving}
    >
      <div className="flex min-h-0 flex-col">
        <div
          role="tablist"
          aria-label={t("creator.worktreeSource.sourceTabs", {
            defaultValue: "Worktree source",
          })}
          className="flex shrink-0 flex-wrap items-end gap-px border-b border-border-2 px-4 pt-1"
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
              className={`relative -mb-px flex shrink-0 items-center gap-1.5 rounded-t-md border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                activeTab === tab.id
                  ? "border-border-2 text-text-1 after:absolute after:-bottom-px after:left-0 after:right-0 after:h-px after:bg-bg-2"
                  : "border-transparent text-text-2 hover:bg-fill-1 hover:text-text-1"
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
          className="min-h-80 p-4"
        >
          {activeTab === "github" && renderGithubTab()}
          {activeTab === "branch" && renderBranchTab()}
        </div>

        {resolveError && (
          <div
            role="alert"
            aria-live="assertive"
            className="border-t border-border-2 px-4 py-2 text-[12px] text-danger-6"
          >
            {resolveError}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default WorktreeSourceModal;
