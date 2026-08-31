import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LinearWorkflowStateCreateRequest,
  LinearWorkflowStateSummary,
  LinearWorkflowStateType,
  LinearWorkflowStateUpdateRequest,
} from "@src/api/http/integrations";
import type { LinearTeamSummary } from "@src/api/http/integrations/linearProjects";
import Button from "@src/components/Button";
import {
  Add01Icon,
  Cancel01Icon,
  CircleIcon,
  Delete02Icon,
  HugeiconsIcon,
  Pen01Icon,
  Refresh04Icon,
  Tick01Icon,
} from "@src/icons";

interface LinearWorkflowStatesSectionProps {
  team?: LinearTeamSummary;
  states: LinearWorkflowStateSummary[];
  loadingStates: boolean;
  savingStateId: string | null;
  onRefreshStates: () => void;
  onCreateState: (request: LinearWorkflowStateCreateRequest) => Promise<void>;
  onUpdateState: (
    stateId: string,
    request: LinearWorkflowStateUpdateRequest
  ) => Promise<void>;
  onArchiveState: (stateId: string) => Promise<void>;
}

interface StateDraft {
  name: string;
  color: string;
  stateType: LinearWorkflowStateType;
}

const WORKFLOW_STATE_TYPES: readonly LinearWorkflowStateType[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

const DEFAULT_STATE_COLOR = "#6B7280";
const DEFAULT_STATE_TYPE: LinearWorkflowStateType = "unstarted";

function createDraftFromState(state?: LinearWorkflowStateSummary): StateDraft {
  return {
    name: state?.name ?? "",
    color: state?.color ?? DEFAULT_STATE_COLOR,
    stateType: state?.type ?? DEFAULT_STATE_TYPE,
  };
}

const LinearWorkflowStatesSection: React.FC<
  LinearWorkflowStatesSectionProps
> = ({
  team,
  states,
  loadingStates,
  savingStateId,
  onRefreshStates,
  onCreateState,
  onUpdateState,
  onArchiveState,
}) => {
  const { t } = useTranslation("projects");
  const [creating, setCreating] = useState(false);
  const [editingStateId, setEditingStateId] = useState<string | null>(null);
  const [draft, setDraft] = useState<StateDraft>(() => createDraftFromState());

  const sortedStates = useMemo(
    () =>
      [...states].sort((left, right) => {
        const leftPosition = left.position ?? Number.MAX_SAFE_INTEGER;
        const rightPosition = right.position ?? Number.MAX_SAFE_INTEGER;
        if (leftPosition !== rightPosition) return leftPosition - rightPosition;
        return left.name.localeCompare(right.name);
      }),
    [states]
  );

  const canSaveDraft = draft.name.trim().length > 0 && !!team;

  const resetDraft = () => {
    setDraft(createDraftFromState());
    setCreating(false);
    setEditingStateId(null);
  };

  const startCreate = () => {
    setDraft(createDraftFromState());
    setCreating(true);
    setEditingStateId(null);
  };

  const startEdit = (state: LinearWorkflowStateSummary) => {
    setDraft(createDraftFromState(state));
    setCreating(false);
    setEditingStateId(state.id);
  };

  const handleSaveCreate = async () => {
    if (!team || !canSaveDraft) return;
    await onCreateState({
      team_id: team.id,
      name: draft.name.trim(),
      color: draft.color,
      state_type: draft.stateType,
    });
    resetDraft();
  };

  const handleSaveEdit = async () => {
    if (!editingStateId || !canSaveDraft) return;
    await onUpdateState(editingStateId, {
      name: draft.name.trim(),
      color: draft.color,
      state_type: draft.stateType,
    });
    resetDraft();
  };

  const renderDraftEditor = (mode: "create" | "edit") => (
    <div className="mx-2 mb-2 rounded-lg border border-border-2 bg-fill-1 p-2">
      <input
        value={draft.name}
        onChange={(event) =>
          setDraft((current) => ({ ...current, name: event.target.value }))
        }
        placeholder={t("linearProjects.statusPanel.statusNamePlaceholder")}
        className="mb-2 h-7 w-full rounded-md border border-border-2 bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-primary-6"
      />
      <div className="mb-2 flex items-center gap-2">
        <input
          type="color"
          value={draft.color}
          onChange={(event) =>
            setDraft((current) => ({ ...current, color: event.target.value }))
          }
          className="h-7 w-8 rounded border border-border-2 bg-bg-1"
          aria-label={t("linearProjects.statusPanel.color")}
        />
        <select
          value={draft.stateType}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              stateType: event.target.value as LinearWorkflowStateType,
            }))
          }
          className="h-7 min-w-0 flex-1 rounded-md border border-border-2 bg-bg-1 px-2 text-xs text-text-1 outline-none focus:border-primary-6"
        >
          {WORKFLOW_STATE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`linearProjects.statusPanel.types.${type}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex justify-end gap-1">
        <button
          type="button"
          onClick={resetDraft}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-text-2 hover:bg-fill-2"
        >
          <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={13} />
          {t("common:actions.cancel")}
        </button>
        <button
          type="button"
          onClick={mode === "create" ? handleSaveCreate : handleSaveEdit}
          disabled={!canSaveDraft || savingStateId !== null}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-primary-6 px-2 text-xs text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={13} />
          {t("common:actions.save")}
        </button>
      </div>
    </div>
  );

  return (
    <section className="px-1 py-2">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-3">
          {t("linearProjects.statusPanel.workflowStates")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            iconOnly
            onClick={onRefreshStates}
            title={t("common:actions.refresh")}
            icon={
              <HugeiconsIcon
                icon={Refresh04Icon}
                data-icon="refresh-cw"
                size={13}
                className={loadingStates ? "animate-spin" : ""}
              />
            }
          />
          <button
            type="button"
            onClick={startCreate}
            disabled={!team}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-fill-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
            title={t("linearProjects.statusPanel.addStatus")}
          >
            <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
          </button>
        </div>
      </div>

      {creating && renderDraftEditor("create")}

      {loadingStates && sortedStates.length === 0 ? (
        <div className="px-2 py-4 text-xs text-text-3">
          {t("linearProjects.statusPanel.loading")}
        </div>
      ) : sortedStates.length === 0 ? (
        <div className="px-2 py-4 text-xs text-text-3">
          {t("linearProjects.statusPanel.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {sortedStates.map((state) => {
            const isEditing = editingStateId === state.id;
            const isSaving = savingStateId === state.id;
            return (
              <div key={state.id}>
                <div className="group flex min-h-8 items-center gap-2 rounded-md px-2 py-1 hover:bg-fill-1">
                  <HugeiconsIcon
                    icon={CircleIcon}
                    data-icon="circle"
                    size={12}
                    fill={state.color ?? DEFAULT_STATE_COLOR}
                    className="shrink-0"
                    style={{ color: state.color ?? DEFAULT_STATE_COLOR }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-text-1">
                      {state.name}
                    </div>
                    <div className="text-[11px] text-text-3">
                      {state.type
                        ? t(`linearProjects.statusPanel.types.${state.type}`)
                        : t("linearProjects.unknownState")}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => startEdit(state)}
                    className="hidden h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-fill-2 hover:text-text-1 group-hover:inline-flex"
                    title={t("common:actions.edit")}
                  >
                    <HugeiconsIcon
                      icon={Pen01Icon}
                      data-icon="pencil"
                      size={12}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => void onArchiveState(state.id)}
                    disabled={isSaving}
                    className="hover:text-danger-7 hidden h-6 w-6 items-center justify-center rounded-md text-text-3 hover:bg-danger-1 disabled:cursor-not-allowed disabled:opacity-50 group-hover:inline-flex"
                    title={t("linearProjects.statusPanel.archiveStatus")}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      data-icon="trash-2"
                      size={12}
                    />
                  </button>
                </div>
                {isEditing && renderDraftEditor("edit")}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default LinearWorkflowStatesSection;
