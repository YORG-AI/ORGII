import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { convertToFileOperation } from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/fileConverter";
import { resolveFileOperationPayload } from "@src/modules/WorkStation/CodeEditor/SessionReplay/resolveFilePayload";
import {
  FILE_OPERATION_TYPE,
  type FileOperationEntry,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/types";
import { buildSessionReplayDiffSectionItems } from "@src/modules/WorkStation/shared";
import { getFileName } from "@src/util/file/pathUtils";

export type RemoteSessionWorkspaceFileMode =
  | "content"
  | "diff"
  | "deleted"
  | "unavailable";

export type RemoteSessionWorkspaceFileStatus =
  | "read"
  | "modified"
  | "added"
  | "deleted"
  | "unavailable";

export interface RemoteSessionWorkspaceFile {
  id: string;
  path: string;
  sourcePath: string;
  fileName: string;
  eventId: string;
  createdAt: string;
  language?: string;
  mode: RemoteSessionWorkspaceFileMode;
  status: RemoteSessionWorkspaceFileStatus;
  content?: string;
  contentStartLine?: number;
  oldContent?: string;
  newContent?: string;
  oldStartLine?: number;
  newStartLine?: number;
  /** Event payloads can be ranged reads or compact diffs, not full files. */
  partial: boolean;
}

function eventTime(event: SessionEvent): number {
  const parsed = Date.parse(event.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareEvents(left: SessionEvent, right: SessionEvent): number {
  return eventTime(left) - eventTime(right) || left.id.localeCompare(right.id);
}

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

function fileId(path: string): string {
  return `remote-session-file:${path}`;
}

function fallbackFile(
  event: SessionEvent,
  operation: FileOperationEntry
): RemoteSessionWorkspaceFile {
  const path = normalizeWorkspacePath(operation.filePath, event.repoPath);
  const payload = resolveFileOperationPayload(operation);
  const common = {
    id: fileId(path),
    path,
    sourcePath: operation.filePath,
    fileName: operation.fileName || getFileName(path),
    eventId: event.id,
    createdAt: event.createdAt,
    language: payload.language ?? operation.language,
  };

  if (operation.type === FILE_OPERATION_TYPE.DELETE) {
    return {
      ...common,
      mode: "deleted",
      status: "deleted",
      partial: false,
    };
  }

  if (operation.type === FILE_OPERATION_TYPE.READ) {
    const contentAvailable = payload.content !== undefined;
    const rangedRead =
      payload.contentStartLine !== undefined ||
      typeof event.args?.limit === "number";
    return {
      ...common,
      mode: contentAvailable ? "content" : "unavailable",
      status: contentAvailable ? "read" : "unavailable",
      content: payload.content,
      contentStartLine: payload.contentStartLine,
      partial: rangedRead,
    };
  }

  if (payload.oldContent !== undefined || payload.newContent !== undefined) {
    return {
      ...common,
      mode: "diff",
      status: payload.oldContent ? "modified" : "added",
      oldContent: payload.oldContent ?? "",
      newContent: payload.newContent ?? "",
      oldStartLine: payload.oldStartLine,
      newStartLine: payload.newStartLine,
      partial: true,
    };
  }

  return {
    ...common,
    mode: "unavailable",
    status: "unavailable",
    partial: true,
  };
}

/**
 * Projects the event prefix at the replay cursor into the files the Cloud
 * transcript can actually prove. It never invents a repository snapshot.
 */
export function buildRemoteSessionWorkspaceFiles(
  events: readonly SessionEvent[]
): RemoteSessionWorkspaceFile[] {
  const files = new Map<string, RemoteSessionWorkspaceFile>();
  const sortedEvents = [...events].sort(compareEvents);

  for (const event of sortedEvents) {
    const operation = convertToFileOperation(event, false);
    if (!operation) continue;

    if (operation.type === FILE_OPERATION_TYPE.WRITE) {
      const sections = buildSessionReplayDiffSectionItems({
        entryId: event.id,
        event,
        filePath: operation.filePath,
        fileName: operation.fileName,
      });

      if (sections.length > 0) {
        for (const section of sections) {
          const path = normalizeWorkspacePath(
            section.file.path,
            event.repoPath
          );
          const isDeleted = section.file.status === "deleted";
          const status: RemoteSessionWorkspaceFileStatus = isDeleted
            ? "deleted"
            : section.file.status === "added"
              ? "added"
              : "modified";
          const nextFile: RemoteSessionWorkspaceFile = {
            id: fileId(path),
            path,
            sourcePath: section.file.path,
            fileName: getFileName(path),
            eventId: event.id,
            createdAt: event.createdAt,
            language: operation.language,
            mode: isDeleted ? "deleted" : "diff",
            status,
            oldContent: section.file.oldContent,
            newContent: section.file.newContent,
            oldStartLine: section.file.oldStartLine,
            newStartLine: section.file.newStartLine,
            partial: !isDeleted,
          };
          files.set(path, nextFile);
        }
        continue;
      }
    }

    const nextFile = fallbackFile(event, operation);
    if (nextFile.path) files.set(nextFile.path, nextFile);
  }

  return Array.from(files.values()).sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}
