import type { GitWorkingDirectoryFile } from "@src/api/http/git";
import { normalizeGitStatus } from "@src/config/gitStatus";
import type { GitFile } from "@src/types/git/types";

/**
 * Map raw working-directory entries from a git status payload into the
 * `GitFile` shape used by the Source Control UI. Extracted from `useGitFiles`
 * so the derivation and structural identity key can be tested without React.
 */
export function deriveBaseFiles(
  statusFiles: GitWorkingDirectoryFile[]
): GitFile[] {
  return statusFiles.map((file, index) => ({
    id: `${file.path}-${index}`,
    path: file.path,
    status: normalizeGitStatus(file.status),
    additions: 0,
    deletions: 0,
    staged: file.staged,
    original_path: file.original_path,
    // Content is loaded lazily when a file is selected.
    oldContent: undefined,
    newContent: undefined,
  }));
}

/**
 * Primitive dependency key for {@link deriveBaseFiles}. A status refresh often
 * replaces the payload object without changing the working tree; using this
 * key lets React memoization retain the derived array without a render-time ref
 * cache. JSON preserves ordering and distinguishes a missing `original_path`
 * from an explicit null, so every derivation-bearing input is represented.
 */
export function baseFileListIdentity(
  statusFiles: GitWorkingDirectoryFile[]
): string {
  return JSON.stringify(
    statusFiles.map((file) => ({
      path: file.path,
      status: file.status,
      staged: file.staged,
      original_path: file.original_path,
    }))
  );
}

/** Rebuild the derived list from its complete primitive identity snapshot. */
export function deriveBaseFilesFromIdentity(identity: string): GitFile[] {
  return deriveBaseFiles(JSON.parse(identity) as GitWorkingDirectoryFile[]);
}
