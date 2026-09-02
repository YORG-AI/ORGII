import React, { memo } from "react";

import { HugeiconsIcon, LockIcon, Tick01Icon } from "@src/icons";

import {
  type CommunicationTodoItem,
  communicationTodoRowKey,
  hasOpenCommunicationTodoBlockers,
  isTodoCompleted,
  isTodoInProgress,
  renderCommunicationTodoLabel,
} from "./bubbleParsers";

const CommunicationTodoCheckbox: React.FC<{
  status: string;
  blocked?: boolean;
}> = ({ status, blocked }) => {
  if (isTodoCompleted(status)) {
    return (
      <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-green-600/80">
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
      <div className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
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
    <div className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

export const CommunicationTodoList: React.FC<{
  todos: CommunicationTodoItem[];
}> = memo(({ todos }) => {
  if (todos.length === 0) return null;

  return (
    <div className="rounded-lg border border-border-2 bg-transparent p-1">
      {todos.map((todo, index) => {
        const done = isTodoCompleted(todo.status);
        const inProgress = isTodoInProgress(todo.status);
        const blocked = hasOpenCommunicationTodoBlockers(todo, todos);
        return (
          <div
            key={communicationTodoRowKey(todo.id, index)}
            className={`group flex h-6 cursor-default items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-fill-2 ${blocked ? "opacity-50" : ""}`}
          >
            <div className="flex shrink-0 items-center justify-center self-center">
              <CommunicationTodoCheckbox
                status={todo.status}
                blocked={blocked}
              />
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
              {renderCommunicationTodoLabel(todo)}
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
    </div>
  );
});
CommunicationTodoList.displayName = "CommunicationTodoList";
