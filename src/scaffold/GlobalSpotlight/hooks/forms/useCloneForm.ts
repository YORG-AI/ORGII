/**
 * useCloneForm Hook
 *
 * Manages clone repository form state and GitHub repository fetching.
 * Handles both "myGitHub" and "githubUrl" workflows.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import type { GitHubRepo } from "@src/api/http/github/types";
import Message from "@src/components/Message";
import { useGitHubConnections } from "@src/hooks/git";
import { createLogger } from "@src/hooks/logger";
import {
  effectiveWorkspaceDefaultRepoLocationAtom,
  workspaceCustomDefaultRepoPathAtom,
} from "@src/store/config/configAtom";
import { resolveDefaultRepoParentPath } from "@src/util/workspace/defaultRepoPath";

const log = createLogger("CloneForm");

// ============================================
// Types
// ============================================

interface UseCloneFormOptions {
  /** Callback after successful clone */
  onSuccess?: (repoId?: string) => Promise<void>;
  /** Callback to close the form */
  onClose?: () => void;
}

export interface UseCloneFormReturn {
  // Sub-tab state
  subTab: "myGitHub" | "githubUrl";
  setSubTab: (tab: "myGitHub" | "githubUrl") => void;

  // Search/filter
  filterText: string;
  setFilterText: (text: string) => void;

  // GitHub repos
  repositories: GitHubRepo[];
  groupedRepos: Array<{ organization: string; repositories: GitHubRepo[] }>;
  selectedRepo: string | null;
  setSelectedRepo: (id: string | null) => void;
  isLoadingRepos: boolean;
  fetchGitHubRepos: () => Promise<void>;

  // URL clone
  repoUrl: string;
  setRepoUrl: (url: string) => void;
  localPath: string;
  setLocalPath: (path: string) => void;

  // Actions
  handleChoosePath: () => Promise<string | null>;
  handleClone: (url: string, path: string) => Promise<string | undefined>;
  resetForm: () => void;
}

// ============================================
// Hook
// ============================================

export function useCloneForm(
  options: UseCloneFormOptions = {}
): UseCloneFormReturn {
  const { t } = useTranslation();
  const { onSuccess, onClose } = options;
  const defaultRepoLocation = useAtomValue(
    effectiveWorkspaceDefaultRepoLocationAtom
  );
  const customDefaultRepoPath = useAtomValue(
    workspaceCustomDefaultRepoPathAtom
  );

  // Sub-tab state
  const [subTab, setSubTab] = useState<"myGitHub" | "githubUrl">("myGitHub");

  // Search/filter
  const [filterText, setFilterText] = useState("");

  // Selected repo
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  // URL clone
  const [repoUrl, setRepoUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [, setLoading] = useState(false);

  // Use GitHub connections hook
  const {
    connections: githubConnections,
    isLoading: isLoadingConnections,
    getReposForConnection,
    reposCache: githubReposCache,
  } = useGitHubConnections({
    autoFetch: subTab === "myGitHub",
  });

  // Collect all GitHub repos from all connections
  const allGitHubRepos = useMemo(() => {
    const repos: GitHubRepo[] = [];
    for (const connection of githubConnections) {
      const connectionRepos = githubReposCache.get(connection.id) || [];
      repos.push(...connectionRepos);
    }
    return repos;
  }, [githubConnections, githubReposCache]);

  // Filter repos by search query
  const filteredRepos = useMemo(() => {
    if (!filterText.trim()) return allGitHubRepos;
    const query = filterText.toLowerCase();
    return allGitHubRepos.filter(
      (repo: GitHubRepo) =>
        repo.name?.toLowerCase().includes(query) ||
        repo.full_name?.toLowerCase().includes(query) ||
        repo.description?.toLowerCase().includes(query)
    );
  }, [allGitHubRepos, filterText]);

  // Group repos by organization
  const groupedRepos = useMemo(() => {
    const grouped = filteredRepos.reduce(
      (
        acc: Array<{ organization: string; repositories: GitHubRepo[] }>,
        repo: GitHubRepo
      ) => {
        const owner = repo.owner || "Unknown";

        const existing = acc.find((group) => group.organization === owner);
        if (existing) {
          existing.repositories.push(repo);
        } else {
          acc.push({ organization: owner, repositories: [repo] });
        }
        return acc;
      },
      []
    );

    // Sort by organization name
    return grouped.sort((a, b) => a.organization.localeCompare(b.organization));
  }, [filteredRepos]);

  // Loading state from GitHub connections hook
  const isLoadingRepos = isLoadingConnections;

  useEffect(() => {
    if (localPath.trim()) return;

    let cancelled = false;
    resolveDefaultRepoParentPath({
      location: defaultRepoLocation,
      customPath: customDefaultRepoPath,
    })
      .then((path) => {
        if (!cancelled && path.trim()) {
          setLocalPath(path);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [customDefaultRepoPath, defaultRepoLocation, localPath]);

  // Reset form
  const resetForm = useCallback(() => {
    setSubTab("myGitHub");
    setFilterText("");
    setSelectedRepo(null);
    setRepoUrl("");
    setLocalPath("");
    setLoading(false);
  }, []);

  // Choose folder path
  const handleChoosePath = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("toasts.chooseFolderCloneRepo"),
      });

      if (selected && typeof selected === "string") {
        return selected;
      }
      return null;
    } catch (error) {
      log.error("Failed to open folder picker:", error);
      Message.error(t("toasts.selectDirectoryFailed"));
      return null;
    }
  }, [t]);

  // Fetch repos for all connections when needed
  useEffect(() => {
    if (subTab === "myGitHub" && githubConnections.length > 0) {
      for (const connection of githubConnections) {
        if (!githubReposCache.has(connection.id)) {
          getReposForConnection(connection.id);
        }
      }
    }
  }, [subTab, githubConnections, githubReposCache, getReposForConnection]);

  // Fetch GitHub repositories (stable callback for manual refresh)
  const fetchGitHubRepos = useCallback(async () => {
    // Trigger refresh by fetching repos for all connections
    for (const connection of githubConnections) {
      await getReposForConnection(connection.id);
    }
  }, [githubConnections, getReposForConnection]);

  // Clone repository
  const handleClone = useCallback(
    async (url: string, path: string): Promise<string | undefined> => {
      if (!url.trim() || !path.trim()) return undefined;

      setLoading(true);
      try {
        const requestedPath = path.trim();
        const defaultPath = await resolveDefaultRepoParentPath({
          location: defaultRepoLocation,
          customPath: customDefaultRepoPath,
        });
        const targetDir =
          requestedPath === defaultPath
            ? await resolveDefaultRepoParentPath({
                location: defaultRepoLocation,
                customPath: customDefaultRepoPath,
                ensureDirectory: true,
              })
            : requestedPath;

        const result = await zodActionRegistry.execute("repo.clone", {
          url: url.trim(),
          targetDir,
        });

        if (result.success) {
          const repoId = (result.data as { repo_id?: string } | undefined)
            ?.repo_id;
          Message.success(t("toasts.repositoryCloned"));
          resetForm();
          onClose?.();
          await onSuccess?.(repoId);
          return repoId;
        }

        Message.error(result.message || t("toasts.repositoryCloneFailed"));
        return undefined;
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t("toasts.repositoryCloneFailed")
        );
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [
      customDefaultRepoPath,
      defaultRepoLocation,
      resetForm,
      onClose,
      onSuccess,
      t,
    ]
  );

  return {
    // Sub-tab
    subTab,
    setSubTab,

    // Search/filter
    filterText,
    setFilterText,

    // GitHub repos
    repositories: filteredRepos,
    groupedRepos,
    selectedRepo,
    setSelectedRepo,
    isLoadingRepos,
    fetchGitHubRepos,

    // URL clone
    repoUrl,
    setRepoUrl,
    localPath,
    setLocalPath,

    // Actions
    handleChoosePath,
    handleClone,
    resetForm,
  };
}

export default useCloneForm;
