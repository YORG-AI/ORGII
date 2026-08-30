import React from "react";

import type { IconSvgElement } from "@src/icons";

import type { SpotlightItem, SpotlightItemData, StatusType } from "./shared";

// ============ PARAM TYPES ============

/** Types of parameters that actions can require */
export type ParamType = "repo" | "branch" | "source" | "language";

// ============ PATH SEGMENT ============

/** A segment in the navigation path - can be an action or a parameter value */
export interface PathSegment {
  /** Segment type */
  type: "action" | ParamType;
  /** Unique ID */
  id: string;
  /** Display label */
  label: string;
  /** Hugeicons glyph data, a hand-authored SVG component, or `""` (no icon) */
  icon: string | React.ComponentType<Record<string, unknown>> | IconSvgElement;
  /** Color for the tag */
  color: string;
  /** Associated data (repo object, branch object, etc.) */
  data?: unknown;
}

// ============ ACTION DEFINITION ============

/** Defines an action and what parameters it requires */
export interface ActionDefinition {
  /** Unique action ID */
  id: string;
  /** Fallback English label. Prefer `labelKey` at render time. */
  label: string;
  /** i18n key for the label (resolved against `common` namespace). */
  labelKey?: string;
  /** Optional shorter label for compact path pills. */
  pillLabelKey?: string;
  /** Hugeicons glyph data or a hand-authored SVG component */
  icon: string | React.ComponentType<Record<string, unknown>> | IconSvgElement;
  /** Color for the tag */
  color: string;
  /** Required parameters in order of collection */
  requiredParams: ParamType[];
  /** Short keywords for quick search (1-2 words, matched at word boundaries) */
  keywords?: string[];
  /** Aliases for fuzzy matching */
  aliases?: string[];
  /** Whether this action has a special modal (like add-repo forms) */
  hasModal?: boolean;
  /** Template for inline display with placeholders (e.g., "Open {repo} in editor") */
  template?: string;
}

// ============ DATA TYPES ============

export interface RepoItem {
  id: string;
  name: string;
  description?: string;
  repo_url?: string;
  branch?: string;
  fs_uri?: string;
  workspace_uuid?: string;
  kind?: string;
  gitStatus?: {
    uncommittedFiles: number;
    ahead: number;
    behind: number;
  };
}

export interface BranchItem {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommitDate?: string;
  /**
   * Filesystem path of the git worktree that has this branch checked
   * out, if any. Populated by `useBranchFetch` (local repos only) from
   * `getGitWorktrees`. `undefined` when the branch is not checked out
   * in any worktree, or when worktree enumeration is unavailable
   * (GitHub remote repos).
   */
  worktreePath?: string;
  /** Whether this entry represents the repository's main working tree. */
  worktreeIsMain?: boolean;
}

// ============ SPOTLIGHT ITEM ============
// Re-export shared types from Spotlight/shared
export type { SpotlightItem, SpotlightItemData, StatusType };

// ============ COMPONENT PROPS ============

export interface GlobalSpotlightProps {
  /** Control open state (parent controls visibility) */
  isOpen?: boolean;
  /**
   * When the parent owns visibility (controlled `isOpen` or portal host), called to dismiss.
   * Ignored when the spotlight uses only its internal open state.
   */
  onClose?: () => void;
}
