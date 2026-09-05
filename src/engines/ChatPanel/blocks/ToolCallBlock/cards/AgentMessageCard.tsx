/**
 * AgentMessageCard — inter-agent message rendering for `org_send_message`.
 *
 * Layout
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ [icon] Sent message to coordinator  · Delivered to 1               │ ← header
 *   └────────────────────────────────────────────────────────────────────┘
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ From       sde-planner                                             │ ← meta section
 *   │ To         coordinator                                             │
 *   │ ──────────────────────────────────────────────────────────────────│
 *   │ <BlockOutput: message body with built-in max-h + show-more>        │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * Title is resolved from Rust via `label_running/done/failed`
 * with `{{recipient}}` interpolated by the adapter — never hardcoded here.
 * Subtitle is the plain status word (Sending / Delivered / Failed /
 * Accepted / Rejected) rendered with the same flat style as `OrgTaskBlock`'s
 * subtitle — no per-status colour, no delivered count number.
 *
 * Defaults to expanded (`defaultCollapsed: false`) so the sender/recipient
 * meta section and message body are visible without an extra click.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";

import {
  BlockOutput,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "../../primitives";
import { useBlockHeader } from "../../useBlockLocate";
import type { AgentMessageCardData } from "../types";

export type AgentMessageLifecycle = "running" | "done" | "failed";

interface AgentMessageCardProps {
  card: AgentMessageCardData;
  /** Header title resolved by the adapter from Rust lifecycle labels.
   *  Example: "Sent message to coordinator". Falls back to `cards.agentMessage.fallbackTitle`. */
  title?: string;
  /** Lifecycle of the underlying tool call, used to derive the subtitle status. */
  lifecycle?: AgentMessageLifecycle;
  /** Used by `useBlockHeader` for persisted collapse state and locate. */
  eventId?: string;
  /** Forwarded to `BlockOutput` for large-payload streaming. */
  sessionId?: string;
  /**
   * When true, skip the internal `EventBlockHeader` and always render the
   * meta + body sections. Used by the simulator Messages app, where the
   * outer chat bubble already provides a verb-phrase header
   * (e.g. "Planner sent a message to Coordinator"); the inner card would
   * duplicate the title. Chat-panel callers leave this `false` (default).
   * The status label that normally sits in the header subtitle is rendered
   * as a meta row instead so the information is preserved.
   */
  hideHeader?: boolean;
}

function resolveStatusKey(
  card: AgentMessageCardData,
  lifecycle: AgentMessageLifecycle
): string {
  if (lifecycle === "running") return "sending";
  if (lifecycle === "failed") return "failed";

  // lifecycle === "done":
  // 1) plan_approval / shutdown responses carry an explicit accepted flag.
  if (
    (card.kind === "shutdown_response" ||
      card.kind === "plan_approval_response") &&
    card.accepted !== undefined
  ) {
    return card.accepted ? "accepted" : "rejected";
  }

  // 2) plain message — surface "Delivered" once any recipient acknowledged.
  if (card.deliveredCount !== undefined && card.deliveredCount > 0) {
    return "delivered";
  }

  return "pending";
}

const AgentMessageCard: React.FC<AgentMessageCardProps> = ({
  card,
  title,
  lifecycle = "done",
  eventId,
  sessionId,
  hideHeader = false,
}) => {
  const { t } = useTranslation("sessions");

  const bodyText = (card.fullText || card.summary || "").trim();
  const hasContent = bodyText.length > 0;

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({ defaultCollapsed: false, eventId });

  const toolIcon = useMemo(
    () =>
      getToolIcon("org_send_message", {
        size: SESSION_UI_TOKENS.ICON.SIZE_SM,
        className: "text-text-2",
      }),
    []
  );

  const isLoading = lifecycle === "running";
  const isFailed = lifecycle === "failed";

  const statusKey = resolveStatusKey(card, lifecycle);
  const statusLabel = t(`cards.agentMessage.status.${statusKey}`);

  const bodyContent = (
    <>
      <MessageMetaSection
        card={card}
        t={t}
        statusLabel={hideHeader ? statusLabel : undefined}
      />
      {hasContent ? (
        <BlockOutput
          output={bodyText}
          withBorder={false}
          sessionId={sessionId}
          eventId={eventId}
        />
      ) : (
        <div className="px-3 py-2 text-[13px] leading-normal text-text-3">
          {t("cards.agentMessage.empty")}
        </div>
      )}
    </>
  );

  // Header-less variant (simulator Messages app): render the meta + body
  // directly inside a styled container; the chat bubble owns the title row.
  if (hideHeader) {
    return (
      <div
        className={`${getEventBlockContainerClasses(true)} animate-fade-in overflow-hidden`}
        data-testid="agent-message-card"
      >
        {bodyContent}
      </div>
    );
  }

  return (
    <div
      className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
      data-testid="agent-message-card"
    >
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onToggleCollapse={hasContent ? handleHeaderClick : undefined}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={toolIcon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          hasContent={hasContent}
          isLoading={isLoading}
          isFailed={isFailed}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title ?? t("cards.agentMessage.fallbackTitle")}
        </EventBlockHeaderTitle>
        {statusLabel && (
          <EventBlockHeaderSubtitle isLoading={isLoading} title={statusLabel}>
            {statusLabel}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {!isCollapsed && (
        <div
          className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in`}
        >
          {bodyContent}
        </div>
      )}
    </div>
  );
};

interface MessageMetaSectionProps {
  card: AgentMessageCardData;
  t: ReturnType<typeof useTranslation>["t"];
  /**
   * When provided, render the lifecycle status (e.g. "Delivered") as an
   * extra meta row. Used by the header-less variant so the status info
   * that normally lives in the header subtitle isn't lost.
   */
  statusLabel?: string;
}

const MessageMetaSection: React.FC<MessageMetaSectionProps> = ({
  card,
  t,
  statusLabel,
}) => {
  const sender = card.sender || null;
  const recipient = card.recipient || null;
  if (!sender && !recipient && !statusLabel) return null;

  return (
    <div className="border-b border-border-1 px-3 py-1.5 text-[13px] leading-normal">
      {sender && (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-text-3">
            {t("cards.agentMessage.meta.sender")}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-text-1"
            title={card.senderMemberId ?? sender}
          >
            {sender}
          </span>
        </div>
      )}
      {recipient && (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-text-3">
            {t("cards.agentMessage.meta.recipient")}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-text-1"
            title={card.recipientMemberId ?? recipient}
          >
            {recipient}
          </span>
        </div>
      )}
      {statusLabel && (
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-text-3">
            {t("cards.agentMessage.meta.status", { defaultValue: "Status" })}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-text-1"
            title={statusLabel}
          >
            {statusLabel}
          </span>
        </div>
      )}
    </div>
  );
};

AgentMessageCard.displayName = "AgentMessageCard";
MessageMetaSection.displayName = "MessageMetaSection";

export default AgentMessageCard;
