/**
 * Shared shapes for the focused-chat workstation rail: the row/section model
 * the rail renders, the session scope it shows at the top, and the props of
 * the rail itself.
 */
import type { LucideIcon } from "lucide-react";
import type { ComponentProps, JSXElementConstructor } from "react";

import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";

export type FocusedChatRailIcon = JSXElementConstructor<
  ComponentProps<LucideIcon>
>;

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
  compact?: boolean;
  onRequestClose?: () => void;
  sections: FocusedChatRailSection[];
}
