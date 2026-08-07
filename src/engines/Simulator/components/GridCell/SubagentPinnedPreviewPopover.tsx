/**
 * SubagentPinnedPreviewPopover
 *
 * Hover-revealed popover surfaced from the subagent cell title row. Mirrors
 * the per-session plan-todo summary but scoped to the subagent's own session —
 * the composer `PlanTodoPill` reads
 * `workstationActiveSessionIdAtom`, which always points at the parent
 * chat panel, so we read `sessionTodoMapAtom` directly with the cell's
 * `sessionId` instead.
 *
 * The pane never renders when the subagent has no todos; this keeps cells
 * without a plan from leaving a hover hot-zone that points at nothing.
 */
import { useAtomValue } from "jotai";
import { Check, ChevronRight, ListTodo, Lock } from "lucide-react";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  type TodoItem,
  getTodoBatchTitle,
  getTodosForSession,
  sessionTodoMapAtom,
} from "@src/store/ui/todoAtom";

interface SubagentPinnedPreviewPopoverProps {
  sessionId: string | null | undefined;
  /** When true, the popover is visible. Driven by the cell's header-hover
   *  state in `IndependentGridCell` so it stays in lockstep with the
   *  action buttons' fade-in / fade-out timing. */
  open: boolean;
}

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

const TodoStatusIcon: React.FC<{ status: string; blocked?: boolean }> = ({
  status,
  blocked,
}) => {
  const norm = status.toLowerCase();
  if (norm === "completed") {
    return (
      <div className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-green-600/80">
        <Check size={7} strokeWidth={3} className="text-white" />
      </div>
    );
  }
  if (norm === "in_progress") {
    return (
      <ChevronRight
        size={12}
        strokeWidth={2}
        className="shrink-0 text-primary-6"
      />
    );
  }
  if (blocked) {
    return (
      <div className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
        <Lock size={5} strokeWidth={2.5} className="text-text-3/60" />
      </div>
    );
  }
  return (
    <div className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

const SubagentPinnedPreviewPopoverComponent: React.FC<
  SubagentPinnedPreviewPopoverProps
> = ({ sessionId, open }) => {
  const { t } = useTranslation("sessions");
  const todoMap = useAtomValue(sessionTodoMapAtom);

  const todos = useMemo<TodoItem[]>(
    () => getTodosForSession(todoMap, sessionId ?? null),
    [todoMap, sessionId]
  );

  if (todos.length === 0) return null;

  const completedCount = todos.filter((todo) =>
    TERMINAL_STATUSES.has(todo.status.toLowerCase())
  ).length;

  // Same "fully done — nothing useful to surface" guard as PlanTodoPill.
  if (completedCount === todos.length) return null;

  const label = getTodoBatchTitle(todos) || t("planner.todoList.title");

  return (
    <div
      role="tooltip"
      className={`pointer-events-none absolute left-2 right-2 top-full z-30 mt-1 max-h-[60vh] overflow-hidden rounded-lg border border-border-2 bg-bg-1 shadow-lg transition-opacity duration-150 ${
        open ? "opacity-100" : "invisible opacity-0"
      }`}
    >
      <div className="flex items-center gap-1.5 border-b border-border-2/60 px-3 py-1.5">
        <ListTodo size={12} strokeWidth={1.75} className="text-text-2" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-1">
          {label}
        </span>
        <span className="shrink-0 rounded bg-fill-2 px-1.5 py-0.5 text-[10px] tabular-nums text-text-2">
          {completedCount}/{todos.length}
        </span>
      </div>
      <ul className="max-h-[40vh] overflow-y-auto px-2 py-1.5">
        {todos.map((todo, idx) => {
          const norm = todo.status.toLowerCase();
          const done = norm === "completed";
          const blocked =
            !done &&
            todo.blockedBy != null &&
            todo.blockedBy.length > 0 &&
            todo.blockedBy.some((blockerIdx) => {
              const blocker = todos[blockerIdx];
              return (
                blocker != null && blocker.status.toLowerCase() !== "completed"
              );
            });
          return (
            <li
              key={todo.id || idx}
              className={`flex items-center gap-1.5 py-0.5 ${blocked ? "opacity-50" : ""}`}
            >
              <TodoStatusIcon status={todo.status} blocked={blocked} />
              <span
                className={`min-w-0 flex-1 truncate text-[12px] ${
                  done ? "text-text-3 line-through" : "text-text-1"
                }`}
                title={todo.content}
              >
                {todo.content}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export const SubagentPinnedPreviewPopover = memo(
  SubagentPinnedPreviewPopoverComponent
);
SubagentPinnedPreviewPopover.displayName = "SubagentPinnedPreviewPopover";
