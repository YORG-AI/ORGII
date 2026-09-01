/**
 * ApprovalRequestEvent — chat history rendering for tool permission requests.
 *
 * Three states (mirroring ModeSwitchEvent):
 * - Approved: green check icon + "Permission granted" title + tool info body (default collapsed)
 * - Denied: red X-circle icon + "Permission denied" title (danger) + tool info body (default collapsed)
 * - Pending: header-only, shimmer "Waiting for your permission" title
 */
import React, { useMemo } from "react";

import { getEventIcon } from "@src/config/toolIcons";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useBlockHeader } from "@src/engines/ChatPanel/blocks/useBlockLocate";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import {
  useLifecycleLabels,
  useToolLabelText,
} from "@src/engines/SessionCore/rendering/registry";

import { AskQuestionHistoryBody } from "../ask-question/AskQuestionHistoryChrome";

// ============================================
// Types
// ============================================

type ApprovalStatus = "approved" | "denied" | "pending";

interface ApprovalData {
  toolName: string;
  description: string;
  status: ApprovalStatus;
}

function extractApprovalData(props: RawEventInput): ApprovalData {
  const event = props.event;
  const result = (event?.result || props.result) as
    | Record<string, unknown>
    | undefined;
  const args = (event?.args || props.args) as
    | Record<string, unknown>
    | undefined;

  const toolName = (args?.tool_name as string) || "Unknown tool";
  const description = (args?.description as string) || "";

  let status: ApprovalStatus = "pending";
  if (result?.approved === true) status = "approved";
  else if (result?.approved === false) status = "denied";
  else if (result?.pending === true) status = "pending";

  return { toolName, description, status };
}

// ============================================
// Resolved Card (approved or denied — collapsible, default collapsed)
// ============================================

const ResolvedCard: React.FC<{
  status: "approved" | "denied";
  toolName: string;
  description: string;
  eventId?: string;
}> = ({ status, toolName, description, eventId }) => {
  const statusLabel = useToolLabelText("ask_user_permissions", status);
  const isApproved = status === "approved";
  const hasBody = Boolean(description);

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: true,
    eventId,
    collapseAllValue: true,
  });

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={getEventIcon("ask_user_permissions", {
            status,
            className: isApproved ? "text-success-6" : "text-danger-6",
          })}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={hasBody ? handleHeaderClick : undefined}
          hasContent={hasBody}
        />
        <EventBlockHeaderTitle className={isApproved ? "" : "text-danger-6"}>
          {statusLabel}
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle title={toolName}>
          {toolName}
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>

      {hasBody && !isCollapsed && (
        <AskQuestionHistoryBody>
          <p className="chat-block-title leading-normal text-text-2">
            {description}
          </p>
        </AskQuestionHistoryBody>
      )}
    </div>
  );
};

// ============================================
// Pending Card (header-only, no buttons)
// ============================================

const PendingCard: React.FC<{
  toolName: string;
  showActiveEventPainting: boolean;
}> = ({ toolName, showActiveEventPainting }) => {
  const labels = useLifecycleLabels("ask_user_permissions");

  return (
    <div className={getEventBlockContainerClasses(false)}>
      <EventBlockHeader isCollapsed={false} withHover={false}>
        <EventBlockHeaderIcon
          icon={getEventIcon("ask_user_permissions", {
            className: "text-primary-6",
          })}
          isCollapsed={false}
          isHeaderHovered={false}
          hasContent={false}
        />
        <EventBlockHeaderTitle isLoading={showActiveEventPainting}>
          {labels.running}
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle title={toolName}>
          {toolName}
        </EventBlockHeaderSubtitle>
      </EventBlockHeader>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

export const ApprovalRequestEvent: React.FC<RawEventInput> = (props) => {
  const normalizedProps = useNormalizedEventProps(
    props,
    "ask_user_permissions"
  );

  const { toolName, description, status } = useMemo(
    () => extractApprovalData(props),
    [props]
  );

  const eventId =
    props.event?.id ||
    props.event_id ||
    ((props as Record<string, unknown>).id as string | undefined);

  if (!normalizedProps) return null;

  if (status === "pending") {
    return (
      <PendingCard
        toolName={toolName}
        showActiveEventPainting={
          normalizedProps.showActiveEventPainting ?? false
        }
      />
    );
  }

  return (
    <ResolvedCard
      status={status}
      toolName={toolName}
      description={description}
      eventId={eventId}
    />
  );
};

ApprovalRequestEvent.displayName = "ApprovalRequestEvent";

export default ApprovalRequestEvent;
