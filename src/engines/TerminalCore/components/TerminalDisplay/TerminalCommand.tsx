/**
 * TerminalCommand Component
 *
 * Shared primitive for displaying terminal commands with syntax highlighting.
 * Consolidates command display logic from:
 * - RunCommand
 * - TerminalBlock
 * - TerminalCommandView
 *
 * Features:
 * - Prism syntax highlighting (shared lazy hook with caching)
 * - Customizable prompt prefix
 * - Optional highlighting disable
 * - Consistent styling across all contexts
 * - Optional inline stop button (right-aligned)
 */
import React, { memo } from "react";

import { useSyntaxHighlight } from "@src/hooks/code";
import { HugeiconsIcon, SquareIcon } from "@src/icons";

export interface TerminalCommandStopAction {
  /** Tooltip for the stop button */
  tooltip?: string;
  /** Whether stop is in progress */
  isStopping?: boolean;
  /** Click handler */
  onClick: (event: React.MouseEvent) => void;
}

export interface TerminalCommandProps {
  /** Command string to display */
  command: string;
  /** Prompt prefix (default: "$") */
  prefix?: string;
  /** Enable syntax highlighting (default: true) */
  highlighted?: boolean;
  /** Font size in px (default: 14) */
  fontSize?: number;
  /**
   * When true, keep the command on one line with a trailing ellipsis if it
   * overflows (narrow panels). Disables wrap; use where full command is in title.
   */
  singleLineEllipsis?: boolean;
  /** Optional stop action - shows a circular stop button at right end */
  stopAction?: TerminalCommandStopAction;
  /** Additional CSS class */
  className?: string;
  /** Additional styles */
  style?: React.CSSProperties;
}

/**
 * TerminalCommand - Displays a terminal command with syntax highlighting
 *
 * @example
 * ```tsx
 * <TerminalCommand command="npm install" />
 * <TerminalCommand command="ls -la" prefix=">" fontSize={13} />
 * <TerminalCommand command="echo hello" highlighted={false} />
 * <TerminalCommand
 *   command="npm run dev"
 *   stopAction={{ onClick: handleStop, tooltip: "Stop" }}
 * />
 * ```
 */
export const TerminalCommand: React.FC<TerminalCommandProps> = memo(
  ({
    command,
    prefix = "$",
    highlighted = true,
    fontSize = 12,
    singleLineEllipsis = false,
    stopAction,
    className = "",
    style,
  }) => {
    const useHighlight = highlighted && !singleLineEllipsis;
    // Single-line ellipsis needs plain text; token spans break text-overflow.
    const highlightedHtml = useSyntaxHighlight(useHighlight ? command : "", {
      lang: "bash",
    });

    const rootClass = [
      "terminal-command",
      singleLineEllipsis ? "terminal-command--single-line-ellipsis" : "",
      stopAction ? "terminal-command--with-stop" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        className={rootClass}
        style={{ fontSize: `${fontSize}px`, ...style }}
        title={singleLineEllipsis ? command : undefined}
      >
        <span className="terminal-command__prefix select-none">{prefix}</span>
        {useHighlight && highlightedHtml ? (
          <span
            className="terminal-command__text prism-html"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <span className="terminal-command__text">{command}</span>
        )}
        {stopAction && (
          <button
            onClick={stopAction.onClick}
            disabled={stopAction.isStopping}
            title={stopAction.tooltip}
            className="terminal-command__stop"
          >
            <HugeiconsIcon
              icon={SquareIcon}
              data-icon="square"
              size={10}
              fill="currentColor"
              strokeWidth={0}
            />
          </button>
        )}
      </div>
    );
  }
);

TerminalCommand.displayName = "TerminalCommand";
