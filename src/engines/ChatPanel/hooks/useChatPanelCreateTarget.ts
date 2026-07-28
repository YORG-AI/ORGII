import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";

import type { SelectOption } from "@src/components/Select";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { SESSION_TARGET_KIND } from "@src/store/session";
import type { SessionCreatorState } from "@src/store/session/creatorStateAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

const ADE_MANAGER_DEF_ID = "builtin:agent-architect";

interface UseChatPanelCreateTargetOptions {
  allAgentDefs: AgentDefinition[];
  sessionCreatorAvailable: boolean;
  setCreateTarget: (target: ChatPanelCreateTarget) => void;
  setCreatorState: (
    updater: (previous: SessionCreatorState) => SessionCreatorState
  ) => void;
  setShowProjectAgentCreator: (enabled: boolean) => void;
  setShowWorkItemAgentCreator: (enabled: boolean) => void;
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

export function useChatPanelCreateTarget({
  allAgentDefs,
  sessionCreatorAvailable,
  setCreateTarget,
  setCreatorState,
  setShowProjectAgentCreator,
  setShowWorkItemAgentCreator,
  setWorkItemCreateDraft,
  t,
}: UseChatPanelCreateTargetOptions) {
  const createTargetOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: CHAT_PANEL_CREATE_TARGET.PROJECT,
        label: t("creator.createTarget.project"),
        dataTestId: "chat-panel-create-target-project-option",
      },
      {
        value: CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS,
        label: t("creator.createTarget.manageAgents"),
        dataTestId: "chat-panel-create-target-manage-agents-option",
      },
      {
        value: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
        label: t("projects:githubIssuesImport.createTarget"),
        dataTestId: "chat-panel-create-target-github-issues-project-option",
      },
      {
        value: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
        label: t("navigation:collaboration.addOrg"),
        dataTestId: "chat-panel-create-target-collab-org-option",
      },
    ],
    [t]
  );

  const handleCreateTargetChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const nextTarget = value as ChatPanelCreateTarget;

      if (nextTarget === CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS) {
        const adeManagerDef = allAgentDefs.find(
          (definition) => definition.id === ADE_MANAGER_DEF_ID
        );
        setCreatorState((previous) => ({
          ...previous,
          dispatchCategory: "rust_agent",
          targetKind: SESSION_TARGET_KIND.AGENT,
          selectedAgentDefinitionId: ADE_MANAGER_DEF_ID,
          selectedAgentOrgId: null,
          agentName: adeManagerDef?.name ?? previous.agentName,
          agentIconId: adeManagerDef?.iconId ?? null,
          cliAgentType: null,
        }));
        setCreateTarget(CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS);
        setWorkItemCreateDraft(null);
        setShowWorkItemAgentCreator(sessionCreatorAvailable);
        setShowProjectAgentCreator(sessionCreatorAvailable);
        return;
      }

      if (nextTarget !== CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
        setWorkItemCreateDraft(null);
        setShowWorkItemAgentCreator(sessionCreatorAvailable);
      }
      if (nextTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT) {
        setShowProjectAgentCreator(false);
      } else if (nextTarget !== CHAT_PANEL_CREATE_TARGET.PROJECT) {
        setShowProjectAgentCreator(sessionCreatorAvailable);
      }
      setCreateTarget(nextTarget);
    },
    [
      allAgentDefs,
      sessionCreatorAvailable,
      setCreateTarget,
      setCreatorState,
      setShowProjectAgentCreator,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
    ]
  );

  return { createTargetOptions, handleCreateTargetChange };
}
