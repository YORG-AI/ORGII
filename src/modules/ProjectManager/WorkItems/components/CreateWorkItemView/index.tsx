import { emit } from "@tauri-apps/api/event";
import { Info, X } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ComposerBar from "@src/components/ComposerBar";
import ComposerShell from "@src/components/ComposerShell";
import Message from "@src/components/Message";
import Switch from "@src/components/Switch";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import LaunchButton from "@src/features/SessionCreator/components/LaunchButton";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { DetailSplitLayout } from "@src/modules/ProjectManager/shared";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import { PANEL_HEADER_TOKENS } from "@src/modules/shared/layouts/blocks";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import type { Person } from "@src/types/core/shared";
import type {
  WorkItemLabel,
  WorkItemMilestone,
  WorkItemProject,
} from "@src/types/core/workItem";

import { DEFAULT_ORCHESTRATOR_CONFIG } from "../../constants";
import WorkItemProperties from "../WorkItemProperties";
import {
  CREATE_WORK_ITEM_VISIBLE_FIELDS,
  InlineCreateWorkItemFields,
  useInlineCreateWorkItemFields,
} from "./InlineCreateWorkItemFields";
import {
  type CreatedWorkItemResult,
  createWorkItemFromDraft,
} from "./createWorkItemFromDraft";

const CREATE_WORK_ITEM_HEADER_ACTION_CLASS =
  "hover:!bg-fill-2 !h-7 !w-7 !min-w-7";
const CREATE_WORK_ITEM_HEADER_ACTION_ACTIVE_CLASS =
  "!h-7 !w-7 !min-w-7 !bg-surface-selected !text-primary-6 hover:!bg-fill-2";

export type { CreatedWorkItemResult };

export interface CreateWorkItemViewProps {
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
  /**
   * Project-org id of the surface hosting the creator. Standalone
   * creations (no project picked) are written under this org so
   * collab-synced orgs pick them up; omitted → personal-org.
   */
  orgId?: string | null;
  repoPath?: string | null;
  onCancel: () => void;
  onSetUnsaved: (hasUnsaved: boolean) => void;
  onWorkItemCreated: (result?: CreatedWorkItemResult) => void;
  onDraftChange?: (draft: WorkItemDraft) => void;
  availableProjects?: WorkItemProject[];
  availableMilestones?: WorkItemMilestone[];
  availableLabels?: WorkItemLabel[];
  availableMembers?: Person[];
  publishHeaderToWorkstation?: boolean;
  showCloseAction?: boolean;
  propertiesOpen?: boolean;
  onToggleProperties?: () => void;
  showPropertiesAction?: boolean;
  aiGenerateMode?: boolean;
  onAiGenerateModeChange?: (enabled: boolean) => void;
  showAiModePanel?: boolean;
  showFooter?: boolean;
  showSubmitAction?: boolean;
  chatPanelFooter?: boolean;
  /** Center the Launchpad toggle and composer as one stack. */
  centerLauncherContent?: boolean;
  /** Render Session Creator in Agent mode with Work Item fields in its composer. */
  renderAgentComposer?: (
    headerContent: React.ReactNode,
    pinnedActionsContent: React.ReactNode
  ) => React.ReactNode;
  defaultAiAssignee?: {
    id: string;
    name: string;
    type: "agent" | "org";
    agentDefinitionId?: string;
  } | null;
}

const logger = createLogger("CreateWorkItemView");

const CreateWorkItemView: React.FC<CreateWorkItemViewProps> = ({
  projectId,
  projectSlug,
  projectName,
  orgId,
  repoPath,
  onCancel,
  onSetUnsaved,
  onWorkItemCreated,
  onDraftChange,
  availableProjects = [],
  availableMilestones = [],
  availableLabels = [],
  availableMembers = [],
  publishHeaderToWorkstation = false,
  showCloseAction = true,
  propertiesOpen,
  onToggleProperties,
  showPropertiesAction = true,
  aiGenerateMode: controlledAiGenerateMode,
  onAiGenerateModeChange,
  showAiModePanel = true,
  showFooter = true,
  showSubmitAction = true,
  chatPanelFooter = false,
  centerLauncherContent = false,
  renderAgentComposer,
  defaultAiAssignee = null,
}) => {
  const { t } = useTranslation("projects");
  const [saving, setSaving] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [localAiGenerateMode, setLocalAiGenerateMode] = useState(true);
  const [localPropertiesOpen, setLocalPropertiesOpen] = useState(false);
  const manualFileInputRef = useRef<HTMLInputElement>(null);

  const resolvedPropertiesOpen = propertiesOpen ?? localPropertiesOpen;
  const resolvedAiGenerateMode =
    controlledAiGenerateMode ?? localAiGenerateMode;

  const inlineFields = useInlineCreateWorkItemFields({
    aiGenerateMode: resolvedAiGenerateMode,
    availableLabels,
    availableMembers,
    availableMilestones,
    availableProjects,
    chatPanelFooter,
    defaultProjectId: projectId,
    onDraftChange,
    onSetUnsaved,
    orgId,
    propertiesOpen: resolvedPropertiesOpen,
    projectId,
    projectName,
    projectSlug,
    repoPath,
  });

  const { draft, editorRef } = inlineFields;
  const canAutoExecuteWithAssignee =
    draft.assigneeType === "agent" || draft.assigneeType === "org";
  const autoExecuteBlocked =
    resolvedAiGenerateMode && !canAutoExecuteWithAssignee;

  useEffect(() => {
    if (!resolvedAiGenerateMode || !defaultAiAssignee || draft.assigneeId)
      return;

    inlineFields.updateDraft({
      assigneeId: defaultAiAssignee.id,
      assigneeType: defaultAiAssignee.type,
      orchestratorConfig: {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        ...(draft.orchestratorConfig ?? {}),
        agent_definition_id: defaultAiAssignee.agentDefinitionId,
        org_id:
          defaultAiAssignee.type === "org" ? defaultAiAssignee.id : undefined,
      },
    });
  }, [
    defaultAiAssignee,
    draft.assigneeId,
    draft.orchestratorConfig,
    inlineFields,
    resolvedAiGenerateMode,
  ]);

  useEffect(() => {
    if (autoExecuteBlocked && createMore) {
      setCreateMore(false);
    }
  }, [autoExecuteBlocked, createMore]);

  const handleAiGenerateModeChange = useCallback(
    (enabled: boolean) => {
      if (onAiGenerateModeChange) {
        onAiGenerateModeChange(enabled);
        return;
      }
      setLocalAiGenerateMode(enabled);
    },
    [onAiGenerateModeChange]
  );

  const handleAutoExecuteChange = useCallback(
    (checked: boolean) => {
      if (checked && autoExecuteBlocked) {
        Message.warning(t("common:toasts.autoExecuteRequiresAgent"));
        return;
      }
      setCreateMore(checked);
    },
    [autoExecuteBlocked, t]
  );

  const handleToggleProperties = useCallback(() => {
    if (onToggleProperties) {
      onToggleProperties();
      return;
    }
    setLocalPropertiesOpen((current) => !current);
  }, [onToggleProperties]);

  const handleManualFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      Array.from(event.target.files ?? []).forEach((file) => {
        editorRef.current?.insertFilePill(file.name, file.name);
      });
      event.target.value = "";
    },
    [editorRef]
  );

  const handleCreate = useCallback(
    async (descriptionOverride?: string) => {
      if (!draft.name.trim() || saving) return;

      setSaving(true);
      try {
        const rawMarkdown =
          descriptionOverride?.trim() ??
          inlineFields.editorRef.current?.getMarkdown()?.trim() ??
          draft.description;
        const result = await createWorkItemFromDraft({
          createMore,
          description: rawMarkdown,
          draft,
          orgId,
          selectedProjectSlug: inlineFields.selectedProjectSlug,
        });

        await emit("orgii-data-changed");
        if (createMore) {
          inlineFields.resetDraftForCreateMore();
          onWorkItemCreated(result);
        } else {
          inlineFields.clearDraft();
          onWorkItemCreated(result);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to create work item", err);
        Message.error(msg);
      } finally {
        setSaving(false);
      }
    },
    [createMore, draft, inlineFields, onWorkItemCreated, orgId, saving]
  );

  useKeyboardSave(
    handleCreate,
    !resolvedAiGenerateMode && !saving && !!draft.name.trim()
  );

  const composerHeaderContent = (
    <div data-testid="create-work-item-composer-header">
      <div className="flex h-10 items-center px-1 py-0">
        {inlineFields.titleSection}
      </div>
      <div className="px-2" aria-hidden>
        <div className="border-t border-border-2" />
      </div>
    </div>
  );
  const workItemPropertyPills = (
    <div
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
      data-testid="create-work-item-pinned-actions"
    >
      {inlineFields.workItemProjectPill}
      {inlineFields.inlinePropertyPills}
    </div>
  );

  return (
    <DetailSplitLayout
      title={t("workItems.newWorkItem")}
      borderlessHeader
      hideHeader
      publishHeaderToWorkstation={publishHeaderToWorkstation}
      headerActions={
        <>
          {showPropertiesAction ? (
            <WorkstationToolbarTooltip
              label={
                resolvedPropertiesOpen
                  ? t("workItems.hideProperties")
                  : t("workItems.showProperties")
              }
            >
              <Button
                {...PANEL_HEADER_TOKENS.actionButton}
                className={
                  resolvedPropertiesOpen
                    ? CREATE_WORK_ITEM_HEADER_ACTION_ACTIVE_CLASS
                    : CREATE_WORK_ITEM_HEADER_ACTION_CLASS
                }
                icon={
                  <Info
                    size={PANEL_HEADER_TOKENS.buttonIconSize}
                    strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  />
                }
                onClick={handleToggleProperties}
                aria-label={
                  resolvedPropertiesOpen
                    ? t("workItems.hideProperties")
                    : t("workItems.showProperties")
                }
                aria-pressed={resolvedPropertiesOpen}
                htmlType="button"
              />
            </WorkstationToolbarTooltip>
          ) : null}
          {showCloseAction ? (
            <WorkstationToolbarTooltip label={t("common:actions.close")}>
              <Button
                {...PANEL_HEADER_TOKENS.actionButton}
                className={CREATE_WORK_ITEM_HEADER_ACTION_CLASS}
                icon={
                  <X
                    size={PANEL_HEADER_TOKENS.buttonIconSize}
                    strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  />
                }
                onClick={onCancel}
                aria-label={t("common:actions.close")}
                htmlType="button"
              />
            </WorkstationToolbarTooltip>
          ) : null}
        </>
      }
      leftContent={
        <div
          className={`flex h-full min-h-0 flex-col ${
            centerLauncherContent ? "overflow-y-auto" : "overflow-hidden"
          }`}
        >
          <div
            className={
              centerLauncherContent
                ? "my-auto flex w-full shrink-0 flex-col"
                : "contents"
            }
            data-testid={
              centerLauncherContent
                ? "create-work-item-centered-launcher"
                : undefined
            }
          >
            {showAiModePanel ? (
              <div className={`${DETAIL_PANEL_TOKENS.headerWidth} px-4 py-2`}>
                <div
                  className="flex items-center justify-center gap-2 px-3 py-2"
                  data-testid="create-work-item-mode-panel"
                >
                  <span className="text-[12px] font-medium text-text-1">
                    Agent
                  </span>
                  <Switch
                    size="small"
                    checked={resolvedAiGenerateMode}
                    onChange={handleAiGenerateModeChange}
                    ariaLabel="Agent"
                    dataTestId="create-work-item-mode-ai-switch"
                  />
                </div>
              </div>
            ) : null}
            {resolvedAiGenerateMode && renderAgentComposer ? (
              <div
                className={
                  centerLauncherContent
                    ? "shrink-0 pt-6"
                    : "min-h-0 flex-1 overflow-hidden pt-6"
                }
              >
                {renderAgentComposer(
                  composerHeaderContent,
                  workItemPropertyPills
                )}
              </div>
            ) : renderAgentComposer ? (
              <div
                className={`session-creator-chat-panel-wrapper pt-6 ${
                  centerLauncherContent
                    ? `${DETAIL_PANEL_TOKENS.headerWidth} shrink-0 px-4`
                    : "min-h-0 flex-1 overflow-hidden"
                }`}
              >
                <div
                  className={`mx-auto flex min-h-0 w-full flex-col ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
                >
                  <div className="session-creator-chat-panel-fullscreen-composer relative w-full">
                    <ComposerShell className="session-creator-chat-panel-fullscreen-input-shell relative z-10 !pt-1.5">
                      {composerHeaderContent}
                      <div className="min-h-0 px-1">
                        {inlineFields.descriptionSection}
                      </div>
                      <ComposerBar
                        onAddContent={() =>
                          editorRef.current?.triggerAtMention()
                        }
                        onUpload={() => manualFileInputRef.current?.click()}
                        onOpenSkillsTools={() =>
                          editorRef.current?.triggerSlashContext()
                        }
                        dropdownDirection="down"
                        toolbarItemGap={false}
                        showContextInfo={false}
                        pills={
                          <>
                            <div
                              aria-hidden
                              className="mx-1 h-4 w-px shrink-0 bg-border-2"
                            />
                            <div className="flex min-w-0 items-center overflow-x-auto scrollbar-hide">
                              {workItemPropertyPills}
                            </div>
                          </>
                        }
                        submitButton={
                          <LaunchButton
                            ariaLabel={t("common:actions.save")}
                            disabled={!draft.name.trim() || saving}
                            loading={saving}
                            onClick={() => {
                              void handleCreate();
                            }}
                          />
                        }
                      />
                      <input
                        ref={manualFileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={handleManualFileUpload}
                        tabIndex={-1}
                        aria-hidden
                      />
                    </ComposerShell>
                  </div>
                </div>
              </div>
            ) : (
              <div className={`${DETAIL_PANEL_TOKENS.headerWidth} h-full px-4`}>
                <InlineCreateWorkItemFields state={inlineFields} />
              </div>
            )}
          </div>
        </div>
      }
      rightContent={
        resolvedPropertiesOpen ? (
          <WorkItemProperties
            workItem={inlineFields.stubWorkItem}
            onUpdate={inlineFields.handlePropertyUpdate}
            availableProjects={inlineFields.resolvedProjects}
            availableMilestones={availableMilestones}
            availableLabels={inlineFields.resolvedLabels}
            availableMembers={inlineFields.resolvedMembers}
            availableAgents={inlineFields.availableAgents}
            availableOrgs={inlineFields.availableOrgs}
            visibleFields={CREATE_WORK_ITEM_VISIBLE_FIELDS}
          />
        ) : undefined
      }
      resizableRightPanel={resolvedPropertiesOpen}
      footer={
        showFooter && inlineFields.showManualInputs && !renderAgentComposer ? (
          chatPanelFooter ? (
            <>
              <Button
                variant="secondary"
                size="small"
                onClick={inlineFields.resetDraftForCreateMore}
              >
                {t("common:actions.reset")}
              </Button>
              <Button
                variant="primary"
                size="small"
                onClick={() => handleCreate()}
                disabled={!draft.name.trim() || saving}
                data-testid="create-work-item-submit"
              >
                {saving ? t("common:status.saving") : t("common:actions.save")}
              </Button>
            </>
          ) : (
            <>
              <label className="mr-2 flex items-center gap-2 text-[12px] text-text-2">
                <Switch
                  size="small"
                  checked={createMore && !autoExecuteBlocked}
                  onChange={handleAutoExecuteChange}
                  disabled={autoExecuteBlocked}
                  dataTestId="create-work-item-auto-execute-switch"
                />
                <span>
                  {resolvedAiGenerateMode
                    ? "Auto execute"
                    : t("projects.createMore")}
                </span>
              </label>
              {showSubmitAction ? (
                <Button
                  variant="primary"
                  size="small"
                  onClick={() => handleCreate()}
                  disabled={!draft.name.trim() || saving}
                  data-testid="create-work-item-submit"
                >
                  {saving
                    ? t("common:status.saving")
                    : resolvedAiGenerateMode
                      ? "Generate Work Items"
                      : t("workItems.createWorkItem")}
                </Button>
              ) : null}
            </>
          )
        ) : undefined
      }
    />
  );
};

export default CreateWorkItemView;
