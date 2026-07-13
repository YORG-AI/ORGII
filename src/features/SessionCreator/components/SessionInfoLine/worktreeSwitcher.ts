import type { GitWorktreeEntry } from "@src/api/http/git";

export function normalizeWorktreePath(path: string): string {
  return path.replace(/^file:\/\//, "").replace(/\/+$/, "");
}

export function getWorktreeName(worktree: GitWorktreeEntry): string {
  const normalizedPath = normalizeWorktreePath(worktree.path);
  return normalizedPath.split("/").pop() || normalizedPath;
}
