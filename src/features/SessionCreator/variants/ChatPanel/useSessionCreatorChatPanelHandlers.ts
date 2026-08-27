/**
 * SessionCreatorChatPanel — Handler Hook
 *
 * Extracts the screen-sharing flow, repo/branch selection handlers, and
 * agent category selection logic from SessionCreatorChatPanel into a
 * dedicated hook to keep the component file under the 600-line limit.
 */
import { useSetAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type WingmanMonitor,
  showDesktopOperationVisibilityTest,
  wingmanListMonitors,
} from "@src/api/tauri/agent";
import { KEY_SOURCE } from "@src/api/tauri/session";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";
import {
  createSystemPathSessionSource,
  getSystemPathIdFromRepoItem,
  getSystemPathSourcePath,
  isSystemPathSourceId,
} from "@src/features/SessionCreator/utils/systemPathSource";
import {
  isSourceCompatibleWithAgent,
  useAgentCompatibility,
} from "@src/hooks/models/useAgentCompatibility";
import { useWorkspaceForm } from "@src/scaffold/GlobalSpotlight/hooks/forms";
import type { AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import type { RepoItem } from "@src/scaffold/GlobalSpotlight/types";
import { REPO_KIND, type RepoKind } from "@src/store/repo/types";
import { sessionCreatorStateAtom, sessionSourceAtom } from "@src/store/session";

import { resolveRepoChangePath } from "./resolveRepoChangePath";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UseSessionCreatorHandlersOptions {
  reposList: Array<{
    id: string;
    name: string;
    path?: string;
    fs_uri?: string;
    kind?: string;
  }>;
  effectiveSource: {
    branch?: string;
    repoId?: string;
    repoName?: string;
    repoPath?: string;
  } | null;
  advancedConfig: AdvancedConfig;
  setAdvancedConfig: (config: AdvancedConfig) => void;
  selectRepo: (repoId: string) => void;
  forceRefreshRepos: () => Promise<void>;
  /** Clears repo-scoped launch selections before committing a repo switch. */
  onRepoScopeChange?: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useSessionCreatorChatPanelHandlers({
  reposList,
  effectiveSource,
  advancedConfig,
  setAdvancedConfig,
  selectRepo,
  forceRefreshRepos,
  onRepoScopeChange,
}: UseSessionCreatorHandlersOptions) {
  const { t } = useTranslation();
  const { registry } = useAgentCompatibility();
  const setCreatorState = useSetAtom(sessionCreatorStateAtom);
  const setSessionSource = useSetAtom(sessionSourceAtom);
  const { handleImportWorkspace } = useWorkspaceForm({
    onSuccess: async (workspaceId?: string) => {
      await forceRefreshRepos();
      if (workspaceId) selectRepo(workspaceId);
    },
  });

  // ── Screen sharing ────────────────────────────────────────────────────────

  const [screenPickerMonitors, setScreenPickerMonitors] = useState<
    WingmanMonitor[] | null
  >(null);

  const handleShareScreenClick = useCallback(async () => {
    try {
      const monitors = await wingmanListMonitors();
      if (monitors.length <= 1) {
        await showDesktopOperationVisibilityTest(monitors[0]?.index);
        return;
      }
      setScreenPickerMonitors(monitors);
    } catch {
      showDesktopOperationVisibilityTest().catch(() => {});
    }
  }, []);

  const handleScreenPicked = useCallback((monitorIndex: number) => {
    setScreenPickerMonitors(null);
    showDesktopOperationVisibilityTest(monitorIndex).catch(() => {});
  }, []);

  // ── Repo / branch selection ───────────────────────────────────────────────

  // Updates the global repo selection and keeps the session draft aligned.
  // The checked-out branch is loaded asynchronously by useRepoSelection and
  // mirrored into the session source once it belongs to the selected repo.
  const handleRepoChange = useCallback(
    (repoId: string, options?: { repoKind?: RepoKind }) => {
      onRepoScopeChange?.();
      selectRepo(repoId);
      const repo = reposList.find((repoItem) => repoItem.id === repoId);
      const isFolder =
        options?.repoKind === REPO_KIND.FOLDER ||
        repo?.kind === REPO_KIND.FOLDER;
      // `reposList` can lag right after "Open Folder" imports a new repo, so the
      // find() above may miss. Never write an empty repoPath in that window —
      // it would clobber the valid path that `onRepoSelect`
      // (handleRepoSelectForSession) just set and strand the creator on
      // "Workspace is still loading".
      const resolvedRepoPath = resolveRepoChangePath({
        repoId,
        matchedRepo: repo,
        currentSourceRepoId: effectiveSource?.repoId,
        currentSourceRepoPath: effectiveSource?.repoPath,
      });
      setSessionSource({
        type: "local",
        repoId,
        repoName: repo?.name,
        repoPath: resolvedRepoPath,
        branch:
          isFolder || effectiveSource?.repoId !== repoId
            ? undefined
            : effectiveSource?.branch,
      });
    },
    [
      selectRepo,
      reposList,
      effectiveSource?.repoId,
      effectiveSource?.repoPath,
      effectiveSource?.branch,
      setSessionSource,
      onRepoScopeChange,
    ]
  );

  // Updates session source for the new repo; branch is intentionally left empty
  // until the repo-selection store reports that repo's checked-out branch.
  const handleRepoSelectForSession = useCallback(
    (selectedRepoId: string, repo: RepoItem) => {
      onRepoScopeChange?.();
      if (isSystemPathSourceId(repo.id)) {
        const repoPath = getSystemPathSourcePath(repo);
        setSessionSource(
          createSystemPathSessionSource({
            systemPathId: getSystemPathIdFromRepoItem(repo),
            t,
            repoId: selectedRepoId,
            repoName: repo.name,
            repoPath,
          })
        );
        if (repoPath) {
          void handleImportWorkspace(repoPath, {
            promptForGitInit: false,
          }).then((workspaceId) => {
            if (!workspaceId) return;
            // Align the repo-selection store with the imported workspace.
            // Without this, selectedRepoId keeps pointing at the previous
            // repo, useChatPanelBranchSync bails on the repoId mismatch, and
            // the branch pill stays icon-only until an unrelated refresh.
            selectRepo(workspaceId);
            setSessionSource({
              type: "local",
              repoId: workspaceId,
              repoName: repo.name,
              repoPath,
              branch: undefined,
            });
          });
        }
        return;
      }

      setSessionSource({
        type: "local",
        repoId: selectedRepoId,
        repoName: repo.name,
        repoPath: repo.fs_uri,
        branch: undefined,
      });
    },
    [handleImportWorkspace, onRepoScopeChange, selectRepo, setSessionSource, t]
  );

  // ── Agent category selection ──────────────────────────────────────────────

  const [requestModelOpen, setRequestModelOpen] = useState(false);

  const handleCategorySelect = useCallback(
    (selection: AgentSelection) => {
      setCreatorState((prev) => ({
        ...prev,
        dispatchCategory: selection.category,
        targetKind: selection.targetKind,
        selectedAgentDefinitionId: selection.agentDefinitionId ?? null,
        selectedAgentOrgId: selection.agentOrgId ?? null,
        agentName: selection.agentName,
        agentIconId: selection.agentIconId ?? null,
        cliAgentType: selection.cliAgentType ?? null,
      }));

      if (selection.category === "human_session") return;

      const newCliType = selection.cliAgentType;
      const hasModel = Boolean(
        advancedConfig.model || advancedConfig.listingModel
      );
      const hasSource = Boolean(advancedConfig.selectedSourceModelType);
      const isHosted = advancedConfig.keySource === KEY_SOURCE.HOSTED;

      const isSourceCompatible =
        !hasSource ||
        isHosted ||
        !newCliType ||
        isSourceCompatibleWithAgent(
          registry,
          selection.category,
          newCliType,
          advancedConfig.selectedSourceModelType!
        );

      if (!isSourceCompatible) {
        setAdvancedConfig({
          ...advancedConfig,
          keySource: advancedConfig.keySource,
          cliAgentType: newCliType,
        });
        setRequestModelOpen(true);
      } else if (!hasModel || !hasSource) {
        if (newCliType) {
          setAdvancedConfig({ ...advancedConfig, cliAgentType: newCliType });
        }
        setRequestModelOpen(true);
      } else {
        if (newCliType) {
          setAdvancedConfig({ ...advancedConfig, cliAgentType: newCliType });
        }
      }
    },
    [setCreatorState, setAdvancedConfig, advancedConfig, registry]
  );

  return {
    // Screen sharing
    screenPickerMonitors,
    setScreenPickerMonitors,
    handleShareScreenClick,
    handleScreenPicked,
    // Repo
    handleRepoChange,
    handleRepoSelectForSession,

    // Category / model
    requestModelOpen,
    setRequestModelOpen,
    handleCategorySelect,
  };
}
