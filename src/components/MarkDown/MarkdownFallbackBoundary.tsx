/**
 * MarkdownFallbackBoundary
 *
 * Contains a render crash inside the Markdown tree to the one piece of content
 * that caused it, and shows a readable substitute for that content instead of
 * an error placeholder. Session transcripts are the product; losing a
 * message's formatting is recoverable, losing its text is not.
 *
 * The failure is pinned to the exact content that threw, so a single malformed
 * string cannot permanently disable a re-used component instance the way a
 * plain `hasError` flag would — the next distinct content renders normally.
 */
import React, { Component, type ReactNode } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("Markdown");

export interface MarkdownFallbackBoundaryProps {
  /** Shown in place of `children` once rendering them has thrown. */
  fallback: ReactNode;
  /** The content being rendered. A change to it clears a recorded failure. */
  resetKey: string;
  /** Names the failing surface in the log line. */
  label: string;
  children: ReactNode;
}

interface MarkdownFallbackBoundaryState {
  /** The `resetKey` whose render threw; null while healthy. */
  failedKey: string | null;
  /** Set by `getDerivedStateFromError`, which cannot read props. */
  justFailed: boolean;
}

export class MarkdownFallbackBoundary extends Component<
  MarkdownFallbackBoundaryProps,
  MarkdownFallbackBoundaryState
> {
  state: MarkdownFallbackBoundaryState = {
    failedKey: null,
    justFailed: false,
  };

  static getDerivedStateFromError(): Partial<MarkdownFallbackBoundaryState> {
    return { justFailed: true };
  }

  static getDerivedStateFromProps(
    props: MarkdownFallbackBoundaryProps,
    state: MarkdownFallbackBoundaryState
  ): Partial<MarkdownFallbackBoundaryState> | null {
    // Runs before the re-render that follows getDerivedStateFromError, which
    // is the first point where the offending content is readable from props.
    if (state.justFailed) {
      return { justFailed: false, failedKey: props.resetKey };
    }
    if (state.failedKey !== null && state.failedKey !== props.resetKey) {
      return { failedKey: null };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    log.error(`${this.props.label} failed to render:`, error, errorInfo);
  }

  render(): ReactNode {
    if (this.state.failedKey !== null) return this.props.fallback;
    return this.props.children;
  }
}

export default MarkdownFallbackBoundary;
