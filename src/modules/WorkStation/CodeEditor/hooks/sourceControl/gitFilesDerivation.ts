import type { GitWorkingDirectoryFile } from "@src/api/http/git";
import { normalizeGitStatus } from "@src/config/gitStatus";
import type { GitFile } from "@src/types/git/types";

/**
 * Map raw working-directory entries from a git status payload into the
 * `GitFile` shape used by the Source Control UI. Extracted from `useGitFiles`
 * so the derivation and equality gate can be unit-tested without React.
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
 * Structural equality for two derived base-file lists. Compares only the
 * identity-bearing fields produced by {@link deriveBaseFiles}
 * (`id`, `path`, `status`, `staged`, `original_path`) — every other field is a
 * constant for a freshly derived list, so this can never "stick" a stale array:
 * any working-tree change to those fields yields `false` and forces a new ref.
 */
export function areBaseFileListsEqual(a: GitFile[], b: GitFile[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.id !== right.id ||
      left.path !== right.path ||
      left.status !== right.status ||
      left.staged !== right.staged ||
      left.original_path !== right.original_path
    ) {
      return false;
    }
  }
  return true;
}
