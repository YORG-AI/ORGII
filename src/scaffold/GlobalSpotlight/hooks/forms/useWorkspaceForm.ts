/**
 * useWorkspaceForm Hook
 *
 * Manages local workspace creation and import form state and actions.
 * Uses .git presence to decide whether a directory is a Git workspace.
 */
import { open } from "@tauri-apps/plugin-dialog";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { zodActionRegistry } from "@src/ActionSystem/schema/zodRegistry";
import { repoApi } from "@src/api/tauri/repo";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import {
  effectiveWorkspaceDefaultRepoLocationAtom,
  workspaceCustomDefaultRepoPathAtom,
} from "@src/store/config/configAtom";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";
import { resolveDefaultRepoParentPath } from "@src/util/workspace/defaultRepoPath";

const logger = createLogger("WorkspaceForm");
const SYSTEM_WORKSPACE_FOLDER_NAMES = new Set([
  "desktop",
  "documents",
  "downloads",
]);

function getNormalizedPathSegments(path: string): string[] {
  return path
    .replace(/^file:\/\//, "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function isSystemWorkspaceRoot(path: string): boolean {
  const segments = getNormalizedPathSegments(path);
  const lastSegment = segments.at(-1)?.toLowerCase();
  return Boolean(lastSegment && SYSTEM_WORKSPACE_FOLDER_NAMES.has(lastSegment));
}

interface UseWorkspaceFormOptions {
  onSuccess?: (workspaceId?: string) => Promise<void>;
  onClose?: () => void;
}

export interface UseWorkspaceFormReturn {
  workspaceName: string;
  setWorkspaceName: (name: string) => void;
  workspacePath: string;
  setWorkspacePath: (path: string) => void;
  loading: boolean;
  handleChoosePath: (mode: "new" | "existing") => Promise<string | null>;
  handleCreateWorkspace: (
    name: string,
    path: string
  ) => Promise<string | undefined>;
  handleImportWorkspace: (
    path: string,
    options?: { promptForGitInit?: boolean }
  ) => Promise<string | undefined>;
  handleOpenLocalWorkspace: (
    initialPath?: string
  ) => Promise<string | undefined>;
  resetForm: () => void;
}

export function useWorkspaceForm(
  options: UseWorkspaceFormOptions = {}
): UseWorkspaceFormReturn {
  const { t } = useTranslation();
  const { onSuccess, onClose } = options;
  const defaultRepoLocation = useAtomValue(
    effectiveWorkspaceDefaultRepoLocationAtom
  );
  const customDefaultRepoPath = useAtomValue(
    workspaceCustomDefaultRepoPathAtom
  );

  const [workspaceName, setWorkspaceName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [loading, setLoading] = useState(false);

  const resetForm = useCallback(() => {
    setWorkspaceName("");
    setWorkspacePath("");
    setLoading(false);
  }, []);

  useEffect(() => {
    if (workspacePath.trim()) return;

    let cancelled = false;
    resolveDefaultRepoParentPath({
      location: defaultRepoLocation,
      customPath: customDefaultRepoPath,
    })
      .then((path) => {
        if (!cancelled && path.trim()) {
          setWorkspacePath(path);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [customDefaultRepoPath, defaultRepoLocation, workspacePath]);

  const handleChoosePath = useCallback(
    async (mode: "new" | "existing"): Promise<string | null> => {
      try {
        const selected = await open({
          directory: true,
          multiple: false,
          title:
            mode === "new"
              ? t("toasts.chooseFolderNewWorkspace")
              : t("toasts.chooseExistingWorkspace"),
        });

        return selected && typeof selected === "string" ? selected : null;
      } catch (error) {
        logger.error("Failed to open folder picker:", error);
        Message.error(t("toasts.selectDirectoryFailed"));
        return null;
      }
    },
    [t]
  );

  const shouldInitializeGit = useCallback(
    async (path: string): Promise<boolean> => {
      if (isSystemWorkspaceRoot(path)) return false;

      return askNativeDialogSafely(t("selectors.repo.gitInitPrompt.message"), {
        title: t("selectors.repo.gitInitPrompt.title"),
        kind: "info",
        okLabel: t("selectors.repo.gitInitPrompt.ok"),
        cancelLabel: t("selectors.repo.gitInitPrompt.cancel"),
      });
    },
    [t]
  );

  const handleCreateWorkspace = useCallback(
    async (name: string, path: string): Promise<string | undefined> => {
      if (!name.trim() || !path.trim()) return undefined;

      setLoading(true);
      try {
        const requestedPath = path.trim();
        const defaultPath = await resolveDefaultRepoParentPath({
          location: defaultRepoLocation,
          customPath: customDefaultRepoPath,
        });
        const trimmedPath =
          requestedPath === defaultPath
            ? await resolveDefaultRepoParentPath({
                location: defaultRepoLocation,
                customPath: customDefaultRepoPath,
                ensureDirectory: true,
              })
            : requestedPath;
        const trimmedName = name.trim();
        const pathSeparator = trimmedPath.includes("\\") ? "\\" : "/";
        const fullPath = trimmedPath.endsWith(pathSeparator)
          ? `${trimmedPath}${trimmedName}`
          : `${trimmedPath}${pathSeparator}${trimmedName}`;

        const initializeGit = await shouldInitializeGit(fullPath);
        const result = await zodActionRegistry.execute("repo.create", {
          path: fullPath,
          name: trimmedName,
          git: initializeGit,
        });

        if (result.success) {
          const workspaceId = (result.data as { repo_id?: string } | undefined)
            ?.repo_id;
          Message.success(t("toasts.workspaceCreated"));
          resetForm();
          onClose?.();
          await onSuccess?.(workspaceId);
          return workspaceId;
        }

        Message.error(result.message || t("toasts.workspaceCreateFailed"));
        return undefined;
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t("toasts.workspaceCreateFailed")
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
      shouldInitializeGit,
      t,
    ]
  );

  const handleImportWorkspace = useCallback(
    async (
      path: string,
      options: { promptForGitInit?: boolean } = {}
    ): Promise<string | undefined> => {
      if (!path.trim()) return undefined;

      setLoading(true);
      try {
        const fsPath = path.trim();
        const isGitWorkspace = await repoApi.checkIsGitRepo(fsPath);
        const promptForGitInit = options.promptForGitInit ?? true;
        const initializeGit = isGitWorkspace
          ? true
          : promptForGitInit && (await shouldInitializeGit(fsPath));
        const result = initializeGit
          ? await repoApi.importLocalRepo({ fs_path: fsPath })
          : await repoApi.importWorkFolder({ fs_path: fsPath });
        const workspaceId = result.data.repo_id;
        Message.success(t("toasts.workspaceImported"));
        resetForm();
        onClose?.();
        await onSuccess?.(workspaceId);
        return workspaceId;
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t("toasts.workspaceImportFailed")
        );
        return undefined;
      } finally {
        setLoading(false);
      }
    },
    [resetForm, onClose, onSuccess, shouldInitializeGit, t]
  );

  const handleOpenLocalWorkspace = useCallback(
    async (initialPath?: string): Promise<string | undefined> => {
      const selectedPath = initialPath ?? (await handleChoosePath("existing"));
      if (!selectedPath) return undefined;
      return handleImportWorkspace(selectedPath);
    },
    [handleChoosePath, handleImportWorkspace]
  );

  return {
    workspaceName,
    setWorkspaceName,
    workspacePath,
    setWorkspacePath,
    loading,
    handleChoosePath,
    handleCreateWorkspace,
    handleImportWorkspace,
    handleOpenLocalWorkspace,
    resetForm,
  };
}

export default useWorkspaceForm;
