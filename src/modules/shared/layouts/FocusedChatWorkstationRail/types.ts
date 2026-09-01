/**
 * Shared shapes for the focused-chat workstation rail: the row/section model
 * the rail renders, the session scope it shows at the top, and the props of
 * the rail itself.
 */
import type React from "react";
import type { ComponentType } from "react";

import type { IconSvgElement } from "@src/icons";
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";

/**
 * A rail icon is either hugeicons glyph data — rendered through
 * `HugeiconsIcon` — or a hand-authored SVG component. `GitHubRailIcon` is the
 * only component today; it wraps a brand mark that is not part of any icon set.
 */
export type FocusedChatRailIcon =
  | IconSvgElement
  | ComponentType<{ size?: number; [key: string]: unknown }>;

export type FocusedChatRailItem = {
  key: string;
  label: string;
  icon: FocusedChatRailIcon;
  /** Keyboard hint shown in a tooltip (e.g. "⌘E"). */
  shortcut?: string;
  fileName?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /**
   * Row opens a second-level panel anchored to itself: it must not close the
   * compact menu it lives in, and it advertises the popup to AT.
   */
  submenu?: boolean;
  onClose?: () => void;
  closeLabel?: string;
  /** Process termination stays distinct from closing a document or view. */
  onStop?: () => void;
  stopLabel?: string;
  /** Working-tree +/- shown after the label (the Review row). */
  additions?: number;
  deletions?: number;
  external?: boolean;
  status?: {
    label: string;
    state: BranchCiStatus;
    title: string;
    /** Show only the glyph; the localized label stays as the tooltip. */
    iconOnly?: boolean;
  };
};

export type FocusedChatRailSection = {
  key: string;
  label: string | null;
  items: FocusedChatRailItem[];
  environment?: FocusedChatSessionContext;
};

/** One agent-spawned child session of the rail's active session. */
export interface FocusedChatRailSubagent {
  sessionId: string;
  /** Agent name (e.g. "Explore"). */
  name: string;
  /** Task title, already stripped of a redundant agent-name prefix. */
  description: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface FocusedChatWorkstationRailProps {
  /** Header host for the narrow-layout pinned trigger. */
  compactMenuHost: HTMLSpanElement | null;
  /** Rail-column host for the conversation scroll navigator. */
  conversationMinimapHostRef: (node: HTMLDivElement | null) => void;
  /** Active session scope moved out of the transcript's former context row. */
  sessionContext?: FocusedChatSessionContext;
  /** The active session's spawned subagent sessions, newest first. */
  subagents?: FocusedChatRailSubagent[];
  /**
   * Mark shown on every subagent row. Resolved once from the PARENT session,
   * because a subagent runs on its parent's harness — so a Codex session's
   * subagents carry the Codex mark, and ORGII's carry the ORG2 one. Passed in
   * already resolved rather than looked up per row so the rail never has to
   * fall back to a generic bot glyph for a child session that has not landed
   * in the session map yet.
   */
  subagentIcon?: FocusedChatRailIcon;
  /** Height of overlaid chat chrome that the rail must remain below. */
  topInset?: number;
}

export interface FocusedChatSessionContext {
  branchName?: string;
  /**
   * Where the session's environment runs. Rendered as a passive chevron row
   * (no switcher wired yet).
   */
  environmentKind?: "local" | "cloud";
  /** Switcher action on the branch row (chevron affordance + click). */
  branchAction?: {
    /** Switcher popup currently open (row highlights, chevron flips up). */
    active?: boolean;
    label: string;
    onClick: () => void;
  };
  repoName?: string;
  repoPath?: string;
  worktreeBranchName?: string;
  worktreePath?: string;
  workItem?: {
    label: string;
    onClick?: () => void;
    statusLabel?: string;
  };
}

export interface WorkstationSectionsProps {
  collapseGroupLabel?: string;
  collapsedGroupKeys?: ReadonlySet<string>;
  compact?: boolean;
  expandGroupLabel?: string;
  onRequestClose?: () => void;
  onToggleGroup?: (groupKey: string) => void;
  sections: FocusedChatRailSection[];
}
