import type {
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import type { TeamInboxSessionHandoffDraft } from "./domain";
import type { TeamInboxHandoffDestination } from "./domain";

export const MAX_HANDOFF_NOTE_LENGTH = 1_000;

export interface SessionHandoffForm {
  title: string;
  destinationKey: string;
  assigneeMemberId: string;
  status: WorkItemStatus;
  priority: WorkItemPriority;
  targetDate: string;
  note: string;
}

export function sessionHandoffFormToWorkItem(
  form: SessionHandoffForm,
  draft: TeamInboxSessionHandoffDraft
): WorkItem {
  return {
    session_id: draft.sessionId,
    user_id: form.assigneeMemberId,
    name: form.title,
    target_date: form.targetDate || null,
    updated_time: "",
    star: false,
    created_time: "",
    spec: draft.requestPreview ?? "",
    status: form.status,
    workItemStatus: form.status,
    priority: form.priority,
    endDate: form.targetDate || undefined,
  };
}

export function sessionHandoffFormWithWorkItemUpdates(
  form: SessionHandoffForm,
  updates: Partial<WorkItem>
): SessionHandoffForm {
  return {
    ...form,
    ...(updates.workItemStatus !== undefined
      ? { status: updates.workItemStatus }
      : {}),
    ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
    ...("endDate" in updates ? { targetDate: updates.endDate ?? "" } : {}),
  };
}

export function selectedHandoffDestination(
  form: Pick<SessionHandoffForm, "destinationKey">,
  draft: TeamInboxSessionHandoffDraft
): TeamInboxHandoffDestination | undefined {
  return draft.destinations.find(
    (destination) => destination.key === form.destinationKey
  );
}

function defaultDestination(
  draft: TeamInboxSessionHandoffDraft
): TeamInboxHandoffDestination | undefined {
  if (draft.sourceDestinationKey) {
    return draft.destinations.find(
      (destination) => destination.key === draft.sourceDestinationKey
    );
  }
  return draft.destinations.length === 1 ? draft.destinations[0] : undefined;
}

function defaultRecipient(destination?: TeamInboxHandoffDestination): string {
  return (
    destination?.recipients.find((member) => member.isCurrentUser)?.id ??
    destination?.recipients[0]?.id ??
    ""
  );
}

export function createSessionHandoffForm(
  draft: TeamInboxSessionHandoffDraft
): SessionHandoffForm {
  const destination = defaultDestination(draft);
  return {
    title: draft.title,
    destinationKey: destination?.key ?? "",
    assigneeMemberId: defaultRecipient(destination),
    status: "planned",
    priority: "none",
    targetDate: "",
    note: "",
  };
}

export function sessionHandoffFormForDestination(
  form: SessionHandoffForm,
  destinationKey: string,
  draft: TeamInboxSessionHandoffDraft
): SessionHandoffForm {
  const destination = draft.destinations.find(
    (candidate) => candidate.key === destinationKey
  );
  return {
    ...form,
    destinationKey,
    assigneeMemberId: defaultRecipient(destination),
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
  if (!form.destinationKey) return "project_required";
  const destination = selectedHandoffDestination(form, draft);
  if (!destination) return "project_unavailable";
  if (!form.assigneeMemberId) return "recipient_required";
  if (
    !destination.recipients.some(
      (member) => member.id === form.assigneeMemberId
    )
  ) {
    return "recipient_unavailable";
  }
  return null;
}

export function isTeamHandoff(
  form: SessionHandoffForm,
  draft: TeamInboxSessionHandoffDraft
): boolean {
  const recipient = selectedHandoffDestination(form, draft)?.recipients.find(
    (member) => member.id === form.assigneeMemberId
  );
  return Boolean(recipient && !recipient.isCurrentUser);
}

export function normalizedSessionHandoffForm(
  form: SessionHandoffForm
): SessionHandoffForm {
  return {
    title: form.title.trim(),
    destinationKey: form.destinationKey,
    assigneeMemberId: form.assigneeMemberId,
    status: form.status,
    priority: form.priority,
    targetDate: form.targetDate,
    note: form.note.trim().slice(0, MAX_HANDOFF_NOTE_LENGTH),
  };
}
