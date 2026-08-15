/**
 * Code Editor Tab Factories
 *
 * Tab factories for the code editor using defineTabFactory.
 */
import type { SearchOptions } from "@src/store/workstation/codeEditor/search";

import { defineTabFactory, getFileExtension, getFileName } from "../tabFactory";
import type { TimelineDiffCommitInfo, WorkStationTab } from "../types";

// ============================================
// File Tabs
// ============================================

export interface FileTabData {
  filePath: string;
  extension: string;
  status: string | null;
  targetLine?: number;
  defaultPreviewMode?: boolean;
}

export const fileTabFactory = defineTabFactory<FileTabData>({
  tabType: "file",
  idStrategy: {
    type: "keyed",
    prefix: "file",
    getKey: (data) => data.filePath,
  },
  getTitle: (data) => getFileName(data.filePath),
});

/** Create a file tab with computed extension */
export interface CreateFileTabOptions {
  targetLine?: number;
  defaultPreviewMode?: boolean;
}

export function createFileTab(
  filePath: string,
  targetLineOrOptions?: number | CreateFileTabOptions
): WorkStationTab {
  const name = getFileName(filePath);
  const extension = getFileExtension(name);
  const options =
    typeof targetLineOrOptions === "number"
      ? { targetLine: targetLineOrOptions }
      : (targetLineOrOptions ?? {});
  return fileTabFactory({
    filePath,
    extension,
    status: null,
    ...(options.targetLine !== undefined && { targetLine: options.targetLine }),
    ...(options.defaultPreviewMode !== undefined && {
      defaultPreviewMode: options.defaultPreviewMode,
    }),
  });
}

// ============================================
// Directory Tab
// ============================================

export interface DirectoryTabData {
  directoryPath: string;
}

export const directoryTabFactory = defineTabFactory<DirectoryTabData>({
  tabType: "directory",
  idStrategy: {
    type: "keyed",
    prefix: "directory",
    getKey: (data) => data.directoryPath,
  },
  getTitle: (data) => getFileName(data.directoryPath) || "Directory",
  category: "explorer",
});

export function createDirectoryTab(directoryPath: string): WorkStationTab {
  return directoryTabFactory({ directoryPath });
}

// ============================================
// Explorer (default home) Tab
// ============================================

/**
 * The Code Editor's pinned, icon-only "home" tab. It carries no data — it
 * exists so the editor pane has something to show when no real file is open.
 *
 *   Sidebar : the host's default {@link EditorPrimarySidebar} (file tree,
 *             search, testing, extensions). No `TAB_SIDEBAR_REGISTRY` entry
 *             on purpose — the host falls back to its default sidebar.
 *   Main    : a placeholder ("Open a file to start editing") rendered by
 *             {@link TabContentRenderer}.
 */
export const explorerTabFactory = defineTabFactory<Record<string, never>>({
  tabType: "explorer",
  idStrategy: { type: "singleton", id: "explorer:main" },
  getTitle: () => "Files",
  // Unified surface: the Explorer is a regular closable tab, opened on demand.
  // The empty-pool "blank state" is the WorkStationStartPage.
});

export function createExplorerTab(): WorkStationTab {
  return explorerTabFactory({});
}

export const startTabFactory = defineTabFactory<Record<string, never>>({
  tabType: "start",
  idStrategy: { type: "singleton", id: "start:main" },
  getTitle: () => "Launchpad",
  icon: "LayoutGrid",
});

export function createStartTab(): WorkStationTab {
  return startTabFactory({});
}

// ============================================
// Git Diff Tabs
// ============================================

export interface GitDiffTabData {
  filePath: string;
  extension: string;
  gitStatusLetter: string;
  isTimeline?: boolean;
  commitSha?: string;
  shortSha?: string;
  headShortSha?: string;
  commitMessage?: string;
  commitAuthor?: string;
  commitTimestamp?: string;
  /**
   * Where the diff tab was opened from. Drives the smart-sidebar behavior:
   * only `"source-control"` causes the host to swap its default sidebar for
   * `DiffTabSidebar` while this tab is active. Other origins (chat link,
   * spotlight, programmatic, etc.) leave the user's current sidebar viewMode
   * untouched, matching VS Code / Cursor behavior.
   */
  origin?: "source-control" | "other";
}

export const gitDiffTabFactory = defineTabFactory<GitDiffTabData>({
  tabType: "git-diff",
  idStrategy: {
    type: "keyed",
    prefix: "git-diff",
    getKey: (data) =>
      data.isTimeline && data.commitSha
        ? `${data.commitSha}:${data.filePath}`
        : data.filePath,
  },
  getTitle: (data) => getFileName(data.filePath),
});

export function createGitDiffTab(
  filePath: string,
  gitStatusLetter: string,
  origin: GitDiffTabData["origin"] = "other"
): WorkStationTab {
  const name = getFileName(filePath);
  const extension = getFileExtension(name);
  return gitDiffTabFactory({ filePath, extension, gitStatusLetter, origin });
}

export function createTimelineDiffTab(
  filePath: string,
  commitSha: string,
  parentShortSha: string,
  commitShortSha: string,
  commitInfo?: TimelineDiffCommitInfo
): WorkStationTab {
  const name = getFileName(filePath);
  const extension = getFileExtension(name);

  // Timeline diff uses a custom ID format
  return {
    id: `timeline-diff:${commitSha}:${filePath}`,
    type: "git-diff",
    title: name,
    data: {
      filePath,
      extension,
      gitStatusLetter: "H",
      isTimeline: true,
      commitSha,
      shortSha: parentShortSha,
      headShortSha: commitShortSha,
      commitMessage: commitInfo?.message,
      commitAuthor: commitInfo?.author,
      commitTimestamp: commitInfo?.timestamp,
    },
  };
}

// ============================================
// Source Control Tab (unified Focus / All Changes)
// ============================================

/**
 * The pinned, non-closable Source Control tab. It is a singleton per
 * editor pane and switches internally between two modes via a header pill:
 *
 *   - `focus`        : single-file working-tree diff (default).
 *   - `all-changes`  : aggregated diff list of all working-tree changes.
 *
 * Working-tree single-file diffs (sidebar click, workstation Open Changes,
 * `useSelectedFile.selectGitDiff`) all flow through this tab in `focus`
 * mode. Historical commit and stash selections render inline here unless the
 * user explicitly opens them in a standalone tab.
 */
export const SOURCE_CONTROL_CHANGES_TAB_ID = "source-control:changes";

export type SourceControlHistorySelection =
  | {
      type: "commit";
      commitSha: string;
      shortSha: string;
      commitMessage: string;
    }
  | {
      type: "stash";
      stashIndex: number;
      stashRef: string;
      stashIdentity: string;
      stashCommitSha: string | null;
      commitSha: string;
      shortSha: string;
      commitMessage: string;
    }
  | {
      type: "pr";
      prNumber: number;
      prTitle: string;
      prUrl: string;
      prStatus: string;
      headBranch: string;
      /** Commit currently selected in PrCommitDropdown — used to drive the main pane diff view */
      selectedCommitSha?: string;
      selectedShortSha?: string;
      selectedCommitMessage?: string;
    }
  | {
      type: "issue";
      issueNumber: number;
      issueTitle: string;
      issueUrl: string;
    };

export interface SourceControlTabData {
  /** Internal view mode toggled by the header pill */
  mode: "focus" | "all-changes";
  /** Whether All Changes is showing the staged set (currently always false) */
  staged: boolean;
  /** Working-tree file count, surfaced for badge / pill display */
  fileCount: number;
  /** Selected file in Focus mode (absolute path); null = empty placeholder */
  focusPath: string | null;
  /** Selected history node rendered inline in the Source Control main pane. */
  historySelection?: SourceControlHistorySelection | null;
}

export const sourceControlTabFactory = defineTabFactory<SourceControlTabData>({
  tabType: "source-control",
  idStrategy: {
    type: "keyed",
    prefix: "source-control",
    getKey: (data) => (data.staged ? "staged-changes" : "changes"),
  },
  getTitle: () => "Review",
  icon: "FileDiff",
});

export function createSourceControlTab(
  fileCount: number,
  options?: {
    mode?: "focus" | "all-changes";
    staged?: boolean;
    focusPath?: string | null;
  }
): WorkStationTab {
  return sourceControlTabFactory({
    mode: options?.mode ?? "focus",
    staged: options?.staged ?? false,
    fileCount,
    focusPath: options?.focusPath ?? null,
    historySelection: null,
  });
}

// ============================================
// Git Log Tab (unique per error)
// ============================================

export interface GitLogTabData {
  operation: string;
  errorMessage: string;
  commandOutput: string;
  timestamp: string;
  virtualFileName: string;
}

export const gitLogTabFactory = defineTabFactory<GitLogTabData>({
  tabType: "git-log",
  idStrategy: { type: "unique", prefix: "git-log" },
  getTitle: (data) => data.virtualFileName,
  icon: "GitBranch",
});

export function createGitLogTab(
  operation: string,
  errorMessage: string,
  commandOutput?: string,
  timestamp?: Date
): WorkStationTab {
  const errorTime = timestamp || new Date();
  const tabTimestamp = errorTime.getTime();
  const virtualFileName = `git-error-${tabTimestamp}`;

  return gitLogTabFactory({
    operation,
    errorMessage,
    commandOutput: commandOutput || errorMessage,
    timestamp: errorTime.toISOString(),
    virtualFileName,
  });
}

// ============================================
// Git Commit Detail Tab
// ============================================

export interface GitCommitDetailTabData {
  commitSha: string;
  shortSha: string;
  commitMessage: string;
}

export const gitCommitDetailTabFactory =
  defineTabFactory<GitCommitDetailTabData>({
    tabType: "git-commit-detail",
    idStrategy: {
      type: "keyed",
      prefix: "git-commit-detail",
      getKey: (data) => data.commitSha,
    },
    getTitle: (data) => `${data.shortSha} ${data.commitMessage}`,
    icon: "GitCommitHorizontal",
  });

export function createGitCommitDetailTab(
  commitSha: string,
  shortSha: string,
  commitMessage: string
): WorkStationTab {
  return gitCommitDetailTabFactory({ commitSha, shortSha, commitMessage });
}

// ============================================
// Git Stash Detail Tab
// ============================================

export interface GitStashDetailTabData {
  stashIndex: number;
  stashRef: string;
  stashIdentity: string;
  stashCommitSha: string | null;
  commitSha: string;
  shortSha: string;
  commitMessage: string;
}

export const gitStashDetailTabFactory = defineTabFactory<GitStashDetailTabData>(
  {
    tabType: "git-stash-detail",
    idStrategy: {
      type: "keyed",
      prefix: "git-stash-detail",
      getKey: (data) => data.stashIdentity,
    },
    getTitle: (data) => {
      const { stashRef, commitMessage } = data;
      return commitMessage && commitMessage !== stashRef
        ? `${stashRef} ${commitMessage}`
        : stashRef;
    },
    icon: "Package",
  }
);

export function createStashDetailTab(
  stashIndex: number,
  stashMessage: string,
  stashCommitSha?: string | null
): WorkStationTab {
  const stashRef = `stash@{${stashIndex}}`;
  const normalizedMessage = stashMessage.trim();
  const normalizedCommitSha = stashCommitSha?.trim();
  const stashIdentity = normalizedCommitSha || stashRef;
  const shortSha =
    normalizedCommitSha && normalizedCommitSha.length >= 8
      ? normalizedCommitSha.slice(0, 8)
      : stashRef;

  return gitStashDetailTabFactory({
    stashIndex,
    stashRef,
    stashIdentity,
    stashCommitSha: normalizedCommitSha ?? null,
    commitSha: stashIdentity,
    shortSha,
    commitMessage: normalizedMessage || stashRef,
  });
}

// ============================================
// Terminal Tabs
// ============================================

export const CODE_EDITOR_MAIN_TERMINAL_SESSION_ID = "main";
export const CODE_EDITOR_MAIN_TERMINAL_TAB_ID = "terminal:main";

export interface TerminalTabData {
  sessionId: string;
  sessionName: string;
}

export const terminalTabFactory = defineTabFactory<TerminalTabData>({
  tabType: "terminal",
  idStrategy: {
    type: "keyed",
    prefix: "terminal",
    getKey: (data) => data.sessionId,
  },
  getTitle: (data) => data.sessionName,
  icon: "SquareTerminal",
});

export function createTerminalTab(
  sessionId: string,
  sessionName: string
): WorkStationTab {
  return terminalTabFactory({ sessionId, sessionName });
}

export interface TerminalContentTabData {
  sessionId: string;
  content: string;
  terminalName: string;
}

export const terminalContentTabFactory =
  defineTabFactory<TerminalContentTabData>({
    tabType: "terminal-content",
    idStrategy: {
      type: "keyed",
      prefix: "terminal-content",
      getKey: (data) => `${data.sessionId}:${data.terminalName}`,
    },
    getTitle: (data) => data.terminalName,
    icon: "SquareTerminal",
  });

export function createTerminalContentTab(
  terminalName: string,
  content: string,
  sessionId: string
): WorkStationTab {
  return terminalContentTabFactory({ sessionId, content, terminalName });
}

// ============================================
// DOM Component Preview Tab
// ============================================

export interface DomComponentPreviewTabData {
  /** Stable id derived from the paste pill (e.g. `paste://1781082907219-…`) */
  pasteId: string;
  /** Human-readable title shown on the tab (e.g. "ComposerShell.json") */
  fileName: string;
  /** Raw JSON text exactly as captured from the page */
  jsonText: string;
}

export const domComponentPreviewTabFactory =
  defineTabFactory<DomComponentPreviewTabData>({
    tabType: "dom-component-preview",
    idStrategy: {
      type: "keyed",
      prefix: "dom-component-preview",
      getKey: (data) => data.pasteId,
    },
    getTitle: (data) => data.fileName,
    icon: "Code",
  });

export function createDomComponentPreviewTab(
  pasteId: string,
  fileName: string,
  jsonText: string
): WorkStationTab {
  return domComponentPreviewTabFactory({ pasteId, fileName, jsonText });
}

// ============================================
// Output Tab
// ============================================

export interface OutputTabData {
  channelId: string;
  channelName: string;
}

export const outputTabFactory = defineTabFactory<OutputTabData>({
  tabType: "output",
  idStrategy: {
    type: "keyed",
    prefix: "output",
    getKey: (data) => data.channelId,
  },
  getTitle: (data) => data.channelName,
});

export function createOutputTab(
  channelId: string,
  channelName: string
): WorkStationTab {
  return outputTabFactory({ channelId, channelName });
}

// ============================================
// Singleton Tabs
// ============================================

export const settingsTabFactory = defineTabFactory<Record<string, never>>({
  tabType: "settings",
  idStrategy: { type: "singleton", id: "settings:main" },
  getTitle: () => "Settings",
  icon: "Settings",
});

export function createSettingsTab(): WorkStationTab {
  return settingsTabFactory({});
}

export const aiImpactTabFactory = defineTabFactory<Record<string, never>>({
  tabType: "ai-impact",
  idStrategy: { type: "singleton", id: "ai-impact:main" },
  getTitle: () => "AI Impact",
  icon: "Sparkles",
});

export function createAIImpactTab(): WorkStationTab {
  return aiImpactTabFactory({});
}

// ============================================
// Search Sessions Tab (singleton)
// ============================================

/**
 * Session search tab — a self-contained view that reuses the shared
 * `SessionTable` (search box + table) over all sessions. Singleton so
 * re-launching it from the Launchpad focuses the existing tab.
 */
export const searchSessionsTabFactory = defineTabFactory<Record<string, never>>(
  {
    tabType: "search-sessions",
    idStrategy: { type: "singleton", id: "search-sessions:main" },
    getTitle: () => "Kanban",
    icon: "LayoutGrid",
  }
);

export function createSearchSessionsTab(): WorkStationTab {
  return searchSessionsTabFactory({});
}

export const lintScanTabFactory = defineTabFactory<{ repoPath: string }>({
  tabType: "lint-scan",
  idStrategy: { type: "singleton", id: "lint-scan:main" },
  getTitle: () => "Lint Scan",
  icon: "ScanSearch",
});

export function createLintScanTab(repoPath: string): WorkStationTab {
  return lintScanTabFactory({ repoPath });
}

// ============================================
// Search Tab (unique)
// ============================================

export interface SearchTabData {
  repoPath?: string;
  initialQuery: string;
  initialOptions?: SearchOptions;
}

export const searchTabFactory = defineTabFactory<SearchTabData>({
  tabType: "search",
  idStrategy: { type: "unique", prefix: "search" },
  getTitle: () => "Search",
  icon: "Search",
});

export function createSearchTab(
  repoPath?: string,
  initialState?: {
    query?: string;
    options?: SearchOptions;
  }
): WorkStationTab {
  return searchTabFactory({
    repoPath,
    initialQuery: initialState?.query ?? "",
    initialOptions: initialState?.options,
  });
}

// ============================================
// URL Preview Tab (agent-triggered webview)
// ============================================

export interface UrlPreviewTabData {
  url: string;
  title?: string;
}

function getTitleFromUrl(url: string, customTitle?: string): string {
  if (customTitle) return customTitle;
  try {
    if (url && url !== "about:blank") {
      const urlObj = new URL(url);
      return urlObj.hostname || "Preview";
    }
  } catch {
    // Invalid URL
  }
  return "Preview";
}

export const urlPreviewTabFactory = defineTabFactory<UrlPreviewTabData>({
  tabType: "url-preview",
  idStrategy: {
    type: "keyed",
    prefix: "url-preview",
    getKey: (data) => data.url,
  },
  getTitle: (data) => getTitleFromUrl(data.url, data.title),
  icon: "Globe",
});

/**
 * Create a URL preview tab (webview in editor area)
 * Used by agent to open URLs for preview
 */
export function createUrlPreviewTab(
  url: string,
  title?: string
): WorkStationTab {
  return urlPreviewTabFactory({ url, title });
}
