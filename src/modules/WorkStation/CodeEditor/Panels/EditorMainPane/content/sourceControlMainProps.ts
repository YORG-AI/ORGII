/**
 * Pure derivation for the Source Control main-pane view.
 *
 * Extracted from `TabContentRenderer` so the same logic can drive the
 * keep-alive Source Control overlay in `EditorMainPane` (which renders the
 * pane independently of the active tab to preserve diff/scroll state across
 * navigation — see issue #16). Keeping it pure makes the file-filtering and
 * focus-resolution logic unit-testable without React.
 */
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import type { SourceControlPillMode } from "./SourceControlMainContent";

/**
 * Resolve the {@link GitFile} for a focus path against the working-tree status
 * map. Handles exact matches, host-relative paths, and repo-root-prefixed
 * absolute paths (worktrees). Shared with the file-tab renderer.
 */
export function getGitFileForPath(
  filePath: string,
  repoPath: string,
  gitFilesByPath: Map<string, GitFile>
): GitFile | undefined {
  const exactMatch = gitFilesByPath.get(filePath);
  if (exactMatch) return exactMatch;

  const hostRelative = filePath.startsWith(`${repoPath}/`)
    ? filePath.slice(repoPath.length + 1)
    : null;
  if (hostRelative) {
    const hostMatch = gitFilesByPath.get(hostRelative);
    if (hostMatch) return hostMatch;
  }

  for (const file of gitFilesByPath.values()) {
    if (!file.repoRoot) continue;
    const prefix = `${file.repoRoot}/`;
    if (!filePath.startsWith(prefix)) continue;
    const relativePath = filePath.slice(prefix.length);
    if (file.path === relativePath) return file;
  }

  return undefined;
}

/** Tab payload fields the Source Control main pane consumes. */
export interface SourceControlMainTabData {
  mode?: string;
  staged?: boolean;
  focusPath?: string | null;
  historySelection?: SourceControlHistorySelection | null;
  files?: GitFile[];
}

export interface DeriveSourceControlMainPropsInput {
  tabData: SourceControlMainTabData;
  gitFilesByPath: Map<string, GitFile>;
  /** Current working-tree files for the Source Control pane. */
  sourceControlFiles: GitFile[];
  /** "uncommitted" | "staged" | "unstaged" | "history" | ... */
  sourceControlFilterMode: string;
  repoPath: string;
  /** Repo/worktree root selected by the Source Control scope picker. */
  activeRepoRoot: string;
}

export interface SourceControlMainDerivedProps {
  mode: SourceControlPillMode;
  staged: boolean;
  focusPath: string | null;
  historySelection: SourceControlHistorySelection | null;
  allFiles: GitFile[];
  focusGitFile: GitFile | null;
  hasFocus: boolean;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isPathInRepoScope(
  filePath: string,
  repoPath: string,
  activeRepoRoot: string
): boolean {
  const normalizedPath = normalizeRepoPath(filePath);
  const normalizedRepoPath = normalizeRepoPath(repoPath);
  const normalizedActiveRoot = normalizeRepoPath(activeRepoRoot);
  const isAbsolute =
    normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath);

  if (!isAbsolute) {
    return normalizedActiveRoot === normalizedRepoPath;
  }

  return (
    normalizedPath === normalizedActiveRoot ||
    normalizedPath.startsWith(`${normalizedActiveRoot}/`)
  );
}

function isFileInRepoScope(
  file: GitFile,
  repoPath: string,
  activeRepoRoot: string
): boolean {
  return (
    normalizeRepoPath(file.repoRoot ?? repoPath) ===
    normalizeRepoPath(activeRepoRoot)
  );
}

function matchesSourceControlFilter(
  file: GitFile,
  sourceControlFilterMode: string
): boolean {
  if (sourceControlFilterMode === "staged") return file.staged;
  if (sourceControlFilterMode === "unstaged") return !file.staged;
  return true;
}

/**
 * Derive every prop `SourceControlMainContent` needs from a Source Control tab
 * payload plus the current working-tree status / filters. Pure; no React.
 */
export function deriveSourceControlMainProps({
  tabData,
  gitFilesByPath,
  sourceControlFiles,
  sourceControlFilterMode,
  repoPath,
  activeRepoRoot,
}: DeriveSourceControlMainPropsInput): SourceControlMainDerivedProps {
  const focusPath = tabData.focusPath ?? null;
  const mode: SourceControlPillMode =
    tabData.mode === "all-changes" ? "all-changes" : "focus";
  const staged = Boolean(tabData.staged);
  const historySelection = tabData.historySelection ?? null;

  const gitStatusFiles = Array.from(gitFilesByPath.values());
  const embeddedFiles = tabData.files ?? [];
  const unfilteredFiles =
    sourceControlFiles.length > 0
      ? sourceControlFiles
      : gitStatusFiles.length > 0
        ? gitStatusFiles
        : embeddedFiles;

  const allFiles = unfilteredFiles.filter(
    (file) =>
      isFileInRepoScope(file, repoPath, activeRepoRoot) &&
      matchesSourceControlFilter(file, sourceControlFilterMode)
  );

  const resolvedFocusFile = focusPath
    ? (getGitFileForPath(focusPath, repoPath, gitFilesByPath) ?? null)
    : null;
  const focusPathInActiveScope = focusPath
    ? isPathInRepoScope(focusPath, repoPath, activeRepoRoot)
    : false;
  const focusGitFile =
    resolvedFocusFile &&
    isFileInRepoScope(resolvedFocusFile, repoPath, activeRepoRoot) &&
    matchesSourceControlFilter(resolvedFocusFile, sourceControlFilterMode)
      ? resolvedFocusFile
      : null;
  const hasFocus = Boolean(
    focusPath && focusPathInActiveScope && (!resolvedFocusFile || focusGitFile)
  );

  return {
    mode,
    staged,
    focusPath,
    historySelection,
    allFiles,
    focusGitFile,
    hasFocus,
  };
}
