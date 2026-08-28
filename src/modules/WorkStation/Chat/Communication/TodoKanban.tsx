/**
 * TodoKanban Component
 *
 * Replaces the stacked TodoBubble list when viewMode === "todo". Renders the
 * latest task snapshot using the shared `features/KanbanBoard` so the
 * Communication app stays visually consistent with the other Kanban
 * surfaces. The board is read-only here (no drag, no add-task). Agent Org
 * sessions use their durable run view; ordinary sessions replay manage_todo
 * events.
 *
 * Column layout: a 3-column board ("Scheduled" / "Done" / "Cancelled").
 * `pending` and `in_progress` both land in the Scheduled column; the
 * per-task lifecycle is conveyed on the card's second line (the `description`
 * slot) so the column count reflects "remaining work", not lifecycle phase.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { type AgentOrgTask, TOOL_NAMES } from "@src/api/tauri/agent";
import type { RustOrgTaskItem } from "@src/engines/SessionCore/core/types";
import { isPersistedOrgTaskEvent } from "@src/engines/SessionCore/rendering/orgTaskOutcome";
import { extractTodoData } from "@src/engines/SessionCore/rendering/props";
import KanbanBoard, {
  DEFAULT_KANBAN_COLUMNS,
  type KanbanColumnConfig,
  type KanbanTask,
  type TaskStatus,
} from "@src/features/KanbanBoard";
import { createLogger } from "@src/hooks/logger";
import {
  Add01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleIcon,
  Clock01Icon,
  type IconSvgElement,
} from "@src/icons";
import { normalizeActivity } from "@src/lib/activityData";
import { preserveTodoContent } from "@src/store/ui/todoMerge";
import { formatSmartDateTime } from "@src/util/data/formatters/date";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

import type { MessageEntry } from "./types";

const log = createLogger("TodoKanban");

// Below this threshold we keep the relative "X min ago" feel; above it
// we switch to absolute clock time (HH:mm, prefixed with Yesterday / month
// when the date drifts). One hour matches the user's mental model: minutes
// scale as "live activity", hours don't.
const ABSOLUTE_TIME_THRESHOLD_MS = 60 * 60 * 1000;

function formatTodoStamp(
  ts: string,
  yesterdayLabel: string,
  minutesAgoLabel: (mins: number) => string,
  nowLabel: string
): string {
  const parsed = new Date(ts).getTime();
  if (Number.isNaN(parsed)) return "";
  const diffMs = Date.now() - parsed;
  if (diffMs < 0) return nowLabel;
  if (diffMs < ABSOLUTE_TIME_THRESHOLD_MS) {
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return nowLabel;
    return minutesAgoLabel(mins);
  }
  return formatSmartDateTime(ts, { yesterdayLabel });
}

interface TodoLike {
  id?: string;
  content?: string;
  description?: string;
  status?: string;
  ownerName?: string;
  owner?: string;
  priority?: KanbanTask["priority"];
}

// Derived from the event stream: when a todo `id` first appears in any
// manage_todo event we treat that event's timestamp as `createdAt`; whenever
// the same `id` shows up later with a changed `content` or `status` we bump
// `updatedAt`. This keeps the surface schema-free — works equally for ORGII
// `manage_todo` events and Cursor `todo_write` events normalized by
// `cursor_db_history.rs`, neither of which currently carry per-todo
// timestamps on the wire.
interface TodoTimelineEntry {
  createdTs: string;
  updatedTs: string;
}

type TodoLifecycleStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

// `manage_todo` (and the equivalent Cursor IDE `todo_write` tool, normalized
// by `cursor_db_history.rs`) only emits four status values: `pending`,
// `in_progress`, `completed`, `cancelled`. Both schemas are pinned in their
// respective JSON-schema enums, so we map them as exact-string matches —
// no substring `includes()` games, no silent fallback for unknown values.
function normalizeLifecycleStatus(
  status: string | undefined
): TodoLifecycleStatus {
  switch ((status || "").toLowerCase()) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "":
      return "pending";
    default:
      if (process.env.NODE_ENV !== "production") {
        log.warn(
          `[TodoKanban] Unknown todo status ${JSON.stringify(status)} — ` +
            `routing to 'pending'. Expected one of: pending, in_progress, completed, cancelled.`
        );
      }
      return "pending";
  }
}

// Map a lifecycle status to the kanban column it lives in. `pending` and
// `in_progress` both belong to the merged "Scheduled" column; the
// distinction shows up on the card body, not the column header.
function lifecycleToColumn(status: TodoLifecycleStatus): TaskStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "in_progress":
      return "planned";
  }
}

// We borrow the column styling (colors, dot, header bg) from the default
// kanban palette for `done` and `cancelled` so we stay visually consistent
// with the other kanban surfaces. The first column reuses the neutral
// "todo" palette but with a session-scoped "Open" label —
// the generic `boardColumns.todo` ("Scheduled") reads wrong inside a
// running session, where these todos are this agent's own work list.
const DEFAULT_BY_ID = new Map(
  DEFAULT_KANBAN_COLUMNS.map((column) => [column.id, column])
);

// `title` here is an i18n key resolved by `KanbanColumn` via `t()`. We
// override the default `boardColumns.*` labels with session-scoped keys
// because "Scheduled" / "Done" / "Cancelled" read as project-management
// jargon, whereas this kanban shows the agent's own in-session work list.
function buildTodoColumns(): KanbanColumnConfig[] {
  const openBase = DEFAULT_BY_ID.get("planned");
  const doneBase = DEFAULT_BY_ID.get("completed");
  const cancelledBase = DEFAULT_BY_ID.get("cancelled");

  if (!openBase || !doneBase || !cancelledBase) {
    throw new Error(
      "TodoKanban: DEFAULT_KANBAN_COLUMNS is missing one of planned/completed/cancelled — palette drift."
    );
  }

  return [
    {
      ...openBase,
      title: "sessions:planner.todoList.columnOpen",
      icon: CircleIcon,
    },
    {
      ...doneBase,
      title: "sessions:planner.todoList.status.completed",
    },
    {
      ...cancelledBase,
      title: "sessions:planner.todoList.status.cancelled",
    },
  ];
}

const TODO_COLUMNS: KanbanColumnConfig[] = buildTodoColumns();

function normalizePriority(
  priority: string | undefined
): KanbanTask["priority"] | undefined {
  const normalizedPriority = (priority || "").toLowerCase();
  switch (normalizedPriority) {
    case "low":
    case "medium":
    case "high":
    case "urgent":
      return normalizedPriority as KanbanTask["priority"];
    default:
      return undefined;
  }
}

function normalizeOwnerDisplayName(
  ownerName: string | undefined,
  owner: string | undefined
): string | undefined {
  const named = ownerName?.trim();
  if (named) return named;
  const rawOwner = owner?.trim();
  if (!rawOwner) return undefined;
  return prettifyMemberName(rawOwner);
}

function orgTaskToTodo(task: RustOrgTaskItem): TodoLike {
  return {
    id: task.id,
    content: task.subject ?? task.activeForm ?? task.description ?? task.id,
    description: task.description,
    status: task.status,
    ownerName: task.ownerName,
    owner: task.owner,
    priority: normalizePriority(task.priority),
  };
}

// Extract the todo array from a single todo-routed message. Centralized so
// the timeline scan and the "latest snapshot" lookup stay in lockstep.
function todosFromMessage(message: MessageEntry): TodoLike[] {
  const extracted = message.event.extracted;
  if (extracted?.kind === "orgTask") {
    if (
      !isPersistedOrgTaskEvent(
        extracted,
        message.event.result,
        message.event.displayStatus
      )
    ) {
      return [];
    }
    // Deletion is an operation on the task row, not a task lifecycle status.
    // `buildTimeline` removes the referenced row explicitly below.
    if (extracted.action === "delete") return [];
    if (extracted.tasks && extracted.tasks.length > 0) {
      return extracted.tasks.map(orgTaskToTodo);
    }
    if (extracted.task) {
      return [orgTaskToTodo(extracted.task)];
    }
    return [];
  }

  const normalized = normalizeActivity(
    message.event as unknown as Record<string, unknown>
  );
  const todoData = extractTodoData({
    eventId: message.eventId,
    eventType: "manage_todo",
    args: normalized.args,
    result: normalized.result,
    status: "success" as const,
    variant: "simulator" as const,
    context: "simulator" as const,
    rustExtracted: message.event.extracted,
  });
  return todoData.todos as TodoLike[];
}

// Walk every manage_todo event in chronological order and accumulate
// per-`id` first-seen / last-changed timestamps. Returns the map plus the
// final todo snapshot (the list rendered in the kanban).
function isSnapshotMessage(message: MessageEntry): boolean {
  const extracted = message.event.extracted;
  if (extracted?.kind !== "orgTask") {
    // Old persisted graph-create events may predate Rust extraction. They are
    // additive mutations, never authoritative snapshots; treating their empty
    // generic-todo projection as a snapshot would erase the replay board.
    return message.event.functionName !== TOOL_NAMES.TASK_GRAPH_CREATE;
  }
  return (
    extracted.action === "list" &&
    isPersistedOrgTaskEvent(
      extracted,
      message.event.result,
      message.event.displayStatus
    )
  );
}

export function buildTimeline(messages: MessageEntry[]): {
  todos: TodoLike[];
  timeline: Map<string, TodoTimelineEntry>;
} {
  const timeline = new Map<
    string,
    TodoTimelineEntry & { lastContent: string; lastStatus: string }
  >();
  const todoMap = new Map<string, TodoLike>();

  for (const message of messages) {
    const snapshot = todosFromMessage(message);
    const ts = message.timestamp;
    const extracted = message.event.extracted;
    if (
      extracted?.kind === "orgTask" &&
      extracted.action === "delete" &&
      isPersistedOrgTaskEvent(
        extracted,
        message.event.result,
        message.event.displayStatus
      )
    ) {
      const deletedIds = [
        ...(extracted.task ? [extracted.task.id] : []),
        ...(extracted.tasks ?? []).map((task) => task.id),
      ];
      for (const deletedId of deletedIds) {
        if (deletedId) todoMap.delete(deletedId);
      }
      continue;
    }
    const previousTodos = Array.from(todoMap.values());
    const reconciledSnapshot = preserveTodoContent(previousTodos, snapshot);
    if (isSnapshotMessage(message)) {
      todoMap.clear();
    }

    for (
      let todoIndex = 0;
      todoIndex < reconciledSnapshot.length;
      todoIndex++
    ) {
      const todo = reconciledSnapshot[todoIndex];
      // Fall back to position when the source omitted a stable id. This is
      // best-effort: positional ids only match across events if the list
      // wasn't reordered, but it's better than collapsing every id-less
      // todo into a single bucket.
      const id = todo.id || `__pos_${todoIndex}`;
      const content = todo.content || "";
      const status = todo.status || "";
      const existing = timeline.get(id);
      if (!existing) {
        timeline.set(id, {
          createdTs: ts,
          updatedTs: ts,
          lastContent: content,
          lastStatus: status,
        });
      } else if (
        existing.lastContent !== content ||
        existing.lastStatus !== status
      ) {
        existing.updatedTs = ts;
        existing.lastContent = content;
        existing.lastStatus = status;
      }
      todoMap.set(id, { ...todo, id });
    }
  }

  // Strip the internal `lastContent` / `lastStatus` tracking fields before
  // returning — callers only care about the timestamps.
  const cleaned = new Map<string, TodoTimelineEntry>();
  for (const [id, entry] of timeline) {
    cleaned.set(id, { createdTs: entry.createdTs, updatedTs: entry.updatedTs });
  }
  return { todos: Array.from(todoMap.values()), timeline: cleaned };
}

export function buildAgentOrgTaskTimeline(tasks: readonly AgentOrgTask[]): {
  todos: TodoLike[];
  timeline: Map<string, TodoTimelineEntry>;
} {
  const timeline = new Map<string, TodoTimelineEntry>();
  const todos = tasks.map((task) => {
    timeline.set(task.id, {
      createdTs: task.createdAt,
      updatedTs: task.updatedAt,
    });
    const ownerName = task.ownerMember
      ? [task.ownerMember.name, task.ownerMember.role]
          .filter(Boolean)
          .join(" · ")
      : undefined;
    return {
      id: task.id,
      content: task.subject,
      description: task.description,
      status: task.status,
      ownerName,
      owner: task.owner ?? undefined,
    };
  });
  return { todos, timeline };
}

export function buildTodoKanbanTimeline(
  messages: MessageEntry[],
  agentOrgTasks?: readonly AgentOrgTask[]
): { todos: TodoLike[]; timeline: Map<string, TodoTimelineEntry> } {
  return agentOrgTasks === undefined
    ? buildTimeline(messages)
    : buildAgentOrgTaskTimeline(agentOrgTasks);
}

interface TodoKanbanProps {
  messages: MessageEntry[];
  /** Defined for Agent Org sessions, including a valid empty task list. */
  agentOrgTasks?: readonly AgentOrgTask[];
}

export const TodoKanban: React.FC<TodoKanbanProps> = ({
  messages,
  agentOrgTasks,
}) => {
  const { t } = useTranslation("sessions");

  // Agent Org task state is cross-session: workers complete tasks in their own
  // sessions, so replaying only the root event stream can never be authoritative.
  // The run view already projects the durable `agent_org_tasks` table and is
  // therefore the source of truth whenever it is available. Ordinary sessions
  // keep the existing event-replay behavior.
  const { todos, timeline } = useMemo(
    () => buildTodoKanbanTimeline(messages, agentOrgTasks),
    [agentOrgTasks, messages]
  );

  // Translated chunks needed by `formatTodoStamp`. Hoisted out of the map
  // callback so we don't re-look-up i18n keys for every todo row.
  const yesterdayLabel = t("planner.todoList.yesterday");
  const nowLabel = t("planner.todoList.justNow");
  const minutesAgoLabel = useCallback(
    (mins: number) => t("planner.todoList.minutesAgo", { count: mins }),
    [t]
  );

  const tasks = useMemo<KanbanTask[]>(
    () =>
      todos.map((todo, index) => {
        const lifecycle = normalizeLifecycleStatus(todo.status);
        const id = todo.id || `__pos_${index}`;
        const stamps = timeline.get(id);
        const createdLabel = stamps
          ? formatTodoStamp(
              stamps.createdTs,
              yesterdayLabel,
              minutesAgoLabel,
              nowLabel
            )
          : "";
        const updatedLabel = stamps
          ? formatTodoStamp(
              stamps.updatedTs,
              yesterdayLabel,
              minutesAgoLabel,
              nowLabel
            )
          : "";
        // Inline pills rendered next to priority / agent / model in the
        // card footer via TaskCard's `metaLines` slot. Icons carry the
        // semantic (GitCommitVertical = updated, Plus = created) so we
        // drop the "Created at / Updated at" text prefix and only show
        // the timestamp itself — keeps both pills compact enough to fit
        // alongside the other footer metadata. The `updated` pill comes
        // first because it reflects the todo's current lifecycle state,
        // which is what the user is most likely scanning for. We omit
        // `updated` when it equals `created` (todo hasn't moved since
        // first appearing) to avoid duplicate-looking pills.
        //
        // The `updated` pill carries the lifecycle signal: icon + color
        // mirror the column the todo sits in.
        //   pending / in_progress → Clock        @ text-2
        //   completed              → CheckCircle2 @ success-6 (matches
        //                                          the Done column header)
        //   cancelled              → XCircle      @ danger-6   (matches
        //                                          the Cancelled column header)
        // The `created` pill is always Plus @ text-2 because it
        // describes when the todo entered the list, not its current
        // state — coloring it would imply the creation itself succeeded
        // or failed.
        let updatedIcon: IconSvgElement = Clock01Icon;
        let updatedColor: string = "var(--color-text-2)";
        if (lifecycle === "completed") {
          updatedIcon = CheckmarkCircle01Icon;
          updatedColor = "var(--color-success-6)";
        } else if (lifecycle === "cancelled") {
          updatedIcon = CancelCircleIcon;
          updatedColor = "var(--color-danger-6)";
        }
        const metaLines: Array<{
          icon: IconSvgElement;
          text: string;
          color?: string;
        }> = [];
        if (updatedLabel && stamps && stamps.updatedTs !== stamps.createdTs) {
          metaLines.push({
            icon: updatedIcon,
            text: updatedLabel,
            color: updatedColor,
          });
        }
        if (createdLabel) {
          metaLines.push({
            icon: Add01Icon,
            text: createdLabel,
            color: "var(--color-text-2)",
          });
        }
        const ownerDisplayName = normalizeOwnerDisplayName(
          todo.ownerName,
          todo.owner
        );
        const description = [ownerDisplayName, todo.description]
          .filter(Boolean)
          .join(" · ");
        return {
          id: todo.id || `todo-${index}`,
          title: todo.content || "",
          description: description || undefined,
          assignee: ownerDisplayName,
          priority: todo.priority,
          metaLines,
          status: lifecycleToColumn(lifecycle),
        };
      }),
    [todos, timeline, yesterdayLabel, nowLabel, minutesAgoLabel]
  );

  // `kanban-board--linear` matches the Kanban / WorkItems styling
  // (column-as-card, fill-2 surface, floating task cards).
  return (
    <div
      data-testid="replay-todo-kanban"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <KanbanBoard
        tasks={tasks}
        columns={TODO_COLUMNS}
        allowColumnReorder={false}
        allowTaskDrag={false}
        showAddButton={false}
        className="kanban-board--linear kanban-board--embedded-todo"
      />
    </div>
  );
};

TodoKanban.displayName = "TodoKanban";

export default TodoKanban;
