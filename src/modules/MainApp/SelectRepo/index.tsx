/**
 * SelectRepoPage
 *
 * Page for repo selection using OnboardingLayout.
 * Users select a repository before proceeding to the main app.
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  Code,
  Folder,
  FolderTree,
  Search,
  Settings,
  SquareArrowRight,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import type { WorkspaceRecord } from "@src/api/tauri/workspace";
import Input from "@src/components/Input";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import {
  ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS,
  OnboardingLayout,
  OnboardingLoadingVideo,
} from "@src/modules/shared/layouts";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { AddWorkspaceModalStage } from "@src/scaffold/GlobalSpotlight/hooks";
import { WorkspacePalette } from "@src/scaffold/GlobalSpotlight/palettes";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";
import {
  REPO_KIND,
  cachedReposAtom,
  getWindowIdsForRepo,
  unregisterWindow,
} from "@src/store/repo";
import {
  activeWorkspaceNameAtom,
  savedWorkspacesAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import type { WorkspaceFolder } from "@src/types/workspace";

const SELECT_REPO_BODY_CLASS = "select-repo-mode";

const log = createLogger("SelectRepoPage");

interface SelectRepoListItem {
  id: string;
  name: string;
  fs_uri?: string;
  kind?: string;
}

function normalizeSearchText(value: string | undefined): string {
  return value?.toLowerCase() ?? "";
}

function repoMatchesQuery(repo: SelectRepoListItem, query: string): boolean {
  return [repo.name, repo.fs_uri, repo.kind].some((value) =>
    normalizeSearchText(value).includes(query)
  );
}

function workspaceMatchesQuery(
  workspace: WorkspaceRecord,
  query: string
): boolean {
  return [
    workspace.name,
    ...workspace.folders.flatMap((folder) => [
      folder.folderName,
      folder.folderPath,
      folder.kind,
    ]),
  ].some((value) => normalizeSearchText(value).includes(query));
}

// ============================================
// Left column — vertical action list (same spotlight entry points as WorkspacePalette)
// ============================================
interface SelectWorkspacePaletteLaunch {
  initialAddStage?: AddWorkspaceModalStage;
  initialAddMenu?: boolean;
  initialManageMode?: boolean;
}

interface SelectRepoActionsListProps {
  onOpenPalette: (launch: SelectWorkspacePaletteLaunch) => void;
}

const SelectRepoActionsList: React.FC<SelectRepoActionsListProps> = ({
  onOpenPalette,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={`flex w-full flex-col overflow-hidden rounded-lg bg-bg-2 ${ONBOARDING_LOADING_VIDEO_MAX_WIDTH_CLASS}`}
    >
      <div
        className="cursor-pointer px-4 py-3.5 transition-colors duration-150 hover:bg-fill-2"
        onClick={() => onOpenPalette({ initialAddMenu: true })}
      >
        <div className="flex w-full items-center gap-3">
          <SquareArrowRight
            size={16}
            strokeWidth={1.5}
            className="h-4 w-4 flex-shrink-0 text-text-2"
          />
          <span className="flex-1 text-left text-sm font-normal text-text-1">
            {t("selectors.repo.addEntry")}
          </span>
        </div>
      </div>

      <div
        className="cursor-pointer px-4 py-3.5 transition-colors duration-150 hover:bg-fill-2"
        onClick={() => onOpenPalette({ initialAddStage: "create-workspace" })}
      >
        <div className="flex w-full items-center gap-3">
          <FolderTree
            size={16}
            strokeWidth={1.5}
            className="h-4 w-4 flex-shrink-0 text-text-2"
          />
          <span className="flex-1 text-left text-sm font-normal text-text-1">
            {t("workspaceForm.createWorkspace")}
          </span>
        </div>
      </div>

      <div
        className="cursor-pointer px-4 py-3.5 transition-colors duration-150 hover:bg-fill-2"
        onClick={() => onOpenPalette({ initialManageMode: true })}
      >
        <div className="flex w-full items-center gap-3">
          <Settings
            size={16}
            strokeWidth={1.5}
            className="h-4 w-4 flex-shrink-0 text-text-2"
          />
          <span className="flex-1 text-left text-sm font-normal text-text-1">
            {t("actions.manage")}
          </span>
        </div>
      </div>
    </div>
  );
};

// ============================================
// Left Column Content
// ============================================
interface LeftColumnContentProps {
  onOpenPalette: (launch: SelectWorkspacePaletteLaunch) => void;
}

const LeftColumnContent: React.FC<LeftColumnContentProps> = ({
  onOpenPalette,
}) => (
  <>
    <OnboardingLoadingVideo />
    <SelectRepoActionsList onOpenPalette={onOpenPalette} />
  </>
);

// ============================================
// Right Column Content (Repo List)
// ============================================
interface RepoListContentProps {
  repos: SelectRepoListItem[];
  recentRepos: SelectRepoListItem[];
  workspaces: WorkspaceRecord[];
  repoLoading: boolean;
  onRepoClick: (repoId: string) => void;
  onWorkspaceClick: (ws: WorkspaceRecord) => void;
  onLoadMore: () => void;
}

const RepoListContent: React.FC<RepoListContentProps> = ({
  repos,
  recentRepos,
  workspaces,
  repoLoading,
  onRepoClick,
  onWorkspaceClick,
  onLoadMore,
}) => {
  const { t } = useTranslation(["market", "common"]);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredWorkspaces = normalizedQuery
    ? workspaces.filter((workspace) =>
        workspaceMatchesQuery(workspace, normalizedQuery)
      )
    : workspaces;
  const filteredRecentRepos = normalizedQuery
    ? recentRepos.filter((repo) => repoMatchesQuery(repo, normalizedQuery))
    : recentRepos;
  const isEmpty = repos.length === 0 && workspaces.length === 0;
  const isFilteredEmpty =
    filteredRecentRepos.length === 0 && filteredWorkspaces.length === 0;

  return (
    <>
      <div className="flex flex-shrink-0 px-3 pb-1 pt-3">
        <Input
          type="search"
          value={searchQuery}
          onChange={setSearchQuery}
          allowClear
          placeholder={t(
            "market:selectRepo.searchPlaceholder",
            "Search repos..."
          )}
          className="h-[34px] rounded-lg bg-fill-1 text-[14px]"
          prefix={<Search size={16} className="text-text-2" />}
        />
      </div>

      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3 pt-1">
        {repoLoading ? (
          <Placeholder
            variant="loading"
            subtitle={t("selectRepo.loadingProjects")}
          />
        ) : isEmpty ? (
          <Placeholder
            variant="empty"
            title={t("market:selectRepo.noRepositories")}
            subtitle={t("market:selectRepo.getStartedHint")}
          />
        ) : isFilteredEmpty ? (
          <Placeholder
            variant="no-results"
            title={t("common:common.noResults")}
            placement="sidebar"
          />
        ) : (
          <div className="flex flex-col gap-1">
            {filteredWorkspaces.map((ws) => {
              const names = ws.folders.map((f) => f.folderName);
              return (
                <div
                  key={`ws-${ws.workspaceId}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-fill-2"
                  onClick={() => onWorkspaceClick(ws)}
                >
                  <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-violet-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)]">
                    <FolderTree size={20} className="text-white" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-text-1">
                      {ws.name}
                    </div>
                    <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-3">
                      {ws.folders.length} repos: {names.join(", ")}
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredRecentRepos.map((repo) => (
              <div
                key={repo.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-fill-2"
                onClick={() => onRepoClick(repo.id)}
              >
                <div
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg shadow-[0_1px_3px_rgba(0,0,0,0.1)] ${
                    repo.kind === REPO_KIND.FOLDER
                      ? "bg-gradient-to-br from-amber-500 to-amber-600"
                      : "bg-gradient-to-br from-primary-5 to-primary-6"
                  }`}
                >
                  {repo.kind === REPO_KIND.FOLDER ? (
                    <Folder size={20} className="text-white" />
                  ) : (
                    <Code size={20} className="text-white" />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-text-1">
                    {repo.name}
                  </div>
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-3">
                    {repo.fs_uri
                      ?.replace("file://", "")
                      ?.replace(/^\/Users\/[^/]+/, "~") ||
                      t("selectRepo.noPath")}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {repos.length > 7 && (
        <div className="px-4 py-2">
          <button
            className="w-full cursor-pointer rounded-md border-none bg-transparent px-3 py-2 text-xs font-medium text-text-2 transition-all duration-150 hover:bg-fill-2 hover:text-text-1"
            onClick={onLoadMore}
          >
            {t("selectRepo.loadMore")}
          </button>
        </div>
      )}
    </>
  );
};

// ============================================
// Main SelectRepoPage Component
// ============================================
const SelectRepoPage: React.FC = () => {
  const navigate = useNavigate();

  // Local state for RepoSelector
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const [paletteLaunch, setPaletteLaunch] =
    useState<SelectWorkspacePaletteLaunch | null>(null);

  // Listen for toolbar click to open selector
  useEffect(() => {
    const handleToolbarClick = () => {
      setPaletteLaunch(null);
      setIsSelectorOpen(true);
    };
    window.addEventListener("open-select-repo-selector", handleToolbarClick);
    return () => {
      window.removeEventListener(
        "open-select-repo-selector",
        handleToolbarClick
      );
    };
  }, []);

  // Get list of repositories
  const { repos, repoLoading, selectedRepoId, selectRepo } = useRepoSelection({
    autoLoad: true,
  });

  // Saved workspaces from DB
  const savedWorkspaces = useAtomValue(savedWorkspacesAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);
  const setActiveWorkspaceName = useSetAtom(activeWorkspaceNameAtom);

  // Get cached repos for recency ordering
  const cachedRepos = useAtomValue(cachedReposAtom);

  useEffect(() => {
    if (selectedRepoId && !repoLoading) {
      navigate("/orgii/app/start-page", { replace: true });
    }
  }, [navigate, repoLoading, selectedRepoId]);

  // Create recent repos list: cached repos first (in order), then remaining repos
  const recentRepos = React.useMemo(() => {
    const cachedIds = cachedRepos.map((cr) => cr.id);
    // Start with cached repos that still exist in repos list
    const fromCached = cachedIds
      .map((id) => repos.find((repo) => repo.id === id))
      .filter(Boolean) as typeof repos;
    // Add remaining repos not in cached list
    const remaining = repos.filter((repo) => !cachedIds.includes(repo.id));
    return [...fromCached, ...remaining].slice(0, 7);
  }, [repos, cachedRepos]);

  // Handle workspace click — activate workspace and navigate
  const handleWorkspaceClick = useCallback(
    (ws: WorkspaceRecord) => {
      const folders: WorkspaceFolder[] = ws.folders.map((f) => ({
        id: crypto.randomUUID(),
        name: f.folderName,
        path: f.folderPath,
        uri: `file://${f.folderPath}`,
        isPrimary: f.isPrimary,
        repoId: f.repoId ?? undefined,
        kind: f.kind === "folder" ? ("folder" as const) : ("git" as const),
      }));
      dispatchSetFolders(folders, ws.workspaceId);
      setActiveWorkspaceName(ws.name);
      navigate("/orgii/app/start-page");
    },
    [dispatchSetFolders, setActiveWorkspaceName, navigate]
  );

  const handleRepoClick = useCallback(
    async (repoId: string) => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        const currentLabel = currentWindow.label;

        // `getWindowIdsForRepo` already filters specialty windows
        // (wingman, etc.) at the registry layer.
        const candidateWindowIds = getWindowIdsForRepo(repoId).filter(
          (id) => id !== currentLabel
        );

        if (candidateWindowIds.length > 0) {
          const { WebviewWindow } =
            await import("@tauri-apps/api/webviewWindow");

          for (const existingWindowId of candidateWindowIds) {
            const existingWindow =
              await WebviewWindow.getByLabel(existingWindowId);

            if (!existingWindow) {
              unregisterWindow(existingWindowId);
              continue;
            }

            // Tauri returns a handle for hidden / minimised windows too —
            // only treat the window as a real focus target when it is
            // actually visible to the user.
            const isVisible = await existingWindow
              .isVisible()
              .catch(() => false);
            if (!isVisible) {
              unregisterWindow(existingWindowId);
              continue;
            }

            await existingWindow.setFocus();
            if (currentLabel !== "main") {
              await currentWindow.close();
            }
            return;
          }
        }

        selectRepo(repoId);
        navigate("/orgii/app/start-page");
      } catch (error) {
        log.error("[SelectRepoPage] Failed to open repo", repoId, error);
      }
    },
    [selectRepo, navigate]
  );

  const handleOpenWorkspacePalette = useCallback(
    (launch: SelectWorkspacePaletteLaunch) => {
      setPaletteLaunch(launch);
      setIsSelectorOpen(true);
    },
    []
  );

  // Handle "Load more" - opens selector with switch tab
  const handleLoadMore = useCallback(() => {
    setPaletteLaunch(null);
    setIsSelectorOpen(true);
  }, []);

  // Handle repo selection from RepoSelector
  const handleRepoSelect = useCallback(
    (repoId: string, _repo: RepoItem) => {
      selectRepo(repoId);
      setIsSelectorOpen(false);
      navigate("/orgii/app/start-page");
    },
    [selectRepo, navigate]
  );

  return (
    <>
      {/* Global styles to hide toolbar elements when in select-repo mode */}
      <style nonce={CODEMIRROR_STYLE_NONCE}>{`
        body.select-repo-mode .tab-bar {
          display: none !important;
        }
        body.select-repo-mode [data-toolbar-section="view-mode-switch"] {
          display: none !important;
        }
        body.select-repo-mode [data-toolbar-section="right-actions"] {
          display: none !important;
        }
        body.select-repo-mode [data-toolbar-section="sidebar-toggle"] {
          display: none !important;
        }
      `}</style>

      <OnboardingLayout
        variant="contained"
        bodyClass={SELECT_REPO_BODY_CLASS}
        leftContent={
          <LeftColumnContent onOpenPalette={handleOpenWorkspacePalette} />
        }
        rightContent={
          <RepoListContent
            repos={repos}
            recentRepos={recentRepos}
            workspaces={savedWorkspaces}
            repoLoading={repoLoading}
            onRepoClick={handleRepoClick}
            onWorkspaceClick={handleWorkspaceClick}
            onLoadMore={handleLoadMore}
          />
        }
      />

      {/* WorkspacePalette - rendered directly for add actions */}
      <WorkspacePalette
        isOpen={isSelectorOpen}
        onClose={() => {
          setIsSelectorOpen(false);
          setPaletteLaunch(null);
        }}
        onSelect={handleRepoSelect}
        currentRepoId={undefined}
        initialAddStage={paletteLaunch?.initialAddStage}
        initialAddMenu={paletteLaunch?.initialAddMenu ?? false}
        initialManageMode={paletteLaunch?.initialManageMode ?? false}
      />
    </>
  );
};

export default SelectRepoPage;
