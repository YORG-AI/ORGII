import { ArrowRight, CheckSquare, FolderKanban } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import type { SelectOption } from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import Modal from "@src/scaffold/ModalSystem";

import type { TeamInboxSessionHandoffDraft } from "../domain";
import {
  MAX_HANDOFF_NOTE_LENGTH,
  type SessionHandoffForm,
  isTeamHandoff,
  selectedHandoffProject,
  sessionHandoffFormError,
  sessionHandoffFormForProject,
} from "../sessionHandoffForm";

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
  const selectedProject = selectedHandoffProject(form, draft);
  const recipient = selectedProject?.recipients.find(
    (member) => member.id === form.assigneeMemberId
  );
  const projectOptions = useMemo<SelectOption[]>(
    () =>
      draft.projects.map((project) => ({
        value: project.slug,
        label: project.name,
      })),
    [draft.projects]
  );
  const recipientOptions = useMemo<SelectOption[]>(
    () =>
      (selectedProject?.recipients ?? []).map((member) => ({
        value: member.id,
        label: member.isCurrentUser
          ? t("teamInbox.handoff.recipientSelf", { name: member.name })
          : member.name,
      })),
    [selectedProject?.recipients, t]
  );

  return (
    <Modal
      visible
      title={t("teamInbox.handoff.title")}
      width={560}
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
              {selectedProject?.sender.name ??
                t("teamInbox.handoff.chooseProject")}
            </span>
            <ArrowRight size={13} aria-hidden />
            <span className="font-medium text-text-2">
              {recipient?.name ?? t("teamInbox.handoff.chooseRecipient")}
            </span>
            {selectedProject ? (
              <>
                <span aria-hidden>·</span>
                <FolderKanban size={13} aria-hidden />
                <span className="truncate">{selectedProject.name}</span>
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
                  <CheckSquare size={12} aria-hidden />
                  {t("teamInbox.handoff.todoCount", {
                    count: draft.todoCount,
                  })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          {!draft.sourceProjectSlug ? (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-text-2">
              {t("teamInbox.handoff.project")}
              <Select
                value={form.projectSlug}
                options={projectOptions}
                onChange={(value) =>
                  onChange(
                    sessionHandoffFormForProject(form, String(value), draft)
                  )
                }
                disabled={submitting}
                placeholder={t("teamInbox.handoff.chooseProject")}
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
              disabled={submitting || !selectedProject}
              showSearch
              dropdownWidthMode="match"
              panelZIndex={10001}
              dataTestId="team-inbox-handoff-recipient"
            />
          </label>

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
