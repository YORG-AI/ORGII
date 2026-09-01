/**
 * Simulator shell replay using DOM + CSS, styled from the same terminal
 * settings as Workstation (theme palette + font atoms). Avoids xterm canvas/WebGL glitches.
 * Command and output render as plain terminal text without syntax highlighting.
 */
import React, { memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import "@src/engines/SessionCore/replay/components/ShellReplayOutput/index.scss";
import { TerminalCommand } from "@src/engines/TerminalCore/components/TerminalDisplay";
import { stripAnsiCodes } from "@src/engines/TerminalCore/components/TerminalDisplay/utils/ansiProcessor";
import { useTerminalSurfaceStyle } from "@src/hooks/terminal/useTerminalSurfaceStyle";

export interface SimulatorShellCssOutputProps {
  command: string;
  output: string;
  exitCode?: number;
  isLoading?: boolean;
  /** Live streaming output shown while command is running (replaces static output during loading) */
  streamOutput?: string;
  /** When true, omit the inline command row (caller renders command elsewhere) */
  hideCommandLine?: boolean;
}

const SimulatorShellCssOutputComponent: React.FC<
  SimulatorShellCssOutputProps
> = ({
  command,
  output,
  exitCode,
  isLoading,
  streamOutput,
  hideCommandLine = false,
}) => {
  const { t } = useTranslation("sessions");
  const {
    foreground,
    mutedForeground,
    errorForeground,
    typography,
    typographyVariables,
  } = useTerminalSurfaceStyle();

  const scrollRef = useRef<HTMLDivElement>(null);
  const isStreaming = isLoading && !!streamOutput;
  const displayOutput = isStreaming ? streamOutput : output;
  const plainOutput = stripAnsiCodes(displayOutput ?? "");
  const displayCommand =
    command.trim() || t("simulator.replay.ide.shell.noCommand");

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const frameId = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      const parentScroller = element.closest<HTMLElement>(
        ".code-viewer-scroll-container"
      );
      parentScroller?.scrollTo({ top: parentScroller.scrollHeight });
    });

    return () => cancelAnimationFrame(frameId);
  }, [plainOutput, isLoading, exitCode]);

  return (
    <div
      ref={scrollRef}
      className="simulator-shell-surface min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 pt-2 pb-[100px]"
      style={typographyVariables}
    >
      {!hideCommandLine ? (
        <div className="mb-1 max-w-full min-w-0">
          <TerminalCommand
            command={displayCommand}
            prefix="$"
            highlighted={false}
            style={{
              color: foreground,
              padding: 0,
              margin: 0,
            }}
          />
        </div>
      ) : null}
      {plainOutput ? (
        <pre
          className="simulator-shell-plain-pre m-0 max-w-full min-w-0 wrap-anywhere wrap-break-word whitespace-pre-wrap"
          style={{ color: foreground }}
        >
          {plainOutput}
        </pre>
      ) : null}
      {isLoading ? (
        <div
          className="simulator-shell-loading mt-1 inline-flex items-center gap-1.5"
          style={typography}
        >
          <span className="animate-shimmer-text bg-linear-to-r from-primary-6/60 via-primary-6 to-primary-6/60 bg-size-[260%_100%] bg-clip-text font-bold text-transparent">
            {t("simulator.replay.ide.shell.outputInProgress")}
          </span>
          <span className="simulator-shell-loading__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
      ) : null}
      {!isLoading && exitCode !== undefined ? (
        <div
          className="mt-2"
          style={{
            ...typography,
            color: exitCode === 0 ? mutedForeground : errorForeground,
          }}
        >
          {t("simulator.replay.ide.shell.exitCode", { code: exitCode })}
        </div>
      ) : null}
    </div>
  );
};

export const SimulatorShellCssOutput = memo(SimulatorShellCssOutputComponent);
SimulatorShellCssOutput.displayName = "SimulatorShellCssOutput";
