import type { TeamInboxSessionHandoffDraft } from "./domain";
import type { TeamInboxHandoffProject } from "./domain";

export const MAX_HANDOFF_NOTE_LENGTH = 1_000;

export interface SessionHandoffForm {
  title: string;
  projectSlug: string;
  assigneeMemberId: string;
  note: string;
}

export function selectedHandoffProject(
  form: Pick<SessionHandoffForm, "projectSlug">,
  draft: TeamInboxSessionHandoffDraft
): TeamInboxHandoffProject | undefined {
  return draft.projects.find((project) => project.slug === form.projectSlug);
}

function defaultProject(
  draft: TeamInboxSessionHandoffDraft
): TeamInboxHandoffProject | undefined {
  if (draft.sourceProjectSlug) {
    return draft.projects.find(
      (project) => project.slug === draft.sourceProjectSlug
    );
  }
  return draft.projects.length === 1 ? draft.projects[0] : undefined;
}

function defaultRecipient(project?: TeamInboxHandoffProject): string {
  return (
    project?.recipients.find((member) => member.isCurrentUser)?.id ??
    project?.recipients[0]?.id ??
    ""
  );
}

export function createSessionHandoffForm(
  draft: TeamInboxSessionHandoffDraft
): SessionHandoffForm {
  const project = defaultProject(draft);
  return {
    title: draft.title,
    projectSlug: project?.slug ?? "",
    assigneeMemberId: defaultRecipient(project),
    note: "",
  };
}

export function sessionHandoffFormForProject(
  form: SessionHandoffForm,
  projectSlug: string,
  draft: TeamInboxSessionHandoffDraft
): SessionHandoffForm {
  const project = draft.projects.find(
    (candidate) => candidate.slug === projectSlug
  );
  return {
    ...form,
    projectSlug,
    assigneeMemberId: defaultRecipient(project),
  };
}

export function sessionHandoffFormError(
  form: SessionHandoffForm,
  draft: TeamInboxSessionHandoffDraft
):
  | "title_required"
  | "project_required"
  | "project_unavailable"
  | "recipient_required"
  | "recipient_unavailable"
  | null {
  if (!form.title.trim()) return "title_required";
  if (!form.projectSlug) return "project_required";
  const project = selectedHandoffProject(form, draft);
  if (!project) return "project_unavailable";
  if (!form.assigneeMemberId) return "recipient_required";
  if (
    !project.recipients.some((member) => member.id === form.assigneeMemberId)
  ) {
    return "recipient_unavailable";
  }
  return null;
}

export function isTeamHandoff(
  form: SessionHandoffForm,
  draft: TeamInboxSessionHandoffDraft
): boolean {
  const recipient = selectedHandoffProject(form, draft)?.recipients.find(
    (member) => member.id === form.assigneeMemberId
  );
  return Boolean(recipient && !recipient.isCurrentUser);
}

export function normalizedSessionHandoffForm(
  form: SessionHandoffForm
): SessionHandoffForm {
  return {
    title: form.title.trim(),
    projectSlug: form.projectSlug,
    assigneeMemberId: form.assigneeMemberId,
    note: form.note.trim().slice(0, MAX_HANDOFF_NOTE_LENGTH),
  };
}
