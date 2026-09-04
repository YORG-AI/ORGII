import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { convertToFileOperation } from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/fileConverter";
import { getFileName } from "@src/util/file/pathUtils";

import type { RemoteSessionWorkspaceFile } from "./remoteSessionWorkspace";

function normalizeWorkspacePath(filePath: string, repoPath?: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedRepoPath = repoPath?.replace(/\\/g, "/").replace(/\/$/, "");

  if (
    normalizedRepoPath &&
    (normalizedFilePath === normalizedRepoPath ||
      normalizedFilePath.startsWith(`${normalizedRepoPath}/`))
  ) {
    const relativePath = normalizedFilePath.slice(normalizedRepoPath.length);
    return relativePath.replace(/^\/+/, "") || getFileName(normalizedFilePath);
  }

  return normalizedFilePath.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Maps a replay cursor event to the workspace-relative path it touches. */
export function resolveRemoteWorkspacePathForEvent(
  event: SessionEvent | null | undefined
): string | null {
  if (!event) return null;
  const operation = convertToFileOperation(event, false);
  if (!operation?.filePath) return null;
  const path = normalizeWorkspacePath(operation.filePath, event.repoPath);
  return path || null;
}

/**
 * Picks the file row My Station should show during replay scrubbing.
 * File events at the replay cursor win; otherwise keep manual selection.
 */
export function resolveRemoteWorkspaceSelectionPath(
  events: readonly SessionEvent[],
  files: readonly RemoteSessionWorkspaceFile[],
  currentEventId: string | null | undefined,
  manualSelectedPath: string | null
): string | null {
  if (files.length === 0) return null;

  const filePaths = new Set(files.map((file) => file.path));
  if (currentEventId) {
    const currentEvent = events.find((event) => event.id === currentEventId);
    const pathFromEvent = resolveRemoteWorkspacePathForEvent(currentEvent);
    if (pathFromEvent && filePaths.has(pathFromEvent)) {
      return pathFromEvent;
    }
  }

  if (manualSelectedPath && filePaths.has(manualSelectedPath)) {
    return manualSelectedPath;
  }

  return files[0]?.path ?? null;
}
