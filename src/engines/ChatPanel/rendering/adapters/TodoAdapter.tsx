/**
 * TodoAdapter — renders `manage_todo` events via `TodoBlock`. Returns
 * `null` when the extracted todo list is empty (the block would show
 * nothing useful) so the chat timeline stays tight.
 */
import { useAtomValue } from "jotai";
import React from "react";

import { extractTodoData } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getTodosForSession, sessionTodoMapAtom } from "@src/store/ui/todoAtom";
import { preserveTodoContent } from "@src/store/ui/todoMerge";

import TodoBlock from "../../blocks/TodoBlock";

export const TodoAdapter: React.FC<UniversalEventProps> = (props) => {
  const action = (props.args?.action as string) || undefined;
  const { todos: eventTodos, wasMerge } = extractTodoData(props);
  const todoMap = useAtomValue(sessionTodoMapAtom);
  const sessionTodos = getTodosForSession(todoMap, props.sessionId);
  const todos = preserveTodoContent(sessionTodos, eventTodos);
  const labels = useLifecycleLabels(props.eventType, action);
  const state = statusToLifecycle(props.status);

  if (todos.length === 0) return null;
  const toolName = props.functionName || props.eventType;
  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name={toolName}>
      <TodoBlock
        todos={todos}
        wasMerge={wasMerge}
        defaultCollapsed={true}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        title={labels[state]}
        toolUsage={props.toolUsage}
      />
    </div>
  );
};

TodoAdapter.displayName = "TodoAdapter";

export default TodoAdapter;
