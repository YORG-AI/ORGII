/**
 * TerminalBlock Component
 *
 * Transparent event header matching Explore/LSP blocks. Expanded command and
 * output content lives in the shared filled body shell, separated by a subtle
 * divider without additional section labels.
 */
import { Square } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { ShellReplayOutput } from "@src/components/ShellReplayOutput";
import "@src/components/TerminalDisplay/index.scss";
import { getToolIcon } from "@src/config/toolIcons";
import type {
  PayloadRef,
  ShellReplayRef,
  ShellReplayState,
  ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import {
  formatCommandForDisplay,
  getCommandSymbolList,
  truncateCommandPreview,
} from "@src/util/terminal/commandParser";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  BlockOutput,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EVENT_LOADING_SHIMMER_TEXT_CLASSES,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

const TERMINAL_OUTPUT_PREVIEW_MAX_HEIGHT = 72;
const TERMINAL_OUTPUT_EXPAND_LINE_THRESHOLD = 3;

export interface TerminalBlockProps {
  command?: string;
  output?: string;
  exitCode?: number;
  executionTime?: number;
  isError?: boolean;
  defaultCollapsed?: boolean;
  title?: string;
  /** Optional secondary detail shown after the title, truncated to preserve space for command symbols. */
  subtitle?: string;
  headerIcon?: React.ReactNode;
  runningStatusText?: string;
  runningStatusIcon?: React.ReactNode;
  /** Optional event ID for simulator replay */
  eventId?: string;
  sessionId?: string;
  payloadRef?: PayloadRef;
  /** Durable replay identity and bounded latest state for shell cards. */
  replayRef?: ShellReplayRef;
  replayState?: ShellReplayState;
  /** When true, shows animated icon and streaming-friendly layout */
  isLoading?: boolean;
  /** Live streaming output (shown during loading before final output) */
  streamOutput?: string;
  /** Process ID shown for backgrounded processes and used for Stop while actively running. */
  pid?: number;
  /**
   * Process status: running, background, exited, killed.
   * NOTE: `"running"` alone does NOT show the Stop button; `isLoading` must
   * also be true. Backgrounded processes show status/PID only.
   */
  processStatus?: "running" | "background" | "exited" | "killed";
  /** Callback when user clicks Stop */
  onStop?: (pid: number) => void;
  /** Token/context attribution metadata for this shell call. */
  toolUsage?: ToolUsageMetadata;
  /** When true, renders output through xterm.js instead of ansi-to-react. */
  tuiRendering?: boolean;
}

const TerminalBlock: React.FC<TerminalBlockProps> = memo(
  ({
    command,
    output,
    exitCode,
    executionTime: _executionTime,
    isError = false,
    defaultCollapsed,
    title,
    subtitle,
    headerIcon,
    runningStatusText,
    runningStatusIcon,
    eventId,
    sessionId,
    payloadRef,
    replayRef,
    replayState,
    isLoading = false,
    streamOutput,
    pid,
    processStatus,
    onStop,
    toolUsage,
    tuiRendering,
  }) => {
    const isErrorExit = exitCode !== undefined && exitCode !== 0;
    const isBackground = processStatus === "background";
    const isStillRunning = isLoading || isBackground;
    // Visibility policy:
    // - Caller-provided defaults always win.
    // - Errors → expanded (need to see what failed).
    // - Still running OR backgrounded → expanded so progress remains visible.
    // - Done & no error → collapse to a chip by default.
    const effectiveDefaultCollapsed =
      defaultCollapsed ?? (isErrorExit ? false : isStillRunning ? false : true);

    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
      setIsCollapsed,
    } = useBlockHeader({
      defaultCollapsed: effectiveDefaultCollapsed,
      eventId,
      collapseAllValue: true,
      preserveDefaultOnExpand: true,
    });

    const wasStillRunningRef = useRef(isStillRunning);
    useEffect(() => {
      if (wasStillRunningRef.current && !isStillRunning && !isErrorExit) {
        setIsCollapsed(true);
      }
      wasStillRunningRef.current = isStillRunning;
    }, [isStillRunning, isErrorExit, setIsCollapsed]);

    const { t } = useTranslation("sessions");
    const { t: tCommon } = useTranslation();
    const displayOutput = output || streamOutput;
    // When the agent provides a description (human summary), promote it to the
    // primary title and drop the default lifecycle label. The parsed command
    // symbols (git, npm, …) still render separately, so the command stays
    // visible in the header.
    const trimmedSubtitle = subtitle?.trim();
    const hasDescriptionTitle = Boolean(trimmedSubtitle);
    const displayTitle =
      trimmedSubtitle ||
      title?.trim() ||
      (isLoading ? t("tools.runCommandRunning") : t("tools.runCommandDone"));
    const commandSymbols = useMemo(
      () => getCommandSymbolList(command),
      [command]
    );
    const hasOutput =
      Boolean(displayOutput && displayOutput.trim().length > 0) ||
      Boolean(replayRef && replayState);

    const formattedCommand = useMemo(
      () => (command ? formatCommandForDisplay(command) : ""),
      [command]
    );
    const commandPreview = useMemo(
      () => truncateCommandPreview(formattedCommand),
      [formattedCommand]
    );

    // Stop button state — reset when process finishes.
    //
    // Gate on `isLoading` so backgrounded shell cards keep their status/PID
    // visible without showing an inline stop/end control.
    const [isStopping, setIsStopping] = useState(false);
    useEffect(() => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!isStillRunning) setIsStopping(false);
    }, [isStillRunning]);
    const effectiveIsStopping = isStopping && isStillRunning;
    const canStop = pid !== undefined && isLoading && !isBackground;

    const handleStop = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (pid && onStop && !effectiveIsStopping) {
          setIsStopping(true);
          onStop(pid);
        }
      },
      [pid, onStop, effectiveIsStopping]
    );

    const statusLabel = useMemo(() => {
      if (processStatus === "killed") {
        return (
          <span className="shrink-0 text-danger-6">
            {t("tools.shellStatus.killed")}
          </span>
        );
      }
      if (processStatus === "background") {
        const label = pid
          ? t("tools.shellStatus.backgroundWithPid", { pid })
          : t("tools.shellStatus.background");
        return <span className="shrink-0 text-text-3">{label}</span>;
      }
      return null;
    }, [processStatus, pid, t]);

    if (!command && !output && !streamOutput && !replayState) return null;

    const hasContent = Boolean(command || displayOutput);

    const headerRight =
      toolUsage || statusLabel || canStop ? (
        <div className="flex items-center gap-2 pl-2">
          {toolUsage && <ToolUsageBadge usage={toolUsage} />}
          {statusLabel}
          {canStop && (
            <button
              type="button"
              className="flex h-5 w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-none bg-text-2 text-white transition-colors hover:bg-text-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 group-hover/chat-block-header:w-5"
              onClick={handleStop}
              disabled={effectiveIsStopping}
              title={tCommon("common:actions.stop")}
              aria-label={tCommon("common:actions.stop")}
            >
              {effectiveIsStopping ? (
                <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Square size={10} fill="currentColor" strokeWidth={0} />
              )}
            </button>
          )}
        </div>
      ) : undefined;

    const runningStatusRow =
      isLoading && runningStatusText ? (
        <div className="mt-1 flex items-center gap-2 px-2 py-1 text-sm text-text-3">
          {runningStatusIcon && (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-3">
              {runningStatusIcon}
            </span>
          )}
          <span
            className={`truncate font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`}
          >
            {runningStatusText}
          </span>
        </div>
      ) : null;

    return (
      <>
        <div
          className={`group/terminal ${getEventBlockContainerClasses(false)}`}
        >
          <EventBlockHeader
            isCollapsed={isCollapsed}
            withHover={false}
            onClick={handleLocate}
            onNavigate={handleLocate}
            onMouseEnter={handleHeaderMouseEnter}
            onMouseLeave={handleHeaderMouseLeave}
            rightContent={headerRight}
          >
            <EventBlockHeaderIcon
              icon={
                headerIcon ??
                getToolIcon("run_shell", {
                  size: 14,
                  className: "text-text-2",
                })
              }
              isCollapsed={isCollapsed}
              isHeaderHovered={isHeaderHovered}
              onToggle={handleHeaderClick}
              hasContent={hasContent}
              revealChevronOnIconHoverOnly={Boolean(eventId)}
              isLoading={isStillRunning}
              isFailed={isError}
            />
            <EventBlockHeaderTitle
              isLoading={isStillRunning}
              truncate={hasDescriptionTitle}
            >
              {displayTitle}
            </EventBlockHeaderTitle>
            {subtitle && !hasDescriptionTitle && (
              <EventBlockHeaderSubtitle
                isLoading={isStillRunning}
                title={subtitle}
              >
                {subtitle}
              </EventBlockHeaderSubtitle>
            )}
            {commandSymbols.length > 0 ? (
              <span
                className={`shrink-0 ${isStillRunning ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : "text-text-1"}`}
                title={commandSymbols.join(", ")}
              >
                {commandSymbols.length <= 2
                  ? commandSymbols.join(", ")
                  : `${commandSymbols.slice(0, 2).join(", ")}, +${commandSymbols.length - 2}`}
              </span>
            ) : null}
            {!isStillRunning && exitCode !== undefined && exitCode !== 0 && (
              <span className="shrink-0 text-danger-6">exit {exitCode}</span>
            )}
          </EventBlockHeader>

          {!isCollapsed && (
            <div
              className={`${EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES} min-w-0 animate-fade-in`}
            >
              {command && (
                <div className="overflow-x-auto scrollbar-hide">
                  <div
                    className="terminal-command terminal-command--chat"
                    style={{
                      fontSize: "var(--chat-code-font-size, 13px)",
                    }}
                  >
                    <span className="terminal-command__prefix select-none">
                      $
                    </span>
                    <span className="terminal-command__text">
                      {commandPreview}
                    </span>
                  </div>
                </div>
              )}

              {hasOutput && (
                <div
                  className={
                    command
                      ? "border-t border-solid border-border-1"
                      : undefined
                  }
                >
                  {replayRef && replayState ? (
                    <ShellReplayOutput
                      command={command ?? ""}
                      replayRef={replayRef}
                      replayState={replayState}
                      cursorEventId={eventId}
                      exitCode={exitCode}
                      hideCommandLine
                      variant="chat"
                      showStatus={false}
                    />
                  ) : (
                    <BlockOutput
                      output={displayOutput!}
                      isError={
                        !isLoading && exitCode !== undefined && exitCode !== 0
                      }
                      status={
                        isLoading || exitCode === undefined
                          ? "default"
                          : exitCode === 0
                            ? "success"
                            : "error"
                      }
                      withBorder={false}
                      sessionId={sessionId}
                      eventId={eventId}
                      payloadRef={payloadRef}
                      collapsedMaxHeight={TERMINAL_OUTPUT_PREVIEW_MAX_HEIGHT}
                      defaultScrollToBottom
                      expandLineThreshold={
                        TERMINAL_OUTPUT_EXPAND_LINE_THRESHOLD
                      }
                      tuiRendering={tuiRendering}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {runningStatusRow}
      </>
    );
  }
);

TerminalBlock.displayName = "TerminalBlock";

export default TerminalBlock;
