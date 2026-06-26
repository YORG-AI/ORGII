import React, { memo, useMemo } from "react";

import { getToolIcon } from "@src/config/toolIcons";
import type { PayloadRef } from "@src/engines/SessionCore/core/types";

import {
  BlockOutput,
  BlockSection,
  ComposerStackListRow,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockExpandableStackList,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

interface ManageCodeMapBlockProps {
  action: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  title: string;
  isLoading?: boolean;
  isFailed?: boolean;
  eventId?: string;
  sessionId?: string;
  payloadRefs?: PayloadRef[];
}

interface InfoRow {
  key: string;
  label: string;
  value: string;
}

function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function getNestedRecord(
  value: Record<string, unknown> | undefined,
  key: string
): Record<string, unknown> | undefined {
  const nested = value?.[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

function buildRows(
  action: string,
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): InfoRow[] {
  const rows: InfoRow[] = [];
  const add = (key: string, label: string, value: unknown) => {
    const text = stringifyValue(value);
    if (text) rows.push({ key, label, value: text });
  };

  add("action", "Action", action);
  add("workspace", "Workspace", args?.workspace_path ?? args?.workspacePath);

  const status = getNestedRecord(result, "status");
  add("freshness", "Freshness", status?.freshness);
  add("files", "Files", status?.files);
  add("symbols", "Symbols", status?.symbols);
  add("relations", "Relations", status?.relations);
  add("size", "Index size", status?.db_size_bytes ?? status?.dbSizeBytes);
  add("error", "Error", status?.error ?? result?.error);

  add("nextStep", "Next step", result?.nextStep);
  add("message", "Message", result?.message);

  return rows;
}

function getRawText(result: Record<string, unknown> | undefined): string {
  if (!result || Object.keys(result).length === 0) return "";
  const content = stringifyValue(result.content ?? result.observation);
  if (content) return content;
  return JSON.stringify(result, null, 2);
}

const ManageCodeMapBlock: React.FC<ManageCodeMapBlockProps> = memo(
  ({
    action,
    args,
    result,
    title,
    isLoading = false,
    isFailed = false,
    eventId,
    sessionId,
    payloadRefs,
  }) => {
    const rows = useMemo(
      () => buildRows(action, args, result),
      [action, args, result]
    );
    const rawText = useMemo(() => getRawText(result), [result]);
    const hasContent = rows.length > 0 || rawText.length > 0;
    const icon = useMemo(
      () =>
        getToolIcon("manage_code_map", {
          action,
          size: 14,
          className: isFailed ? "text-danger-6" : "text-text-2",
        }),
      [action, isFailed]
    );
    const outputPayloadRef = payloadRefs?.find((ref) =>
      ref.fieldPath.startsWith("result.")
    );

    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleLocate,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
    } = useBlockHeader({
      defaultCollapsed: false,
      eventId,
      collapseAllValue: true,
    });

    return (
      <div
        className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
        data-tool-call-event-id={eventId}
        data-tool-call-name="manage_code_map"
      >
        <EventBlockHeader
          isCollapsed={isCollapsed}
          withHover={false}
          onClick={handleLocate}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
        >
          <EventBlockHeaderIcon
            icon={icon}
            isCollapsed={isCollapsed}
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
        </EventBlockHeader>

        {!isCollapsed && hasContent && (
          <div
            className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in`}
          >
            {rows.length > 0 && (
              <EventBlockExpandableStackList
                layout="body"
                items={rows}
                renderItem={(row) => (
                  <ComposerStackListRow
                    title={row.value}
                    leading={null}
                    primary={row.label}
                    secondary={row.value}
                    variant="info"
                  />
                )}
                getKey={(row) => row.key}
                visibleCount={8}
              />
            )}

            {rawText.length > 0 && rows.length === 0 && (
              <BlockSection label="Output">
                <BlockOutput
                  output={rawText}
                  visibleLines={8}
                  withBorder={false}
                  sessionId={sessionId}
                  eventId={eventId}
                  payloadRef={outputPayloadRef}
                />
              </BlockSection>
            )}
          </div>
        )}
      </div>
    );
  }
);

ManageCodeMapBlock.displayName = "ManageCodeMapBlock";

export default ManageCodeMapBlock;
export type { ManageCodeMapBlockProps };
