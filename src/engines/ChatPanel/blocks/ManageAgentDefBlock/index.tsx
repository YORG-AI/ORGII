/**
 * ManageAgentDefBlock — compact card for `manage_agent_def` tool events.
 *
 * Shown when the agent creates, updates, lists, or removes custom agent
 * definitions. Follows the same OrgTaskBlock card layout:
 *   - Header: action icon + lifecycle-aware title from Rust i18n keys
 *   - Body: agent name, description snippet, action badge
 *
 * List/get actions with no agent name collapse to title-only.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import { BotIcon, HugeiconsIcon } from "@src/icons";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EVENT_BLOCK_BADGE_BG_CLASSES,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

// ============================================
// Types
// ============================================

export type ManageAgentDefAction =
  | "list"
  | "get"
  | "create"
  | "update"
  | "remove"
  | "list_orgs"
  | "get_org"
  | "create_org"
  | "update_org"
  | "remove_org"
  | string;

interface ManageAgentDefBlockProps {
  action: ManageAgentDefAction;
  /** Agent / team name */
  agentName?: string;
  /** Agent description (shown as body text) */
  description?: string;
  /** Result summary text (for list/get) */
  resultText?: string;
  isLoading?: boolean;
  eventId?: string;
  /** Lifecycle-aware title resolved by FallbackAdapter via useLifecycleLabels */
  title: string;
  toolUsage?: ToolUsageMetadata;
}

// ============================================
// Action icon
// ============================================
//
// Icons are resolved from Rust `action_icons` on the `manage_agent_def`
// tool entry — see `core/tools/builtin_tools/table/agent.rs`. The Rust
// table is the single source of truth for which glyph maps to
// which CRUD action.

function getActionIcon(action: ManageAgentDefAction) {
  return getToolIcon("manage_agent_def", { action });
}

function getActionBadgeLabel(
  action: ManageAgentDefAction,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const key = `manageAgentDef.action.${action}`;
  return t(key, { defaultValue: action });
}

// ============================================
// Compact card body
// ============================================

function AgentDefCard({
  action,
  agentName,
  description,
  resultText,
}: {
  action: ManageAgentDefAction;
  agentName?: string;
  description?: string;
  resultText?: string;
}) {
  const { t } = useTranslation("sessions");

  // List/get with no specific agent — show result summary
  if (!agentName && resultText) {
    return (
      <div className="px-3 pb-3 text-[11px] leading-relaxed text-text-3">
        {resultText.length > 200 ? `${resultText.slice(0, 200)}…` : resultText}
      </div>
    );
  }

  if (!agentName) return null;

  const badgeLabel = getActionBadgeLabel(action, t);

  return (
    <div className="org-task-block__card">
      {/* Agent name + action badge */}
      <div className="kanban-task-card__header mb-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <HugeiconsIcon
            icon={BotIcon}
            data-icon="bot"
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-text-3"
          />
          <div className="kanban-task-card__title truncate text-[13px]">
            {agentName}
          </div>
        </div>
        <span className={`${EVENT_BLOCK_BADGE_BG_CLASSES} shrink-0`}>
          {badgeLabel}
        </span>
      </div>

      {/* Description */}
      {description && (
        <div className="kanban-task-card__description mt-1 line-clamp-3 text-[11px]">
          {description}
        </div>
      )}
    </div>
  );
}

// ============================================
// Main Block
// ============================================

const ManageAgentDefBlock: React.FC<ManageAgentDefBlockProps> = ({
  action,
  agentName,
  description,
  resultText,
  isLoading = false,
  eventId,
  title,
  toolUsage,
}) => {
  const hasBody = Boolean(agentName || resultText);

  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleLocate,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
  } = useBlockHeader({
    defaultCollapsed: true,
    eventId,
    collapseAllValue: true,
  });

  const icon = getActionIcon(action);

  return (
    <div className={`${getEventBlockContainerClasses(false)} animate-fade-in`}>
      <EventBlockHeader
        isCollapsed={isCollapsed}
        withHover={false}
        onClick={handleLocate}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        rightContent={
          toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
        }
      >
        <EventBlockHeaderIcon
          icon={icon}
          isCollapsed={isCollapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={hasBody ? handleHeaderClick : undefined}
          hasContent={hasBody}
          revealChevronOnIconHoverOnly={Boolean(eventId)}
          isLoading={isLoading}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title}
        </EventBlockHeaderTitle>
        {agentName && (
          <EventBlockHeaderSubtitle isLoading={isLoading} title={agentName}>
            {agentName}
          </EventBlockHeaderSubtitle>
        )}
      </EventBlockHeader>

      {!isCollapsed && hasBody && (
        <div
          className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in p-3`}
        >
          <AgentDefCard
            action={action}
            agentName={agentName}
            description={description}
            resultText={resultText}
          />
        </div>
      )}
    </div>
  );
};

ManageAgentDefBlock.displayName = "ManageAgentDefBlock";

export default ManageAgentDefBlock;
