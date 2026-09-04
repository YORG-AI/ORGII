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

/** Browser session state and commands consumed by BrowserCore surfaces. */
export interface BrowserState {
  sessions: BrowserSession[];
  activeSessionId: string;
  activeSession: BrowserSession | undefined;
  addSession: (url?: string, incognito?: boolean) => string;
  closeSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string) => void;
  updateSession: (sessionId: string, updates: Partial<BrowserSession>) => void;
  forceSave?: () => void;
}
