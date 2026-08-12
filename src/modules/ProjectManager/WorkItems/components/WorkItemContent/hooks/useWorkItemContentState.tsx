import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import type { TabPillItem } from "@src/components/TabPill";
import { createLogger } from "@src/hooks/logger";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";
import {
  resolveImagePathsForDisplay,
  unresolveImagePathsForStorage,
} from "@src/modules/ProjectManager/shared/utils/workItemImagePaths";
import type { Person } from "@src/types/core/shared";
import type {
  TodoItem,
  WorkItemComment,
  WorkItem as WorkItemExtended,
} from "@src/types/core/workItem";

import { SESSION_TAB_KEYS, type SessionTab } from "../types";
import { useWorkItemTimeline } from "../useWorkItemTimeline";
import { normalizeWorkItemMentionIds } from "../workItemMentions";

const logger = createLogger("useWorkItemContentState");

interface UseWorkItemContentStateOptions {
  workItem: WorkItemExtended;
  onUpdateWorkItem?: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate?: (updates: Partial<WorkItemExtended>) => void;
  currentUserProp?: Person;
  teamMembers?: Person[];
  projectSlug?: string | null;
  shortId?: string | null;
  orgId?: string | null;
}

export function useWorkItemContentState(
  options: UseWorkItemContentStateOptions
) {
  const {
    workItem,
    onUpdateWorkItem,
    onUpdateWorkItemImmediate,
    currentUserProp,
    teamMembers = [],
    projectSlug,
    shortId,
    orgId,
  } = options;

  const { t } = useTranslation("projects");
  const {
    currentUser: resolvedCurrentUser,
    memberIds: resolvedCurrentUserMemberIds,
  } = useCurrentUserMemberIds(teamMembers);

  const currentUser = useMemo(
    () =>
      currentUserProp ??
      resolvedCurrentUser ?? {
        id: "system",
        name: t("workItems.activity.system"),
        color: "var(--color-fill-3)",
      },
    [currentUserProp, resolvedCurrentUser, t]
  );
  const currentUserMemberIds = useMemo(() => {
    const ids = new Set(resolvedCurrentUserMemberIds);
    if (currentUserProp?.id) ids.add(currentUserProp.id);
    return ids;
  }, [currentUserProp?.id, resolvedCurrentUserMemberIds]);

  const [activeSessionTab, setActiveSessionTab] =
    useState<SessionTab>("session");
  const [commentText, setCommentText] = useState("");
  const [replyToCommentId, setReplyToCommentId] = useState<string | null>(null);
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const currentPhase = workItem.orchestratorState?.current_phase ?? "idle";
  const isAgentRunning = currentPhase === "sde" || currentPhase === "review";
  const scopedShortId = shortId ?? workItem.shortId ?? "";

  useEffect(() => {
    if (!scopedShortId || !currentUser.id) return;
    let cancelled = false;
    projectApi
      .listWorkItemSubscriptions({
        projectSlug: projectSlug ?? null,
        orgId: orgId || "personal-org",
        workItemId: scopedShortId,
      })
      .then((subscriptions) => {
        if (!cancelled) {
          setIsSubscribed(
            subscriptions.some(
              (subscription) =>
                subscription.subscriberId === currentUser.id &&
                !subscription.mutedAt
            )
          );
        }
      })
      .catch((error) =>
        logger.warn("Failed to read Work Item subscriptions", error)
      );
    return () => {
      cancelled = true;
    };
  }, [currentUser.id, orgId, projectSlug, scopedShortId]);

  const sessionTabItems: TabPillItem[] = useMemo(
    () =>
      SESSION_TAB_KEYS.map((key) => ({
        key,
        label:
          key === "session"
            ? t("common:terminology.agent")
            : t(`common:labels.${key}`),
        dataTestId: `work-item-sessions-tab-${key}`,
        badge:
          key === "session" && isAgentRunning ? (
            <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6" />
          ) : undefined,
      })),
    [t, isAgentRunning]
  );

  // --- Description editor ---

  const rawDescription =
    workItem.spec || workItem.session_metadata?.file_change_summary || "";
  const [resolvedDescriptionState, setResolvedDescriptionState] = useState<{
    source: string;
    value: string;
  } | null>(null);
  const resolvedDescription =
    resolvedDescriptionState?.source === rawDescription
      ? resolvedDescriptionState.value
      : null;

  useEffect(() => {
    let cancelled = false;
    if (projectSlug && rawDescription) {
      resolveImagePathsForDisplay(rawDescription, projectSlug)
        .then((resolved) => {
          if (!cancelled) {
            setResolvedDescriptionState({
              source: rawDescription,
              value: resolved,
            });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResolvedDescriptionState({
              source: rawDescription,
              value: rawDescription,
            });
          }
        });
    } else {
      setResolvedDescriptionState({
        source: rawDescription,
        value: rawDescription,
      });
    }
    return () => {
      cancelled = true;
    };
  }, [rawDescription, projectSlug]);

  // --- Timeline ---

  const timelineMembers = useMemo(
    () =>
      currentUser
        ? [
            ...teamMembers.filter((member) => member.id !== currentUser.id),
            currentUser,
          ]
        : teamMembers,
    [currentUser, teamMembers]
  );
  const { timelineEntries } = useWorkItemTimeline({
    workItem,
    teamMembers: timelineMembers,
  });

  // --- Handlers ---

  const handleTitleChange = useCallback(
    (title: string) => {
      if (title === workItem.name) return;
      onUpdateWorkItem?.({ name: title });
    },
    [onUpdateWorkItem, workItem.name]
  );

  const handleDescriptionChange = useCallback(
    (markdown: string) => {
      const storable = unresolveImagePathsForStorage(markdown.trim());
      const current =
        workItem.spec || workItem.session_metadata?.file_change_summary || "";
      if (storable === current) return;
      onUpdateWorkItem?.({ spec: storable });
    },
    [
      onUpdateWorkItem,
      workItem.spec,
      workItem.session_metadata?.file_change_summary,
    ]
  );

  const handleTodosChange = useCallback(
    (updatedTodos: TodoItem[]) => {
      const todoUpdates = { todos: updatedTodos } as Partial<WorkItemExtended>;
      if (onUpdateWorkItemImmediate) {
        onUpdateWorkItemImmediate(todoUpdates);
        return;
      }
      onUpdateWorkItem?.(todoUpdates);
    },
    [onUpdateWorkItem, onUpdateWorkItemImmediate]
  );

  const handleCommentSubmit = useCallback(async () => {
    if (!scopedShortId || !commentText.trim() || isSubmittingComment) return;

    setIsSubmittingComment(true);
    try {
      const mentioned = normalizeWorkItemMentionIds(
        mentionedUserIds,
        teamMembers,
        currentUser.id
      );
      const result = await projectApi.postDiscussionComment({
        projectSlug: projectSlug ?? null,
        orgId: orgId || "personal-org",
        workItemId: scopedShortId,
        commentId: `cmt-${Date.now()}-${crypto.randomUUID()}`,
        authorId: currentUser.id,
        authorName: currentUser.name ?? currentUser.id,
        content: commentText.trim(),
        mentionedUserIds: mentioned,
        parentId: replyToCommentId,
      });
      setIsSubscribed(true);
      setCommentText("");
      setReplyToCommentId(null);
      setMentionedUserIds([]);
      logger.debug(
        `Persisted Discussion comment ${result.comment.id} (${result.wakeReason})`
      );
    } catch (err) {
      logger.error("Failed to create comment", err);
    } finally {
      setIsSubmittingComment(false);
    }
  }, [
    commentText,
    isSubmittingComment,
    scopedShortId,
    currentUser.id,
    currentUser.name,
    mentionedUserIds,
    teamMembers,
    orgId,
    projectSlug,
    replyToCommentId,
  ]);

  const handleResolveDiscussionThread = useCallback(
    async (threadId: string, conclusionCommentId?: string) => {
      if (!scopedShortId || !currentUser.id) return;
      try {
        const comments = await projectApi.resolveDiscussionThread({
          scope: {
            projectSlug: projectSlug ?? null,
            orgId: orgId || "personal-org",
            workItemId: scopedShortId,
          },
          threadId,
          actorId: currentUser.id,
          conclusionCommentId: conclusionCommentId ?? null,
        });
        const nextComments = comments as WorkItemComment[];
        if (onUpdateWorkItemImmediate) {
          onUpdateWorkItemImmediate({ comments: nextComments });
        } else {
          onUpdateWorkItem?.({ comments: nextComments });
        }
      } catch (error) {
        logger.error("Failed to resolve Discussion thread", error);
      }
    },
    [
      currentUser.id,
      onUpdateWorkItem,
      onUpdateWorkItemImmediate,
      orgId,
      projectSlug,
      scopedShortId,
    ]
  );

  const handleReopenDiscussionThread = useCallback(
    async (threadId: string) => {
      if (!scopedShortId || !currentUser.id) return;
      try {
        const comments = await projectApi.reopenDiscussionThread({
          scope: {
            projectSlug: projectSlug ?? null,
            orgId: orgId || "personal-org",
            workItemId: scopedShortId,
          },
          threadId,
          actorId: currentUser.id,
        });
        const nextComments = comments as WorkItemComment[];
        if (onUpdateWorkItemImmediate) {
          onUpdateWorkItemImmediate({ comments: nextComments });
        } else {
          onUpdateWorkItem?.({ comments: nextComments });
        }
      } catch (error) {
        logger.error("Failed to reopen Discussion thread", error);
      }
    },
    [
      currentUser.id,
      onUpdateWorkItem,
      onUpdateWorkItemImmediate,
      orgId,
      projectSlug,
      scopedShortId,
    ]
  );

  const handleToggleSubscription = useCallback(async () => {
    if (!scopedShortId || !currentUser.id) return;
    const next = !isSubscribed;
    try {
      const subscriptions = await projectApi.setWorkItemSubscribed(
        {
          projectSlug: projectSlug ?? null,
          orgId: orgId || "personal-org",
          workItemId: scopedShortId,
        },
        currentUser.id,
        next
      );
      setIsSubscribed(
        subscriptions.some(
          (subscription) =>
            subscription.subscriberId === currentUser.id &&
            !subscription.mutedAt
        )
      );
    } catch (error) {
      logger.error("Failed to update Work Item subscription", error);
    }
  }, [currentUser.id, isSubscribed, orgId, projectSlug, scopedShortId]);

  return {
    currentUser,
    currentUserMemberIds,
    activeSessionTab,
    setActiveSessionTab,
    commentText,
    setCommentText,
    replyToCommentId,
    setReplyToCommentId,
    mentionedUserIds,
    setMentionedUserIds,
    isSubscribed,
    handleToggleSubscription,
    isSubmittingComment,
    currentPhase,
    isAgentRunning,
    sessionTabItems,
    resolvedDescription,
    rawDescription,
    timelineEntries,
    handleTitleChange,
    handleDescriptionChange,
    handleTodosChange,
    handleCommentSubmit,
    handleResolveDiscussionThread,
    handleReopenDiscussionThread,
  };
}
