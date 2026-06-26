/**
 * Pure derivation for the Source Control main-pane view.
 *
 * Extracted from `TabContentRenderer` so the same logic can drive the
 * keep-alive Source Control overlay in `EditorMainPane` (which renders the
 * pane independently of the active tab to preserve diff/scroll state across
 * navigation — see issue #16). Keeping it pure makes the file-filtering and
 * focus-resolution logic unit-testable without React.
 */
import { SOURCE_CONTROL_ALL_SESSIONS_FILTER } from "@src/store/workstation/codeEditor/sourceControlSessionFilterAtom";
import type { SourceControlHistorySelection } from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";

import { SOURCE_CONTROL_OTHER_SESSIONS_FILTER } from "../hooks";
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
  /** Files annotated with their originating session (empty when unattributed). */
  sourceControlAttributedFiles: GitFile[];
  /** "uncommitted" | "staged" | "unstaged" | "history" | ... */
  sourceControlFilterMode: string;
  /** Session-scope filter for the "uncommitted" mode. */
  sourceControlSessionFilter: string;
  repoPath: string;
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

/**
 * Derive every prop `SourceControlMainContent` needs from a Source Control tab
 * payload plus the current working-tree status / filters. Pure; no React.
 */
export function deriveSourceControlMainProps({
  tabData,
  gitFilesByPath,
  sourceControlAttributedFiles,
  sourceControlFilterMode,
  sourceControlSessionFilter,
  repoPath,
}: DeriveSourceControlMainPropsInput): SourceControlMainDerivedProps {
  const focusPath = tabData.focusPath ?? null;
  const mode: SourceControlPillMode =
    tabData.mode === "all-changes" ? "all-changes" : "focus";
  const staged = Boolean(tabData.staged);
  const historySelection = tabData.historySelection ?? null;

  const gitStatusFiles = Array.from(gitFilesByPath.values());
  const embeddedFiles = tabData.files ?? [];
  const unfilteredFiles =
    sourceControlAttributedFiles.length > 0
      ? sourceControlAttributedFiles
      : gitStatusFiles.length > 0
        ? gitStatusFiles
        : embeddedFiles;

  const allFiles = unfilteredFiles.filter((file) => {
    if (sourceControlFilterMode === "staged" && !file.staged) return false;
    if (sourceControlFilterMode === "unstaged" && file.staged) return false;
    if (
      sourceControlFilterMode !== "uncommitted" ||
      sourceControlSessionFilter === SOURCE_CONTROL_ALL_SESSIONS_FILTER
    ) {
      return true;
    }
    if (sourceControlSessionFilter === SOURCE_CONTROL_OTHER_SESSIONS_FILTER) {
      return !file.sourceSessionId;
    }
    return file.sourceSessionId === sourceControlSessionFilter;
  });

  const focusGitFile = focusPath
    ? (getGitFileForPath(focusPath, repoPath, gitFilesByPath) ?? null)
    : null;

  return {
    mode,
    staged,
    focusPath,
    historySelection,
    allFiles,
    focusGitFile,
    hasFocus: Boolean(focusPath),
  };
}
