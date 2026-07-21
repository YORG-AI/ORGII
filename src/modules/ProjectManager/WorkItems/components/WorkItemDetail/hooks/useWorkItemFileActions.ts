import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  presentedWorkstationWorkspaceKeyAtom,
  queueFileOpens,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { openFileInEditor } from "@src/util/ui/openFileInEditor";

export function useWorkItemFileActions(repoPath?: string | null) {
  const navigate = useNavigate();

  const resolvePath = useCallback(
    (filePath: string) => {
      if (filePath.startsWith("/")) return filePath;
      if (!repoPath) return filePath;
      return `${repoPath}/${filePath.replace(/^\.\//, "")}`;
    },
    [repoPath]
  );

  const openInEditor = useCallback(
    (files: Array<{ path: string; line?: number }>) => {
      const resolved = files.map((file) => ({
        path: resolvePath(file.path),
        line: file.line,
      }));

      const workspace = getInstrumentedStore().get(
        presentedWorkstationWorkspaceKeyAtom
      );
      queueFileOpens(workspace, resolved);

      for (const { path, line } of resolved) {
        openFileInEditor(path, { line });
      }

      navigate(ROUTES.workStation.code.path);
    },
    [resolvePath, navigate]
  );

  const handleOpenFileDiff = useCallback(
    (filePath: string) => openInEditor([{ path: filePath }]),
    [openInEditor]
  );

  const handleOpenFileAtLine = useCallback(
    (filePath: string, line?: number) =>
      openInEditor([{ path: filePath, line }]),
    [openInEditor]
  );

  const handleReviewAllFiles = useCallback(
    (filePaths: string[]) =>
      openInEditor(filePaths.map((filePath) => ({ path: filePath }))),
    [openInEditor]
  );

  return {
    handleOpenFileDiff,
    handleOpenFileAtLine,
    handleReviewAllFiles,
  };
}
