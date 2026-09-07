/**
 * browserReplayUtils
 *
 * Pure utility functions and constants for the Browser SessionReplay component.
 * Extracted to keep index.tsx under the 600-line limit.
 */
import type { BrowserReplaySidebarCategory } from "./BrowserSidebar";
import { categorizeBrowserEntry } from "./entryUtils";
import type { BrowserEntry, InternalBrowserEntry } from "./types";

// ============================================
// Tab ID constants
// ============================================

export const MY_TABS_BROWSER_TAB_ID = "browser:my-tabs";
export const AGENT_BROWSER_TAB_ID = "browser:agent-browser";
export const SEARCH_FETCH_TAB_ID = "browser:search-fetch";
export const TAB_ICON_SIZE = 14;
export const TAB_ICON_CLASS = "shrink-0";

export const BROWSER_CATEGORY_BY_TAB_ID: ReadonlyMap<
  string,
  BrowserReplaySidebarCategory
> = new Map([
  [AGENT_BROWSER_TAB_ID, "agent_browser"],
  [SEARCH_FETCH_TAB_ID, "search_fetch"],
]);

export const TAB_ID_BY_ENTRY_CATEGORY: ReadonlyMap<string, string> = new Map([
  ["browser", AGENT_BROWSER_TAB_ID],
  ["internal_browser", AGENT_BROWSER_TAB_ID],
  ["web_search", SEARCH_FETCH_TAB_ID],
  ["web_fetch", SEARCH_FETCH_TAB_ID],
]);

// ============================================
// Timestamp helpers
// ============================================

export function getBrowserEntryTimestamp(
  entry: BrowserEntry | InternalBrowserEntry
): string {
  return entry.timestamp || entry.event?.createdAt || "";
}

function newestTimestampFromEntries(
  entries: Iterable<BrowserEntry | InternalBrowserEntry>,
  shouldInclude: (entry: BrowserEntry | InternalBrowserEntry) => boolean = () =>
    true
): string {
  let newestTimestamp = "";
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (!shouldInclude(entry)) continue;
    const timestamp = getBrowserEntryTimestamp(entry);
    if (!timestamp) continue;
    const timestampMs = new Date(timestamp).getTime();
    if (!Number.isFinite(timestampMs) || timestampMs <= newestMs) continue;
    newestMs = timestampMs;
    newestTimestamp = timestamp;
  }

  return newestTimestamp;
}

export function getNewestAgentBrowserTimestamp(
  browserEntries: BrowserEntry[],
  internalBrowserEntries: InternalBrowserEntry[]
): string {
  const newestBrowserTimestamp = newestTimestampFromEntries(
    browserEntries,
    (entry) => categorizeBrowserEntry(entry as BrowserEntry) === "browser"
  );
  const newestInternalTimestamp = newestTimestampFromEntries(
    internalBrowserEntries
  );
  if (!newestBrowserTimestamp) return newestInternalTimestamp;
  if (!newestInternalTimestamp) return newestBrowserTimestamp;
  return new Date(newestBrowserTimestamp).getTime() >=
    new Date(newestInternalTimestamp).getTime()
    ? newestBrowserTimestamp
    : newestInternalTimestamp;
}

export function getNewestSearchFetchTimestamp(
  browserEntries: BrowserEntry[]
): string {
  return newestTimestampFromEntries(browserEntries, (entry) => {
    const category = categorizeBrowserEntry(entry as BrowserEntry);
    return category === "web_search" || category === "web_fetch";
  });
}

// ============================================
// Entry helpers
// ============================================

export function getEntryCategory(
  entryId: string,
  browserEntries: BrowserEntry[],
  internalBrowserEntries: InternalBrowserEntry[]
): string | null {
  const nativeEntry = internalBrowserEntries.find(
    (entry) => entry.entryId === entryId
  );
  if (nativeEntry) return "internal_browser";

  const browserEntry = browserEntries.find(
    (entry) => entry.entryId === entryId
  );
  return browserEntry ? categorizeBrowserEntry(browserEntry) : null;
}

export function labelWithCount(label: string, count: number): string {
  return `${label} (${count})`;
}
