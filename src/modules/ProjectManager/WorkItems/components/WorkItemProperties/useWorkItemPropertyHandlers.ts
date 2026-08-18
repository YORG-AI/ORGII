import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";

import type {
  OrchestratorConfig,
  WorkItemSchedule,
} from "@src/api/http/project";
import { builtInAgentsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type {
  AgentDefinition,
  OrgMember,
} from "@src/modules/MainApp/AgentOrgs/types";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItem as WorkItemExtended,
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemPriority,
  WorkItemProject,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { DEFAULT_ORCHESTRATOR_CONFIG } from "../../constants";

type WorkItemOrchestratorConfigRuntime = OrchestratorConfig & {
  agentDefinitionId?: string;
};

interface UseWorkItemPropertyHandlersParams {
  workItem: WorkItemExtended;
  onUpdate: (updates: Partial<WorkItemExtended>) => void;
  availableMembers: Person[];
  availableAgents: AgentDefinition[];
  availableOrgs: OrgMember[];
  closePicker: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export function useWorkItemPropertyHandlers({
  workItem,
  onUpdate,
  availableMembers,
  availableAgents,
  availableOrgs,
  closePicker,
  t,
}: UseWorkItemPropertyHandlersParams) {
  const builtInAgents = useAtomValue(builtInAgentsAtom);

  const allAgentList = useMemo(
    () => [
      ...builtInAgents.map((agent) => ({ id: agent.id, name: agent.name })),
      ...availableAgents.map((agent) => ({ id: agent.id, name: agent.name })),
    ],
    [builtInAgents, availableAgents]
  );

  const handleStatusChange = useCallback(
    (value: WorkItemStatus) => {
      onUpdate({ workItemStatus: value });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const handlePriorityChange = useCallback(
    (value: WorkItemPriority) => {
      onUpdate({ priority: value });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const handleAssigneeChange = useCallback(
    (person: Person | null, assigneeType?: string) => {
      const updates: Partial<WorkItemExtended> = {
        assignee: person || undefined,
        assigneeType: assigneeType ?? undefined,
      };

      const baseConfig: WorkItemOrchestratorConfigRuntime = {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        ...workItem.orchestratorConfig,
      };

      if (assigneeType === "agent" && person) {
        updates.orchestratorConfig = {
          ...baseConfig,
          agent_definition_id: person.id,
          org_id: undefined,
          sub_agent_ids: undefined,
        };
      } else if (assigneeType === "org" && person) {
        const org = availableOrgs.find((orgItem) => orgItem.id === person.id);
        updates.orchestratorConfig = {
          ...baseConfig,
          org_id: person.id,
          agent_definition_id: org?.agentId || undefined,
          sub_agent_ids:
            org?.children?.map((member) => member.agentId).filter(Boolean) ??
            [],
        };
      } else {
        const {
          agent_definition_id: _defId,
          agentDefinitionId: _staleDefId,
          org_id: _orgId,
          sub_agent_ids: _subIds,
          ...rest
        } = baseConfig;
        updates.orchestratorConfig = rest as OrchestratorConfig;
      }

      onUpdate(updates);
      closePicker();
    },
    [workItem.orchestratorConfig, availableOrgs, onUpdate, closePicker]
  );

  const handleScheduleChange = useCallback(
    (schedule: WorkItemSchedule | null) => {
      onUpdate({ schedule });
    },
    [onUpdate]
  );

  const handleLabelToggle = useCallback(
    (label: WorkItemLabel) => {
      const currentLabels = workItem.labels || [];
      const exists = currentLabels.find((item) => item.id === label.id);
      if (exists) {
        onUpdate({
          labels: currentLabels.filter((item) => item.id !== label.id),
        });
      } else {
        onUpdate({ labels: [...currentLabels, label] });
      }
    },
    [workItem.labels, onUpdate]
  );

  const handleLabelsClear = useCallback(() => {
    onUpdate({ labels: [] });
    closePicker();
  }, [onUpdate, closePicker]);

  const handleProjectChange = useCallback(
    (project: WorkItemProject | null) => {
      onUpdate({ project: project || undefined });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const handleMilestoneChange = useCallback(
    (milestone: WorkItemMilestone | null) => {
      onUpdate({ milestone: milestone || undefined });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const handleStartDateChange = useCallback(
    (date: Date | null) => {
      onUpdate({ startDate: date?.toISOString() || undefined });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const handleDateChange = useCallback(
    (date: Date | null) => {
      onUpdate({ endDate: date?.toISOString() || undefined });
      closePicker();
    },
    [onUpdate, closePicker]
  );

  const formatStartDate = useCallback(
    (date: string | undefined): string => {
      if (!date) return t("workItems.properties.noStartDate");
      const startDate = new Date(date);
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (startDate.toDateString() === today.toDateString())
        return t("workItems.properties.today");
      if (startDate.toDateString() === tomorrow.toDateString())
        return t("workItems.properties.tomorrow");
      return startDate.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    },
    [t]
  );

  const formatDueDate = useCallback(
    (date: string | undefined): string => {
      if (!date) return t("workItems.properties.noDueDate");
      const dueDate = new Date(date);
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (dueDate.toDateString() === today.toDateString())
        return t("workItems.properties.today");
      if (dueDate.toDateString() === tomorrow.toDateString())
        return t("workItems.properties.tomorrow");
      return dueDate.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    },
    [t]
  );

  const getRelativeTime = useCallback(
    (date: string | undefined): string => {
      if (!date) return "";
      const dueDate = new Date(date);
      const now = new Date();
      const diffMs = dueDate.getTime() - now.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffMs < 0) {
        const absDays = Math.abs(diffDays);
        const absHours = Math.abs(diffHours);
        if (absDays > 0)
          return t("workItems.properties.daysAgo", { count: absDays });
        return t("workItems.properties.hoursAgo", { count: absHours });
      }
      if (diffDays > 0)
        return t("workItems.properties.inDays", { count: diffDays });
      if (diffHours > 0)
        return t("workItems.properties.inHours", { count: diffHours });
      return t("workItems.properties.inLessThanHour");
    },
    [t]
  );

  return {
    builtInAgents,
    allAgentList,
    handleStatusChange,
    handlePriorityChange,
    handleAssigneeChange,
    handleScheduleChange,
    handleLabelToggle,
    handleLabelsClear,
    handleProjectChange,
    handleMilestoneChange,
    handleStartDateChange,
    handleDateChange,
    formatStartDate,
    formatDueDate,
    getRelativeTime,
  };
}
