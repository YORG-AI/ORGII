/**
 * Workspace Folder Adapter
 *
 * Converts WorkspaceFolder domain objects into SpotlightItem format
 * for multi-root workspace display in the WorkspacePalette.
 */
import type { GitRepositoryStatus } from "@src/types/session/steps";
import type { WorkspaceFolder } from "@src/types/workspace";

import { ICONS } from "../../config";
import type { SpotlightItem } from "../../types";

export interface BuildWorkspaceFolderItemOptions {
  activeFolderId?: string | null;
  gitStatusMap: Map<string, GitRepositoryStatus>;
  onAction: (folder: WorkspaceFolder) => void;
}

export function buildWorkspaceFolderItems(
  folders: WorkspaceFolder[],
  options: BuildWorkspaceFolderItemOptions
): SpotlightItem[] {
  const { activeFolderId, gitStatusMap, onAction } = options;

  return folders.map((folder) => {
    const status = gitStatusMap.get(folder.path);
    const files = status?.working_directory?.files ?? [];
    const changedCount =
      files.filter((f) => f.staged).length +
      files.filter((f) => !f.staged && f.status !== "?").length +
      files.filter((f) => f.status === "?").length;

    return {
      id: `ws-folder-${folder.id}`,
      label: folder.name,
      desc: folder.path,
      icon: folder.kind === "folder" ? ICONS.folder : ICONS.repo,
      type: "repo" as const,
      data: {
        isSelector: true,
        isCurrentSelection: folder.id === activeFolderId,
        contextMenuCopy: { name: folder.name, path: folder.path },
        tagLabel: folder.isPrimary ? "Primary" : undefined,
        gitStatus:
          changedCount > 0
            ? { uncommittedFiles: changedCount, ahead: 0, behind: 0 }
            : undefined,
      },
      action: () => onAction(folder),
    };
  });
}
