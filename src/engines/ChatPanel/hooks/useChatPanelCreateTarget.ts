import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";

import type { SelectOption } from "@src/components/Select";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCollabOrgCreateIntent,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

interface UseChatPanelCreateTargetOptions {
  sessionCreatorAvailable: boolean;
  setCreateTarget: (target: ChatPanelCreateTarget) => void;
  setCollabOrgCreateIntent: (
    intent: ChatPanelCollabOrgCreateIntent | null
  ) => void;
  setShowProjectAgentCreator: (enabled: boolean) => void;
  setShowWorkItemAgentCreator: (enabled: boolean) => void;
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

export function useChatPanelCreateTarget({
  sessionCreatorAvailable,
  setCreateTarget,
  setCollabOrgCreateIntent,
  setShowProjectAgentCreator,
  setShowWorkItemAgentCreator,
  setWorkItemCreateDraft,
  t,
}: UseChatPanelCreateTargetOptions) {
  const createTargetOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: CHAT_PANEL_CREATE_TARGET.PROJECT,
        label: t("sessions:creator.createTarget.project"),
        dataTestId: "chat-panel-create-target-project-option",
      },
      {
        value: CHAT_PANEL_CREATE_TARGET.PARALLEL_RUN,
        label: t("sessions:creator.createTarget.parallelRun"),
        dataTestId: "chat-panel-create-target-parallel-run-option",
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
      // Selector changes are ordinary navigation, not a continuation of a
      // one-shot guide preset that may still be waiting on lazy rendering.
      setCollabOrgCreateIntent(null);

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
      sessionCreatorAvailable,
      setCollabOrgCreateIntent,
      setCreateTarget,
      setShowProjectAgentCreator,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
    ]
  );

  return { createTargetOptions, handleCreateTargetChange };
}
