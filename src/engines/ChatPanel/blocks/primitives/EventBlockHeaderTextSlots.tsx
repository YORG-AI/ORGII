/**
 * Event block header row — text slot primitives
 *
 * Standard layout inside `EventBlockHeader` (after `EventBlockHeaderIcon`):
 *
 * 1. **icon** — `EventBlockHeaderIcon` (not in this file)
 * 2. **title** — primary label (tool/action name, block kind)
 * 3. **subtitle** — main detail, often truncated (query, path, command summary)
 * 4. **info** — right-side meta, muted (counts, status snippet)
 *
 * Not every block uses all four; omit `subtitle` or `info` when unused.
 *
 * ⚠️ Every Chat block header must use these primitives — never a raw `<span>`
 * with `font-medium text-text-2`. Reasons:
 *
 * - Consistent font size regardless of ancestor wrapper. The `.chat-block-header`
 *   size reset lives in `ChatHistory/index.scss` scoped to `.wp__chat__history`;
 *   raw spans rendered outside that wrapper (playground, previews) fall back to
 *   the base `--chat-font-size` (17px) instead of `--chat-block-title-size`
 *   (16px).
 * - Automatic loading shimmer (`isLoading` swaps in `font-bold` + gradient).
 * - Correct shrink/truncate semantics (`shrink-0` for title,
 *   `min-w-0 flex-initial truncate` for subtitle).
 *
 * See `.cursor/rules/session-rendering.mdc` → "Chat block styling — header
 * primitives (mandatory)".
 */
import React, { type ReactNode } from "react";

import { EVENT_LOADING_SHIMMER_TEXT_CLASSES } from "./config";

export interface EventBlockHeaderTitleProps {
  children: ReactNode;
  /** When true, applies loading shimmer to text */
  isLoading?: boolean;
  /**
   * When true, the title truncates instead of staying at natural width.
   * Use when the title carries a long, variable-length string (e.g. an
   * agent-provided description promoted into the title slot).
   */
  truncate?: boolean;
  className?: string;
}

export interface EventBlockHeaderSubtitleProps {
  children: ReactNode;
  isLoading?: boolean;
  /** Shown on hover when text is truncated */
  title?: string;
  className?: string;
}

export interface EventBlockHeaderInfoProps {
  children: ReactNode;
  isLoading?: boolean;
  className?: string;
}

export const EventBlockHeaderTitle: React.FC<EventBlockHeaderTitleProps> = ({
  children,
  isLoading = false,
  truncate = false,
  className = "",
}) => (
  <span
    className={`inline-flex items-center leading-tight ${truncate ? "min-w-0 flex-initial truncate" : "shrink-0 whitespace-nowrap"} ${isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : "font-medium text-text-2"} ${className}`.trim()}
  >
    {children}
  </span>
);

EventBlockHeaderTitle.displayName = "EventBlockHeaderTitle";

export const EventBlockHeaderSubtitle: React.FC<
  EventBlockHeaderSubtitleProps
> = ({ children, isLoading = false, title: titleAttr, className = "" }) => (
  <span
    className={`inline-flex min-w-0 flex-initial items-center truncate leading-tight ${isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : "text-text-2"} ${className}`.trim()}
    title={titleAttr}
  >
    {children}
  </span>
);

EventBlockHeaderSubtitle.displayName = "EventBlockHeaderSubtitle";

export const EventBlockHeaderInfo: React.FC<EventBlockHeaderInfoProps> = ({
  children,
  isLoading = false,
  className = "",
}) => (
  <span
    className={`shrink-0 ${isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : "text-text-3"} ${className}`.trim()}
  >
    {children}
  </span>
);

EventBlockHeaderInfo.displayName = "EventBlockHeaderInfo";
