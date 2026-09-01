// Browser-specific types

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

export interface BrowserSession {
  id: string;
  url: string;
  title: string;
  history: string[];
  historyIndex: number;
  historyEntries?: BrowserHistoryEntry[];
  isLoading: boolean;
  error: string | null;
  incognito?: boolean;
}
