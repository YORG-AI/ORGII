/**
 * Shared shapes for the focused-chat workstation rail: the row/section model
 * the rail renders, the session scope it shows at the top, and the props of
 * the rail itself.
 */
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
  onClick?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** Working-tree +/- shown after the label (the Review row). */
  additions?: number;
  deletions?: number;
  external?: boolean;
  status?: {
    label: string;
    state: BranchCiStatus;
    title: string;
  };
};

export type FocusedChatRailSection = {
  key: string;
  label: string | null;
  items: FocusedChatRailItem[];
  environment?: FocusedChatSessionContext;
};

export interface FocusedChatWorkstationRailProps {
  /** Header host for the narrow-layout pinned trigger. */
  compactMenuHost: HTMLSpanElement | null;
  /** Rail-column host for the conversation scroll navigator. */
  conversationMinimapHostRef: (node: HTMLDivElement | null) => void;
  /** Active session scope moved out of the transcript's former context row. */
  sessionContext?: FocusedChatSessionContext;
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
