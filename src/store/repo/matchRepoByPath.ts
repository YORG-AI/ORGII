/**
 * Shared path → repo matching.
 *
 * Single normalization + comparison used by session/workspace hint logic
 * so surfaces agree about what "the session's repo" is.
 */
import type { Repo } from "./types";

export function toRepoFileSystemPath(path: string | undefined | null): string {
  if (!path) return "";
  const stripped = path.trim().startsWith("file://")
    ? path.trim().replace("file://", "")
    : path.trim();
  return stripped.length > 1 ? stripped.replace(/\/+$/, "") : stripped;
}

/** Strip file:// prefix and trailing slashes; lowercase for the
 *  case-insensitive default filesystem on macOS. */
export function normalizeRepoPath(path: string | undefined | null): string {
  return toRepoFileSystemPath(path).toLowerCase();
}

/** Find the registered repo whose path (or fs_uri) equals `path`. */
export function matchRepoByPath(
  repos: readonly Repo[],
  path: string | undefined | null
): Repo | undefined {
  const normalized = normalizeRepoPath(path);
  if (!normalized) return undefined;
  return repos.find(
    (repo) => normalizeRepoPath(repo.path ?? repo.fs_uri) === normalized
  );
}
