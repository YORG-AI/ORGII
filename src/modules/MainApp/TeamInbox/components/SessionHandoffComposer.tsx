import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import {
  ArrowRight02Icon,
  CheckmarkSquare01Icon,
  FolderKanbanIcon,
  HugeiconsIcon,
} from "@src/icons";
import WorkItemProperties from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties";
import type { WorkItemPropertyFieldKey } from "@src/modules/ProjectManager/WorkItems/components/WorkItemProperties/types";
import Modal from "@src/scaffold/ModalSystem";
import type { WorkItem } from "@src/types/core/workItem";

import type { TeamInboxSessionHandoffDraft } from "../domain";
import {
  MAX_HANDOFF_NOTE_LENGTH,
  type SessionHandoffForm,
  isTeamHandoff,
  selectedHandoffDestination,
  sessionHandoffFormError,
  sessionHandoffFormForDestination,
  sessionHandoffFormToWorkItem,
  sessionHandoffFormWithWorkItemUpdates,
} from "../sessionHandoffForm";

const SESSION_HANDOFF_PROPERTY_FIELDS: WorkItemPropertyFieldKey[] = [
  "status",
  "priority",
  "date",
];

interface SessionHandoffComposerProps {
  draft: TeamInboxSessionHandoffDraft;
  error?: string | null;
  form: SessionHandoffForm;
  submitting: boolean;
  onCancel: () => void;
  onChange: (form: SessionHandoffForm) => void;
  onSubmit: () => void;
}

const SessionHandoffComposer: React.FC<SessionHandoffComposerProps> = ({
  draft,
  error,
  form,
  submitting,
  onCancel,
  onChange,
  onSubmit,
}) => {
  const { t } = useTranslation();
  const validationError = sessionHandoffFormError(form, draft);
  const teamHandoff = isTeamHandoff(form, draft);
  const selectedDestination = selectedHandoffDestination(form, draft);
  const recipient = selectedDestination?.recipients.find(
    (member) => member.id === form.assigneeMemberId
  );
  const destinationOptions = useMemo<SelectOption[]>(
    () =>
      draft.destinations.map((destination) => ({
        value: destination.key,
        label:
          destination.kind === "cloud_org"
            ? t("teamInbox.handoff.cloudDestination", {
                name: destination.name,
              })
            : destination.name,
      })),
    [draft.destinations, t]
  );
  const recipientOptions = useMemo<SelectOption[]>(
    () =>
      (selectedDestination?.recipients ?? []).map((member) => ({
        value: member.id,
        label: member.isCurrentUser
          ? t("teamInbox.handoff.recipientSelf", { name: member.name })
          : member.name,
      })),
    [selectedDestination?.recipients, t]
  );
  const propertyWorkItem = useMemo(
    () => sessionHandoffFormToWorkItem(form, draft),
    [draft, form]
  );
  const handlePropertyUpdate = useCallback(
    (updates: Partial<WorkItem>) => {
      if (submitting) return;
      onChange(sessionHandoffFormWithWorkItemUpdates(form, updates));
    },
    [form, onChange, submitting]
  );

  return (
    <Modal
      visible
      title={t("teamInbox.handoff.title")}
      width={640}
      bodyClassName="p-0"
      onCancel={onCancel}
      onOk={onSubmit}
      okText={t(
        teamHandoff
          ? "teamInbox.handoff.submitHandoff"
          : "teamInbox.handoff.submitCreate"
      )}
      cancelText={t("common:actions.cancel")}
      okButtonProps={{
        loading: submitting,
        disabled: Boolean(validationError),
      }}
      cancelButtonProps={{ disabled: submitting }}
      maskClosable={!submitting}
      escToExit={!submitting}
    >
      <div
        data-testid="team-inbox-session-handoff-composer"
        className="flex flex-col"
      >
        <div className="border-b border-border-2 bg-bg-2 px-5 py-4">
          <div className="flex items-center gap-2 text-xs text-text-3">
            <span className="font-medium text-text-2">
              {selectedDestination?.sender.name ??
                t("teamInbox.handoff.chooseDestination")}
            </span>
            <HugeiconsIcon
              icon={ArrowRight02Icon}
              data-icon="arrow-right"
              size={13}
              aria-hidden
            />
            <span className="font-medium text-text-2">
              {recipient?.name ?? t("teamInbox.handoff.chooseRecipient")}
            </span>
            {selectedDestination ? (
              <>
                <span aria-hidden>·</span>
                <HugeiconsIcon
                  icon={FolderKanbanIcon}
                  data-icon="folder-kanban"
                  size={13}
                  aria-hidden
                />
                <span className="truncate">
                  {selectedDestination.kind === "cloud_org"
                    ? t("teamInbox.handoff.cloudDestination", {
                        name: selectedDestination.name,
                      })
                    : selectedDestination.name}
                </span>
              </>
            ) : null}
          </div>
          {draft.requestPreview ? (
            <p className="mt-3 line-clamp-3 whitespace-pre-wrap text-sm leading-5 text-text-2">
              {draft.requestPreview}
            </p>
          ) : null}
          {draft.impactSummary || draft.todoCount > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-text-3">
              {draft.impactSummary ? <span>{draft.impactSummary}</span> : null}
              {draft.todoCount > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <HugeiconsIcon
                    icon={CheckmarkSquare01Icon}
                    data-icon="check-square"
                    size={12}
                    aria-hidden
                  />
                  {t("teamInbox.handoff.todoCount", {
                    count: draft.todoCount,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {!draft.sourceDestinationKey ? (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-text-2">
              {t("teamInbox.handoff.destination")}
              <Select
                value={form.destinationKey}
                options={destinationOptions}
                onChange={(value) =>
                  onChange(
                    sessionHandoffFormForDestination(form, String(value), draft)
                  )
                }
                disabled={submitting}
                placeholder={t("teamInbox.handoff.chooseDestination")}
                showSearch
                dropdownWidthMode="match"
                panelZIndex={10001}
                dataTestId="team-inbox-handoff-project"
              />
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5 text-xs font-medium text-text-2">
            {t("teamInbox.handoff.workItemTitle")}
            <Input
              value={form.title}
              onChange={(title) => onChange({ ...form, title })}
              disabled={submitting}
              maxLength={120}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs font-medium text-text-2">
            {t("teamInbox.handoff.assignTo")}
            <Select
              value={form.assigneeMemberId}
              options={recipientOptions}
              onChange={(value) =>
                onChange({ ...form, assigneeMemberId: String(value) })
              }
              disabled={submitting || !selectedDestination}
              showSearch
              dropdownWidthMode="match"
              panelZIndex={10001}
              dataTestId="team-inbox-handoff-recipient"
            />
          </label>

          <fieldset
            key={submitting ? "locked-properties" : "editable-properties"}
            disabled={submitting}
            className="m-0 min-w-0 border-0 p-0"
            data-testid="team-inbox-handoff-properties"
          >
            <legend className="sr-only">
              {t("projects:workItems.properties.propertiesSection")}
            </legend>
            <WorkItemProperties
              workItem={propertyWorkItem}
              onUpdate={handlePropertyUpdate}
              visibleFields={SESSION_HANDOFF_PROPERTY_FIELDS}
              fieldVariant="pill"
              pillLayout="wrap"
              showTime={false}
              showMoreMenu={false}
            />
          </fieldset>

          {teamHandoff ? (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-text-2">
              {t("teamInbox.handoff.note")}
              <Textarea
                value={form.note}
                onChange={(note) => onChange({ ...form, note })}
                disabled={submitting}
                maxLength={MAX_HANDOFF_NOTE_LENGTH}
                showWordLimit
                autoSize={{ minRows: 3, maxRows: 6 }}
                resize="none"
                placeholder={t("teamInbox.handoff.notePlaceholder")}
              />
            </label>
          ) : (
            <p className="rounded-lg border border-border-2 bg-bg-2 px-3 py-2 text-xs leading-5 text-text-3">
              {t("teamInbox.handoff.selfHint")}
            </p>
          )}

          {validationError && !error ? (
            <p role="alert" className="text-xs text-danger-6">
              {t(`teamInbox.handoff.validation.${validationError}`)}
            </p>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-danger-6">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Modal>
  );
};

export default SessionHandoffComposer;
