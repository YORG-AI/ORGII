/**
 * File action utilities shared across file action modules.
 */

export function resolvePath(path: string, repoPath: string): string {
  const isWindowsAbsolute =
    /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");

  if (path.startsWith("/") || isWindowsAbsolute) {
    return path;
  }
  return `${repoPath}/${path}`;
}
