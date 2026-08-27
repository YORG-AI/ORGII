/**
 * SessionReplayProject
 *
 * Simulator app that visualizes agent project management operations
 * (manage_story, manage_work_item, delegate_story) using the same row/detail
 * surfaces as the Project Manager where those components are safe to reuse.
 */
import { FileText, LayoutList } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { SessionEvent } from "@src/engines/SessionCore";
import type { SimulatorAppProps } from "@src/engines/Simulator/apps/core/types";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import { ProjectRow } from "@src/modules/ProjectManager/Projects/components";
import {
  WorkItemContent,
  WorkItemRow,
  WorkItemSection,
} from "@src/modules/ProjectManager/WorkItems/components";
import {
  getProjectStatusConfig,
  getWorkItemStatusConfig,
} from "@src/modules/ProjectManager/config/manage";
import {
  CountBadge,
  NoTabsPlaceholder,
  type ReplayTab,
  SimulatorReplayChrome,
  useSimulatorAwaitingAgentCaption,
  useSimulatorPlaceholderActions,
} from "@src/modules/WorkStation/shared";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/modules/WorkStation/shared/tokens";
import type {
  Project,
  ProjectPriority,
  ProjectStatus,
} from "@src/types/core/project";
import type {
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import { deriveProjectState } from "./config";
import type { ProjectOperation, SimulatorProjectState } from "./types";

type ProjectReplayView =
  | { kind: "projectList"; projects: Project[] }
  | {
      kind: "workItemList";
      workItems: WorkItem[];
      projectName: string;
      prefix: string;
    }
  | {
      kind: "workItemDetail";
      workItem: WorkItem;
      projectName: string;
      prefix: string;
    }
  | { kind: "summary"; title: string; body: string };

const STORY_STATUS_VALUES = new Set<ProjectStatus>([
  "backlog",
  "planned",
  "in_progress",
  "completed",
  "canceled",
]);

const STORY_PRIORITY_VALUES = new Set<ProjectPriority>([
  "urgent",
  "high",
  "medium",
  "low",
  "none",
]);

const WORK_ITEM_STATUS_VALUES = new Set<WorkItemStatus>([
  "backlog",
  "planned",
  "in_progress",
  "in_review",
  "completed",
  "cancelled",
  "duplicate",
]);

const WORK_ITEM_PRIORITY_VALUES = new Set<WorkItemPriority>([
  "none",
  "urgent",
  "high",
  "medium",
  "low",
]);

function operationTypeLabel(
  op: ProjectOperation,
  t: ReturnType<typeof useTranslation<"sessions">>["t"]
): string {
  if (op.functionName === "delegate_story") {
    return t("simulator.replay.project.operation.delegate");
  }
  if (op.functionName === "manage_story") {
    if (op.action) {
      const key = `simulator.replay.project.action.${op.action}` as const;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return t("simulator.replay.project.operation.manageProject");
  }
  if (op.functionName === "manage_work_item") {
    if (op.action) {
      const key = `simulator.replay.project.action.${op.action}` as const;
      const translated = t(key);
      if (translated !== key) return translated;
    }
    return t("simulator.replay.project.operation.manageWorkItem");
  }
  return op.functionName;
}

function slugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function normalizeProjectStatus(value: string | undefined): ProjectStatus {
  return value && STORY_STATUS_VALUES.has(value as ProjectStatus)
    ? (value as ProjectStatus)
    : "planned";
}

function normalizeProjectPriority(value: string | undefined): ProjectPriority {
  return value && STORY_PRIORITY_VALUES.has(value as ProjectPriority)
    ? (value as ProjectPriority)
    : "medium";
}

function normalizeWorkItemStatus(value: string | undefined): WorkItemStatus {
  return value && WORK_ITEM_STATUS_VALUES.has(value as WorkItemStatus)
    ? (value as WorkItemStatus)
    : "planned";
}

function normalizeWorkItemPriority(
  value: string | undefined
): WorkItemPriority {
  return value && WORK_ITEM_PRIORITY_VALUES.has(value as WorkItemPriority)
    ? (value as WorkItemPriority)
    : "medium";
}

function createProject(params: {
  name: string;
  slug?: string;
  status?: string;
  priority?: string;
  description?: string;
  index: number;
}): Project {
  const slug = params.slug || slugFromName(params.name);
  const now = new Date().toISOString();
  return {
    id: slug,
    name: params.name,
    description: params.description,
    slug,
    workItemPrefix: slug.slice(0, 3).toUpperCase(),
    status: normalizeProjectStatus(params.status),
    priority: normalizeProjectPriority(params.priority),
    health: "on_track",
    createdAt: now,
    updatedAt: now,
    workItemCount: Math.max(1, 8 - params.index),
  };
}

function createWorkItem(params: {
  id: string;
  title: string;
  projectName: string;
  status?: string;
  priority?: string;
  assignee?: string;
  description?: string;
}): WorkItem {
  const now = new Date().toISOString();
  return {
    session_id: params.id,
    user_id: "simulator",
    name: params.title,
    status: normalizeWorkItemStatus(params.status),
    spec: params.description || "",
    star: false,
    target_date: null,
    created_time: now,
    updated_time: now,
    workItemStatus: normalizeWorkItemStatus(params.status),
    priority: normalizeWorkItemPriority(params.priority),
    assignee: params.assignee
      ? { id: params.assignee, name: params.assignee }
      : undefined,
    project: {
      id: slugFromName(params.projectName),
      name: params.projectName,
    },
  };
}

function parseProjectRows(text: string): Project[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line, index) => {
      const nameMatch = line.match(/^[-\s]*\*\*(.*?)\*\*/);
      const fallbackNameMatch = line.match(/^[-\s]*(.*?)\s+\(slug:/);
      const slugMatch = line.match(/\(slug:\s*([^)]+)\)/);
      const statusMatch = line.match(/—\s*([a-z_]+)(?:\s*·|$)/);
      const priorityMatch = line.match(/·\s*(urgent|high|medium|low|none)/);
      const name =
        nameMatch?.[1] ?? fallbackNameMatch?.[1] ?? `Project ${index + 1}`;
      return createProject({
        name: name.trim(),
        slug: slugMatch?.[1]?.trim(),
        status: statusMatch?.[1]?.trim(),
        priority: priorityMatch?.[1]?.trim(),
        index,
      });
    });
}

function parseWorkItemRows(text: string, projectName: string): WorkItem[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line, index) => {
      const boldTitleMatch = line.match(/^[-\s]*\*\*(.*?)\*\*\s+\[([^\]]+)\]/);
      const findTitleMatch = line.match(/^[-\s]*\[([^\]]+)\]\s+"([^"]+)"/);
      const title =
        boldTitleMatch?.[1] ?? findTitleMatch?.[2] ?? `Work item ${index + 1}`;
      const id =
        boldTitleMatch?.[2] ??
        findTitleMatch?.[1] ??
        `WI-${String(index + 1).padStart(3, "0")}`;
      const statusMatch = line.match(/—\s*([a-z_]+)(?:\s*·|$)/);
      const priorityMatch = line.match(/·\s*(urgent|high|medium|low|none)/);
      const assigneeMatch = line.match(/@([\w-]+)/);
      return createWorkItem({
        id: id.trim(),
        title: title.trim(),
        projectName,
        status: statusMatch?.[1]?.trim(),
        priority: priorityMatch?.[1]?.trim(),
        assignee: assigneeMatch?.[1]?.trim(),
      });
    });
}

function projectNameFromOperation(op: ProjectOperation): string {
  const argsProject =
    typeof op.args.project_slug === "string" ? op.args.project_slug : undefined;
  return op.projectName ?? argsProject ?? "Project Manager";
}

function projectPrefixFromName(projectName: string): string {
  return (
    projectName
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 3)
      .toUpperCase() || "STO"
  );
}

function extractMutationTitle(op: ProjectOperation): string {
  const title = typeof op.args.title === "string" ? op.args.title : undefined;
  const name = typeof op.args.name === "string" ? op.args.name : undefined;
  const quotedWorkItem = op.resultText.match(/work item '([^']+)'/i)?.[1];
  const quotedProject = op.resultText.match(/project '([^']+)'/i)?.[1];
  return title ?? name ?? quotedWorkItem ?? quotedProject ?? op.resultText;
}

function extractMutationId(
  op: ProjectOperation,
  fallbackPrefix: string
): string {
  const shortId =
    typeof op.args.short_id === "string" ? op.args.short_id : undefined;
  const resultId = op.resultText.match(/\[([^\]]+)\]/)?.[1];
  return shortId ?? resultId ?? `${fallbackPrefix}-001`;
}

function buildReplayView(op: ProjectOperation): ProjectReplayView {
  const action = op.action ?? "";
  const projectName = projectNameFromOperation(op);
  const prefix = projectPrefixFromName(projectName);

  if (op.functionName === "manage_story" && action === "list") {
    const projects = parseProjectRows(op.resultText);
    return projects.length > 0
      ? { kind: "projectList", projects }
      : { kind: "summary", title: "Project list", body: op.resultText };
  }

  if (
    (op.functionName === "manage_story" &&
      (action === "list_items" || action === "find")) ||
    (op.functionName === "manage_work_item" &&
      (action === "list" || action === "list_items"))
  ) {
    const workItems = parseWorkItemRows(op.resultText, projectName);
    return workItems.length > 0
      ? { kind: "workItemList", workItems, projectName, prefix }
      : { kind: "summary", title: projectName, body: op.resultText };
  }

  if (op.functionName === "manage_work_item") {
    const title = extractMutationTitle(op);
    const workItem = createWorkItem({
      id: extractMutationId(op, prefix),
      title,
      projectName,
      status: typeof op.args.status === "string" ? op.args.status : undefined,
      priority:
        typeof op.args.priority === "string" ? op.args.priority : undefined,
      description: op.resultText,
    });
    return { kind: "workItemDetail", workItem, projectName, prefix };
  }

  if (op.functionName === "manage_story") {
    const title = extractMutationTitle(op);
    const project = createProject({
      name: title,
      slug: typeof op.args.slug === "string" ? op.args.slug : undefined,
      status: typeof op.args.status === "string" ? op.args.status : undefined,
      priority:
        typeof op.args.priority === "string" ? op.args.priority : undefined,
      description: op.resultText,
      index: 0,
    });
    return { kind: "projectList", projects: [project] };
  }

  return { kind: "summary", title: op.functionName, body: op.resultText };
}

function groupProjectsByStatus(projects: Project[]): Array<{
  status: ProjectStatus;
  projects: Project[];
}> {
  const groups = new Map<ProjectStatus, Project[]>();
  for (const project of projects) {
    const group = groups.get(project.status) ?? [];
    group.push(project);
    groups.set(project.status, group);
  }
  return Array.from(groups, ([status, groupedProjects]) => ({
    status,
    projects: groupedProjects,
  }));
}

function groupWorkItemsByStatus(workItems: WorkItem[]): Array<{
  status: WorkItemStatus;
  workItems: WorkItem[];
}> {
  const groups = new Map<WorkItemStatus, WorkItem[]>();
  for (const workItem of workItems) {
    const status = workItem.workItemStatus || "backlog";
    const group = groups.get(status) ?? [];
    group.push(workItem);
    groups.set(status, group);
  }
  return Array.from(groups, ([status, groupedWorkItems]) => ({
    status,
    workItems: groupedWorkItems,
  }));
}

function ProjectReplayContent({ view }: { view: ProjectReplayView }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (view.kind === "projectList") {
    const selectedProjectId = selectedId;
    const projectGroups = groupProjectsByStatus(view.projects);
    return (
      <div className="scrollbar-overlay flex-1 overflow-y-auto pb-[100px]">
        <div className="flex flex-col pb-3">
          {projectGroups.map((group) => {
            const statusConfig = getProjectStatusConfig(group.status);
            return (
              <WorkItemSection
                key={group.status}
                status={group.status}
                statusConfig={statusConfig}
                count={group.projects.length}
                label={statusConfig.label}
              >
                {group.projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    isSelected={project.id === selectedProjectId}
                    onSelect={setSelectedId}
                    readonly
                  />
                ))}
              </WorkItemSection>
            );
          })}
        </div>
      </div>
    );
  }

  if (view.kind === "workItemList") {
    const selectedWorkItemId = selectedId;
    const workItemGroups = groupWorkItemsByStatus(view.workItems);
    return (
      <div className="scrollbar-overlay flex-1 overflow-y-auto pb-[100px]">
        <div className="flex flex-col pb-3">
          {workItemGroups.map((group) => (
            <WorkItemSection
              key={group.status}
              status={group.status}
              statusConfig={getWorkItemStatusConfig(group.status)}
              count={group.workItems.length}
            >
              {group.workItems.map((workItem) => (
                <WorkItemRow
                  key={workItem.session_id}
                  workItem={workItem}
                  isSelected={workItem.session_id === selectedWorkItemId}
                  onSelect={setSelectedId}
                  workItemPrefix={view.prefix}
                  readonly
                />
              ))}
            </WorkItemSection>
          ))}
        </div>
      </div>
    );
  }

  if (view.kind === "workItemDetail") {
    return (
      <WorkItemContent
        workItem={view.workItem}
        projectSlug={slugFromName(view.projectName)}
        shortId={view.workItem.session_id}
      />
    );
  }

  return (
    <div className="scrollbar-overlay flex-1 overflow-y-auto p-4 pb-[100px]">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-medium text-text-1">
        <FileText size={14} className="text-text-3" />
        {view.title}
      </div>
      <pre className="whitespace-pre-wrap text-[12px] leading-5 text-text-2">
        {view.body}
      </pre>
    </div>
  );
}

function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<SessionEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.functionName === "string" &&
    typeof event.createdAt === "string"
  );
}

function buildProjectReplayTabs(
  operations: ProjectOperation[],
  t: ReturnType<typeof useTranslation<"sessions">>["t"]
): ReplayTab[] {
  return operations.map((op) => ({
    eventId: op.eventId,
    kind: "tool",
    label: operationTypeLabel(op, t),
    title: op.resultSummary || operationTypeLabel(op, t),
    icon: <LayoutList size={14} className="text-primary-6" />,
  }));
}

const SessionReplayProject: React.FC<SimulatorAppProps> = ({
  state: appState,
  currentEvent,
  mode = "simulation",
}) => {
  const projectState = appState as SimulatorProjectState | undefined;
  const { t } = useTranslation("sessions");
  const isCurrentEventLoading =
    (currentEvent as unknown as { displayStatus?: string })?.displayStatus ===
    "running";
  const simulatorPlaceholderActions = useSimulatorPlaceholderActions(mode);
  const simulatorAwaitingAgentCaption = useSimulatorAwaitingAgentCaption();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const derivedFallbackState = useMemo(() => {
    if (projectState?.operations && projectState.operations.length > 0)
      return null;
    if (projectState?.appEvents && projectState.appEvents.length > 0) {
      return deriveProjectState(
        projectState.appEvents,
        projectState.currentEventId
      );
    }
    if (isSessionEvent(currentEvent)) {
      return deriveProjectState([currentEvent], currentEvent.id);
    }
    return null;
  }, [currentEvent, projectState]);

  const operations = projectState?.operations?.length
    ? projectState.operations
    : (derivedFallbackState?.operations ?? []);
  const stateSelectedOperation =
    projectState?.selectedOperation ??
    derivedFallbackState?.selectedOperation ??
    null;
  const selectedOperation =
    operations.find((op) => op.eventId === selectedEventId) ??
    stateSelectedOperation;

  const view = useMemo(
    () => (selectedOperation ? buildReplayView(selectedOperation) : null),
    [selectedOperation]
  );

  const replayTabs = buildProjectReplayTabs(operations, t);
  const headerContent = useMemo(
    () => (
      <div className="flex min-w-0 items-center gap-2">
        <LayoutList size={14} className="shrink-0 text-text-3" />
        <span className="truncate text-[12px] font-medium text-text-1">
          {t("simulator.replay.project.headerTitle")}
        </span>
        <CountBadge
          variant="neutral"
          count={operations.length}
          label=""
          showZero
        />
      </div>
    ),
    [operations.length, t]
  );

  usePublishWorkstationTabHeader({
    host: "simulator",
    content: headerContent,
    enabled: operations.length > 0,
  });

  if (operations.length === 0 || !view) {
    return (
      <SimulatorReplayChrome
        tabs={replayTabs}
        activeEventId={selectedOperation?.eventId ?? null}
        onTabClick={setSelectedEventId}
        sidebarToggleDisabled
      >
        <div className={`min-h-0 flex-1 ${EDITOR_TAB_CANVAS_BG_CLASS}`}>
          {isCurrentEventLoading ? (
            <Placeholder
              variant="loading"
              placement="detail-panel"
              fillParentHeight
            />
          ) : (
            <NoTabsPlaceholder
              icon="project"
              caption={simulatorAwaitingAgentCaption}
              actions={simulatorPlaceholderActions}
            />
          )}
        </div>
      </SimulatorReplayChrome>
    );
  }

  return (
    <SimulatorReplayChrome
      tabs={replayTabs}
      activeEventId={selectedOperation?.eventId ?? null}
      onTabClick={setSelectedEventId}
      sidebarToggleDisabled
    >
      <div
        className={`flex min-h-0 flex-1 flex-col overflow-hidden ${EDITOR_TAB_CANVAS_BG_CLASS}`}
      >
        <ProjectReplayContent view={view} />
      </div>
    </SimulatorReplayChrome>
  );
};

export { SessionReplayProject as SimulatorProject };
export default SessionReplayProject;
