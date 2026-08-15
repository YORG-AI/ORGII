/**
 * Tab Factory System
 *
 * Unified factory for creating WorkStationTab instances.
 * Reduces boilerplate and ensures consistency across all tab types.
 *
 * ## ID Patterns
 *
 * Three types of ID generation:
 * 1. **Singleton** - Fixed ID like "settings:main" (only one instance)
 * 2. **Data-keyed** - ID from data like "file:/path/to/file" (deduped by key)
 * 3. **Unique** - Timestamp-based like "search:1234567890-abc123" (always new)
 *
 * ## Usage
 *
 * See `factories/` directory for all pre-defined tab factories.
 */
import type {
  WorkStationTab,
  WorkStationTabCategory,
  WorkStationTabType,
} from "./types";

export { getFileName } from "@src/util/file/pathUtils";

// ============================================
// Types
// ============================================

/** ID generation strategy */
export type TabIdStrategy<TData = unknown> =
  | { type: "singleton"; id: string }
  | {
      type: "keyed";
      prefix: string;
      getKey: (data: TData) => string;
    }
  | { type: "unique"; prefix: string };

/** Tab factory configuration */
export interface TabFactoryConfig<TData> {
  /** Tab type (must match WorkStationTabType) */
  tabType: WorkStationTabType;
  /** ID generation strategy */
  idStrategy: TabIdStrategy<TData>;
  /** Get display title from data */
  getTitle: (data: TData) => string;
  /** Optional icon (Lucide icon name) */
  icon?: string;
  /** Whether tab is closable (default: true) */
  closable?: boolean;
  /** Whether tab is pinned (renders first, survives close-all) */
  pinned?: boolean;
  /**
   * When true, the tab may be hidden from the rendered tab bar when a
   * host-specific regular tab exists. Useful for "blank state" fixtures like
   * the Code Editor's Explorer tab.
   */
  hideWhenOthersExist?: boolean;
  /** Renderer category — overrides the default derived from `tabType` */
  category?: WorkStationTabCategory;
}

/**
 * Default category for each tab type. Overridable per-factory via the
 * `category` field when a tab type wants its own mount slot (e.g. a
 * read-only viewer that should not share state with the editor).
 */
const DEFAULT_CATEGORY_BY_TYPE: Record<
  WorkStationTabType,
  WorkStationTabCategory
> = {
  file: "file",
  directory: "explorer",
  explorer: "explorer",
  "git-diff": "git",
  "source-control": "git",
  "timeline-diff": "git",
  "git-log": "git",
  "git-commit-detail": "git",
  "git-stash-detail": "git",
  "terminal-content": "terminal",
  "dom-component-preview": "preview",
  terminal: "terminal",
  output: "terminal",
  settings: "settings",
  search: "search",
  "lint-scan": "lint",
  "ai-impact": "ai-impact",
  "search-sessions": "search-sessions",
  "url-preview": "preview",
  "browser-session": "browser",
  devtools: "browser",
  "project-dashboard": "project",
  "project-work-items": "project",
  "project-linear-projects": "project",
  "project-linear-work-items": "project",
  "project-settings": "project",
  "project-org": "project",
  "project-org-settings": "project",
  "project-git-sync-review": "project",
  "project-workitems": "project",
  "workItem-detail": "project",
  "chat-session": "chat",
  "subagent-detail": "subagent",
  "agent-config": "agent-config",
  "canvas-preview": "preview",
  "github-issue-detail": "git",
  "github-pr-detail": "git",
  start: "launchpad",
};

// ============================================
// Factory Function
// ============================================

/**
 * Create a tab factory function for a specific tab type.
 *
 * @example
 * // Singleton tab (only one instance)
 * const settingsTabFactory = defineTabFactory({
 *   tabType: "settings",
 *   idStrategy: { type: "singleton", id: "settings:main" },
 *   getTitle: () => "Settings",
 *   icon: "Settings",
 * });
 *
 * @example
 * // Keyed tab (deduped by file path)
 * const fileTabFactory = defineTabFactory({
 *   tabType: "file",
 *   idStrategy: { type: "keyed", prefix: "file", getKey: (d) => d.filePath },
 *   getTitle: (d) => getFileName(d.filePath),
 * });
 *
 * @example
 * // Unique tab (always creates new)
 * const searchTabFactory = defineTabFactory({
 *   tabType: "search",
 *   idStrategy: { type: "unique", prefix: "search" },
 *   getTitle: () => "Search",
 *   icon: "Search",
 * });
 */
export function defineTabFactory<TData>(
  config: TabFactoryConfig<TData>
): (data: TData) => WorkStationTab {
  return (data: TData): WorkStationTab => {
    // Generate ID based on strategy
    let id: string;
    switch (config.idStrategy.type) {
      case "singleton":
        id = config.idStrategy.id;
        break;
      case "keyed":
        id = `${config.idStrategy.prefix}:${config.idStrategy.getKey(data)}`;
        break;
      case "unique":
        id = `${config.idStrategy.prefix}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        break;
    }

    return {
      id,
      type: config.tabType,
      category: config.category ?? DEFAULT_CATEGORY_BY_TYPE[config.tabType],
      title: config.getTitle(data),
      icon: config.icon,
      data: data as Record<string, unknown>,
      closable: config.closable ?? true,
      pinned: config.pinned ?? false,
      hideWhenOthersExist: config.hideWhenOthersExist ?? false,
    };
  };
}

export function getFileExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}
