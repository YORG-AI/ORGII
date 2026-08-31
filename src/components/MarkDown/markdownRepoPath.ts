/**
 * markdownRepoPath
 *
 * Decides whether a code-fence file reference points inside the active
 * workspace, and resolves it to an absolute path the editor can open.
 */
export function normalizePathForRepoCheck(path: string): string {
  return path
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

export function isAbsolutePath(path: string): boolean {
  return /^(?:file:\/\/)?\//.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

export function isPathInCurrentRepo(
  filePath: string | undefined,
  repoRoot: string
): boolean {
  if (!filePath || !repoRoot) return false;
  const normalizedFilePath = normalizePathForRepoCheck(filePath);
  if (!isAbsolutePath(normalizedFilePath)) return true;
  const normalizedRepoRoot = normalizePathForRepoCheck(repoRoot);
  return (
    normalizedFilePath === normalizedRepoRoot ||
    normalizedFilePath.startsWith(`${normalizedRepoRoot}/`)
  );
}

export function resolveCurrentRepoFilePath(
  filePath: string | undefined,
  repoRoot: string
): string | undefined {
  if (!isPathInCurrentRepo(filePath, repoRoot) || !filePath) return undefined;
  const normalizedFilePath = normalizePathForRepoCheck(filePath);
  if (isAbsolutePath(normalizedFilePath)) return normalizedFilePath;
  return `${normalizePathForRepoCheck(repoRoot)}/${normalizedFilePath.replace(
    /^\.\//,
    ""
  )}`;
}
