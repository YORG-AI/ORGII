import type { ActivityChunk } from "@src/types/session/session";

import {
  claudeCodeHistoryChunks,
  claudeCodeHistoryListSessions,
} from "../claudeCodeHistory";
import type {
  ClaudeCodeHistorySessionPage,
  ClaudeCodeHistorySessionRow,
} from "../claudeCodeHistory";
import { codexAppChunks, codexAppListSessions } from "../codexApp";
import type { CodexAppSessionPage, CodexAppSessionRow } from "../codexApp";
import {
  opencodeHistoryChunks,
  opencodeHistoryListSessions,
} from "../opencodeHistory";
import type {
  OpenCodeHistorySessionPage,
  OpenCodeHistorySessionRow,
} from "../opencodeHistory";
import type { DispatchCategory } from "../session";
import {
  windsurfHistoryChunks,
  windsurfHistoryListSessions,
} from "../windsurfHistory";
import type {
  WindsurfHistorySessionPage,
  WindsurfHistorySessionRow,
} from "../windsurfHistory";
import {
  workBuddyHistoryChunks,
  workBuddyHistoryListSessions,
} from "../workbuddyHistory";
import type {
  WorkBuddyHistorySessionPage,
  WorkBuddyHistorySessionRow,
} from "../workbuddyHistory";

export type ImportedHistorySourceId =
  | "codex_app"
  | "claude_code"
  | "opencode"
  | "windsurf"
  | "workbuddy";

export type ImportedHistoryListCategory =
  `external_history:${ImportedHistorySourceId}`;

export interface ImportedHistorySessionRow {
  sessionId: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  category: "external_history";
  readOnly: true;
  model?: string;
  totalTokens: number;
  background: boolean;
  isActive: boolean;
  repoPath?: string;
  repoName?: string;
  branch?: string;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  touchedFiles: string[];
}

export interface ImportedHistorySessionPage {
  sessions: ImportedHistorySessionRow[];
  hasMore: boolean;
}

export interface ImportedHistorySource {
  sourceId: ImportedHistorySourceId;
  listCategory: ImportedHistoryListCategory;
  dispatchCategory: Extract<DispatchCategory, "external_history">;
  prefix: string;
  iconId: string;
  displayName: string;
  groupLabel: string;
  sidebarPageSize?: number;
  listSessions(args?: {
    limit?: number;
    offset?: number;
  }): Promise<ImportedHistorySessionPage>;
  loadChunks(sessionId: string): Promise<ActivityChunk[]>;
}

function asImportedPage(
  page:
    | CodexAppSessionPage
    | ClaudeCodeHistorySessionPage
    | OpenCodeHistorySessionPage
    | WindsurfHistorySessionPage
    | WorkBuddyHistorySessionPage
): ImportedHistorySessionPage {
  return page;
}

export const IMPORTED_HISTORY_SOURCES: readonly ImportedHistorySource[] = [
  {
    sourceId: "codex_app",
    listCategory: "external_history:codex_app",
    dispatchCategory: "external_history",
    prefix: "codexapp-",
    iconId: "codex",
    displayName: "Codex",
    groupLabel: "Codex App",
    async listSessions(args) {
      return asImportedPage(await codexAppListSessions(args));
    },
    loadChunks: codexAppChunks,
  },
  {
    sourceId: "claude_code",
    listCategory: "external_history:claude_code",
    dispatchCategory: "external_history",
    prefix: "claudecodeapp-",
    iconId: "claude_code",
    displayName: "Claude Code",
    groupLabel: "Claude Code",
    async listSessions(args) {
      return asImportedPage(await claudeCodeHistoryListSessions(args));
    },
    loadChunks: claudeCodeHistoryChunks,
  },
  {
    sourceId: "opencode",
    listCategory: "external_history:opencode",
    dispatchCategory: "external_history",
    prefix: "opencodeapp-",
    iconId: "opencode",
    displayName: "OpenCode",
    groupLabel: "OpenCode",
    async listSessions(args) {
      return asImportedPage(await opencodeHistoryListSessions(args));
    },
    loadChunks: opencodeHistoryChunks,
  },
  {
    sourceId: "windsurf",
    listCategory: "external_history:windsurf",
    dispatchCategory: "external_history",
    prefix: "windsurfapp-",
    iconId: "windsurf",
    displayName: "Windsurf",
    groupLabel: "Windsurf",
    async listSessions(args) {
      return asImportedPage(await windsurfHistoryListSessions(args));
    },
    loadChunks: windsurfHistoryChunks,
  },
  {
    sourceId: "workbuddy",
    listCategory: "external_history:workbuddy",
    dispatchCategory: "external_history",
    prefix: "workbuddyapp-",
    iconId: "workbuddy",
    displayName: "WorkBuddy",
    groupLabel: "WorkBuddy",
    async listSessions(args) {
      return asImportedPage(await workBuddyHistoryListSessions(args));
    },
    loadChunks: workBuddyHistoryChunks,
  },
];

export function getImportedHistorySourceBySessionId(
  sessionId: string | null | undefined
): ImportedHistorySource | undefined {
  if (!sessionId) return undefined;
  return IMPORTED_HISTORY_SOURCES.find((source) =>
    sessionId.startsWith(source.prefix)
  );
}

export function getImportedHistorySourceByListCategory(
  category: ImportedHistoryListCategory
): ImportedHistorySource | undefined {
  return IMPORTED_HISTORY_SOURCES.find(
    (source) => source.listCategory === category
  );
}

export function isImportedHistoryListCategory(
  category: string
): category is ImportedHistoryListCategory {
  return IMPORTED_HISTORY_SOURCES.some(
    (source) => source.listCategory === category
  );
}

export function isImportedHistorySourceSession(
  sessionId: string,
  source: ImportedHistorySource
): boolean {
  return sessionId.startsWith(source.prefix);
}

export type {
  CodexAppSessionRow,
  ClaudeCodeHistorySessionRow,
  OpenCodeHistorySessionRow,
  WindsurfHistorySessionRow,
  WorkBuddyHistorySessionRow,
};
