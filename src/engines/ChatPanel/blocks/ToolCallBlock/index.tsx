/**
 * ToolCall Block - Transparent variant for generic tool calls
 *
 * Displays tool name, action summary, and results.
 * Used as fallback for OS Agent tools without specific blocks
 * (git, web_fetch, gui, session_*, project, message, spawn, cron, manage_workspace).
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { TOOL_NAMES } from "@src/api/tauri/agent/toolNames";
import { TOOL_USAGE_ARGS_KEY } from "@src/engines/SessionCore/core/types";
import { formatToolName } from "@src/util/ui/rendering/formatToolName";
import { getRegistryToolLabelText } from "@src/util/ui/rendering/registryToolLabel";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

import {
  BlockOutput,
  BlockSection,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";
import McpProgressRow from "./McpProgressRow";
import OutputContent from "./OutputContent";
import ToolResultActions from "./ToolResultActions";
import ToolUsageBadge from "./ToolUsageBadge";
import {
  DEFAULT_VISIBLE_LINES,
  SEARCH_NO_RESULT_MESSAGES,
  TOOL_SNAPSHOT_MAX_CHARS,
  getToolIcon,
} from "./config";
import {
  buildWorkspaceInfoRows,
  extractArgsSummary,
  extractResultText,
  extractToolSource,
  hasNonEmptyResultValues,
  hasStyledOutput,
  isBrowserSnapshotResult,
  isBrowserTool,
  isErrorResult,
  isSearchTool,
  isShellTool,
  parseAgentMessageCard,
  parseAwaitListingResult,
  parseCommandResult,
  parseFileCardResult,
  parseManageLspResult,
  parseManageWorkspaceResult,
  parseOrgtrackEnvelope,
  parseProjectCardResult,
  parseProjectToolListResult,
  parseSearchFilesResult,
  parseWebsiteCardResult,
  parseWorkItemCardResult,
} from "./helpers";
import type { ToolCallBlockProps } from "./types";

export type { ToolCallBlockProps } from "./types";

const ToolCallBlock: React.FC<ToolCallBlockProps> = React.memo(
  ({
    toolName,
    title,
    args = {},
    result: rawResult,
    isLoading = false,
    defaultCollapsed = true,
    eventId,
    iconOverride,
    callId,
    sessionId,
    toolUsage,
    payloadRefs,
  }) => {
    const result = useMemo(() => rawResult ?? {}, [rawResult]);
    const { t } = useTranslation("sessions");
    const isFileEditTool =
      toolName === "edit_file" ||
      toolName === "apply_patch" ||
      toolName === "write_file";
    const streamOutput =
      typeof args.streamOutput === "string"
        ? args.streamOutput
        : isFileEditTool && typeof args.streamContent === "string"
          ? args.streamContent
          : "";
    const displayArgs = Object.fromEntries(
      Object.entries(args).filter(
        ([key]) =>
          key !== "streamOutput" &&
          key !== "streamContent" &&
          key !== TOOL_USAGE_ARGS_KEY
      )
    );
    const hasArgs = Object.keys(displayArgs).length > 0;
    const hasResult =
      Object.keys(result).length > 0 && hasNonEmptyResultValues(result);
    const hasContent = hasArgs || hasResult || streamOutput.length > 0;
    const derivedAction = useMemo(
      () => deriveToolAction(toolName, args),
      [toolName, args]
    );

    const isError = useMemo(
      () => (hasResult ? isErrorResult(result) : false),
      [hasResult, result]
    );
    const isNoResultSearch = useMemo(() => {
      if (!hasResult) return false;
      const text = extractResultText(result);
      return text !== null && SEARCH_NO_RESULT_MESSAGES.has(text);
    }, [hasResult, result]);
    const effectiveDefaultCollapsed = isNoResultSearch || defaultCollapsed;

    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({
      defaultCollapsed: effectiveDefaultCollapsed,
      eventId,
      collapseAllValue: true,
    });

    const icon = useMemo(() => {
      if (iconOverride) return iconOverride;
      const action =
        derivedAction ||
        (args.command as string | undefined) ||
        (toolName.includes("_")
          ? toolName.substring(toolName.indexOf("_") + 1)
          : undefined);
      return getToolIcon(toolName, { action });
    }, [toolName, args, iconOverride, derivedAction]);
    const displayName = useMemo(() => {
      if (title) return title;
      const action = derivedAction;
      const registryLabel = getRegistryToolLabelText(
        toolName,
        isLoading ? "running" : isError ? "failed" : "done",
        action
      );
      if (registryLabel) return registryLabel;
      return formatToolName(toolName);
    }, [title, toolName, isLoading, isError, derivedAction]);
    const argsSummary = useMemo(
      () => extractArgsSummary(toolName, args),
      [toolName, args]
    );

    const isBrowserSnapshot = useMemo(
      () =>
        hasResult ? isBrowserSnapshotResult(toolName, args, result) : false,
      [hasResult, toolName, args, result]
    );

    const styledOutput = useMemo(() => {
      if (toolName === "manage_workspace") {
        const action =
          typeof args.action === "string" ? args.action : undefined;
        // For mutation actions (add/clone/create/remove) we can render the
        // workspace-info card from args alone — that way the user sees the
        // URL / target_dir / path the moment the call starts, not only once
        // the (potentially slow) git operation finishes. On failure we
        // fall through to the raw output so the error message is visible.
        if (action && action !== "list" && !isError) {
          const rows = buildWorkspaceInfoRows(args);
          if (rows && rows.length > 0) {
            return { type: "workspaceInfo" as const, rows };
          }
        }
        if (hasResult) {
          const text = extractResultText(result);
          const workspaces = text ? parseManageWorkspaceResult(text) : null;
          if (workspaces) return { type: "workspaces" as const, workspaces };
        }
      }
      if (toolName === "manage_lsp" && hasResult) {
        const data = parseManageLspResult(args, result);
        if (data) return { type: "lspStatus" as const, data };
      }
      if (
        toolName === "await_output" &&
        (args.command as string | undefined) === "list" &&
        hasResult
      ) {
        const jobs = parseAwaitListingResult(result);
        if (jobs) return { type: "jobListing" as const, jobs };
      }
      if (
        (toolName === "manage_story" || toolName === "manage_work_item") &&
        hasResult
      ) {
        const text = extractResultText(result);
        if (text) {
          const rows = parseProjectToolListResult(text, toolName, args);
          if (rows) return { type: "projectToolList" as const, rows };
        }
      }
      if (
        (isSearchTool(toolName) || toolName === "manage_story_list") &&
        hasResult
      ) {
        const text = extractResultText(result);
        if (text) {
          if (SEARCH_NO_RESULT_MESSAGES.has(text))
            return { type: "noResult" as const, message: text };
          if ((args.action as string) === "files") {
            const files = parseSearchFilesResult(text);
            if (files)
              return {
                type: "files" as const,
                files,
                repoPath: args.repo_path as string | undefined,
              };
          }
        }
      }

      // Rich card parsers — single-item mutations
      if (toolName === "manage_work_item" && hasResult) {
        const card = parseWorkItemCardResult(args, result);
        if (card) return { type: "workItemCard" as const, card };
      }
      if (toolName === "manage_story" && hasResult) {
        const card = parseProjectCardResult(args, result);
        if (card) return { type: "projectCard" as const, card };
      }
      if (toolName === "write_file" && hasResult) {
        const card = parseFileCardResult(args, result);
        if (card) return { type: "fileCard" as const, card };
      }
      if ((toolName === "web_fetch" || isBrowserTool(toolName)) && hasResult) {
        const card = parseWebsiteCardResult(toolName, args, result);
        if (card) return { type: "websiteCard" as const, card };
      }
      if (toolName === TOOL_NAMES.ORG_SEND_MESSAGE) {
        const card = parseAgentMessageCard(args, result);
        return { type: "agentMessageCard" as const, card };
      }
      if (isShellTool(toolName) && hasResult) {
        const envelope = parseOrgtrackEnvelope(args, result);
        if (envelope)
          return { type: "orgtrackEnvelope" as const, card: envelope };
        const card = parseCommandResult(args, result);
        if (card) return { type: "commandResult" as const, card };
      }

      return null;
    }, [toolName, hasResult, result, args, isError]);

    const hideRawArgs = hasStyledOutput(toolName) || toolName === "manage_lsp";

    const outputPayloadRef = payloadRefs?.find(
      (ref) =>
        ref.fieldPath.startsWith("result.") ||
        ref.fieldPath === "extracted.subagent.resultContent" ||
        ref.fieldPath === "extracted.message.content"
    );
    const argsPayloadRef = payloadRefs?.find((ref) =>
      ref.fieldPath.startsWith("args.")
    );

    const outputText = useMemo(() => {
      if (!hasResult || isBrowserSnapshot || styledOutput) return "";

      const resultText = extractResultText(result);
      if (resultText) {
        return resultText.length > 3000
          ? resultText.substring(0, 3000) + "\n... (truncated)"
          : resultText;
      }

      return JSON.stringify(result, null, 2);
    }, [hasResult, result, isBrowserSnapshot, styledOutput]);

    const hasOutput = outputText.length > 0 || isBrowserSnapshot;

    const argsText = useMemo(() => {
      if (!hasArgs || hideRawArgs) return "";
      return JSON.stringify(displayArgs, null, 2);
    }, [hasArgs, hideRawArgs, displayArgs]);

    const resultContent = useMemo(() => {
      const raw = (result.content as string) || "";
      if (!isBrowserSnapshot) return raw;
      if (raw.length <= TOOL_SNAPSHOT_MAX_CHARS) return raw;
      return (
        raw.slice(0, TOOL_SNAPSHOT_MAX_CHARS) +
        t("tools.outputTruncatedForDisplay")
      );
    }, [result, isBrowserSnapshot, t]);

    const completedLabel = t("common:status.completed");

    // Jump-to-source target — present only when the tool references a
    // concrete file on disk (read/write/edit-style tools).
    const toolSource = useMemo(
      () => extractToolSource(toolName, args),
      [toolName, args]
    );

    const resultActions =
      !isLoading && toolSource ? (
        <ToolResultActions source={toolSource} />
      ) : null;

    const showMcpProgress = Boolean(
      isLoading && callId && sessionId && !isCollapsed
    );
    const hasExpandedShell =
      !isCollapsed &&
      (hasContent ||
        showMcpProgress ||
        (isLoading && (argsText || streamOutput || styledOutput)));

    return (
      <div
        className={`${getEventBlockContainerClasses(false)} animate-fade-in`}
        data-tool-call-event-id={eventId}
        data-tool-call-name={toolName}
      >
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
            onToggle={hasContent ? handleHeaderClick : undefined}
            hasContent={hasContent}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {displayName}
          </EventBlockHeaderTitle>
          {argsSummary && (
            <EventBlockHeaderSubtitle isLoading={isLoading} title={argsSummary}>
              {argsSummary}
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>

        {hasExpandedShell && (
          <div
            className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} animate-fade-in`}
          >
            {showMcpProgress && callId && sessionId && (
              <McpProgressRow sessionId={sessionId} toolCallId={callId} />
            )}
            {argsText.length > 0 && (
              <BlockSection label={t("tools.inputSection")}>
                <BlockOutput
                  output={argsText}
                  visibleLines={DEFAULT_VISIBLE_LINES}
                  withBorder={false}
                  sessionId={sessionId}
                  eventId={eventId}
                  payloadRef={argsPayloadRef}
                />
              </BlockSection>
            )}

            {isLoading && styledOutput && (
              <BlockSection
                label={t("tools.outputSection")}
                borderTop={argsText.length > 0}
              >
                <OutputContent
                  styledOutput={styledOutput}
                  isBrowserSnapshot={false}
                  resultContent=""
                  hasOutput={false}
                  outputText=""
                  isError={false}
                  hasResult={false}
                  completedLabel={completedLabel}
                  sessionId={sessionId}
                  eventId={eventId}
                  payloadRef={outputPayloadRef}
                />
              </BlockSection>
            )}

            {isLoading && streamOutput && (
              <BlockSection
                label={t("tools.outputSection")}
                borderTop={argsText.length > 0 || Boolean(styledOutput)}
              >
                <BlockOutput
                  output={streamOutput}
                  visibleLines={DEFAULT_VISIBLE_LINES}
                  withBorder={false}
                />
              </BlockSection>
            )}

            {!isLoading && (
              <>
                {argsText.length > 0 || resultActions ? (
                  <BlockSection
                    label={t("tools.outputSection")}
                    borderTop={argsText.length > 0}
                    headerAction={resultActions}
                  >
                    <OutputContent
                      styledOutput={styledOutput}
                      isBrowserSnapshot={isBrowserSnapshot}
                      resultContent={resultContent}
                      hasOutput={hasOutput}
                      outputText={outputText}
                      isError={isError}
                      hasResult={hasResult}
                      completedLabel={completedLabel}
                      sessionId={sessionId}
                      eventId={eventId}
                      payloadRef={outputPayloadRef}
                    />
                  </BlockSection>
                ) : (
                  <OutputContent
                    styledOutput={styledOutput}
                    isBrowserSnapshot={isBrowserSnapshot}
                    resultContent={resultContent}
                    hasOutput={hasOutput}
                    outputText={outputText}
                    isError={isError}
                    hasResult={hasResult}
                    completedLabel={completedLabel}
                    sessionId={sessionId}
                    eventId={eventId}
                    payloadRef={outputPayloadRef}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }
);

ToolCallBlock.displayName = "ToolCallBlock";

export default ToolCallBlock;
