/**
 * Kanban View State atoms.
 *
 * Holds the bits of `TaskKanban` UI state that must survive when the user
 * toggles between Kanban and Canvas views (which unmounts `KanbanBoard`)
 * or briefly navigates away and comes back.
 *
 * Tier split mirrors the rest of the app:
 *   - `kanbanTimeFilterAtom` is a real user preference (the pill choice
 *     should outlive a reload), so it persists to localStorage — same
 *     pattern as `creatorDefaultExecModeAtom` (`orgii:agentExecMode`).
 *   - `kanbanSelectedTaskIdAtom` and `kanbanDetailPanelVisibleAtom` are
 *     transient session state. Module-level Jotai atoms are enough to
 *     survive remounts during navigation while still resetting on reload,
 *     so route transitions do not discard the user's board preferences.
 *
 * Selection is stored as the task **id**, not the `KanbanTask` object:
 * the task list is rebuilt every render from live session data, so
 * snapshotting the object would freeze status / unread badges. Callers
 * re-resolve via `tasks.find(t => t.id === selectedTaskId)`.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import {
  DEFAULT_KANBAN_TIME_FILTER,
  KANBAN_AGENT_TYPE_FILTER,
  KANBAN_SIDEBAR_FILTER,
  type KanbanAgentTypeFilter,
  type KanbanAutoArchiveTtl,
  type KanbanSidebarFilter,
  type KanbanTimeFilter,
} from "@src/features/TaskKanban/config";

const AGENT_TYPE_FILTER_STORAGE_KEY = "orgii:kanbanAgentTypeFilter";
const SIDEBAR_FILTER_STORAGE_KEY = "orgii:kanbanSidebarFilter";
const TIME_FILTER_STORAGE_KEY = "orgii:kanbanTimeFilter";
const AUTO_ARCHIVE_TTL_STORAGE_KEY = "orgii:kanbanAutoArchiveTtl";
const MANUAL_ARCHIVED_STORAGE_KEY = "orgii:kanbanManualArchivedSessions";
const MAX_MANUAL_ARCHIVED_SESSION_IDS = 1000;

const KNOWN_KANBAN_SIDEBAR_FILTERS = new Set<KanbanSidebarFilter>([
  KANBAN_SIDEBAR_FILTER.ALL,
  KANBAN_SIDEBAR_FILTER.TODO,
  KANBAN_SIDEBAR_FILTER.IN_PROGRESS,
  KANBAN_SIDEBAR_FILTER.BLOCKING,
  KANBAN_SIDEBAR_FILTER.TURN_FINISHED,
  KANBAN_SIDEBAR_FILTER.ARCHIVED,
]);

const KNOWN_TIME_FILTERS = new Set<KanbanTimeFilter>([
  "12h",
  "24h",
  "3d",
  "7d",
]);

const KNOWN_AUTO_ARCHIVE_TTLS = new Set<KanbanAutoArchiveTtl>([
  "never",
  "12h",
  "24h",
  "3d",
  "7d",
]);

function isKanbanAgentTypeFilter(
  value: unknown
): value is KanbanAgentTypeFilter {
  return typeof value === "string" && value.length > 0;
}

function isKanbanSidebarFilter(value: unknown): value is KanbanSidebarFilter {
  return (
    typeof value === "string" &&
    KNOWN_KANBAN_SIDEBAR_FILTERS.has(value as KanbanSidebarFilter)
  );
}

function isKanbanTimeFilter(value: unknown): value is KanbanTimeFilter {
  return (
    typeof value === "string" &&
    KNOWN_TIME_FILTERS.has(value as KanbanTimeFilter)
  );
}

function isKanbanAutoArchiveTtl(value: unknown): value is KanbanAutoArchiveTtl {
  return (
    typeof value === "string" &&
    KNOWN_AUTO_ARCHIVE_TTLS.has(value as KanbanAutoArchiveTtl)
  );
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

const kanbanAgentTypeFilterStorage = {
  getItem(
    key: string,
    initialValue: KanbanAgentTypeFilter
  ): KanbanAgentTypeFilter {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed: unknown = JSON.parse(stored);
      return isKanbanAgentTypeFilter(parsed) ? parsed : initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: KanbanAgentTypeFilter) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

const kanbanSidebarFilterStorage = {
  getItem(key: string, initialValue: KanbanSidebarFilter): KanbanSidebarFilter {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed: unknown = JSON.parse(stored);
      return isKanbanSidebarFilter(parsed) ? parsed : initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: KanbanSidebarFilter) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

const timeFilterStorage = {
  getItem(key: string, initialValue: KanbanTimeFilter): KanbanTimeFilter {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed: unknown = JSON.parse(stored);
      return isKanbanTimeFilter(parsed) ? parsed : initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: KanbanTimeFilter) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

const autoArchiveTtlStorage = {
  getItem(
    key: string,
    initialValue: KanbanAutoArchiveTtl
  ): KanbanAutoArchiveTtl {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed: unknown = JSON.parse(stored);
      return isKanbanAutoArchiveTtl(parsed) ? parsed : initialValue;
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: KanbanAutoArchiveTtl) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

const manualArchivedSessionIdsStorage = {
  getItem(key: string, initialValue: string[]): string[] {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed: unknown = JSON.parse(stored);
      return parseStringArray(parsed).slice(0, MAX_MANUAL_ARCHIVED_SESSION_IDS);
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: string[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      key,
      JSON.stringify(value.slice(0, MAX_MANUAL_ARCHIVED_SESSION_IDS))
    );
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

export const kanbanAgentTypeFilterAtom = atomWithStorage<KanbanAgentTypeFilter>(
  AGENT_TYPE_FILTER_STORAGE_KEY,
  KANBAN_AGENT_TYPE_FILTER.ALL,
  kanbanAgentTypeFilterStorage
);
kanbanAgentTypeFilterAtom.debugLabel = "kanban/agentTypeFilter";

export const kanbanSidebarFilterAtom = atomWithStorage<KanbanSidebarFilter>(
  SIDEBAR_FILTER_STORAGE_KEY,
  KANBAN_SIDEBAR_FILTER.ALL,
  kanbanSidebarFilterStorage
);
kanbanSidebarFilterAtom.debugLabel = "kanban/sidebarFilter";

/** Persisted user preference — the active time-window pill. */
export const kanbanTimeFilterAtom = atomWithStorage<KanbanTimeFilter>(
  TIME_FILTER_STORAGE_KEY,
  DEFAULT_KANBAN_TIME_FILTER,
  timeFilterStorage
);
kanbanTimeFilterAtom.debugLabel = "kanban/timeFilter";

export const kanbanAutoArchiveTtlAtom = atomWithStorage<KanbanAutoArchiveTtl>(
  AUTO_ARCHIVE_TTL_STORAGE_KEY,
  "24h",
  autoArchiveTtlStorage
);
kanbanAutoArchiveTtlAtom.debugLabel = "kanban/autoArchiveTtl";

export const kanbanManualArchivedSessionIdsAtom = atomWithStorage<string[]>(
  MANUAL_ARCHIVED_STORAGE_KEY,
  [],
  manualArchivedSessionIdsStorage
);
kanbanManualArchivedSessionIdsAtom.debugLabel =
  "kanban/manualArchivedSessionIds";

export const kanbanManualArchivedSessionsAtom = atom<Set<string>>((get) => {
  return new Set(get(kanbanManualArchivedSessionIdsAtom));
});
kanbanManualArchivedSessionsAtom.debugLabel = "kanban/manualArchivedSessions";

/** Currently previewed task id. `null` when no task is selected. */
export const kanbanSelectedTaskIdAtom = atom<string | null>(null);
kanbanSelectedTaskIdAtom.debugLabel = "kanban/selectedTaskId";

/** Whether the floating session-preview panel is visible. */
export const kanbanDetailPanelVisibleAtom = atom<boolean>(false);
kanbanDetailPanelVisibleAtom.debugLabel = "kanban/detailPanelVisible";

/**
 * Team-session card currently previewed on the board, paired with the local
 * session id its remote import materializes. The cloud card carries no
 * `session_id` of its own, and the imported copy only joins the board once
 * the transcript lands — this is what lets the preview render the session in
 * between. Transient, like the selection atoms above.
 */
export interface KanbanCloudPreviewTarget {
  /** Cloud task id (`cloud-remote:<row id>`) that was clicked. */
  taskId: string;
  /** Local session id the remote import writes into. */
  sessionId: string;
}
export const kanbanCloudPreviewTargetAtom =
  atom<KanbanCloudPreviewTarget | null>(null);
kanbanCloudPreviewTargetAtom.debugLabel = "kanban/cloudPreviewTarget";

/** Transient session-name query; intentionally resets on app reload. */
export const kanbanSearchQueryAtom = atom<string>("");
kanbanSearchQueryAtom.debugLabel = "kanban/searchQuery";
