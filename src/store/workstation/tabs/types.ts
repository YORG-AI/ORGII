/**
 * Workstation Tabs Type Definitions
 *
 * Unified tab system supporting all Workstation apps:
 * - Code Editor (file, git-diff, terminal, output, settings)
 * - Database Explorer (table, query, schema)
 * - Browser (browser-session)
 */

// ============================================
// Tab Type Enum
// ============================================

/**
 * All possible tab types across Workstation apps
 */
export type WorkStationTabType =
  // Code Editor tabs
  | "file"
  | "directory" // GitHub-style directory listing opened from chat/path references
  | "explorer" // Default pinned "home" tab — sidebar shows file tree, main pane shows placeholder
  | "git-diff"
  | "source-control"
  | "timeline-diff"
  | "git-log" // Git error log viewer (CodeMirror-based)
  | "git-commit-detail" // Git commit detail (split: file list + diff)
  | "git-stash-detail" // Git stash detail (split: file list + diff)
  | "terminal-content" // Terminal output viewer (read-only, from pill double-click)
  | "dom-component-preview" // Pasted DOM-component JSON viewer (Raw / Preview iframe)
  | "terminal"
  | "output"
  | "settings"
  | "search" // Repository-wide search tab
  | "lint-scan" // Workspace lint scan configuration
  | "ai-impact" // AI session impact dashboard
  | "search-sessions" // Session search + table (reuses SessionTable; launchpad tab)
  | "url-preview" // URL preview (agent-triggered webview in editor)
  // Browser tabs
  | "browser-session"
  /** DevTools right panel (Elements / Console / Network) */
  | "devtools"
  // Project Manager tabs
  | "project-dashboard"
  | "project-work-items"
  | "project-linear-projects"
  | "project-linear-work-items"
  | "project-settings"
  | "project-org"
  | "project-org-settings"
  | "project-git-sync-review"
  | "project-workitems"
  | "workItem-detail"
  | "chat-session"
  // Subagent detail tab (chat-like view of subagent activities + result)
  | "subagent-detail"
  // Agent / Team configuration tab — hosts the multi-tab agent/team detail
  // view inside the Code Editor surface (opened from the Agent Teams page
  // table rows; mirrors how skills are previewed).
  | "agent-config"
  // Canvas preview tab — renders agent-generated canvas from canvasPreviewAtom
  | "canvas-preview"
  // GitHub Issues detail tab — opened from the sidebar Issues panel
  | "github-issue-detail"
  // GitHub Pull Request detail tab — opened from Kanban PR rows
  | "github-pr-detail"
  // Start page — the launcher shown when nothing else is open
  | "start";

// ============================================
// Tab Types
// ============================================

/**
 * Unified tab type - single flat interface for all tab types
 *
 * This is used across all Workstation apps:
 * - Code Editor: file, git-diff, source-control, timeline-diff, terminal, output, settings
 * - Database Explorer: table, query, schema
 * - Browser: browser-session
 */
/**
 * Tab category — groups tabs that share the same renderer / heavy state so
 * the content layer can mount one component per category and only swap the
 * active tab's data, instead of unmount/remount on every tab switch.
 *
 * Defaults are derived from `type` when a factory does not declare one
 * explicitly (see `tabFactory.ts::deriveCategory`).
 */
export type WorkStationTabCategory =
  | "file" // Editor (file + ephemeral file-shaped views)
  | "explorer" // Pinned default home tab (no shared state, just a placeholder)
  | "git" // git-diff, source-control, git-commit-detail, git-stash-detail, git-log
  | "search"
  | "terminal"
  | "settings"
  | "lint"
  | "ai-impact"
  | "search-sessions"
  | "preview"
  | "subagent"
  | "agent-config"
  | "chat"
  | "db-table"
  | "db-query"
  | "db-schema"
  | "browser"
  | "project"
  | "launchpad";

export const TAB_RETURN_TARGET_DATA_KEY = "returnTabId";

export interface WorkStationTab {
  /** Unique identifier (e.g., "file:/path", "table:conn:name", "browser-session:123") */
  id: string;
  /** Tab type */
  type: WorkStationTabType;
  /**
   * Renderer category. Tabs with the same category share a single mounted
   * component instance and switch via prop change rather than remount.
   */
  category?: WorkStationTabCategory;
  /** Display title */
  title: string;
  /** Optional icon override */
  icon?: string;
  /** Type-specific data stored as flexible object */
  data: Record<string, unknown>;
  /** Whether tab can be closed (default: true) */
  closable?: boolean;
  /**
   * Pinned tabs are always rendered first in the tab bar and survive
   * "close all" / "close other" operations. Pair with `closable: false`
   * for permanent fixtures like the Diff tab in the Code Editor.
   */
  pinned?: boolean;
  /**
   * When true, the tab may be hidden from the rendered tab bar when a
   * host-specific regular tab exists. The tab still lives in pane state and
   * can become active again automatically once those regular tabs are closed —
   * used for "blank state" fixtures like the Code Editor's Explorer tab.
   */
  hideWhenOthersExist?: boolean;
  /** Whether tab has unsaved changes */
  hasUnsavedChanges?: boolean;
}

/**
 * State shape for the single workstation tab pane.
 *
 * The workstation has exactly one tab pane (`WorkStationLayoutState.mainPane`).
 * All tabs across every content host (Code Editor, Browser, Database,
 * Project Manager, Launchpad) live in this single pool — the active
 * content host is derived from the active tab's type / category via
 * `tabToHost`, not from a separate pane bucket.
 */
export interface PanelState {
  tabs: WorkStationTab[];
  activeTabId: string | null;
}

/**
 * WorkStation task-workspace identity.
 *
 * This is deliberately distinct from browser/terminal resource session IDs
 * and from SessionCore's transient pipeline session. Only the WorkStation's
 * remembered agent-session selection may produce a `session` key.
 */
export type WorkstationWorkspaceKey =
  | { kind: "global" }
  | { kind: "session"; sessionId: string };

export type WorkstationWorkspaceId = "global" | `session:${string}`;

export type WorkstationTabPartition = "shared" | "workspace";

export interface WorkstationTabRef {
  partition: WorkstationTabPartition;
  tabId: string;
}

/** Session/global-owned task context. Shared resource tabs live separately. */
export interface WorkstationWorkspaceState {
  tabs: WorkStationTab[];
  activeTabRef: WorkstationTabRef | null;
  /** Per-workspace presentation order, including references to shared tabs. */
  tabOrder: WorkstationTabRef[];
}

export interface WorkstationSharedState {
  tabs: WorkStationTab[];
}

/** Persisted v3 state. Runtime storage splits this document into per-scope keys. */
export interface WorkstationTabsStateV3 {
  version: 3;
  shared: WorkstationSharedState;
  globalWorkspace: WorkstationWorkspaceState;
  sessionWorkspaces: Record<string, WorkstationWorkspaceState>;
  /**
   * Workspace-local v2 tabs waiting for the first explicitly opened session.
   * Cold-start Global Workspace must not consume this seed.
   */
  legacySeed: WorkstationWorkspaceState | null;
}

export type WorkstationTabOwnership = "workspace-local" | "shared-resource";

/**
 * Closing most shared tabs only hides them from the current task workspace.
 * Browser and Terminal tabs are different: they own live sessions, so an
 * explicit user close must tear the resource down globally as well.
 */
export function closesSharedResourceOnDismiss(
  type: WorkStationTabType
): boolean {
  return type === "browser-session" || type === "terminal";
}

/**
 * Exhaustive ownership policy. There is intentionally no default: adding a
 * tab type must include an explicit product decision about its owner.
 */
export function getWorkstationTabOwnership(
  type: WorkStationTabType
): WorkstationTabOwnership {
  switch (type) {
    case "file":
    case "directory":
    case "explorer":
    case "git-diff":
    case "source-control":
    case "timeline-diff":
    case "git-log":
    case "git-commit-detail":
    case "git-stash-detail":
    case "terminal-content":
    case "dom-component-preview":
    case "output":
    case "search":
    case "lint-scan":
    case "ai-impact":
    case "search-sessions":
    case "url-preview":
    case "subagent-detail":
    case "canvas-preview":
    case "github-issue-detail":
    case "github-pr-detail":
      return "workspace-local";

    case "terminal":
    case "settings":
    case "browser-session":
    case "devtools":
    case "project-dashboard":
    case "project-work-items":
    case "project-linear-projects":
    case "project-linear-work-items":
    case "project-settings":
    case "project-org":
    case "project-org-settings":
    case "project-git-sync-review":
    case "project-workitems":
    case "workItem-detail":
    case "chat-session":
    case "agent-config":
    case "start":
      return "shared-resource";
  }
}

/**
 * Root workstation layout state — a single tab pool. There is no longer
 * any notion of split panes, a pane tree, host-specific pane buckets, or
 * a focused-pane id; the active tab in `mainPane` is the only piece of
 * "which tab is the user looking at?" state.
 */
export interface WorkStationLayoutState {
  mainPane: PanelState;
}

// ============================================
// Tab Factory Types
// ============================================

/**
 * Commit info for timeline diffs
 */
export interface TimelineDiffCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  timestamp: string;
}

// ============================================
// Browser Tab Data Types
// ============================================

/**
 * Data stored in browser session tabs
 */
export interface BrowserSessionTabData {
  sessionId: string;
  url: string;
  incognito?: boolean;
  isLoading?: boolean;
}

// ============================================
// Project Manager Tab Data Types
// ============================================

/**
 * Data stored in project work items tabs
 */
export interface ProjectWorkItemsTabData {
  projectId: string;
  projectName: string;
  projectSlug?: string;
  dataPath?: string;
}

/**
 * Data stored in new project (create) tabs — draft lives in a jotai atom keyed by tab ID
 */
export interface NewProjectTabData {
  /** intentionally empty — form state cached in projectDraftsAtom */
}

/**
 * Data stored in a single work item detail tab (expanded from inline panel)
 */
export interface WorkItemDetailTabData {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  orgId?: string;
  dataPath?: string;
  workItemId: string;
  workItemName: string;
  workItemStatus?: string;
  /** Unsaved changes transferred from the inline detail panel */
  pendingUpdates?: Record<string, unknown>;
}

/**
 * Data stored in new work item (create) tabs
 */
export interface NewWorkItemTabData {
  projectId: string;
  projectName: string;
}

/**
 * Data stored in token category tabs
 */
export interface TokenCategoryTabData {
  category: string;
}

// ============================================
// URL Preview Tab Data Types
// ============================================

/**
 * Data stored in URL preview tabs (agent-opened webview in editor)
 */
export interface UrlPreviewTabData {
  /** URL to display */
  url: string;
  /** Optional title (extracted from page or provided) */
  title?: string;
}

// ============================================
// Chat Session Tab Data Types
// ============================================

/**
 * Data stored in chat session tabs (opened from work items, session history, etc.)
 */
export interface ChatSessionTabData {
  /** The agent/coding session ID to display in the chat view */
  sessionId: string;
  /** Optional work item ID this session is linked to */
  workItemId?: string;
  /** Optional work item short ID for display (e.g. "PROJ-0042") */
  workItemShortId?: string;
}

// ============================================
// Subagent Detail Tab Data Types
// ============================================

/**
 * Data stored in subagent detail tabs (opened from subagent cards in chat).
 * Child session events are loaded live via useSessionEvents(subagentSessionId).
 */
export interface SubagentDetailTabData {
  description: string;
  subagentType?: string;
  resultContent?: string;
  success?: boolean;
  subagentSessionId?: string;
  elapsedMs?: number;
  prompt?: string;
  errorMessage?: string;
}

// ============================================
// Agent Config Tab Data Types
// ============================================

/**
 * Variant of the entity hosted inside an `agent-config` tab. The renderer
 * dispatches on this field to mount the matching detail view that
 * previously lived inside the Agent Teams page right-hand panel.
 */
export type AgentConfigTabVariant =
  | "builtin-os"
  | "builtin-sde"
  | "wingman"
  | "custom"
  | "cli"
  | "org";

/**
 * Data stored in agent-config tabs (opened from the Agent Teams page
 * table rows via `openAgentConfigInWorkStation`).
 *
 * The tab is keyed by `entityId` so re-opening the same agent / team from
 * the list focuses the existing tab instead of creating a duplicate.
 */
export interface AgentConfigTabData {
  variant: AgentConfigTabVariant;
  /** Stable identifier for the underlying entity (agent id or org id). */
  entityId: string;
  /** Display name shown in the tab title and breadcrumbs. */
  displayName: string;
  /** Serialized snapshot for variants whose detail can be opened before the
   * backing list refresh has reached the WorkStation renderer. */
  entitySnapshot?: unknown;
  /**
   * For `cli` variant only: the underlying CLI agent type (e.g. "cursor_cli",
   * "claude_code"). Needed by the renderer to fetch the live `AvailableCliAgent`
   * record from the RPC list at view time.
   */
  cliAgentType?: string;
}

// ============================================
// Editor Cache Types (Per-Repo for FILES only)
// ============================================

/**
 * Cached FILE tabs for a single repo
 *
 * IMPORTANT: Only FILE tabs are cached per-repo.
 * Terminal and Browser tabs are GLOBAL and NOT affected by repo switching.
 *
 * When switching repos:
 * - File tabs are saved to cache and swapped
 * - Terminal/Browser tabs stay in place (not touched)
 */
export interface EditorRepoCache {
  /** Repo path (key) */
  repoPath: string;
  /** File tabs only (type: "file", "git-diff", "source-control", "timeline-diff") */
  fileTabs: WorkStationTab[];
  /** Active file tab ID (null if no file tab was active) */
  activeFileTabId: string | null;
  /** Last time this repo was accessed */
  lastAccessedAt: number;
}

/**
 * Map of repo paths to their cached file tabs
 */
export type EditorCacheMap = Record<string, EditorRepoCache>;

// ============================================
// Tab Type Classification
// ============================================

/** Tab types that are FILE tabs (cached per-repo) */
export const FILE_TAB_TYPES = [
  "file",
  "git-diff",
  "source-control",
  "timeline-diff",
  "git-log",
  "git-commit-detail",
  "git-stash-detail",
  "terminal-content",
  "dom-component-preview",
] as const;

/** Tab types that are TOOL tabs (global, not cached per-repo) */
export const TOOL_TAB_TYPES = [
  "terminal",
  "output",
  "settings",
  "search",
  "lint-scan",
  "ai-impact",
  "search-sessions",
  "url-preview",
  // Browser tabs
  "browser-session",
  // Project Manager tabs
  "project-dashboard",
  "project-work-items",
  "project-linear-projects",
  "project-linear-work-items",
  "project-settings",
  "project-org",
  "project-org-settings",
  "project-workitems",
  "workItem-detail",
  "chat-session",
  "subagent-detail",
  "agent-config",
  // GitHub Issues detail
  "github-issue-detail",
  // GitHub Pull Request detail
  "github-pr-detail",
  // Start page launcher
  "start",
] as const;

export type FileTabType = (typeof FILE_TAB_TYPES)[number];
export type ToolTabType = (typeof TOOL_TAB_TYPES)[number];
