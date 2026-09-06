/**
 * SubagentPinnedPreviewPopover
 *
 * On-demand, keyboard-accessible plan preview in the subagent title row. Mirrors
 * the per-session plan-todo summary but scoped to the subagent's own session —
 * the composer `PlanTodoPill` reads
 * `workstationActiveSessionIdAtom`, which always points at the parent
 * chat panel, so we read `sessionTodoMapAtom` directly with the cell's
 * `sessionId` instead.
 *
 * The pane never renders when the subagent has no todos; this keeps cells
 * without a plan from leaving a hover hot-zone that points at nothing.
 */
import { atom, useAtomValue } from "jotai";
import React, { memo, useId, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArrowRight01Icon,
  HugeiconsIcon,
  ListTodoIcon,
  LockIcon,
  Tick01Icon,
} from "@src/icons";
import {
  type TodoItem,
  getTodoBatchTitle,
  getTodosForSession,
  sessionTodoMapAtom,
} from "@src/store/ui/todoAtom";

interface SubagentPinnedPreviewPopoverProps {
  sessionId: string | null | undefined;
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
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={7}
          strokeWidth={3}
          className="text-white"
        />
      </div>
    );
  }
  if (norm === "in_progress") {
    return (
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={12}
        strokeWidth={2}
        className="shrink-0 text-primary-6"
      />
    );
  }
  if (blocked) {
    return (
      <div className="flex h-3 w-3 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
        <HugeiconsIcon
          icon={LockIcon}
          data-icon="lock"
          size={5}
          strokeWidth={2.5}
          className="text-text-3/60"
        />
      </div>
    );
  }
  return (
    <div className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

const SubagentPinnedPreviewPopoverComponent: React.FC<
  SubagentPinnedPreviewPopoverProps
> = ({ sessionId }) => {
  const todosAtom = useMemo(
    () => atom((get) => getTodosForSession(get(sessionTodoMapAtom), sessionId)),
    [sessionId]
  );
  const todos = useAtomValue(todosAtom);
  if (
    todos.length === 0 ||
    todos.every((todo) => TERMINAL_STATUSES.has(todo.status))
  )
    return null;
  return <PlanPreview todos={todos} />;
};

function PlanPreview({ todos }: { todos: TodoItem[] }) {
  const { t } = useTranslation("sessions");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const { isOpen, isPositioned, toggle, close, panelRef, panelPosition } =
    useDropdownEngine<HTMLButtonElement>({
      anchorRef: buttonRef,
      captureKeyboardFocus: true,
      autoKeyboardNavigation: false,
    });

  const completedCount = todos.filter((todo) =>
    TERMINAL_STATUSES.has(todo.status)
  ).length;
  const label = getTodoBatchTitle(todos) || t("planner.todoList.title");

  return (
    <>
      <Button
        ref={buttonRef}
        htmlType="button"
        variant="tertiary"
        size="small"
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        aria-haspopup="dialog"
        aria-label={`${label}: ${completedCount}/${todos.length}`}
        title={label}
        onClick={toggle}
        icon={
          <HugeiconsIcon icon={ListTodoIcon} size={12} strokeWidth={1.75} />
        }
      >
        <span className="tabular-nums">
          {completedCount}/{todos.length}
        </span>
      </Button>
      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
                buttonRef.current?.focus();
              }
            }}
            className="fixed z-50 flex w-80 max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg border border-border-2 bg-bg-1 shadow-lg"
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
              maxHeight: panelPosition.maxHeight,
              visibility: isPositioned ? "visible" : "hidden",
            }}
          >
            <div className="flex items-center gap-1.5 border-b border-border-2/60 px-3 py-1.5">
              <HugeiconsIcon
                icon={ListTodoIcon}
                data-icon="list-todo"
                size={12}
                strokeWidth={1.75}
                className="text-text-2"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-1">
                {label}
              </span>
              <span className="shrink-0 rounded bg-fill-2 px-1.5 py-0.5 text-[10px] text-text-2 tabular-nums">
                {completedCount}/{todos.length}
              </span>
            </div>
            <ul
              tabIndex={0}
              aria-label={label}
              className="min-h-0 overflow-y-auto px-2 py-1.5"
            >
              {todos.map((todo, idx) => {
                const norm = todo.status.toLowerCase();
                const done = norm === "completed";
                const blocked =
                  !done &&
                  todo.blockedBy != null &&
                  todo.blockedBy.length > 0 &&
                  todo.blockedBy.some((blockerIdx) => {
                    const blocker = todos[blockerIdx - 1];
                    return (
                      blocker != null &&
                      blocker.status.toLowerCase() !== "completed"
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
          </div>,
          document.body
        )}
    </>
  );
}

export const SubagentPinnedPreviewPopover = memo(
  SubagentPinnedPreviewPopoverComponent
);
SubagentPinnedPreviewPopover.displayName = "SubagentPinnedPreviewPopover";
