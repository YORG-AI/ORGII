import { emit } from "@tauri-apps/api/event";
import { useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  type LinkedSession,
  type WorkItemData,
  projectApi,
} from "@src/api/http/project";
import Message from "@src/components/Message";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  allocateCloudAwareStandaloneWorkItemId,
  allocateCloudAwareWorkItemId,
} from "@src/features/Org2Cloud/cloudShortId";
import { useWorkStationTabs } from "@src/hooks/tabHost/useWorkStationTabs";
import i18n from "@src/i18n";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { resolveHumanAssigneeWrite } from "@src/modules/ProjectManager/WorkItems/humanAssignee";
import { openSessionInNewChatTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { SESSION_TARGET_KIND } from "@src/store/session";
import type { SessionCreatorState } from "@src/store/session/creatorStateAtom";
import {
  type ChatPanelCreateProjectContext,
  type ChatPanelSelectedProject,
} from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import { createWorkItemDetailTab } from "@src/store/workstation/tabs";
import { getDispatchCategory } from "@src/util/session/sessionDispatch";

// Work Item Manager persona was retired; the generic OS Agent fills
// the draft through the injected `org2-pm` CLI from its shell.
const WORK_ITEM_DEFAULT_AGENT_DEF_ID = "builtin:os";
const AI_WORK_ITEM_DEFAULT_TITLE = "AI Work Item Draft";

interface AiWorkItemLaunchMetadata {
  shortId: string;
  projectSlug: string;
  projectId: string;
  projectName: string;
  /**
   * Project-org id a STANDALONE item was written under. The post-launch
   * linked-session write MUST reuse it — an orgless rewrite would re-home
   * the row to `personal-org` (the Rust upsert overwrites `org_id` on
   * conflict) and detach it from collab sync.
   */
  orgId?: string;
  item: WorkItemData;
}

function isAiWorkItemLaunchMetadata(
  metadata: unknown
): metadata is AiWorkItemLaunchMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "shortId" in metadata &&
    "item" in metadata
  );
}

interface ResolvedAiWorkItemExecutionTarget {
  targetId: string;
  targetType: "agent" | "org";
  targetName: string;
  agentDefinitionId?: string;
}

interface UseAiWorkItemCreatorOptions {
  allAgentDefs: AgentDefinition[];
  /**
   * Org context of the create surface (set by NEW_WORK_ITEM navigation
   * from an org hub). Standalone AI work items are written under this
   * org so collab-synced orgs pick them up; null → personal-org.
   */
  createProjectContext: ChatPanelCreateProjectContext | null;
  creatorState: SessionCreatorState;
  setActiveSessionId: (sessionId: string | null) => void;
  setSelectedProject: (project: ChatPanelSelectedProject | null) => void;
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  setWorkstationActiveSessionId: (sessionId: string | null) => void;
  workItemCreateDraft: WorkItemDraft | null;
}

export function useAiWorkItemCreator({
  allAgentDefs,
  createProjectContext,
  creatorState,
  setActiveSessionId,
  setSelectedProject,
  setWorkItemCreateDraft,
  setWorkstationActiveSessionId,
  workItemCreateDraft,
}: UseAiWorkItemCreatorOptions) {
  const openLaunchedSessionTab = useSetAtom(openSessionInNewChatTabAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const { openTab: openStationTab } = useWorkStationTabs();
  const resolveAiWorkItemExecutionTarget = useCallback(
    (draft: WorkItemDraft): ResolvedAiWorkItemExecutionTarget | null => {
      const configuredOrgId = draft.orchestratorConfig?.org_id;
      if (configuredOrgId) {
        return {
          targetId: configuredOrgId,
          targetType: "org",
          targetName: creatorState.agentName ?? configuredOrgId,
          agentDefinitionId: draft.orchestratorConfig?.agent_definition_id,
        };
      }

      const configuredAgentId = draft.orchestratorConfig?.agent_definition_id;
      if (configuredAgentId) {
        const agentName =
          allAgentDefs.find((agent) => agent.id === configuredAgentId)?.name ??
          configuredAgentId;
        return {
          targetId: configuredAgentId,
          targetType: "agent",
          targetName: agentName,
          agentDefinitionId: configuredAgentId,
        };
      }

      if (
        creatorState.targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
        creatorState.selectedAgentOrgId
      ) {
        return {
          targetId: creatorState.selectedAgentOrgId,
          targetType: "org",
          targetName: creatorState.agentName ?? creatorState.selectedAgentOrgId,
          agentDefinitionId:
            creatorState.selectedAgentDefinitionId ?? undefined,
        };
      }

      if (creatorState.selectedAgentDefinitionId) {
        const agent = allAgentDefs.find(
          (definition) =>
            definition.id === creatorState.selectedAgentDefinitionId
        );
        return {
          targetId: creatorState.selectedAgentDefinitionId,
          targetType: "agent",
          targetName:
            agent?.name ??
            creatorState.agentName ??
            creatorState.selectedAgentDefinitionId,
          agentDefinitionId: creatorState.selectedAgentDefinitionId,
        };
      }

      const fallbackAgent = allAgentDefs.find(
        (definition) => definition.id === WORK_ITEM_DEFAULT_AGENT_DEF_ID
      );
      if (fallbackAgent) {
        return {
          targetId: fallbackAgent.id,
          targetType: "agent",
          targetName: fallbackAgent.name,
          agentDefinitionId: fallbackAgent.id,
        };
      }

      return null;
    },
    [
      allAgentDefs,
      creatorState.agentName,
      creatorState.selectedAgentDefinitionId,
      creatorState.selectedAgentOrgId,
      creatorState.targetKind,
    ]
  );

  const resolveAiWorkItemContext = useCallback(async () => {
    const draft = workItemCreateDraft;
    if (!draft) return null;

    const executionTarget = resolveAiWorkItemExecutionTarget(draft);
    if (!executionTarget) {
      Message.error(i18n.t("toasts.chooseExecutionAgentAi"));
      return null;
    }

    const projects = await projectApi.readProjects();
    const selectedProject = draft.projectId
      ? projects.find((project) => project.meta.id === draft.projectId)
      : undefined;
    const selectedProjectSlug = selectedProject?.slug ?? "";
    const selectedProjectId = selectedProject?.meta.id ?? draft.projectId ?? "";
    const selectedProjectName = selectedProject?.meta.name ?? "";
    // Project-scoped ids go through the collab-aware allocator (design
    // §16.5): server counter under a collab-synced org, local counter
    // otherwise. Standalone work items have no project row, so they use
    // the org-scoped local counter under the surface's org (documented
    // residual in allocateCloudAwareStandaloneWorkItemId).
    const draftOrgId =
      draft.orgId && draft.orgId !== "personal-org" ? draft.orgId : undefined;
    const standaloneOrgId = selectedProjectSlug
      ? undefined
      : (draftOrgId ?? createProjectContext?.orgId);
    const shortId = selectedProjectSlug
      ? await allocateCloudAwareWorkItemId(selectedProjectSlug)
      : await allocateCloudAwareStandaloneWorkItemId(standaloneOrgId);
    const title = draft.name.trim() || AI_WORK_ITEM_DEFAULT_TITLE;
    const description = draft.description.trim();
    const humanAssignment = resolveHumanAssigneeWrite(
      draft.assigneeId,
      draft.assigneeType
    );

    // Canonical work.create: the Rust service owns row construction.
    const request = {
      title,
      body: description,
      projectId: selectedProjectId || undefined,
      status: draft.status || "planned",
      priority: draft.priority || "none",
      ...humanAssignment,
      labels: draft.labelIds,
      milestone: draft.milestoneId,
      startDate: draft.startDate,
      targetDate: draft.targetDate,
      orchestratorConfig: {
        ...(draft.orchestratorConfig ?? {
          review_enabled: false,
          follow_up_enabled: false,
          auto_retry_on_failure: false,
          max_retry_count: 0,
          auto_create_pr: false,
        }),
        agent_definition_id: executionTarget.agentDefinitionId,
        org_id:
          executionTarget.targetType === "org"
            ? executionTarget.targetId
            : undefined,
      },
      schedule: draft.schedule ?? undefined,
    };

    const item: WorkItemData = selectedProjectSlug
      ? await projectApi.createWorkItem(selectedProjectSlug, shortId, request)
      : await projectApi.createStandaloneWorkItem(
          shortId,
          request,
          standaloneOrgId ? { orgId: standaloneOrgId } : undefined
        );

    return {
      workItemId: shortId,
      projectSlug: selectedProjectSlug || undefined,
      orgId: standaloneOrgId,
      agentRole: "custom" as const,
      agentExecMode: "build",
      // The draft-fill session runs OS Agent: it always carries
      // run_shell, and the launch injects the org2-pm identity so the
      // linked-work-item brief can be acted on. Human assignment remains
      // independent from this execution target.
      agentDefinitionId: WORK_ITEM_DEFAULT_AGENT_DEF_ID,
      metadata: {
        shortId,
        projectSlug: selectedProjectSlug,
        projectId: selectedProjectId,
        projectName: selectedProjectName,
        orgId: standaloneOrgId,
        item,
      },
    };
  }, [
    createProjectContext?.orgId,
    resolveAiWorkItemExecutionTarget,
    workItemCreateDraft,
  ]);

  const handleAiWorkItemSessionStart = useCallback(
    async (info: SessionLaunchSuccessInfo) => {
      const metadata = info.workItemContext?.metadata;
      if (!isAiWorkItemLaunchMetadata(metadata)) return;

      const startedAt = new Date().toISOString();
      const linkedSession: LinkedSession = {
        session_id: info.sessionId,
        session_type:
          getDispatchCategory(info.sessionId) === "cli_agent"
            ? "cli"
            : "native",
        agent_role: "custom",
        started_at: startedAt,
        status: "running",
        cost_usd: 0,
        total_tokens: 0,
        result_preview: "Plan",
      };
      const updatedItem: WorkItemData = {
        ...metadata.item,
        frontmatter: {
          ...metadata.item.frontmatter,
          linked_sessions: [linkedSession],
          updated_at: startedAt,
        },
      };

      if (metadata.projectSlug) {
        await projectApi.updateWorkItemPartial(
          metadata.projectSlug,
          metadata.shortId,
          { linkedSessions: [linkedSession] }
        );
      } else {
        // Partial update in the same org scope as the creating write — an
        // orgless whole-row rewrite would re-home the item to personal-org
        // and detach it from collab sync, and could race concurrent edits.
        await projectApi.updateStandaloneWorkItemPartial(
          metadata.shortId,
          { linkedSessions: [linkedSession] },
          metadata.orgId ? { orgId: metadata.orgId } : undefined
        );
      }

      setSelectedProject(null);
      setWorkItemCreateDraft(null);
      // Land the launched session in the LEFT chat panel as a normal session
      // tab (the existing chat UX), and open the Work Item detail in the
      // RIGHT station pane. The item filling in live stays visible beside
      // the conversation instead of competing with it for the chat surface.
      setActiveSessionId(info.sessionId);
      setWorkstationActiveSessionId(info.sessionId);
      openLaunchedSessionTab({ sessionId: info.sessionId });
      setStationMode(STATION_MODE.MY_STATION);
      openStationTab(
        createWorkItemDetailTab(
          metadata.projectId || undefined,
          metadata.projectName || undefined,
          metadata.shortId,
          updatedItem.frontmatter.title || AI_WORK_ITEM_DEFAULT_TITLE,
          metadata.projectSlug || undefined,
          undefined,
          undefined,
          updatedItem.frontmatter.status
        )
      );
      await emit("orgii-data-changed");
    },
    [
      openLaunchedSessionTab,
      openStationTab,
      setActiveSessionId,
      setSelectedProject,
      setStationMode,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
    ]
  );

  const defaultAiWorkItemExecutionTarget = useMemo(() => {
    const fallbackDraft: WorkItemDraft = {
      name: "",
      description: "",
      status: "planned",
      priority: "none",
      labelIds: [],
    };
    const resolved = resolveAiWorkItemExecutionTarget(
      workItemCreateDraft ?? fallbackDraft
    );
    if (!resolved) return null;
    return {
      id: resolved.targetId,
      name: resolved.targetName,
      type: resolved.targetType,
      agentDefinitionId: resolved.agentDefinitionId,
    };
  }, [resolveAiWorkItemExecutionTarget, workItemCreateDraft]);

  return {
    defaultAiWorkItemExecutionTarget,
    handleAiWorkItemSessionStart,
    resolveAiWorkItemContext,
  };
}
