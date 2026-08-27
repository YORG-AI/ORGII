/**
 * useWorkItemHandoff
 *
 * Handoff response state for a Work Item: who may accept/return the pending
 * handoff, the in-flight action, and the optimistic override applied after a
 * transition succeeds.
 */
import { useState } from "react";

import { type WorkItemHandoff, projectApi } from "@src/api/http/project";
import type { Person } from "@src/types/core/shared";
import type { WorkItem } from "@src/types/core/workItem";

import type { WorkItemContentProps } from "../types";

export interface UseWorkItemHandoffOptions {
  workItem: WorkItem;
  shortId?: string | null;
  projectSlug?: string | null;
  onTransitionHandoff?: WorkItemContentProps["onTransitionHandoff"];
  onRefreshWorkflow?: () => void;
  currentUser: Person;
  currentUserMemberIds: Set<string>;
  teamMembers: Person[];
  t: (key: string) => string;
}

export function useWorkItemHandoff({
  workItem,
  shortId,
  projectSlug,
  onTransitionHandoff,
  onRefreshWorkflow,
  currentUser,
  currentUserMemberIds,
  teamMembers,
  t,
}: UseWorkItemHandoffOptions) {
  const [handoffOverride, setHandoffOverride] = useState<{
    workItemId: string;
    value: WorkItemHandoff;
  } | null>(null);
  const [respondingHandoff, setRespondingHandoff] = useState<
    "accept" | "return" | null
  >(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const handoff =
    handoffOverride?.workItemId === workItem.session_id &&
    handoffOverride.value.id === workItem.handoff?.id
      ? handoffOverride.value
      : workItem.handoff;
  const canRespondToHandoff = Boolean(
    handoff &&
    shortId &&
    (onTransitionHandoff || projectSlug) &&
    currentUserMemberIds.has(handoff.recipientMemberId) &&
    handoff.status === "pending"
  );
  const handoffRecipientName = handoff
    ? teamMembers.find((member) => member.id === handoff.recipientMemberId)
        ?.name
    : undefined;
  const handoffResponseUnavailableReason =
    handoff?.status === "pending" && currentUser.id === "system"
      ? t("common:teamInbox.handoff.identityUnavailable")
      : undefined;

  const respondToHandoff = (action: "accept" | "return", note?: string) => {
    if (
      !handoff ||
      !shortId ||
      (!onTransitionHandoff && !projectSlug) ||
      respondingHandoff ||
      !currentUserMemberIds.has(handoff.recipientMemberId)
    ) {
      return;
    }
    setRespondingHandoff(action);
    setHandoffError(null);
    const transition = {
      handoffId: handoff.id,
      action,
      actor: {
        id: handoff.recipientMemberId,
        name: handoffRecipientName || handoff.recipientName || currentUser.name,
      },
      note,
    } as const;
    const request = onTransitionHandoff
      ? onTransitionHandoff(transition)
      : projectApi.transitionWorkItemHandoff(projectSlug!, shortId, transition);
    void request
      .then((result) => {
        const nextHandoff =
          "frontmatter" in result ? result.frontmatter.handoff : result.handoff;
        if (nextHandoff) {
          setHandoffOverride({
            workItemId: workItem.session_id,
            value: nextHandoff,
          });
        }
        onRefreshWorkflow?.();
      })
      .catch(() => {
        setHandoffError(t("common:teamInbox.handoff.responseError"));
      })
      .finally(() => {
        setRespondingHandoff(null);
      });
  };

  return {
    handoff,
    canRespondToHandoff,
    handoffError,
    handoffRecipientName,
    handoffResponseUnavailableReason,
    respondingHandoff,
    respondToHandoff,
  };
}
