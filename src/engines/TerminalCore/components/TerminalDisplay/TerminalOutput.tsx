/**
 * TerminalOutput Component
 *
 * Shared primitive for displaying terminal command output.
 * Consolidates output display logic from:
 * - RunCommand
 * - TerminalBlock
 *
 * Features:
 * - ANSI color code rendering (via ansi-to-react)
 * - Error state display with icon
 * - Loading state with animation
 * - Handles various backend output formats
 * - Optional scrolling with max height
 */
import Ansi from "ansi-to-react";
import { AlertTriangle } from "lucide-react";
import React, { memo, useMemo } from "react";

import { processAnsiContent } from "./utils/ansiProcessor";
import {
  extractExitCode,
  extractStderr,
  getOutputAsString,
} from "./utils/outputFormatter";

export interface TerminalOutputProps {
  /** Raw output from backend (string or object) */
  output?: string | Record<string, unknown>;
  /** Explicit error message (overrides extraction) */
  error?: string;
  /** Exit code (used for error detection) */
  exitCode?: number;
  /** Result object for automatic error extraction */
  result?: Record<string, unknown>;
  /** Maximum height in px (default: 420) */
  maxHeight?: number;
  /** Enable ANSI processing (default: true) */
  processAnsi?: boolean;
  /** Show loading state when no output */
  showLoading?: boolean;
  /** Additional CSS class */
  className?: string;
  /** Additional styles */
  style?: React.CSSProperties;
}

/**
 * TerminalOutput - Displays terminal command output with ANSI colors
 *
 * @example
 * ```tsx
 * <TerminalOutput output={result.output} exitCode={0} />
 * <TerminalOutput output="Hello world" processAnsi={false} />
 * <TerminalOutput error="Command failed" />
 * <TerminalOutput showLoading />
 * ```
 */
export const TerminalOutput: React.FC<TerminalOutputProps> = memo(
  ({
    output,
    error,
    exitCode: propExitCode,
    result,
    maxHeight = 420,
    processAnsi = true,
    showLoading = true,
    className = "",
    style,
  }) => {
    // Extract output string from various formats
    const outputString = useMemo(
      () => (output ? getOutputAsString(output) : ""),
      [output]
    );

    // Determine error state
    const extractedExitCode = useMemo(
      () => (result ? extractExitCode(result) : undefined),
      [result]
    );
    const finalExitCode = propExitCode ?? extractedExitCode;
    const hasExitError = finalExitCode !== undefined && finalExitCode !== 0;

    const extractedStderr = useMemo(
      () => (result ? extractStderr(result) : ""),
      [result]
    );

    const hasError =
      error ||
      hasExitError ||
      (result?.message as string | undefined) ||
      (result?.success === false && !result?.output);

    const errorMessage =
      error ||
      extractedStderr ||
      (result?.message as string) ||
      (hasExitError ? `Exit code: ${finalExitCode}` : "");

    const hasOutput = !!outputString;

    // Render error state
    if (hasError) {
      return (
        <div
          className={`terminal-output ${className}`}
          style={{ maxHeight, ...style }}
        >
          <div className="terminal-output__error">
            <AlertTriangle size={16} className="terminal-output__error-icon" />
            <div className="terminal-output__error-content">
              <span className="terminal-output__error-label">Error</span>
              <pre className="terminal-output__error-message">
                {String(errorMessage)}
              </pre>
            </div>
          </div>
        </div>
      );
    }

    // Render output
    if (hasOutput) {
      return (
        <div
          className={`terminal-output ${className}`}
          style={{ maxHeight, ...style }}
        >
          <pre className="terminal-output__pre">
            {typeof output === "string" && processAnsi ? (
              <Ansi>{processAnsiContent(outputString)}</Ansi>
            ) : (
              outputString
            )}
          </pre>
        </div>
      );
    }

    // Render loading state
    if (showLoading) {
      return (
        <div
          className={`terminal-output ${className}`}
          style={{ maxHeight, ...style }}
        >
          <div className="terminal-output__loading">
            <div className="terminal-output__loading-dots">
              <span
                className="terminal-output__loading-dot"
                style={{ animationDelay: "0ms" }}
              />
              <span
                className="terminal-output__loading-dot"
                style={{ animationDelay: "150ms" }}
              />
              <span
                className="terminal-output__loading-dot"
                style={{ animationDelay: "300ms" }}
              />
            </div>
            <span className="terminal-output__loading-text">
              Executing command...
            </span>
          </div>
        </div>
      );
    }

    // Empty state
    return null;
  }
);

TerminalOutput.displayName = "TerminalOutput";
