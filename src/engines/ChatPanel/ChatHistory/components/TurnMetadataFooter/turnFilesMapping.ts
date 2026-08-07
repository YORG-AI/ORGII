import type { FileChangeInfo } from "@src/engines/ChatPanel/InputArea/components/compactFileChangesHelpers";
import type { TurnModifiedFile } from "@src/engines/SessionCore/storage/sqliteCache";

function basename(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] || path;
}

/** Map already-materialized DB rows to the shared file-row display shape. */
export function mapTurnModifiedFilesToFileChanges(
  files: readonly TurnModifiedFile[] | undefined | null
): FileChangeInfo[] {
  if (!files || files.length === 0) return [];

  return files
    .filter((file) => typeof file?.path === "string" && file.path.length > 0)
    .map((file) => ({
      path: file.path,
      fileName:
        typeof file.fileName === "string" && file.fileName.length > 0
          ? file.fileName
          : basename(file.path),
      status: file.status ?? "modified",
      additions: Number.isFinite(file.additions)
        ? Math.max(0, Math.trunc(file.additions))
        : 0,
      deletions: Number.isFinite(file.deletions)
        ? Math.max(0, Math.trunc(file.deletions))
        : 0,
      lineCount: 0,
    }));
}
