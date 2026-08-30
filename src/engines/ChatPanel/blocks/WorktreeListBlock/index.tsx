/**
 * WorktreeListBlock — Header row + expandable worktree details.
 */
import React from "react";

import { getToolIcon } from "@src/config/toolIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import { HugeiconsIcon, WorkflowCircle05Icon } from "@src/icons";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  ComposerStackListRow,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockExpandableStackList,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderInfo,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  SESSION_UI_TOKENS,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

export interface WorktreeEntryItem {
  path: string;
  branch: string;
}

export interface WorktreeDetailRow {
  key: string;
  label: string;
  value: string;
}

export interface WorktreeListBlockProps {
  action: string;
  entries?: WorktreeEntryItem[];
  rows?: WorktreeDetailRow[];
  eventId?: string;
  title: string;
  toolUsage?: ToolUsageMetadata;
  isLoading?: boolean;
  isFailed?: boolean;
}

const VISIBLE_ITEMS = 6;

function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function unwrapWorktreeResult(
  result: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!result) return {};

  const outputObject = parseJsonObject(result.output);
  if (outputObject) return { ...result, ...outputObject };

  const contentObject = parseJsonObject(result.content);
  if (contentObject) return { ...result, ...contentObject };

  return result;
}

export function extractWorktreeEntries(
  result: Record<string, unknown> | undefined
): WorktreeEntryItem[] {
  const raw = unwrapWorktreeResult(result).entries;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is WorktreeEntryItem =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as Record<string, unknown>).path === "string" &&
      typeof (entry as Record<string, unknown>).branch === "string"
  );
}

export function buildWorktreeRows(
  action: string,
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): WorktreeDetailRow[] {
  const rows: WorktreeDetailRow[] = [];
  const normalizedResult = unwrapWorktreeResult(result);
  const add = (key: string, label: string, value: unknown) => {
    const text = stringifyValue(value);
    if (text) rows.push({ key, label, value: text });
  };

  add("action", "Action", action);
  add("branch", "Branch", normalizedResult.branch ?? args?.branch);
  add("base", "Base", normalizedResult.base ?? args?.base_ref ?? args?.baseRef);
  add("path", "Path", normalizedResult.path);
  if (action === "leave") add("remove", "Remove directory", args?.remove);
  add("removed", "Removed", normalizedResult.removed);
  add("reused", "Reused existing", normalizedResult.reused);
  add(
    "message",
    normalizedResult.success === false ? "Error" : "Message",
    normalizedResult.error ??
      normalizedResult.content ??
      normalizedResult.message
  );

  return rows;
}

const renderWorktreeRow = (entry: WorktreeEntryItem) => (
  <ComposerStackListRow
    title={entry.path}
    leading={
      <HugeiconsIcon
        icon={WorkflowCircle05Icon}
        data-icon="git-branch"
        size={14}
        className="shrink-0 text-primary-6"
      />
    }
    primary={entry.branch}
  />
);

const getWorktreeKey = (entry: WorktreeEntryItem) => entry.path;

const renderDetailRow = (row: WorktreeDetailRow) => (
  <ComposerStackListRow
    title={row.value}
    leading={null}
    primary={row.label}
    secondary={row.value}
    variant="info"
  />
);

export const WorktreeListBlock: React.FC<WorktreeListBlockProps> = ({
  action,
  entries = [],
  rows = [],
  eventId,
  title,
  toolUsage,
  isLoading = false,
  isFailed = false,
}) => {
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({
    defaultCollapsed: false,
    eventId,
    collapseAllValue: false,
  });

  const isExpanded = !isCollapsed;

  const hasEntries = entries.length > 0;
  const hasRows = rows.length > 0;
  const hasContent = hasEntries || hasRows;

  return (
    <div
      className={getEventBlockContainerClasses(false)}
      data-tool-call-event-id={eventId}
      data-tool-call-name="worktree"
    >
      <EventBlockHeader
        isCollapsed={!isExpanded}
        withHover={false}
        onClick={handleLocate}
        onNavigate={handleLocate}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
        className={eventId ? "cursor-pointer" : undefined}
        rightContent={
          toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
        }
      >
        <EventBlockHeaderIcon
          icon={getToolIcon("worktree", {
            size: SESSION_UI_TOKENS.ICON.SIZE_SM,
            className: isFailed ? "text-danger-6" : "text-text-2",
          })}
          isCollapsed={!isExpanded}
          isHeaderHovered={isHeaderHovered}
          onToggle={hasContent ? handleHeaderClick : undefined}
          hasContent={hasContent}
          revealChevronOnIconHoverOnly={Boolean(eventId)}
          isLoading={isLoading}
          isFailed={isFailed}
        />
        <EventBlockHeaderTitle isLoading={isLoading}>
          {title}
        </EventBlockHeaderTitle>
        <EventBlockHeaderSubtitle isLoading={isLoading} title={action}>
          {action}
        </EventBlockHeaderSubtitle>
        {hasEntries && (
          <EventBlockHeaderInfo>{entries.length}</EventBlockHeaderInfo>
        )}
      </EventBlockHeader>

      {isExpanded && hasContent && (
        <div className={EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES}>
          {hasRows && (
            <EventBlockExpandableStackList
              layout="body"
              items={rows}
              renderItem={renderDetailRow}
              getKey={(row) => row.key}
              visibleCount={8}
            />
          )}
          {hasEntries && (
            <EventBlockExpandableStackList
              layout="full"
              items={entries}
              renderItem={renderWorktreeRow}
              getKey={getWorktreeKey}
              visibleCount={VISIBLE_ITEMS}
            />
          )}
        </div>
      )}
    </div>
  );
};

WorktreeListBlock.displayName = "WorktreeListBlock";

export default WorktreeListBlock;
