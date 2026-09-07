import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type QuickAction,
  projectApi,
  quickActionsCacheKey,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import { useProjectCachedResource } from "@src/hooks/project";
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  Edit02Icon,
  FlashIcon,
  HugeiconsIcon,
  PlayIcon,
  Settings02Icon,
} from "@src/icons";
import { ActivityHeaderActionButton } from "@src/modules/shared/components/ActivityTimeline";
import Modal from "@src/scaffold/ModalSystem";

import { WorkItemThreadSection } from "../WorkItemThread";
import { buildQuickActionUpsertRequest } from "./quickActionDraft";

export interface QuickActionCandidate {
  id: string;
  name: string;
}

export interface QuickActionsSectionProps {
  orgId: string;
  projectSlug: string | null;
  shortId: string;
  currentUser: { id: string; name?: string };
  agents: QuickActionCandidate[];
  agentOrgs: QuickActionCandidate[];
  disabled?: boolean;
  onInvoked?: () => void | Promise<void>;
}

const VERDICT_KEYS: Record<string, string> = {
  mention: "previewMentionResume",
  mention_start: "previewMentionStart",
  mention_unroutable: "previewMentionUnroutable",
};
const EMPTY_QUICK_ACTIONS: QuickAction[] = [];

export const QuickActionsSection: React.FC<QuickActionsSectionProps> = ({
  orgId,
  projectSlug,
  shortId,
  currentUser,
  agents,
  agentOrgs,
  disabled = false,
  onInvoked,
}) => {
  const { t } = useTranslation("projects");
  const readActions = useCallback(
    () => projectApi.listQuickActions(orgId),
    [orgId]
  );
  const { data: actions, refresh: refreshActions } = useProjectCachedResource({
    cacheKey: quickActionsCacheKey(orgId),
    read: readActions,
    empty: EMPTY_QUICK_ACTIONS,
  });
  const [manageOpen, setManageOpen] = useState(false);
  const [invokingId, setInvokingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [draftTarget, setDraftTarget] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    void refreshActions().catch(() => undefined);
  }, [refreshActions]);

  const targetOptions = useMemo(
    () => [
      ...agents.map((agent) => ({
        value: `agent:${agent.id}`,
        label: agent.name,
      })),
      ...agentOrgs.map((org) => ({
        value: `agent_org:${org.id}`,
        label: org.name,
      })),
    ],
    [agentOrgs, agents]
  );

  const targetName = useCallback(
    (action: QuickAction) => {
      const pool = action.targetKind === "agent" ? agents : agentOrgs;
      return (
        pool.find((candidate) => candidate.id === action.targetId)?.name ??
        action.targetId
      );
    },
    [agentOrgs, agents]
  );

  const handleInvoke = useCallback(
    async (action: QuickAction) => {
      setInvokingId(action.id);
      try {
        const result = await projectApi.invokeQuickAction({
          projectSlug,
          orgId,
          workItemId: shortId,
          actionId: action.id,
          actorId: currentUser.id,
          actorName: currentUser.name ?? currentUser.id,
        });
        const verdictKey = VERDICT_KEYS[result.wakeReason];
        Message.success(
          verdictKey
            ? t(`workItems.discussion.${verdictKey}`)
            : result.wakeReason
        );
        refresh();
        await onInvoked?.();
      } catch (error) {
        Message.error(String(error));
      } finally {
        setInvokingId(null);
      }
    },
    [
      currentUser.id,
      currentUser.name,
      onInvoked,
      orgId,
      projectSlug,
      refresh,
      shortId,
      t,
    ]
  );

  const handleCreate = useCallback(async () => {
    const request = buildQuickActionUpsertRequest({
      id: editingId,
      orgId,
      name: draftName,
      description:
        actions.find((action) => action.id === editingId)?.description ?? "",
      target: draftTarget,
      prompt: draftPrompt,
      createdBy: currentUser.id,
    });
    if (!request) return;
    setCreating(true);
    try {
      await projectApi.upsertQuickAction(request);
      setDraftName("");
      setDraftPrompt("");
      setDraftTarget(null);
      setEditingId(null);
      refresh();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setCreating(false);
    }
  }, [
    actions,
    currentUser.id,
    draftName,
    draftPrompt,
    draftTarget,
    editingId,
    orgId,
    refresh,
  ]);

  const handleEdit = useCallback((action: QuickAction) => {
    setEditingId(action.id);
    setDraftName(action.name);
    setDraftPrompt(action.prompt);
    setDraftTarget(`${action.targetKind}:${action.targetId}`);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setDraftName("");
    setDraftPrompt("");
    setDraftTarget(null);
  }, []);

  const handleArchive = useCallback(
    async (action: QuickAction) => {
      try {
        await projectApi.archiveQuickAction(orgId, action.id);
        if (editingId === action.id) handleCancelEdit();
        refresh();
      } catch (error) {
        Message.error(String(error));
      }
    },
    [editingId, handleCancelEdit, orgId, refresh]
  );

  return (
    <WorkItemThreadSection
      testId="work-item-quick-actions"
      icon={
        <HugeiconsIcon
          icon={FlashIcon}
          data-icon="zap"
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-text-3"
          aria-hidden
        />
      }
      title={
        <span className="font-normal">
          {t("workItems.quickActions.title", {
            defaultValue: "Quick actions",
          })}
        </span>
      }
      action={
        <ActivityHeaderActionButton
          icon={
            <HugeiconsIcon
              icon={Settings02Icon}
              data-icon="settings-2"
              size={12}
            />
          }
          label={t("common:actions.manage", { defaultValue: "Manage" })}
          onClick={() => setManageOpen(true)}
          disabled={disabled}
          data-testid="work-item-quick-actions-manage"
        />
      }
    >
      {actions.length === 0 ? (
        <p className="text-xs text-text-4">
          {t("workItems.quickActions.empty", {
            defaultValue:
              "No quick actions yet. Save a reusable prompt for an agent.",
          })}
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {actions.map((action) => (
            <Button
              key={action.id}
              variant="secondary"
              appearance="outline"
              size="small"
              icon={
                <HugeiconsIcon icon={PlayIcon} data-icon="play" size={12} />
              }
              loading={invokingId === action.id}
              disabled={disabled || invokingId !== null}
              onClick={() => void handleInvoke(action)}
              title={`${targetName(action)} · ${action.prompt}`}
              data-testid={`work-item-quick-action-${action.id}`}
            >
              {action.name}
            </Button>
          ))}
        </div>
      )}

      <Modal
        visible={manageOpen}
        title={t("workItems.quickActions.manageTitle", {
          defaultValue: "Manage quick actions",
        })}
        width={520}
        onCancel={() => setManageOpen(false)}
        footer={null}
      >
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-2 rounded-lg border border-border-1 p-3">
            <Input
              value={draftName}
              onChange={(value) => setDraftName(value)}
              placeholder={t("workItems.quickActions.namePlaceholder", {
                defaultValue: "Action name (e.g. Fix CI)",
              })}
              size="small"
              data-testid="work-item-quick-action-name"
            />
            <Select
              value={draftTarget ?? undefined}
              options={targetOptions}
              onChange={(value) => setDraftTarget(value as string)}
              placeholder={t("workItems.quickActions.targetPlaceholder", {
                defaultValue: "Target agent",
              })}
              size="small"
              showSearch
              dataTestId="work-item-quick-action-target"
            />
            <Textarea
              value={draftPrompt}
              onChange={(value) => setDraftPrompt(value)}
              placeholder={t("workItems.quickActions.promptPlaceholder", {
                defaultValue: "What should the agent do?",
              })}
              size="small"
              data-testid="work-item-quick-action-prompt"
            />
            <div className="flex justify-end gap-2">
              {editingId ? (
                <Button
                  variant="tertiary"
                  size="small"
                  onClick={handleCancelEdit}
                  data-testid="work-item-quick-action-cancel-edit"
                >
                  {t("common:actions.cancel", { defaultValue: "Cancel" })}
                </Button>
              ) : null}
              <Button
                variant="primary"
                size="small"
                icon={
                  <HugeiconsIcon
                    icon={editingId ? Edit02Icon : Add01Icon}
                    data-icon={editingId ? "pencil" : "plus"}
                    size={13}
                  />
                }
                disabled={
                  !draftName.trim() || !draftPrompt.trim() || !draftTarget
                }
                loading={creating}
                onClick={() => void handleCreate()}
                data-testid="work-item-quick-action-create"
              >
                {editingId
                  ? t("common:actions.save", { defaultValue: "Save" })
                  : t("common:actions.add", { defaultValue: "Add" })}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            {actions.map((action) => (
              <div
                key={action.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-fill-1"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-text-1">
                  {action.name}
                </span>
                <span className="truncate text-xs text-text-4">
                  {targetName(action)} · ×{action.useCount}
                </span>
                <Button
                  variant="tertiary"
                  appearance="ghost"
                  size="mini"
                  iconOnly
                  icon={
                    <HugeiconsIcon
                      icon={Edit02Icon}
                      data-icon="pencil"
                      size={13}
                    />
                  }
                  onClick={() => handleEdit(action)}
                  aria-label={t("common:actions.edit", {
                    defaultValue: "Edit action",
                  })}
                  data-testid={`work-item-quick-action-edit-${action.id}`}
                />
                <Button
                  variant="tertiary"
                  appearance="ghost"
                  size="mini"
                  iconOnly
                  icon={
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      data-icon="trash-2"
                      size={13}
                    />
                  }
                  onClick={() => void handleArchive(action)}
                  aria-label={t("workItems.quickActions.archive", {
                    defaultValue: "Archive action",
                  })}
                />
              </div>
            ))}
            {actions.length === 0 ? (
              <p className="px-2 py-1 text-xs text-text-4">
                {t("workItems.quickActions.emptyManage", {
                  defaultValue: "Nothing saved yet.",
                })}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end">
            <Button
              variant="tertiary"
              size="small"
              icon={
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={13} />
              }
              onClick={() => setManageOpen(false)}
            >
              {t("common:actions.close", { defaultValue: "Close" })}
            </Button>
          </div>
        </div>
      </Modal>
    </WorkItemThreadSection>
  );
};

export default QuickActionsSection;
