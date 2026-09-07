import React, { createContext, useContext, useMemo } from "react";

import type {
  AgentOrgRunView,
  AgentOrgTaskStateProjection,
} from "@src/api/tauri/agent";

interface AgentOrgTaskProjectionValue {
  runId: string;
  tasksById: ReadonlyMap<string, AgentOrgTaskStateProjection>;
}

const AgentOrgTaskProjectionContext =
  createContext<AgentOrgTaskProjectionValue | null>(null);

export function AgentOrgTaskProjectionProvider({
  view,
  children,
}: {
  view: AgentOrgRunView | null;
  children?: React.ReactNode;
}) {
  const value = useMemo<AgentOrgTaskProjectionValue | null>(() => {
    if (!view) return null;
    return {
      runId: view.context.runId,
      tasksById: new Map(
        view.taskStateWindow.tasks.map((task) => [task.taskId, task])
      ),
    };
  }, [view]);

  return (
    <AgentOrgTaskProjectionContext.Provider value={value}>
      {children}
    </AgentOrgTaskProjectionContext.Provider>
  );
}

export function useAgentOrgTaskProjection(
  orgRunId: string | undefined,
  taskId: string
): AgentOrgTaskStateProjection | null | undefined {
  const projection = useContext(AgentOrgTaskProjectionContext);
  if (!projection || !orgRunId || projection.runId !== orgRunId) {
    return undefined;
  }
  return projection.tasksById.get(taskId) ?? null;
}
