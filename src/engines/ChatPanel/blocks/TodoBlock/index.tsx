/**
 * TodoBlock - Inline task list display for chat history.
 *
 * Always renders the standard collapsible todo list using the same
 * EventBlockHeader + vertical-line pattern as other tool blocks.
 */
import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import {
  ChevronsDownUpIcon,
  HugeiconsIcon,
  LockIcon,
  Tick01Icon,
  UnfoldMoreIcon,
} from "@src/icons";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderInfo,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
  useEventBlockHeader,
} from "../primitives";

// ============================================
// Types
// ============================================

export interface TodoItem {
  id: string;
  content: string;
  /**
   * Optional present-continuous label. When a todo is `in_progress` the UI
   * prefers this form (e.g. "Running tests") over `content` ("Run tests")
   * so the row reads like a live spinner label.
   */
  activeForm?: string;
  status: string;
  /**
   * Indices of tasks that must complete before this task can start.
   * When non-empty, the task is rendered dimmed with a "▸ blocked by #N"
   * badge to show dependency ordering.
   */
  blockedBy?: number[];
}

export interface TodoBlockProps {
  todos: TodoItem[];
  wasMerge?: boolean;
  defaultCollapsed?: boolean;
  isLoading?: boolean;
  /** Pre-translated lifecycle label (e.g. "Updating to-do", "Updated to-do"). Falls back to the generic title key. */
  title?: string;
  toolUsage?: ToolUsageMetadata;
}

// ============================================
// Helpers
// ============================================

const normalizeStatus = (status: string): string =>
  (status || "").toLowerCase();

const isCompleted = (status: string): boolean => {
  const statusNorm = normalizeStatus(status);
  return statusNorm.includes("completed") || statusNorm === "completed";
};

const isInProgress = (status: string): boolean =>
  normalizeStatus(status) === "in_progress";

/**
 * Pick the label to render for a todo row:
 *   - in_progress + activeForm present  → activeForm ("Running tests")
 *   - any other case                     → content    ("Run tests")
 *
 * Centralised so every renderer (chat inline list, plan card, etc.) shows
 * the same text and we can evolve the rule (e.g. italics for activeForm)
 * in one place.
 */
function renderTodoLabel(todo: TodoItem): string {
  if (isInProgress(todo.status) && todo.activeForm && todo.activeForm.trim()) {
    return todo.activeForm;
  }
  return todo.content;
}

// ============================================
// TodoCheckbox
// ============================================

const TodoCheckbox: React.FC<{ status: string; blocked?: boolean }> = ({
  status,
  blocked,
}) => {
  if (isCompleted(status)) {
    return (
      <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-green-600/80">
        <HugeiconsIcon
          icon={Tick01Icon}
          data-icon="check"
          size={8}
          strokeWidth={3}
          className="text-white"
        />
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
        <HugeiconsIcon
          icon={LockIcon}
          data-icon="lock"
          size={6}
          strokeWidth={2.5}
          className="text-text-3/60"
        />
      </div>
    );
  }
  return (
    <div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

// ============================================
// StandardTodoBlock — collapsible inline card
//
// Collapsed: chevron + "N To-dos" header row
// Expanded:  list of todo rows with checkbox + label
// ============================================

const isChanged = (status: string): boolean => {
  const norm = normalizeStatus(status);
  return norm !== "pending";
};

/**
 * Returns true if the todo has unresolved blockers — i.e. there are
 * blockedBy indices that refer to tasks that are NOT yet completed or
 * cancelled. When all blockers are resolved we stop dimming the row.
 */
function hasOpenBlockers(todo: TodoItem, allTodos: TodoItem[]): boolean {
  if (!todo.blockedBy || todo.blockedBy.length === 0) return false;
  return todo.blockedBy.some((blockerIndex) => {
    const blocker = allTodos.find(
      (t, idx) => idx === blockerIndex || Number(t.id) === blockerIndex
    );
    if (!blocker) return false;
    const norm = normalizeStatus(blocker.status);
    return norm !== "completed" && norm !== "cancelled";
  });
}

function todoRowKey(todoId: string, index: number): string {
  return `chat-todo:${todoId || "missing"}:${index}`;
}

interface StandardTodoBlockProps {
  todos: TodoItem[];
  defaultCollapsed: boolean;
  wasMerge?: boolean;
  isLoading?: boolean;
  title?: string;
  toolUsage?: ToolUsageMetadata;
}

const StandardTodoBlock: React.FC<StandardTodoBlockProps> = memo(
  ({
    todos,
    defaultCollapsed,
    wasMerge = false,
    isLoading = false,
    title,
    toolUsage,
  }) => {
    const { t } = useTranslation("sessions");
    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
    } = useEventBlockHeader({ defaultCollapsed, collapseAllValue: true });
    const [isListExpanded, setIsListExpanded] = useState(false);

    if (todos.length === 0) return null;

    const completedCount = todos.filter((todoItem) =>
      isCompleted(todoItem.status)
    ).length;
    const totalCount = todos.length;

    const changedTodos = wasMerge
      ? todos.filter((todo) => isChanged(todo.status))
      : [];
    const needsExpand = wasMerge && changedTodos.length < totalCount;
    const visibleTodos = wasMerge && !isListExpanded ? changedTodos : todos;

    const infoLabel =
      completedCount > 0
        ? t("planner.todoList.completedCount", {
            completed: completedCount,
            total: totalCount,
          })
        : t("planner.todoList.countOnly", { total: totalCount });

    const todoIcon = getToolIcon("manage_todo", {
      size: 14,
      className: "text-text-2",
    });

    return (
      <div
        className={getEventBlockContainerClasses(false)}
        data-testid="chat-todo-block"
      >
        <EventBlockHeader
          isCollapsed={isCollapsed}
          onClick={handleHeaderClick}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={todoIcon}
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={handleHeaderClick}
            hasContent={true}
            isLoading={isLoading}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {title || t("planner.todoList.title")}
          </EventBlockHeaderTitle>
          <EventBlockHeaderInfo isLoading={isLoading}>
            {infoLabel}
          </EventBlockHeaderInfo>
        </EventBlockHeader>

        {!isCollapsed && (
          <div className={EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES}>
            <div className="flex flex-col p-1">
              {visibleTodos.map((todo, idx) => {
                const done = isCompleted(todo.status);
                const inProgress = isInProgress(todo.status);
                const blocked = hasOpenBlockers(todo, todos);
                return (
                  <div
                    key={todoRowKey(todo.id, idx)}
                    className={`group flex h-6 cursor-default items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-fill-2 ${blocked ? "opacity-50" : ""}`}
                  >
                    <div className="flex shrink-0 items-center justify-center self-center">
                      <TodoCheckbox status={todo.status} blocked={blocked} />
                    </div>
                    <span
                      className={`min-w-0 flex-1 truncate text-[13px] ${
                        done
                          ? "text-text-3 line-through"
                          : inProgress
                            ? "text-primary-6"
                            : "text-text-1"
                      }`}
                    >
                      {renderTodoLabel(todo)}
                    </span>
                    {blocked && todo.blockedBy && (
                      <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-text-3/70">
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
                  </div>
                );
              })}
              {needsExpand && (
                <button
                  type="button"
                  className="group flex h-6 w-full cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-1.5 text-left transition-colors hover:bg-fill-2"
                  aria-expanded={isListExpanded}
                  onClick={() => setIsListExpanded((prev) => !prev)}
                >
                  <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-3 transition-colors group-hover:text-text-1">
                    {isListExpanded ? (
                      <HugeiconsIcon
                        icon={ChevronsDownUpIcon}
                        data-icon="chevrons-down-up"
                        size={14}
                        strokeWidth={2}
                      />
                    ) : (
                      <HugeiconsIcon
                        icon={UnfoldMoreIcon}
                        data-icon="chevrons-up-down"
                        size={14}
                        strokeWidth={2}
                      />
                    )}
                  </div>
                  <span className="text-[13px] text-text-3 transition-colors group-hover:text-text-1">
                    {isListExpanded
                      ? t("common:showLess")
                      : t("common:showMore")}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }
);

StandardTodoBlock.displayName = "StandardTodoBlock";

// ============================================
// Main Export
// ============================================

const TodoBlock: React.FC<TodoBlockProps> = memo(
  ({
    todos,
    wasMerge = false,
    defaultCollapsed = true,
    isLoading = false,
    title,
    toolUsage,
  }) => {
    if (todos.length === 0) return null;

    return (
      <StandardTodoBlock
        todos={todos}
        defaultCollapsed={defaultCollapsed}
        wasMerge={wasMerge}
        isLoading={isLoading}
        title={title}
        toolUsage={toolUsage}
      />
    );
  }
);

TodoBlock.displayName = "TodoBlock";

export default TodoBlock;
