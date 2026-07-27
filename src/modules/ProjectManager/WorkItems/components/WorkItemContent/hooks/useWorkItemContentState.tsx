import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TabPillItem } from "@src/components/TabPill";
import { createLogger } from "@src/hooks/logger";
import {
  resolveImagePathsForDisplay,
  unresolveImagePathsForStorage,
} from "@src/modules/ProjectManager/shared/utils/workItemImagePaths";
import type { Person } from "@src/types/core/shared";
import type {
  TodoItem,
  WorkItem as WorkItemExtended,
} from "@src/types/core/workItem";

import { SESSION_TAB_KEYS, type SessionTab } from "../types";
import { useWorkItemTimeline } from "../useWorkItemTimeline";

const logger = createLogger("useWorkItemContentState");

interface UseWorkItemContentStateOptions {
  workItem: WorkItemExtended;
  onUpdateWorkItem?: (updates: Partial<WorkItemExtended>) => void;
  onUpdateWorkItemImmediate?: (updates: Partial<WorkItemExtended>) => void;
  currentUserProp?: Person;
  teamMembers?: Person[];
  projectSlug?: string | null;
  shortId?: string | null;
  onStartAgent?: (instructions?: string) => void;
  onOpenSession?: (sessionId: string) => void;
  activeAgentSessionId?: string | null;
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
    shortId: _shortId,
    onStartAgent,
    onOpenSession,
    activeAgentSessionId,
  } = options;

  const { t } = useTranslation("projects");

  const currentUser = currentUserProp ?? {
    id: "current",
    name: t("workItems.activity.you"),
    color: "#52c41a",
  };

  const [activeSessionTab, setActiveSessionTab] =
    useState<SessionTab>("session");
  const [commentText, setCommentText] = useState("");
  const [isSubscribed, setIsSubscribed] = useState(true);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);

  const currentPhase = workItem.orchestratorState?.current_phase ?? "idle";
  const isAgentRunning = currentPhase === "sde" || currentPhase === "review";

  const pendingOpenChatRef = useRef(false);

  const handleStartAgentAndOpenChat = useCallback(
    (instructions?: string) => {
      pendingOpenChatRef.current = true;
      onStartAgent?.(instructions);
    },
    [onStartAgent]
  );

  useEffect(() => {
    if (
      pendingOpenChatRef.current &&
      activeAgentSessionId &&
      activeAgentSessionId !== "pending" &&
      onOpenSession
    ) {
      pendingOpenChatRef.current = false;
      onOpenSession(activeAgentSessionId);
    }
  }, [activeAgentSessionId, onOpenSession]);

  const prevSessionIdRef = useRef(activeAgentSessionId);
  useEffect(() => {
    if (
      pendingOpenChatRef.current &&
      prevSessionIdRef.current &&
      !activeAgentSessionId
    ) {
      pendingOpenChatRef.current = false;
    }
    prevSessionIdRef.current = activeAgentSessionId;
  }, [activeAgentSessionId]);

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

  const { timelineEntries } = useWorkItemTimeline({
    workItem,
    teamMembers,
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
    if (!commentText.trim() || isSubmittingComment) return;

    setIsSubmittingComment(true);
    try {
      const newComment = {
        id: `cmt-${Date.now()}`,
        author: currentUser.name,
        content: commentText.trim(),
        created_at: new Date().toISOString(),
      };
      onUpdateWorkItem?.({
        comments: [...(workItem.comments ?? []), newComment],
      } as Partial<WorkItemExtended>);
      setCommentText("");
    } catch (err) {
      logger.error("Failed to create comment", err);
    } finally {
      setIsSubmittingComment(false);
    }
  }, [
    commentText,
    isSubmittingComment,
    workItem,
    currentUser.name,
    onUpdateWorkItem,
  ]);

  return {
    currentUser,
    activeSessionTab,
    setActiveSessionTab,
    commentText,
    setCommentText,
    isSubscribed,
    setIsSubscribed,
    isSubmittingComment,
    currentPhase,
    isAgentRunning,
    handleStartAgentAndOpenChat,
    sessionTabItems,
    resolvedDescription,
    rawDescription,
    timelineEntries,
    handleTitleChange,
    handleDescriptionChange,
    handleTodosChange,
    handleCommentSubmit,
  };
}
