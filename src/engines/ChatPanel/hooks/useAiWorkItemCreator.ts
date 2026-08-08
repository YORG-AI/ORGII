import { emit } from "@tauri-apps/api/event";
import { useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  type LinkedSession,
  type WorkItemData,
  projectApi,
  workItemDataToUI,
} from "@src/api/http/project";
import Message from "@src/components/Message";
import type { SessionLaunchSuccessInfo } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  allocateCloudAwareStandaloneWorkItemId,
  allocateCloudAwareWorkItemId,
} from "@src/features/Org2Cloud/cloudShortId";
import i18n from "@src/i18n";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { openOrFocusSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { SESSION_TARGET_KIND } from "@src/store/session";
import type { SessionCreatorState } from "@src/store/session/creatorStateAtom";
import {
  type ChatPanelCreateProjectContext,
  type ChatPanelSelectedProject,
  type ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import { getDispatchCategory } from "@src/util/session/sessionDispatch";

// Work Item Manager persona was retired; the generic OS Agent carries
// manage_work_item/manage_project as ordinary built-in tools.
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

interface ResolvedAiWorkItemAssignee {
  assigneeId: string;
  assigneeType: "agent" | "org";
  assigneeName: string;
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
  setSelectedWorkItem: (workItem: ChatPanelSelectedWorkItem | null) => void;
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
  setSelectedWorkItem,
  setWorkItemCreateDraft,
  setWorkstationActiveSessionId,
  workItemCreateDraft,
}: UseAiWorkItemCreatorOptions) {
  const openOrFocusSessionTab = useSetAtom(
    openOrFocusSessionInChatPanelTabAtom
  );
  const resolveAiWorkItemAssignee = useCallback(
    (draft: WorkItemDraft): ResolvedAiWorkItemAssignee | null => {
      if (draft.assigneeType === "agent" && draft.assigneeId) {
        const agentName =
          allAgentDefs.find((agent) => agent.id === draft.assigneeId)?.name ??
          draft.assigneeId;
        return {
          assigneeId: draft.assigneeId,
          assigneeType: "agent",
          assigneeName: agentName,
          agentDefinitionId: draft.assigneeId,
        };
      }

      if (draft.assigneeType === "org" && draft.assigneeId) {
        return {
          assigneeId: draft.assigneeId,
          assigneeType: "org",
          assigneeName: creatorState.agentName ?? draft.assigneeId,
          agentDefinitionId: draft.orchestratorConfig?.agent_definition_id,
        };
      }

      if (
        creatorState.targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
        creatorState.selectedAgentOrgId
      ) {
        return {
          assigneeId: creatorState.selectedAgentOrgId,
          assigneeType: "org",
          assigneeName:
            creatorState.agentName ?? creatorState.selectedAgentOrgId,
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
          assigneeId: creatorState.selectedAgentDefinitionId,
          assigneeType: "agent",
          assigneeName:
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
          assigneeId: fallbackAgent.id,
          assigneeType: "agent",
          assigneeName: fallbackAgent.name,
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

    const assignee = resolveAiWorkItemAssignee(draft);
    if (!assignee) {
      Message.error(i18n.t("toasts.chooseAgentAssigneeAi"));
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

    // Canonical work.create: the Rust service owns row construction.
    const request = {
      title,
      body: description,
      projectId: selectedProjectId || undefined,
      status: draft.status || "planned",
      priority: draft.priority || "none",
      assignee: assignee.assigneeId,
      assigneeType: assignee.assigneeType,
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
        agent_definition_id: assignee.agentDefinitionId,
        org_id:
          assignee.assigneeType === "org" ? assignee.assigneeId : undefined,
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
      agentRole: "custom" as const,
      // The draft-fill session must run an agent that registers
      // manage_work_item; the composer's selected agent (usually SDE)
      // does not carry the PM tools and would silently fail to fill
      // the draft it was launched for. The item's assignee is
      // unaffected — it stays whatever was resolved above.
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
    resolveAiWorkItemAssignee,
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

      const workItem = workItemDataToUI(updatedItem, {
        labelMap: new Map(),
        memberMap: new Map(),
      });
      setSelectedProject(null);
      setSelectedWorkItem({
        shortId: metadata.shortId,
        projectSlug: metadata.projectSlug,
        projectId: metadata.projectId,
        projectName: metadata.projectName,
        orgId: metadata.orgId,
        workItem,
      });
      setWorkItemCreateDraft(null);
      // Land the user IN the launched session instead of bouncing them
      // back to the start page's Session tab: after "create a work item
      // with AI" the only honest answer to "what is happening now?" is
      // the agent session doing the work — it also surfaces the item
      // via the active-WorkItem pill. The old reset left a blank
      // composer and a toast minutes later.
      setActiveSessionId(info.sessionId);
      setWorkstationActiveSessionId(info.sessionId);
      openOrFocusSessionTab({
        sessionId: info.sessionId,
        sessionName: metadata.item.frontmatter.title,
      });
      await emit("orgii-data-changed");
    },
    [
      openOrFocusSessionTab,
      setActiveSessionId,
      setSelectedProject,
      setSelectedWorkItem,
      setWorkItemCreateDraft,
      setWorkstationActiveSessionId,
    ]
  );

  const defaultAiWorkItemAssignee = useMemo(() => {
    const fallbackDraft: WorkItemDraft = {
      name: "",
      description: "",
      status: "planned",
      priority: "none",
      labelIds: [],
    };
    const resolved = resolveAiWorkItemAssignee(
      workItemCreateDraft ?? fallbackDraft
    );
    if (!resolved) return null;
    return {
      id: resolved.assigneeId,
      name: resolved.assigneeName,
      type: resolved.assigneeType,
      agentDefinitionId: resolved.agentDefinitionId,
    };
  }, [resolveAiWorkItemAssignee, workItemCreateDraft]);

  return {
    defaultAiWorkItemAssignee,
    handleAiWorkItemSessionStart,
    resolveAiWorkItemContext,
  };
}
