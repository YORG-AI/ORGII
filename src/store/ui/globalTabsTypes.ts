/**
 * Global Tabs — Types and utilities
 */

// ============================================
// Types
// ============================================

export interface BrowserTab {
  id: string;
  title: string;
  url?: string;
  favicon?: string;
  isActive: boolean;
  isPrivate?: boolean;
  timestamp: number;
}

export interface TerminalSession {
  id: string;
  name: string;
  isActive: boolean;
  timestamp: number;
}

interface EditorRepo {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  timestamp: number;
}

interface DocumentFile {
  id: string;
  title: string;
  updatedAt?: string;
  isActive: boolean;
  timestamp: number;
}

interface WorkspaceSession {
  session_id: string;
  name: string;
  repo_id: string;
  isActive: boolean;
  timestamp: number;
}

interface ShortcutItem {
  id: string;
  name: string;
  isActive: boolean;
  timestamp: number;
}

export interface GlobalTabsState {
  browser: BrowserTab[];
  terminal: TerminalSession[];
  editor: EditorRepo[];
  files: DocumentFile[];
  sessions: WorkspaceSession[];
  shortcuts: ShortcutItem[];
}

// ============================================
// Utilities
// ============================================

/**
 * Get favicon URL for a given site URL.
 * Uses Google's favicon service which is reliable and fast.
 */
export const getFaviconUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname) return undefined;
    return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
  } catch {
    return undefined;
  }
};

/**
 * Get site name from URL (e.g., "google.com.hk" -> "Google")
 */
export const getSiteNameFromUrl = (url: string | undefined): string => {
  if (!url) return "New Tab";
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const domain = hostname.replace(/^www\./, "");
    const parts = domain.split(".");
    if (parts.length >= 2) {
      const siteName = parts[0];
      return siteName.charAt(0).toUpperCase() + siteName.slice(1);
    }
    return domain;
  } catch {
    return "New Tab";
  }
};

// Max size limits per tab type (FIFO eviction for oldest inactive items)
export const MAX_BROWSER_TABS = 50;
export const MAX_TERMINAL_SESSIONS = 20;

/** Evict oldest inactive items when array exceeds maxSize. Keeps active items. */
export function evictOldest<T extends { isActive: boolean; timestamp: number }>(
  items: T[],
  maxSize: number
): T[] {
  if (items.length <= maxSize) return items;
  const active = items.filter((item) => item.isActive);
  const inactive = items
    .filter((item) => !item.isActive)
    .sort((itemA, itemB) => itemA.timestamp - itemB.timestamp);
  const keepCount = Math.max(0, maxSize - active.length);
  return [...active, ...inactive.slice(-keepCount)];
}
