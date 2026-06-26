import {
  Archive,
  CheckCircle2,
  Circle,
  Clock,
  type LucideIcon,
  MessageCircleWarning,
} from "lucide-react";

import type {
  KanbanColumnConfig,
  TaskStatus,
} from "@src/features/KanbanBoard/types";
import type { Session } from "@src/store/session";

/**
 * Kanban Configuration
 *
 * Defines session-based column settings for the Agent Kanban board.
 *
 * The board mirrors the sidebar status lights:
 *   - Todo          → agent is queued and has not started running yet
 *   - In Progress   → agent is actively running or installing
 *   - Blocking      → user action is pending (`waiting_for_user`)
 *   - Turn Finished → agent has stopped and the user's review/next turn can begin
 *   - Archived      → manually archived or stale by TTL
 *
 * The Agent Kanban widens the column id space beyond the shared `TaskStatus`
 * union with extra local buckets. Cards keep their precise backend result
 * badges independent of column routing.
 * These ids are kept local to this module so other consumers of `TaskStatus`
 * (WorkItems, Gantt) are not affected.
 */

export type { TaskStatus, KanbanColumnConfig };

/** Agent-Kanban-only column ids on top of the shared `TaskStatus` set. */
export type AgentExtraColumnId =
  | "todo"
  | "done"
  | "blocking"
  | "turn_finished"
  | "archived";

export const KANBAN_SIDEBAR_FILTER = {
  ALL: "all",
  TODO: "todo",
  IN_PROGRESS: "in_progress",
  BLOCKING: "blocking",
  TURN_FINISHED: "turn_finished",
  ARCHIVED: "archived",
} as const;

export type KanbanSidebarFilter =
  (typeof KANBAN_SIDEBAR_FILTER)[keyof typeof KANBAN_SIDEBAR_FILTER];

export const KANBAN_AGENT_TYPE_FILTER = {
  ALL: "all",
  OS_AGENT: "builtin:os",
  SDE_AGENT: "builtin:sde",
  CUSTOM_RUST_AGENT: "rust_agent:custom",
  CURSOR_IDE: "cursor_ide",
  CURSOR_CLI: "cursor_cli",
  CLAUDE_CODE: "claude_code",
  CODEX: "codex",
  GEMINI_CLI: "gemini_cli",
  COPILOT: "copilot",
  KIRO: "kiro",
  KIMI_CLI: "kimi_cli",
  OPENCODE: "opencode",
  WINDSURF: "windsurf",
  WORKBUDDY: "workbuddy",
} as const;

export type KanbanBuiltInAgentTypeFilter =
  (typeof KANBAN_AGENT_TYPE_FILTER)[keyof typeof KANBAN_AGENT_TYPE_FILTER];
export type KanbanAgentTypeFilter = KanbanBuiltInAgentTypeFilter | string;

/** Widened column id used inside Agent Kanban only. */
export type AgentKanbanColumnId = TaskStatus | AgentExtraColumnId;

/**
 * Local column-config shape that allows the extra Agent-Kanban id.
 * Structurally identical to `KanbanColumnConfig` apart from the widened id;
 * cast to `KanbanColumnConfig[]` at the `<KanbanBoard>` boundary, where the
 * id is treated purely as an opaque grouping key.
 */
interface AgentKanbanColumnConfig {
  id: AgentKanbanColumnId;
  title: string;
  icon: LucideIcon;
  color: string;
  bgColor: string;
  dotColor: string;
  headerBgColor: string;
  /** Show a + button in the column header for this specific column. */
  showAddButton?: boolean;
}

/**
 * Column ID → i18n key mapping for translation at render time.
 * Keys reference sessions:opsControl.columns.* namespace.
 */
const COLUMN_TITLE_KEYS: Record<string, string> = {
  todo: "opsControl.columns.todo",
  in_progress: "opsControl.columns.inProgress",
  blocking: "opsControl.columns.blocking",
  turn_finished: "opsControl.columns.turnFinished",
  archived: "opsControl.columns.archived",
};

export function getColumnTitleKey(columnId: string): string {
  return COLUMN_TITLE_KEYS[columnId] ?? columnId;
}

export const KANBAN_COLUMNS: AgentKanbanColumnConfig[] = [
  {
    id: "todo",
    title: "sessions:opsControl.columns.todo",
    icon: Circle,
    color: "var(--color-fill-4)",
    bgColor: "color-mix(in srgb, var(--color-fill-4) 55%, transparent)",
    dotColor: "var(--color-fill-4)",
    headerBgColor: "color-mix(in srgb, var(--color-fill-4) 45%, transparent)",
    showAddButton: true,
  },
  {
    id: "in_progress",
    title: "sessions:opsControl.columns.inProgress",
    icon: Clock,
    color: "var(--color-primary-6)",
    bgColor: "color-mix(in srgb, var(--color-primary-6) 10%, transparent)",
    dotColor: "var(--color-primary-6)",
    headerBgColor: "color-mix(in srgb, var(--color-primary-6) 8%, transparent)",
  },
  {
    id: "blocking",
    title: "sessions:opsControl.columns.blocking",
    icon: MessageCircleWarning,
    color: "#FF8C42",
    bgColor: "rgba(255, 140, 66, 0.1)",
    dotColor: "#FF8C42",
    headerBgColor: "rgba(255, 140, 66, 0.08)",
  },
  {
    id: "turn_finished",
    title: "sessions:opsControl.columns.turnFinished",
    icon: CheckCircle2,
    color: "#52C41A",
    bgColor: "rgba(82, 196, 26, 0.1)",
    dotColor: "#52C41A",
    headerBgColor: "rgba(82, 196, 26, 0.08)",
  },
  {
    id: "archived",
    title: "sessions:opsControl.columns.archived",
    icon: Archive,
    color: "var(--color-text-3)",
    bgColor: "color-mix(in srgb, var(--color-fill-4) 18%, transparent)",
    dotColor: "var(--color-text-3)",
    headerBgColor: "color-mix(in srgb, var(--color-fill-4) 14%, transparent)",
  },
];

// ============================================
// Session Status → Kanban Column Mapping
// ============================================

const KANBAN_SESSION_STATUS = {
  IDLE: "idle",
  PENDING: "pending",
  QUEUED: "queued",
  RUNNING: "running",
  IN_PROGRESS: "in_progress",
  INSTALLING: "installing",
  WAITING_FOR_USER: "waiting_for_user",
  WAITING_FOR_FUNDS: "waiting_for_funds",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  ERROR: "error",
  CANCELLED: "cancelled",
  ABANDONED: "abandoned",
  TIMEOUT: "timeout",
  KILLED: "killed",
} as const;

const TODO_SESSION_STATUSES = new Set<string>([
  KANBAN_SESSION_STATUS.PENDING,
  KANBAN_SESSION_STATUS.QUEUED,
]);

const RUNNING_SESSION_STATUSES = new Set<string>([
  KANBAN_SESSION_STATUS.RUNNING,
  KANBAN_SESSION_STATUS.IN_PROGRESS,
  KANBAN_SESSION_STATUS.INSTALLING,
]);

const ACTIVE_SESSION_STATUSES = new Set<string>([
  ...TODO_SESSION_STATUSES,
  ...RUNNING_SESSION_STATUSES,
]);

/**
 * Full session → Kanban column routing for Agent Kanban.
 *
 * Priority order (first match wins):
 *   1. Pending / queued session statuses     → todo
 *   2. Running / installing session statuses → in_progress
 *   3. Waiting for user action               → blocking
 *   4. Manual archive override               → archived
 *   5. Idle longer than auto-archive TTL     → archived
 *   6. Everything else                       → turn_finished
 */
export function mapSessionToKanbanColumn(
  session: Session,
  options: {
    manualArchivedSessionIds?: ReadonlySet<string>;
    autoArchiveTtl?: KanbanAutoArchiveTtl;
    nowMs?: number;
  } = {}
): AgentKanbanColumnId {
  const status = session.status;
  if (TODO_SESSION_STATUSES.has(status)) {
    return "todo";
  }

  if (RUNNING_SESSION_STATUSES.has(status)) {
    return "in_progress";
  }

  if (status === KANBAN_SESSION_STATUS.WAITING_FOR_USER) {
    return "blocking";
  }

  if (options.manualArchivedSessionIds?.has(session.session_id)) {
    return "archived";
  }

  if (isSessionAutoArchived(session, options.autoArchiveTtl, options.nowMs)) {
    return "archived";
  }

  return "turn_finished";
}

// ============================================
// Time Filter Configuration
// ============================================

export type KanbanTimeFilter = "12h" | "24h" | "3d" | "7d";
export type KanbanAutoArchiveTtl = "never" | "12h" | "24h" | "3d" | "7d";

export const KANBAN_TIME_FILTERS: {
  key: KanbanTimeFilter;
  labelKey: string;
}[] = [
  { key: "12h", labelKey: "opsControl.timeFilter.12h" },
  { key: "24h", labelKey: "opsControl.timeFilter.24h" },
  { key: "3d", labelKey: "opsControl.timeFilter.3d" },
  { key: "7d", labelKey: "opsControl.timeFilter.7d" },
];

export const KANBAN_AUTO_ARCHIVE_TTLS: {
  key: KanbanAutoArchiveTtl;
  labelKey: string;
}[] = [
  { key: "never", labelKey: "opsControl.autoArchive.never" },
  { key: "12h", labelKey: "opsControl.autoArchive.12h" },
  { key: "24h", labelKey: "opsControl.autoArchive.24h" },
  { key: "3d", labelKey: "opsControl.autoArchive.3d" },
  { key: "7d", labelKey: "opsControl.autoArchive.7d" },
];

const TIME_FILTER_MS: Record<KanbanTimeFilter, number> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const AUTO_ARCHIVE_TTL_MS: Record<
  Exclude<KanbanAutoArchiveTtl, "never">,
  number
> = {
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/**
 * Returns the cutoff timestamp for time-based filters.
 * Sessions with `updated_at` before this cutoff are excluded.
 */
export function getTimeFilterCutoff(filter: KanbanTimeFilter): number {
  return Date.now() - TIME_FILTER_MS[filter];
}

function getSessionActivityTimestampMs(session: Session): number {
  const timestamp =
    session.updated_at || session.completed_at || session.created_at;
  if (!timestamp) return 0;
  const parsed = new Date(timestamp).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSessionAutoArchived(
  session: Session,
  ttl: KanbanAutoArchiveTtl = "24h",
  nowMs: number = Date.now()
): boolean {
  if (ttl === "never") return false;
  if (ACTIVE_SESSION_STATUSES.has(session.status)) return false;
  const lastActivityMs = getSessionActivityTimestampMs(session);
  if (lastActivityMs <= 0) return false;
  return nowMs - lastActivityMs >= AUTO_ARCHIVE_TTL_MS[ttl];
}

// ============================================
// Helper Functions
// ============================================

export function getColumnConfig(
  status: AgentKanbanColumnId
): AgentKanbanColumnConfig {
  return KANBAN_COLUMNS.find((col) => col.id === status) || KANBAN_COLUMNS[0];
}
