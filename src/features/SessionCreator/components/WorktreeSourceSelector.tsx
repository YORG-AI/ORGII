import { Cloud, Folder, GitBranch, GitPullRequest, Hash } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { resolvePrWorktreeBase } from "@src/api/tauri/github";
import { useWorktreeMap } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap";
import type {
  WorktreeLaunchSelection,
  WorktreeLaunchSource,
} from "@src/store/session/worktreeLaunchSourceAtom";
import { resolveWorktreeSelectionRepoKey } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  WorktreeSourceDropdownView,
  type WorktreeSourceSelectorViewProps,
  WorktreeSourceSpotlightView,
} from "./WorktreeSourceSelectorViews";
import { useWorktreeSourceData } from "./useWorktreeSourceData";
import {
  branchToLaunchSource,
  customRefToLaunchSource,
  filterBranchOptions,
  formatBranchTimestamp,
  groupBranchOptions,
  shouldOfferCustomRef,
  sourceKey,
} from "./worktreeBranchSource";
import { prToWorktreeOption } from "./worktreePrSource";
import { mergeResolvedPrBase } from "./worktreeSourceResolve";
import type {
  WorktreeSourcePickerItem,
  WorktreeSourcePickerMode,
  WorktreeSourcePickerSection,
} from "./worktreeSourceSelectorTypes";

export type WorktreeSourcePickerPresentation = "dropdown" | "spotlight";

export interface WorktreeSourceSelectorProps {
  isOpen: boolean;
  presentation: WorktreeSourcePickerPresentation;
  anchorRef: React.RefObject<HTMLElement | null>;
  placement?: "top" | "bottom" | "auto";
  repoId?: string;
  repoPath?: string;
  currentBranchName?: string;
  selectedSource?: WorktreeLaunchSource | null;
  onClose: () => void;
  onSelect: (selection: WorktreeLaunchSelection) => void;
}

const BRANCH_GROUP_LABEL_FALLBACK = {
  recent: "Recent",
  worktrees: "Worktrees",
  otherBranches: "Other Branches",
} as const;
export const WorktreeSourceSelector: React.FC<WorktreeSourceSelectorProps> = ({
  isOpen,
  presentation,
  anchorRef,
  placement = "bottom",
  repoId,
  repoPath,
  currentBranchName,
  selectedSource,
  onClose,
  onSelect,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const [mode, setMode] = useState<WorktreeSourcePickerMode>("branch");
  const [query, setQuery] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const resolveGenerationRef = useRef(0);

  const selectionRepoKey = resolveWorktreeSelectionRepoKey(repoId, repoPath);
  useEffect(
    () => () => {
      resolveGenerationRef.current += 1;
    },
    [isOpen, selectionRepoKey]
  );

  const { branch: branchData, github: githubData } = useWorktreeSourceData({
    open: isOpen,
    repoId,
    repoPath,
    loadBranches: mode === "branch",
    loadGithub: mode === "pr",
  });
  const worktreeMap = useWorktreeMap({
    enabled: isOpen && mode === "branch" && Boolean(repoPath),
    repoId: repoId || "default",
    repoPath,
    isLocalRepo: true,
  });

  const branchSections = useMemo<WorktreeSourcePickerSection[]>(() => {
    const filtered = filterBranchOptions(branchData.options, query);
    const groups = groupBranchOptions(filtered, worktreeMap, currentBranchName);
    const sections: WorktreeSourcePickerSection[] = [];
    if (shouldOfferCustomRef(query, branchData.options)) {
      const source = customRefToLaunchSource(query);
      if (source) {
        sections.push({
          key: "custom-ref",
          items: [
            {
              id: `custom:${source.baseBranch}`,
              label: t("sessions:creator.worktreeSource.branchUseAsRef", {
                value: source.baseBranch,
                defaultValue: `Use "${source.baseBranch}" as ref`,
              }),
              detail: t("sessions:creator.worktreeSource.branchCustomRefHint", {
                defaultValue: "Tag, commit, or any git ref",
              }),
              icon: Hash,
              source,
            },
          ],
        });
      }
    }
    for (const group of groups) {
      sections.push({
        key: group.key,
        label: t(`common:selectors.branch.labels.${group.labelKey}`, {
          defaultValue: BRANCH_GROUP_LABEL_FALLBACK[group.labelKey],
        }),
        items: group.options.map((option) => {
          const source = branchToLaunchSource(option);
          return {
            id: `branch:${option.name}`,
            label: option.name,
            meta: formatBranchTimestamp(option),
            icon: option.worktreePath
              ? Folder
              : option.isRemote
                ? Cloud
                : GitBranch,
            source,
          };
        }),
      });
    }
    return sections;
  }, [branchData.options, currentBranchName, query, t, worktreeMap]);

  const prSections = useMemo<WorktreeSourcePickerSection[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const options = githubData.prs
      .map(prToWorktreeOption)
      .filter(
        (option) =>
          !normalizedQuery ||
          option.searchableText.toLowerCase().includes(normalizedQuery)
      )
      .map<WorktreeSourcePickerItem>((option) => ({
        id: option.id,
        label: option.source.label,
        detail: option.detail,
        icon: GitPullRequest,
        source: option.source,
        resolveMeta: option.resolveMeta,
      }));
    return options.length > 0 ? [{ key: "pull-requests", items: options }] : [];
  }, [githubData.prs, query]);

  const sections = mode === "branch" ? branchSections : prSections;
  const items = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );
  const activeData = mode === "branch" ? branchData : githubData;
  const activeError = resolveError ?? activeData.error;
  const selectedSourceKey = selectedSource ? sourceKey(selectedSource) : null;

  const handleModeChange = useCallback((nextMode: WorktreeSourcePickerMode) => {
    setMode(nextMode);
    setQuery("");
    setResolveError(null);
  }, []);

  const handleSelect = useCallback(
    async (item: WorktreeSourcePickerItem) => {
      if (resolving) return;
      setResolveError(null);
      if (!selectionRepoKey) {
        setResolveError(
          t("sessions:creator.worktreeSource.selectRepository", {
            defaultValue:
              "Select a repository before choosing a worktree source",
          })
        );
        return;
      }

      let source = item.source;
      if (item.resolveMeta) {
        if (!repoPath) {
          setResolveError(
            t("sessions:creator.worktreeSource.selectRepository", {
              defaultValue:
                "Select a repository before choosing a worktree source",
            })
          );
          return;
        }
        const generation = ++resolveGenerationRef.current;
        setResolving(true);
        try {
          const resolution = await resolvePrWorktreeBase({
            repoPath,
            prNumber: item.resolveMeta.prNumber,
            headBranch: item.resolveMeta.headBranch,
            baseBranch: item.resolveMeta.baseBranch,
          });
          if (generation !== resolveGenerationRef.current) return;
          source = mergeResolvedPrBase(source, resolution);
        } catch (error) {
          if (generation !== resolveGenerationRef.current) return;
          setResolveError(
            error instanceof Error ? error.message : String(error)
          );
          return;
        } finally {
          if (generation === resolveGenerationRef.current) {
            setResolving(false);
          }
        }
      }

      onSelect({ repoKey: selectionRepoKey, source });
      onClose();
    },
    [onClose, onSelect, repoPath, resolving, selectionRepoKey, t]
  );

  const viewProps: WorktreeSourceSelectorViewProps = {
    isOpen,
    anchorRef,
    placement,
    mode,
    query,
    sections,
    items,
    selectedSourceKey,
    effectiveCurrentBranchName: selectedSource ? undefined : currentBranchName,
    loading: activeData.state === "loading",
    refreshing: activeData.refreshing,
    resolving,
    error: activeError,
    emptyMessage:
      mode === "branch"
        ? t("sessions:creator.worktreeSource.branchNoMatches", {
            defaultValue: "No matching branches",
          })
        : t("sessions:creator.worktreeSource.prNoMatches", {
            defaultValue: "No matching pull requests",
          }),
    loadingLabel: t("common:status.loading", { defaultValue: "Loading" }),
    resolvingLabel: t("sessions:creator.worktreeSource.resolving", {
      defaultValue: "Resolving PR…",
    }),
    searchPlaceholder:
      mode === "branch"
        ? t("sessions:creator.worktreeSource.branchSearch", {
            defaultValue: "Search branches or enter a ref",
          })
        : t("sessions:creator.worktreeSource.prSearch", {
            defaultValue: "Search pull requests",
          }),
    searchAriaLabel:
      mode === "branch"
        ? t("sessions:creator.worktreeSource.branchSearchAria", {
            defaultValue: "Search branches or enter a base ref",
          })
        : t("sessions:creator.worktreeSource.prSearchAria", {
            defaultValue: "Search pull requests",
          }),
    retryLabel: t("common:actions.retry", { defaultValue: "Retry" }),
    onClose,
    onModeChange: handleModeChange,
    onQueryChange: setQuery,
    onRetry: activeData.refresh,
    onSelect: (item) => void handleSelect(item),
  };

  return presentation === "dropdown" ? (
    <WorktreeSourceDropdownView {...viewProps} />
  ) : (
    <WorktreeSourceSpotlightView {...viewProps} />
  );
};

export default WorktreeSourceSelector;
