/**
 * Terminal output content for shell commands in session replay CodePanel.
 *
 * PERFORMANCE: Output truncation is now handled by processTerminalOutput utility.
 * The ShellOperationEntry.output should ideally be pre-truncated at ingestion time.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ShellReplayOutput } from "@src/components/ShellReplayOutput";
import { TerminalCommand } from "@src/components/TerminalDisplay";
import {
  TERMINAL_OUTPUT_MAX_LENGTH,
  processTerminalOutput,
} from "@src/modules/WorkStation/CodeEditor/util/terminalOutput";

import { SimulatorShellCssOutput } from "../ShellCssOutput";
import type { ShellOperationEntry } from "../types";

export const TerminalContent: React.FC<{
  operation: ShellOperationEntry;
  /** When true, omit the inline command row (e.g. custom output supplies its own) */
  hideCommandLine?: boolean;
}> = memo(({ operation: shellOp, hideCommandLine = false }) => {
  const { t } = useTranslation("sessions");

  // Process and truncate output - memoized to avoid reprocessing on re-renders
  const truncatedOutput = useMemo(() => {
    if (shellOp.replayRef) return "";
    const suffix = t("simulator.replay.ide.codePanel.truncatedSuffix");
    return processTerminalOutput(
      shellOp.output,
      TERMINAL_OUTPUT_MAX_LENGTH,
      suffix
    );
  }, [shellOp.output, shellOp.replayRef, t]);

  if (shellOp.customOutputComponent) {
    return (
      <div className="flex h-full flex-col overflow-auto">
        {!hideCommandLine ? (
          <div className="border-b border-border-2 px-3 py-2">
            <TerminalCommand
              command={shellOp.command}
              prefix="$"
              fontSize={12}
              singleLineEllipsis
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{shellOp.customOutputComponent}</div>
      </div>
    );
  }

  if (shellOp.replayRef && shellOp.replayState) {
    const replayIdentity = JSON.stringify([
      shellOp.replayCursorEventId ?? "live",
      shellOp.replayRef.sessionId,
      shellOp.replayRef.callId,
      shellOp.replayState.bookmark.visibleThroughSequence,
      shellOp.replayState.bookmark.visibleBytes,
    ]);
    return (
      <ShellReplayOutput
        key={replayIdentity}
        command={shellOp.command}
        replayRef={shellOp.replayRef}
        replayState={shellOp.replayState}
        cursorEventId={shellOp.replayCursorEventId}
        exitCode={shellOp.exitCode}
        hideCommandLine={hideCommandLine}
      />
    );
  }

  if (shellOp.replayRef) {
    return (
      <SimulatorShellCssOutput
        command={shellOp.command}
        output={shellOp.output ?? ""}
        hideCommandLine={hideCommandLine}
      />
    );
  }

  return (
    <SimulatorShellCssOutput
      command={shellOp.command}
      output={truncatedOutput}
      exitCode={shellOp.exitCode}
      isLoading={shellOp.isLoading}
      streamOutput={shellOp.streamOutput}
      hideCommandLine={hideCommandLine}
    />
  );
});

TerminalContent.displayName = "TerminalContent";
