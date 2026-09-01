/**
 * TreePanelSidebar Types
 *
 * Type definitions for the TreePanelSidebar component
 */
import React from "react";

// ============================================
// Tree Node Structure
// ============================================

export interface TreePanelNode {
  /** Unique identifier for the node */
  id: string;
  /** Display name */
  name: string;
  /** Full path or identifier */
  path: string;
  /** Node type */
  type: "file" | "directory";
  /** Child nodes (for directories) */
  children?: TreePanelNode[];
  /** Whether the directory is expanded */
  expanded?: boolean;
  /** Optional icon override */
  icon?: React.ReactNode;
  /** Optional secondary text */
  secondaryText?: string;
  /** Whether this node is currently active/selected by agent */
  isAgentSelected?: boolean;

  /** Git status (optional - only present if file has changes) */
  gitStatus?: "modified" | "added" | "deleted" | "renamed" | "conflicted";
  /** Whether git changes are staged */
  gitStaged?: boolean;
  /** Aggregate status for folders (highest priority status of children) */
  aggregateStatus?: "modified" | "added" | "deleted" | "renamed" | "conflicted";

  /** Whether this is a symbolic link */
  isSymlink?: boolean;
  /** Whether this file is ignored by .gitignore */
  isIgnored?: boolean;
}

// ============================================
// Section Header Actions
// ============================================

type SectionHeaderButtonAction = {
  /** Unique action key */
  key: string;
  /** Icon element */
  icon: React.ReactNode;
  /** Optional label text (displayed next to icon) */
  label?: string;
  /** Tooltip text */
  tooltip: string;
  /** Click callback */
  onClick: () => void;
  /** When true, forces the actions bar to remain visible (e.g. dropdown is open) */
  forceVisible?: boolean;
};

type SectionHeaderCustomAction = {
  /** Unique action key */
  key: string;
  /** Custom render replacing the default button (for dropdowns, etc.) */
  customRender: React.ReactNode;
  /** When true, forces the actions bar to remain visible (e.g. dropdown is open) */
  forceVisible?: boolean;
};

export type SectionHeaderAction =
  | SectionHeaderButtonAction
  | SectionHeaderCustomAction;

/** Type guard to check if an action uses custom rendering. */
export function isSectionHeaderCustomAction(
  action: SectionHeaderAction
): action is SectionHeaderCustomAction {
  return "customRender" in action;
}
