import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  updatePendingPlanContent as persistPendingPlanContent,
  respondPlanApproval,
} from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  persistEditedPlanContent,
  resolvePlanMarkdownContent,
  updatePendingPlanContent,
} from "@src/engines/SessionCore/derived/planContentPersistence";
import {
  derivePlanApprovalViewState,
  getPendingPlanAliases,
  getPlanEventAliases,
  isPlanDisplayEvent,
  planAliasesContain,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { usePendingPlanApproval } from "@src/hooks/session/usePendingPlanApproval";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import {
  type PendingPlanApproval,
  clearPendingPlanApproval,
  pendingPlanApprovalsAtom,
} from "@src/store/session/planApprovalAtom";
import { sessionMapAtom } from "@src/store/session/sessionAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";

import type { MessageEntry } from "./types";

interface UsePlanApprovalOptions {
  interactionMessages: MessageEntry[];
  selectedMessage?: MessageEntry | null;
  viewMode: string;
}

export interface PlanApprovalState {
  activePlanMessage: MessageEntry | null;
  /**
   * Stable, view-independent id of the plan that is currently pending, or
   * null when nothing is pending. Unlike `activePlanMessage.eventId` (which
   * can switch between a synthesized snapshot id and a real event id as the
   * view mode changes), this is derived straight from the pending-approval
   * record so it stays constant for a given plan — making it safe to key
   * user view/preview overrides on.
   */
  pendingPlanId: string | null;
  /** Absolute path of the active plan file, or null when unresolved. */
  planPath: string | null;
  isPlanDoc: boolean;
  isPlanPending: boolean;
  isEditing: boolean;
  isPreviewMode: boolean;
  editedContent: string;
  submitting: boolean;
  hasEdits: boolean;
  buildDisabled: boolean;
  buildButtonRef: React.RefObject<HTMLButtonElement>;
  setIsPreviewMode: (v: boolean) => void;
  setEditedContent: (v: string) => void;
  handleEditToggle: () => void;
  /** Persist the edited plan and exit edit mode WITHOUT approving / building. */
  handleSave: () => Promise<void>;
  handleBuild: () => Promise<void>;
}

function asStringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pendingPlanToMessageEntry(
  pendingPlan: PendingPlanApproval,
  timestamp: string
): MessageEntry {
  const eventId =
    pendingPlan.planRevisionId || pendingPlan.toolCallId || "pending-plan";
  return {
    eventId,
    event: {
      id: eventId,
      chunk_id: eventId,
      sessionId: pendingPlan.sessionId,
      createdAt: timestamp,
      functionName: "plan_approval",
      uiCanonical: "plan_approval",
      actionType: "plan_approval",
      args: {
        title: pendingPlan.planTitle,
        content: pendingPlan.planContent,
        planId: pendingPlan.planId,
        planRevisionId: pendingPlan.planRevisionId,
        originToolCallId: pendingPlan.originToolCallId,
        toolCallId: pendingPlan.toolCallId,
        planPath: pendingPlan.planPath,
      },
      result: {
        status: "pending",
        planId: pendingPlan.planId,
        planRevisionId: pendingPlan.planRevisionId,
        originToolCallId: pendingPlan.originToolCallId,
        toolCallId: pendingPlan.toolCallId,
        planPath: pendingPlan.planPath,
      },
      source: "assistant",
      displayText: pendingPlan.planTitle || "Plan",
      displayStatus: "awaiting_user",
      displayVariant: "tool_call",
      activityStatus: "agent",
      callId: pendingPlan.toolCallId,
    },
    type: "interaction",
    content: pendingPlan.planContent,
    sender: "agent",
    timestamp,
    order: Number.MAX_SAFE_INTEGER,
    isCurrent: false,
  };
}

export function usePlanApproval({
  interactionMessages,
  selectedMessage,
  viewMode,
}: UsePlanApprovalOptions): PlanApprovalState {
  const { t } = useTranslation("sessions");
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const activeSessionPendingPlan = usePendingPlanApproval(activeSessionId);
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
  const sessionMap = useAtomValue(sessionMapAtom);
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const creatorDefaultSelection = useAtomValue(
    creatorDefaultModelSelectionAtom
  );
  const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);

  const [isPreviewMode, setIsPreviewMode] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const buildButtonRef = useRef<HTMLButtonElement>(
    null
  ) as React.RefObject<HTMLButtonElement>;

  const currentPendingPlan = activeSessionPendingPlan;
  const planViewState = useMemo(
    () =>
      derivePlanApprovalViewState({
        pendingPlan: currentPendingPlan,
        chatEvents: interactionMessages.map((message) => message.event),
      }),
    [currentPendingPlan, interactionMessages]
  );
  const pendingAliases = getPendingPlanAliases(currentPendingPlan);
  const selectedPlanMessage =
    viewMode === "preview" && selectedMessage?.event
      ? isPlanDisplayEvent(selectedMessage.event)
        ? selectedMessage
        : null
      : null;
  const pendingPlanMessage =
    viewMode === "preview" && pendingAliases.length > 0
      ? [...interactionMessages].reverse().find((message) => {
          if (!isPlanDisplayEvent(message.event)) return false;
          const eventAliases = getPlanEventAliases(message.event);
          return pendingAliases.some((alias) => eventAliases.includes(alias));
        })
      : null;
  const fallbackPlanMessage =
    viewMode === "preview" && interactionMessages.length > 0
      ? [...interactionMessages]
          .reverse()
          .find((message) => isPlanDisplayEvent(message.event))
      : null;
  const pendingPlanSnapshotMessage =
    currentPendingPlan && planViewState.currentSurfaceVisible
      ? pendingPlanToMessageEntry(currentPendingPlan, new Date().toISOString())
      : null;
  const defaultPlanMessage =
    pendingPlanMessage ??
    pendingPlanSnapshotMessage ??
    fallbackPlanMessage ??
    null;
  const activePlanMessage = selectedPlanMessage ?? defaultPlanMessage;
  const isPlanDoc = Boolean(activePlanMessage);

  const planSessionId = isPlanDoc
    ? (activePlanMessage!.event.sessionId ?? activeSessionId)
    : activeSessionId;

  const planArgs = isPlanDoc
    ? (activePlanMessage!.event.args as Record<string, unknown> | undefined)
    : undefined;
  const planResult = isPlanDoc
    ? (activePlanMessage!.event.result as Record<string, unknown> | undefined)
    : undefined;
  const planIdentity = isPlanDoc
    ? getPlanEventAliases(activePlanMessage!.event)
    : [];

  const planSessionPendingPlan = usePendingPlanApproval(planSessionId);

  const planRawContent = isPlanDoc
    ? resolvePlanMarkdownContent(
        activePlanMessage!.event,
        planSessionPendingPlan
      )
    : "";
  const planPath =
    asStringArg(planArgs?.["planPath"]) ||
    asStringArg(planResult?.["planPath"]) ||
    null;

  const planApprovalAliases = getPendingPlanAliases(planSessionPendingPlan);
  const matchesCurrentPendingPlan = planIdentity.some((identity) =>
    planAliasesContain(planApprovalAliases, identity)
  );
  // A plan that matches the session's pending approval is awaiting review and
  // must be editable/buildable in the Agent Station preview. The earlier
  // `currentSurfaceVisible` gate is a chat-composer concept (it stays false
  // for a freshly-pending plan with no user reply after it), which wrongly
  // disabled Edit/Save here even though the badge read "Ready for review".
  // The dedicated preview surface owns the single pending plan, so matching
  // the pending approval is the correct, sufficient condition (issue #28).
  const isPlanPending = matchesCurrentPendingPlan;
  const pendingPlanId = planSessionPendingPlan
    ? planSessionPendingPlan.planRevisionId ||
      planSessionPendingPlan.toolCallId ||
      "pending-plan"
    : null;
  const sessionIsWorking =
    planSessionId === activeSessionId &&
    (runtimeStatus === "running" || runtimeStatus === "installing");
  const buildDisabled = !isPlanPending || submitting || sessionIsWorking;

  const handleEditToggle = useCallback(() => {
    if (!isEditing) {
      setEditedContent(planRawContent);
      setIsPreviewMode(false);
    }
    setIsEditing((prev) => !prev);
  }, [isEditing, planRawContent]);

  const handleSave = useCallback(async () => {
    if (!planSessionId || buildDisabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await persistEditedPlanContent({
        sessionId: planSessionId,
        planRevisionId: planSessionPendingPlan?.planRevisionId,
        pendingAliases: planApprovalAliases,
        content: editedContent,
        io: {
          persistPendingContent: persistPendingPlanContent,
          getEvents: (sessionId) => eventStoreProxy.getEvents(sessionId),
          patchEvent: (id, args, sessionId) =>
            eventStoreProxy.updateById(id, { args }, sessionId),
          saveCache: (sessionId) => eventStoreProxy.saveToCache(sessionId),
        },
      });
      setPendingPlanApprovals((prev) =>
        updatePendingPlanContent(prev, planSessionId, editedContent)
      );
      setIsEditing(false);
    } catch (err) {
      Message.error(
        err instanceof Error ? err.message : t("planDoc.saveFailed")
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    planSessionId,
    buildDisabled,
    planSessionPendingPlan,
    planApprovalAliases,
    editedContent,
    setPendingPlanApprovals,
    t,
  ]);

  const handleBuild = useCallback(async () => {
    if (!planSessionId || buildDisabled || submittingRef.current) return;
    submittingRef.current = true;
    if (buildButtonRef.current) buildButtonRef.current.disabled = true;
    setSubmitting(true);
    try {
      const planSession = sessionMap.get(planSessionId);
      const sessionSelection = planSession
        ? {
            ...creatorDefaultSelection,
            keySource:
              planSession.keySource ?? creatorDefaultSelection?.keySource,
            model: planSession.model ?? creatorDefaultSelection?.model,
            selectedAccountId:
              planSession.accountId ??
              creatorDefaultSelection?.selectedAccountId,
            cliAgentType:
              planSession.cliAgentType ?? creatorDefaultSelection?.cliAgentType,
            tier: planSession.tier ?? creatorDefaultSelection?.tier,
          }
        : creatorDefaultSelection;
      const { model, accountId } = resolveModelForMessage(sessionSelection);
      const workspacePath = planSession?.repoPath ?? activeWorkspaceRootPath;
      const contentOverride =
        isEditing && editedContent !== planRawContent
          ? editedContent
          : undefined;
      await respondPlanApproval(
        planSessionId,
        contentOverride ? "approve_with_edits" : "approve",
        contentOverride,
        {
          model,
          accountId,
          workspacePath,
        }
      );
      setPendingPlanApprovals((prev) =>
        clearPendingPlanApproval(
          prev,
          planSessionId,
          planSessionPendingPlan?.toolCallId ??
            planSessionPendingPlan?.planRevisionId
        )
      );
      setIsEditing(false);
    } catch (err) {
      Message.error(
        err instanceof Error ? err.message : t("planDoc.buildFailed")
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    planSessionId,
    buildDisabled,
    isEditing,
    editedContent,
    planRawContent,
    sessionMap,
    creatorDefaultSelection,
    activeWorkspaceRootPath,
    setPendingPlanApprovals,
    planSessionPendingPlan,
    t,
  ]);

  const hasEdits = isEditing && editedContent !== planRawContent;

  return {
    activePlanMessage,
    pendingPlanId,
    planPath,
    isPlanDoc,
    isPlanPending,
    isEditing,
    isPreviewMode,
    editedContent,
    submitting,
    hasEdits,
    buildDisabled,
    buildButtonRef,
    setIsPreviewMode,
    setEditedContent,
    handleEditToggle,
    handleSave,
    handleBuild,
  };
}
