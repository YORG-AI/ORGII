import { CheckSquare2, Plus, Trash2, X } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Input from "@src/components/Input";
import { ActivityHeaderActionButton } from "@src/modules/shared/components/ActivityTimeline";
import type { TodoItem } from "@src/types/core/workItem";

import { WorkItemThreadSection } from "../WorkItemThread";
import {
  THREAD_TODO_MAX_LENGTH,
  createThreadTodo,
  normalizeThreadTodos,
} from "./threadTodos";

interface ThreadTodoChecklistProps {
  todos: TodoItem[];
  onChange: (todos: TodoItem[]) => void;
  disabled?: boolean;
}

const ThreadTodoChecklist: React.FC<ThreadTodoChecklistProps> = ({
  todos,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const normalizedTodos = useMemo(() => normalizeThreadTodos(todos), [todos]);
  const completedCount = normalizedTodos.filter(
    (todo) => todo.status === "completed"
  ).length;

  useEffect(() => {
    if (adding) inputRef.current?.focus({ preventScroll: true });
  }, [adding]);

  const closeComposer = () => {
    setAdding(false);
    setDraft("");
  };

  const commitDraft = () => {
    const nextTodo = createThreadTodo(draft, Date.now());
    if (!nextTodo) {
      closeComposer();
      return;
    }
    onChange([...normalizedTodos, nextTodo]);
    setDraft("");
    requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true })
    );
  };

  return (
    <WorkItemThreadSection
      testId="work-item-thread-todos"
      icon={
        <CheckSquare2
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-text-3"
          aria-hidden
        />
      }
      title={
        <span className="font-normal">
          {t("projects:workItems.todos.title")}
        </span>
      }
      meta={
        <span className="text-[11px] tabular-nums text-text-4">
          {completedCount}/{normalizedTodos.length}
        </span>
      }
      action={
        !disabled ? (
          <ActivityHeaderActionButton
            icon={<Plus size={12} aria-hidden />}
            label={t("common:actions.add")}
            onClick={() => setAdding(true)}
            disabled={adding}
            data-testid="work-item-thread-todo-add"
          />
        ) : null
      }
    >
      {normalizedTodos.length === 0 && !adding ? (
        <Button
          variant="tertiary"
          appearance="ghost"
          size="small"
          long
          icon={!disabled ? <Plus size={13} aria-hidden /> : undefined}
          iconPosition="right"
          className="!h-auto !justify-between !rounded-lg !px-2 !py-2 !text-left !text-[12px] !font-normal !text-text-3 hover:!bg-fill-1 hover:!text-text-2"
          onClick={() => setAdding(true)}
          disabled={disabled}
          data-testid="work-item-thread-todos-empty"
        >
          {t("projects:workItems.todos.addFirst")}
        </Button>
      ) : (
        <div className="flex flex-col gap-0.5">
          {normalizedTodos.map((todo) => (
            <div
              key={todo.id}
              className="group flex min-h-8 items-start gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-fill-1"
            >
              <div className="flex h-6 shrink-0 items-center">
                <Checkbox
                  checked={todo.status === "completed"}
                  onChange={() =>
                    onChange(
                      normalizedTodos.map((candidate) =>
                        candidate.id === todo.id
                          ? {
                              ...candidate,
                              status:
                                candidate.status === "completed"
                                  ? "pending"
                                  : "completed",
                            }
                          : candidate
                      )
                    )
                  }
                  disabled={disabled}
                />
              </div>
              <span
                className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-6 ${
                  todo.status === "completed"
                    ? "text-text-3 line-through"
                    : "text-text-1"
                }`}
              >
                {todo.content}
              </span>
              {!disabled ? (
                <Button
                  variant="tertiary"
                  appearance="ghost"
                  size="mini"
                  shape="square"
                  iconOnly
                  icon={<Trash2 size={13} aria-hidden />}
                  className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                  aria-label={t("common:actions.delete")}
                  onClick={() =>
                    onChange(
                      normalizedTodos.filter(
                        (candidate) => candidate.id !== todo.id
                      )
                    )
                  }
                />
              ) : null}
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="flex items-center gap-2 py-2">
          <Input
            ref={inputRef}
            value={draft}
            onChange={setDraft}
            maxLength={THREAD_TODO_MAX_LENGTH}
            size="small"
            appearance="ghost"
            className="min-w-0 flex-1"
            inputClassName="text-[13px] !font-normal"
            placeholder={t("projects:workItems.todos.placeholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitDraft();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeComposer();
              }
            }}
            data-testid="work-item-thread-todo-input"
          />
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            shape="square"
            iconOnly
            icon={<Plus size={13} aria-hidden />}
            aria-label={t("common:actions.add")}
            disabled={!draft.trim()}
            onClick={commitDraft}
            data-testid="work-item-thread-todo-commit"
          />
          <Button
            variant="tertiary"
            appearance="ghost"
            size="small"
            shape="square"
            iconOnly
            icon={<X size={13} aria-hidden />}
            aria-label={t("common:actions.cancel")}
            onClick={closeComposer}
            data-testid="work-item-thread-todo-cancel"
          />
        </div>
      ) : null}
    </WorkItemThreadSection>
  );
};

export default ThreadTodoChecklist;
