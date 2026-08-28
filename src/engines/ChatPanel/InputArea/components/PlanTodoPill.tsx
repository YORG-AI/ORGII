import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useEffect, useId, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { pillControlStateClass } from "@src/components/CompoundPill/config";
import {
  DropdownHeader,
  DropdownPanel,
} from "@src/components/Dropdown/exports";
import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  ArrowRight01Icon,
  HugeiconsIcon,
  ListTodoIcon,
  LockIcon,
  Tick01Icon,
} from "@src/icons";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  type TodoItem,
  clearTodosForSessionAtom,
  getTodoBatchTitle,
  getTodosForSession,
  sessionTodoMapAtom,
} from "@src/store/ui/todoAtom";

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);

const TodoStatusIcon: React.FC<{ status: string; blocked?: boolean }> = ({
  status,
  blocked,
}) => {
  const normalizedStatus = status.toLowerCase();
  if (normalizedStatus === "completed") {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-green-600/80">
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={8}
          strokeWidth={3}
          className="text-white"
        />
      </span>
    );
  }
  if (normalizedStatus === "in_progress") {
    return (
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        data-icon="chevron-right"
        size={14}
        strokeWidth={2}
        className="shrink-0 text-primary-6"
      />
    );
  }
  if (blocked) {
    return (
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
        <HugeiconsIcon
          icon={LockIcon}
          data-icon="lock"
          size={6}
          strokeWidth={2.5}
          className="text-text-3/60"
        />
      </span>
    );
  }
  return (
    <span className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

function todoRowKey(todoId: string, index: number): string {
  return `plan-todo:${todoId || "missing"}:${index}`;
}

export function countCompletedTodos(todos: readonly TodoItem[]): number {
  return todos.filter((todo) => todo.status.toLowerCase().includes("completed"))
    .length;
}

interface PlanTodoPillProps {
  sessionId?: string | null;
}

const PlanTodoPill: React.FC<PlanTodoPillProps> = memo(({ sessionId }) => {
  const { t } = useTranslation("sessions");
  const todoMap = useAtomValue(sessionTodoMapAtom);
  const todos = useMemo(
    () => getTodosForSession(todoMap, sessionId),
    [todoMap, sessionId]
  );
  const isAgentWorking = useAtomValue(isSessionActiveAtom);
  const clearTodosForSession = useSetAtom(clearTodosForSessionAtom);
  const panelId = useId();
  const { isOpen, isPositioned, triggerRef, panelRef, panelPosition, toggle } =
    useDropdownEngine<HTMLButtonElement>({
      placement: "top",
      align: "left",
      gap: DROPDOWN_PANEL.triggerGapTight,
    });

  const allTerminal =
    todos.length > 0 &&
    todos.every((todo) => TERMINAL_STATUSES.has(todo.status.toLowerCase()));

  useEffect(() => {
    if (!isAgentWorking && allTerminal && sessionId) {
      clearTodosForSession(sessionId);
    }
  }, [isAgentWorking, allTerminal, sessionId, clearTodosForSession]);

  const panelPositionStyle = useMemo<React.CSSProperties>(
    () => ({
      ...(panelPosition.top !== undefined
        ? { top: panelPosition.top }
        : { bottom: panelPosition.bottom }),
      ...(panelPosition.right !== undefined
        ? { right: panelPosition.right }
        : { left: panelPosition.left }),
    }),
    [panelPosition]
  );

  if (todos.length === 0) return null;

  const completedCount = countCompletedTodos(todos);
  const label = getTodoBatchTitle(todos) || t("planner.todoList.title");
  const progressLabel = `${completedCount}/${todos.length}`;

  return (
    <>
      <Button
        ref={triggerRef as React.Ref<HTMLButtonElement>}
        variant="secondary"
        appearance="outline"
        size="small"
        shape="round"
        icon={
          <HugeiconsIcon
            icon={ListTodoIcon}
            data-icon="list-todo"
            size={13}
            strokeWidth={1.75}
          />
        }
        title={`${label} · ${progressLabel}`}
        aria-label={`${label} · ${progressLabel}`}
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        onClick={toggle}
        className={`shrink-0 tabular-nums ${pillControlStateClass(isOpen)}`}
      >
        {progressLabel}
      </Button>

      {isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef as React.Ref<HTMLDivElement>}
            id={panelId}
            role="region"
            aria-label={label}
            className="fixed flex w-[min(320px,calc(100vw-16px))] flex-col"
            maxHeight="min(360px, 60vh)"
            animated={false}
            style={panelPositionStyle}
          >
            <DropdownHeader>
              <HugeiconsIcon
                icon={ListTodoIcon}
                data-icon="list-todo"
                size={13}
                strokeWidth={1.75}
                className="shrink-0 text-text-2"
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-1">
                {label}
              </span>
              <span className="shrink-0 text-[12px] font-medium tabular-nums text-text-3">
                {progressLabel}
              </span>
            </DropdownHeader>

            <ul className="overflow-y-auto px-2 py-1.5 scrollbar-hide">
              {todos.map((todo, index) => {
                const done = todo.status.toLowerCase().includes("completed");
                const blocked =
                  !done &&
                  todo.blockedBy != null &&
                  todo.blockedBy.length > 0 &&
                  todo.blockedBy.some((blockerIndex) => {
                    const blocker = todos[blockerIndex];
                    return (
                      blocker != null &&
                      !blocker.status.toLowerCase().includes("completed")
                    );
                  });

                return (
                  <li
                    key={todoRowKey(todo.id, index)}
                    className={`flex min-h-7 items-start gap-2 rounded-md px-1.5 py-1 ${blocked ? "opacity-50" : ""}`}
                  >
                    <span className="mt-0.5">
                      <TodoStatusIcon status={todo.status} blocked={blocked} />
                    </span>
                    <span
                      className={`min-w-0 flex-1 text-[12px] leading-5 ${done ? "text-text-3 line-through" : "text-text-1"}`}
                    >
                      {todo.content}
                    </span>
                    {blocked && todo.blockedBy && (
                      <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[10px] text-text-3/70">
                        <HugeiconsIcon
                          icon={LockIcon}
                          data-icon="lock"
                          size={8}
                          strokeWidth={2}
                        />
                        {todo.blockedBy
                          .map((blockerIndex) => `#${blockerIndex}`)
                          .join(", ")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </DropdownPanel>,
          document.body
        )}
    </>
  );
});

PlanTodoPill.displayName = "PlanTodoPill";

export default PlanTodoPill;
