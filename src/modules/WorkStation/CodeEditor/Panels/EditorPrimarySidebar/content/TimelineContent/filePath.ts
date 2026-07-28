export function toTimelineRepoRelativePath(
  filePath: string | null | undefined,
  repoId: string | null | undefined,
  repoPath: string | null | undefined
): string | null {
  if (!filePath || !repoId) return null;

  for (const root of [repoId, repoPath]) {
    if (!root || !filePath.startsWith(root)) continue;

    return filePath
      .slice(root.length)
      .replace(/^[\\/]+/, "")
      .replace(/\\/g, "/");
  }

  return filePath;
}
