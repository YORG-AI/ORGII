/**
 * CreatePlanCard — Card-style plan display for the `create_plan` tool.
 *
 * Inline editing: "Edit" replaces the markdown preview with a textarea.
 * "Save" persists the edited plan (file + plan event + pending snapshot) and
 * exits edit mode WITHOUT approving/building. "Build" approves the (persisted)
 * plan and starts execution; "Skip" rejects it without starting Build.
 */
import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { CheckCircle2, Pencil, X, XCircle } from "lucide-react";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { respondPlanApproval } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import Message from "@src/components/Message";
import { getToolIcon } from "@src/config/toolIcons";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  persistEditedPlanContent,
  updatePendingPlanContent,
} from "@src/engines/SessionCore/derived/planContentPersistence";
import {
  type PlanApprovalStatus,
  type PlanSurface,
  type PlanSurfaceState,
  getPendingPlanAliases,
  shouldDefaultCollapsePlanCard,
} from "@src/engines/SessionCore/derived/planDisplayEvents";
import { useMountedCleanup } from "@src/hooks/lifecycle/useMounted";
import { FileService } from "@src/services/file";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import {
  clearPendingPlanApproval,
  pendingPlanApprovalsAtom,
} from "@src/store/session/planApprovalAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";

import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

const PLAN_ICON_SIZE = 14;
// Generous bound: approval does plan-file IO + may register a session before
// returning; normal completion is <1s, the timeout only guards a wedged IPC.
const PLAN_APPROVAL_RPC_TIMEOUT_MS = 30_000;

function deriveDisplayTitle(title: string, content: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) return trimmedTitle;

  const headingMatch = content.match(/^\s*#\s+(.+)$/m);
  return headingMatch?.[1]?.trim() ?? "";
}

function getPlanStateLabel(
  t: TFunction<"sessions">,
  status: PlanApprovalStatus,
  isStreaming: boolean,
  ready: boolean
): string {
  if (isStreaming) return t("planDoc.drafting");
  if (status === "approved") return t("planDoc.built");
  if (status === "archived") return t("planDoc.archived");
  if (status === "cancelled") return t("planDoc.cancelled");
  if (ready) return t("planDoc.readyForReview");
  return t("planDoc.idle");
}

export interface CreatePlanCardProps {
  content: string;
  title: string;
  isStreaming: boolean;
  /** Tool execution call id; kept only for transcript/tool correlation. */
  toolCallId?: string;
  /** Stable pending approval slot id authored by the backend. */
  planId?: string;
  /** Active plan-card revision id authored by the backend. */
  planRevisionId?: string;
  sessionId?: string;
  eventId?: string;
  surface?: PlanSurface;
  approvalStatus?: PlanApprovalStatus;
  ownsPendingPlan?: boolean;
  surfaceState?: PlanSurfaceState;
  onOpenPreview?: () => void;
  /**
   * Current-surface only: when true, the card is hidden and the parent
   * is expected to render a pill in `CollapsedInlineRow` instead. The
   * card un-mounts entirely so its action buttons don't keep capturing
   * keyboard shortcuts.
   */
  collapsed?: boolean;
  /**
   * Current-surface only: triggered when the user clicks the in-header
   * X button to collapse the card into its pill representation.
   */
  onCollapse?: () => void;
}

const CreatePlanCard: React.FC<CreatePlanCardProps> = memo(
  ({
    content,
    title,
    isStreaming,
    toolCallId,
    planId: _planId,
    planRevisionId,
    sessionId: sessionIdProp,
    eventId,
    surface = "transcript",
    approvalStatus = "pending",
    ownsPendingPlan = false,
    surfaceState,
    onOpenPreview,
    collapsed = false,
    onCollapse,
  }) => {
    const { t } = useTranslation("sessions");
    const activeSessionId = useAtomValue(activeSessionIdAtom);
    const sessionId = sessionIdProp ?? activeSessionId;
    const approvalMap = useAtomValue(pendingPlanApprovalsAtom);
    const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
    const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
    // Read the plan's *own* session row for model+key — approving a
    // plan should not silently use whatever model the user happens to
    // have selected as their creator-default; it should resume the
    // session that produced the plan with that session's model.
    const planSession = useAtomValue(sessionByIdAtom(sessionId ?? ""));
    const creatorDefaultSelection = useAtomValue(
      creatorDefaultModelSelectionAtom
    );
    const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
    const isCurrentSurface = surface === "current";
    const ownsActions =
      surfaceState?.ownsActions ?? (isCurrentSurface || ownsPendingPlan);
    const effectiveApprovalStatus = surfaceState?.status ?? approvalStatus;

    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({
      eventId,
      defaultCollapsed: shouldDefaultCollapsePlanCard({ surface, isStreaming }),
    });

    const [submitting, setSubmitting] = useState(false);
    // Ref guards against double-submit during the async window before
    // setSubmitting(true) propagates — keeps the button disabled immediately.
    const submittingRef = useRef(false);
    const mountedRef = useRef(true);
    useMountedCleanup(mountedRef);

    const [isEditing, setIsEditing] = useState(false);
    const [editedContent, setEditedContent] = useState(content);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Keep editedContent in sync when content streams in (only while not editing).
    useEffect(() => {
      if (!isEditing) setEditedContent(content);
    }, [content, isEditing]);

    const state = sessionId ? approvalMap.get(sessionId) : undefined;
    const cardRevisionId = planRevisionId || toolCallId;
    const idMatch =
      !!state?.current &&
      !!cardRevisionId &&
      (state.current.planRevisionId === cardRevisionId ||
        state.current.toolCallId === cardRevisionId);
    const ready =
      surfaceState?.readyForReview ??
      (idMatch && !isStreaming && effectiveApprovalStatus === "pending");
    const autoApproveAt = idMatch
      ? (state.current?.autoApproveAt ?? null)
      : null;
    const [nowMs, setNowMs] = useState<number>(() => Date.now());

    useEffect(() => {
      if (!autoApproveAt || submitting) return;
      const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }, [autoApproveAt, submitting]);

    const autoApproveRemaining =
      autoApproveAt && !submitting && ready
        ? Math.max(0, Math.ceil((autoApproveAt - nowMs) / 1000))
        : null;
    const sessionIsWorking =
      sessionId === activeSessionId &&
      (runtimeStatus === "running" || runtimeStatus === "installing");
    const actionsDisabled = submitting || sessionIsWorking;
    const interactive =
      surfaceState?.actionable !== undefined
        ? surfaceState.actionable && !actionsDisabled
        : ownsActions && ready && !actionsDisabled;
    const hasEdits = isEditing && editedContent !== content;
    const displayTitle =
      deriveDisplayTitle(title, content) || t("planDoc.untitled");
    const stateLabel = getPlanStateLabel(
      t,
      effectiveApprovalStatus,
      isStreaming,
      ready
    );
    const handlePreviewNavigate =
      onOpenPreview ?? (eventId ? handleLocate : undefined);

    const handleSubmit = useCallback(
      async (
        choice: "approve" | "approve_with_edits" | "reject",
        edited?: string
      ) => {
        if (!sessionId || !interactive || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        try {
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
                  planSession.cliAgentType ??
                  creatorDefaultSelection?.cliAgentType,
                tier: planSession.tier ?? creatorDefaultSelection?.tier,
              }
            : creatorDefaultSelection;
          const { model, accountId } = resolveModelForMessage(sessionSelection);
          const workspacePath =
            planSession?.repoPath ?? activeWorkspaceRootPath;
          // Build kicks off a synthetic turn on the backend without going
          // through useMessageDispatch — optimistically flip to running
          // BEFORE the RPC await so the planning indicator appears
          // immediately (P3), not one round-trip later. Skip stays idle.
          // The setter's session gate drops the write for background plans.
          if (choice !== "reject") {
            beginOptimisticTurn(sessionId);
          }
          try {
            // Timeout fallback: if the approval RPC hangs (backend wedged,
            // IPC drop), roll back the optimistic running state instead of
            // leaving the session stuck in a running state with no terminal
            // event ever arriving.
            await Promise.race([
              respondPlanApproval(sessionId, choice, edited, {
                model,
                accountId,
                workspacePath,
              }),
              new Promise<never>((_, reject) => {
                window.setTimeout(
                  () => reject(new Error(t("planDoc.buildFailed"))),
                  PLAN_APPROVAL_RPC_TIMEOUT_MS
                );
              }),
            ]);
          } catch (rpcError) {
            if (choice !== "reject") failOptimisticTurn(sessionId);
            throw rpcError;
          }
          setPendingPlanApprovals((prev) =>
            clearPendingPlanApproval(prev, sessionId, cardRevisionId)
          );
          if (mountedRef.current) setIsEditing(false);
        } catch (err) {
          Message.error(
            err instanceof Error ? err.message : t("planDoc.buildFailed")
          );
        } finally {
          submittingRef.current = false;
          if (mountedRef.current) setSubmitting(false);
        }
      },
      [
        sessionId,
        interactive,
        planSession,
        creatorDefaultSelection,
        activeWorkspaceRootPath,
        setPendingPlanApprovals,
        cardRevisionId,
        t,
        mountedRef,
      ]
    );

    const handleBuild = useCallback(() => {
      void handleSubmit(
        isEditing && hasEdits ? "approve_with_edits" : "approve",
        isEditing && hasEdits ? editedContent : undefined
      );
    }, [isEditing, hasEdits, editedContent, handleSubmit]);

    // Save persists the edited plan to its backing store (plan file + the plan
    // event the preview re-reads + the pending snapshot) and exits edit mode,
    // WITHOUT approving or building. A later Build approves the persisted plan.
    const pendingSnapshot = state?.current ?? null;
    const handleSave = useCallback(async () => {
      if (!sessionId || !interactive || submittingRef.current) return;
      submittingRef.current = true;
      setSubmitting(true);
      try {
        await persistEditedPlanContent({
          sessionId,
          planPath: pendingSnapshot?.planPath ?? null,
          pendingAliases: getPendingPlanAliases(pendingSnapshot),
          content: editedContent,
          io: {
            saveFile: (path, content) => FileService.save(path, content),
            getEvents: (id) => eventStoreProxy.getEvents(id),
            patchEvent: (id, args, sid) =>
              eventStoreProxy.updateById(id, { args }, sid),
            saveCache: (id) => eventStoreProxy.saveToCache(id),
          },
        });
        setPendingPlanApprovals((prev) =>
          updatePendingPlanContent(prev, sessionId, editedContent)
        );
        if (mountedRef.current) setIsEditing(false);
      } catch (err) {
        Message.error(
          err instanceof Error ? err.message : t("planDoc.saveFailed")
        );
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    }, [
      sessionId,
      interactive,
      pendingSnapshot,
      editedContent,
      setPendingPlanApprovals,
      t,
    ]);

    const handleSkip = useCallback(() => {
      void handleSubmit("reject");
    }, [handleSubmit]);

    const handleEditToggle = useCallback(() => {
      if (isEditing) {
        setIsEditing(false);
        setEditedContent(content);
      } else {
        if (isCollapsed) handleHeaderClick();
        setEditedContent(content);
        setIsEditing(true);
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    }, [isEditing, isCollapsed, handleHeaderClick, content]);

    if (!isStreaming && !ready && isCurrentSurface) return null;
    // Current-surface collapse is owned by `useComposerSections` —
    // returning null lets the pill row take over without leaving a
    // ghost card behind. Transcript surface ignores this prop.
    if (isCurrentSurface && collapsed) return null;

    const collapseButton =
      isCurrentSurface && onCollapse ? (
        <Button
          variant="tertiary"
          size="mini"
          iconOnly
          data-testid="create-plan-collapse"
          onClick={() => onCollapse()}
          icon={<X size={12} strokeWidth={2} />}
          title={t("planDoc.collapse")}
        />
      ) : null;
    const planActions =
      ownsActions || collapseButton ? (
        <div
          className="flex items-center gap-1"
          onClick={(event) => event.stopPropagation()}
        >
          {ownsActions && (
            <>
              {autoApproveRemaining !== null && ready && !isEditing && (
                <span className="chat-block-xs tabular-nums text-text-3">
                  {t("chat.autoExecuteCountdown", {
                    seconds: autoApproveRemaining,
                  })}
                </span>
              )}
              {ready && !isEditing && (
                <Button
                  variant="tertiary"
                  size="mini"
                  data-testid="create-plan-skip"
                  onClick={handleSkip}
                  disabled={!interactive || submitting}
                  icon={<XCircle size={12} />}
                >
                  {t("planDoc.skip")}
                </Button>
              )}
              {ready && (
                <Button
                  variant="tertiary"
                  size="mini"
                  data-testid="create-plan-edit"
                  onClick={handleEditToggle}
                  disabled={actionsDisabled}
                  icon={isEditing ? <X size={12} /> : <Pencil size={12} />}
                >
                  {isEditing ? t("planDoc.cancelEdit") : t("planDoc.edit")}
                </Button>
              )}
              {isEditing ? (
                <Button
                  variant="primary"
                  size="mini"
                  data-testid="create-plan-save"
                  onClick={() => void handleSave()}
                  disabled={!interactive || submitting}
                  icon={<CheckCircle2 size={12} />}
                >
                  {t("common:actions.save")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="mini"
                  data-testid="create-plan-build"
                  onClick={handleBuild}
                  disabled={!interactive || submitting}
                  icon={<CheckCircle2 size={12} />}
                >
                  {t("planDoc.build")}
                </Button>
              )}
            </>
          )}
          {collapseButton}
        </div>
      ) : null;
    const planIcon = getToolIcon("create_plan", { size: PLAN_ICON_SIZE });

    return (
      <div
        className={getEventBlockContainerClasses()}
        data-testid="create-plan-card"
        data-plan-ready={ready ? "true" : "false"}
        data-plan-surface={surface}
        data-plan-revision-id={cardRevisionId}
        data-plan-approval-status={effectiveApprovalStatus}
        data-plan-actions-disabled={actionsDisabled ? "true" : "false"}
        data-plan-collapsed={isCollapsed ? "true" : "false"}
      >
        <EventBlockHeader
          isCollapsed={isCollapsed}
          withHover
          onClick={handleLocate}
          onNavigate={handlePreviewNavigate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          rightContent={planActions}
        >
          <EventBlockHeaderIcon
            icon={planIcon}
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            iconSize={PLAN_ICON_SIZE}
            onToggle={handleHeaderClick}
            hasContent
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isStreaming}
          />
          <EventBlockHeaderTitle isLoading={isStreaming}>
            {stateLabel}
          </EventBlockHeaderTitle>
          <EventBlockHeaderSubtitle
            isLoading={isStreaming}
            title={displayTitle}
          >
            {displayTitle}
          </EventBlockHeaderSubtitle>
        </EventBlockHeader>

        {!isCollapsed &&
          (isEditing ? (
            <div className="px-3 py-2">
              <textarea
                ref={textareaRef}
                className="scrollbar-overlay h-[280px] w-full resize-y rounded-md border border-border-2 bg-bg-1 px-3 py-2 text-[13px] leading-relaxed text-text-1 outline-none focus:border-primary-6"
                value={editedContent}
                onChange={(event) => setEditedContent(event.target.value)}
                spellCheck={false}
              />
            </div>
          ) : (
            <div
              className={`overflow-y-auto overflow-x-hidden px-3 py-2 ${ready ? "max-h-[280px]" : "max-h-[160px]"}`}
            >
              {content.trim() ? (
                <div className="chat-block-content leading-relaxed text-text-2">
                  <Markdown textContent={content} skipPreprocess />
                </div>
              ) : (
                <span className="chat-block-content text-text-3">
                  {t("planDoc.emptyPlan")}
                </span>
              )}
            </div>
          ))}
      </div>
    );
  }
);

CreatePlanCard.displayName = "CreatePlanCard";

export default CreatePlanCard;
