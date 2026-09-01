import { emit } from "@tauri-apps/api/event";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import Message from "@src/components/Message";
import Switch from "@src/components/Switch";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import LaunchButton from "@src/features/SessionCreator/components/LaunchButton";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { Cancel01Icon, HugeiconsIcon, InformationCircleIcon } from "@src/icons";
import {
  CreateComposerHeader,
  CreateComposerPinnedActions,
  DetailSplitLayout,
  ManualCreateComposer,
} from "@src/modules/ProjectManager/shared";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import {
  CreatorContentLayout,
  PANEL_HEADER_TOKENS,
} from "@src/modules/shared/layouts/blocks";
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
  "hover:bg-fill-2! h-7! w-7! min-w-7!";
const CREATE_WORK_ITEM_HEADER_ACTION_ACTIVE_CLASS =
  "h-7! w-7! min-w-7! bg-surface-selected! text-primary-6! hover:bg-fill-2!";

export type { CreatedWorkItemResult };

interface CreateWorkItemViewProps {
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
  /** Optional content centered in the page above the bottom-docked manual composer. */
  middleContent?: React.ReactNode;
  /** Agent/Manual segmented control rendered with the creator setup pills. */
  creatorModeControl?: React.ReactNode;
  /** Render Session Creator in Agent mode with Work Item fields in its composer. */
  renderAgentComposer?: (
    headerContent: React.ReactNode,
    pinnedActionsContent: React.ReactNode
  ) => React.ReactNode;
  defaultAiExecutionTarget?: {
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
  middleContent,
  creatorModeControl,
  renderAgentComposer,
  defaultAiExecutionTarget = null,
}) => {
  const { t } = useTranslation("projects");
  const [saving, setSaving] = useState(false);
  const [createMore, setCreateMore] = useState(false);
  const [localAiGenerateMode, setLocalAiGenerateMode] = useState(true);
  const [localPropertiesOpen, setLocalPropertiesOpen] = useState(false);

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
    dockedComposer: Boolean(renderAgentComposer),
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
  const canAutoExecuteWithTarget = Boolean(
    draft.orchestratorConfig?.agent_definition_id ||
    draft.orchestratorConfig?.org_id
  );
  const autoExecuteBlocked =
    resolvedAiGenerateMode && !canAutoExecuteWithTarget;

  useEffect(() => {
    if (
      !resolvedAiGenerateMode ||
      !defaultAiExecutionTarget ||
      canAutoExecuteWithTarget
    )
      return;

    inlineFields.updateDraft({
      orchestratorConfig: {
        ...DEFAULT_ORCHESTRATOR_CONFIG,
        ...(draft.orchestratorConfig ?? {}),
        agent_definition_id: defaultAiExecutionTarget.agentDefinitionId,
        org_id:
          defaultAiExecutionTarget.type === "org"
            ? defaultAiExecutionTarget.id
            : undefined,
      },
    });
  }, [
    canAutoExecuteWithTarget,
    defaultAiExecutionTarget,
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
        Message.warning(t("common:toasts.autoExecuteRequiresExecutionAgent"));
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

        await emit("orgii-data-changed", {
          project_slug: result.projectSlug,
          work_item_id: result.shortId,
          source: "work-item-create",
        });
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
    <CreateComposerHeader dataTestId="create-work-item-composer-header">
      {inlineFields.titleSection}
    </CreateComposerHeader>
  );
  const workItemPropertyPills = (
    <CreateComposerPinnedActions dataTestId="create-work-item-pinned-actions">
      {creatorModeControl}
      {inlineFields.workItemProjectPill}
      {inlineFields.inlinePropertyPills}
    </CreateComposerPinnedActions>
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
            <ToolbarTooltip
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
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    data-icon="info"
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
            </ToolbarTooltip>
          ) : null}
          {showCloseAction ? (
            <ToolbarTooltip label={t("common:actions.close")}>
              <Button
                {...PANEL_HEADER_TOKENS.actionButton}
                className={CREATE_WORK_ITEM_HEADER_ACTION_CLASS}
                icon={
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    data-icon="x"
                    size={PANEL_HEADER_TOKENS.buttonIconSize}
                    strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  />
                }
                onClick={onCancel}
                aria-label={t("common:actions.close")}
                htmlType="button"
              />
            </ToolbarTooltip>
          ) : null}
        </>
      }
      leftContent={
        <CreatorContentLayout
          placement={
            resolvedAiGenerateMode && renderAgentComposer ? "fill" : "bottom"
          }
          contentDataTestId="create-work-item-creator-content"
          middleContent={middleContent}
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
                  onCheckedChange={handleAiGenerateModeChange}
                  ariaLabel="Agent"
                  dataTestId="create-work-item-mode-ai-switch"
                />
              </div>
            </div>
          ) : null}
          {resolvedAiGenerateMode && renderAgentComposer ? (
            renderAgentComposer(composerHeaderContent, workItemPropertyPills)
          ) : renderAgentComposer ? (
            <ManualCreateComposer
              dataTestId="create-work-item-manual-composer"
              editorRef={editorRef}
              headerContent={composerHeaderContent}
              editorContent={inlineFields.descriptionSection}
              pinnedActionsContent={workItemPropertyPills}
              pills={
                <MarkdownEditorModeSwitch
                  mode={inlineFields.editorMode}
                  onModeChange={inlineFields.setEditorMode}
                  disabled={saving}
                  dataTestId="create-work-item-description-mode-switch"
                />
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
          ) : (
            <div className={`${DETAIL_PANEL_TOKENS.headerWidth} h-full px-4`}>
              <InlineCreateWorkItemFields state={inlineFields} />
            </div>
          )}
        </CreatorContentLayout>
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
                  onCheckedChange={handleAutoExecuteChange}
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
