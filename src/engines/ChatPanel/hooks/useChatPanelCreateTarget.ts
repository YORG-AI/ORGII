import type { TFunction } from "i18next";
import { useCallback, useMemo } from "react";

import type { SelectOption } from "@src/components/Select";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

interface UseChatPanelCreateTargetOptions {
  sessionCreatorAvailable: boolean;
  setCreateTarget: (target: ChatPanelCreateTarget) => void;
  setShowProjectAgentCreator: (enabled: boolean) => void;
  setShowWorkItemAgentCreator: (enabled: boolean) => void;
  setWorkItemCreateDraft: (draft: WorkItemDraft | null) => void;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

export function useChatPanelCreateTarget({
  sessionCreatorAvailable,
  setCreateTarget,
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
    ],
    [t]
  );

  const handleCreateTargetChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const nextTarget = value as ChatPanelCreateTarget;
      if (nextTarget !== CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
        setWorkItemCreateDraft(null);
        setShowWorkItemAgentCreator(sessionCreatorAvailable);
      }
      if (nextTarget !== CHAT_PANEL_CREATE_TARGET.PROJECT) {
        setShowProjectAgentCreator(sessionCreatorAvailable);
      }
      setCreateTarget(nextTarget);
    },
    [
      sessionCreatorAvailable,
      setCreateTarget,
      setShowProjectAgentCreator,
      setShowWorkItemAgentCreator,
      setWorkItemCreateDraft,
    ]
  );

  return { createTargetOptions, handleCreateTargetChange };
}
