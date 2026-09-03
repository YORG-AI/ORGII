import { useAtomValue } from "jotai";
import React, { useEffect } from "react";
import { createPortal } from "react-dom";

import { useInlineCreateWorkItemFields } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView/InlineCreateWorkItemFields";
import { DEFAULT_ORCHESTRATOR_CONFIG } from "@src/modules/ProjectManager/WorkItems/constants";
import {
  CreateComposerHeader,
  CreateComposerPinnedActions,
} from "@src/modules/ProjectManager/shared/components/CreateComposerScaffold";
import { primaryWorkspaceRootAtom } from "@src/store/workspace";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import type { DefaultAiWorkItemExecutionTarget } from "./StartPageAgentComposer";

interface StartPageWorkItemComposerChromeProps {
  creatorModeControl: React.ReactNode;
  defaultAiWorkItemExecutionTarget: DefaultAiWorkItemExecutionTarget | null;
  headerHost: HTMLDivElement | null;
  onDraftChange: (draft: WorkItemDraft) => void;
  orgId?: string;
  pinnedActionsHost: HTMLDivElement | null;
}

const ignoreUnsavedChange = () => undefined;

/**
 * Work-item-only controller loaded beside the persistent SessionCreator. Its
 * two portals add the title and property controls without owning or replacing
 * the composer itself.
 */
export default function StartPageWorkItemComposerChrome({
  creatorModeControl,
  defaultAiWorkItemExecutionTarget,
  headerHost,
  onDraftChange,
  orgId,
  pinnedActionsHost,
}: StartPageWorkItemComposerChromeProps): React.ReactNode {
  const workspaceRoot = useAtomValue(primaryWorkspaceRootAtom);
  const inlineFields = useInlineCreateWorkItemFields({
    aiGenerateMode: true,
    chatPanelFooter: true,
    dockedComposer: true,
    onDraftChange,
    onSetUnsaved: ignoreUnsavedChange,
    orgId,
    repoPath: workspaceRoot?.path ?? null,
  });
  const { draft, updateDraft } = inlineFields;
  const canAutoExecuteWithTarget = Boolean(
    draft.orchestratorConfig?.agent_definition_id ||
    draft.orchestratorConfig?.org_id
  );

  useEffect(() => {
    if (!defaultAiWorkItemExecutionTarget || canAutoExecuteWithTarget) return;

    updateDraft({
      orchestratorConfig: {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        ...(draft.orchestratorConfig ?? {}),
        agent_definition_id: defaultAiWorkItemExecutionTarget.agentDefinitionId,
        org_id:
          defaultAiWorkItemExecutionTarget.type === "org"
            ? defaultAiWorkItemExecutionTarget.id
            : undefined,
      },
    });
  }, [
    canAutoExecuteWithTarget,
    defaultAiWorkItemExecutionTarget,
    draft.orchestratorConfig,
    updateDraft,
  ]);

  return (
    <>
      {headerHost
        ? createPortal(
            <CreateComposerHeader dataTestId="create-work-item-composer-header">
              {inlineFields.titleSection}
            </CreateComposerHeader>,
            headerHost,
            "work-item-composer-header"
          )
        : null}
      {pinnedActionsHost
        ? createPortal(
            <CreateComposerPinnedActions dataTestId="create-work-item-pinned-actions">
              {creatorModeControl}
              {inlineFields.workItemProjectPill}
              {inlineFields.inlinePropertyPills}
            </CreateComposerPinnedActions>,
            pinnedActionsHost,
            "work-item-composer-pinned-actions"
          )
        : null}
    </>
  );
}
