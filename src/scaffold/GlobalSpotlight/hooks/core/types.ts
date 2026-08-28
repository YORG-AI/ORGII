/**
 * Core Types for Spotlight Reducer Architecture
 *
 * Centralized type definitions for the new reducer-based spotlight system.
 */
import type { ComponentType } from "react";

import type { LanguagePreference } from "@src/i18n";
import type { IconSvgElement } from "@src/icons";

import type {
  ActionDefinition,
  BranchItem,
  ParamType,
  PathSegment,
  RepoItem,
  SpotlightItem,
} from "../../types";

// ============================================
// Spotlight Stage
// ============================================

/**
 * The current stage of spotlight interaction
 */
export type SpotlightStage =
  | "idle" // No selection made
  | "selecting" // Selecting action/repo/branch/param
  | "confirming" // All params filled, showing confirmation page
  | "executing"; // Action is executing

// ============================================
// Spotlight State
// ============================================

/**
 * Complete state managed by the spotlight reducer
 */
export interface SpotlightState {
  // ========== Stage Management ==========
  /** Current interaction stage */
  stage: SpotlightStage;

  // ========== Navigation State ==========
  /** Path segments (breadcrumb trail) */
  path: PathSegment[];
  /** Current search query */
  searchQuery: string;
  /** Selected item index for keyboard navigation */
  selectedIndex: number;
  // ========== Derived State (computed in reducer) ==========
  /** Current action in path (if any) */
  currentAction: ActionDefinition | null;
  /** Current repo in path (if any) */
  currentRepo: RepoItem | null;
  /** Current branch in path (if any) */
  currentBranch: string | null;
  /** Current language in path (if any) */
  currentLanguage: LanguagePreference | null;
  /** Next parameter type needed (if any) */
  missingParam: ParamType | null;
  /** Whether all required params are filled */
  isComplete: boolean;
}

// ============================================
// Spotlight Actions (Reducer)
// ============================================

/**
 * Actions that can be dispatched to the spotlight reducer
 */
export type SpotlightAction =
  // ========== Path Management ==========
  | { type: "PUSH_ACTION"; payload: { action: ActionDefinition } }
  | { type: "PUSH_REPO"; payload: { repo: RepoItem } }
  | {
      type: "PUSH_BRANCH";
      payload: { branchName: string; branchData?: BranchItem };
    }
  | {
      type: "PUSH_LANGUAGE";
      payload: { language: LanguagePreference; label: string };
    }
  | { type: "PUSH_SEGMENT"; payload: { segment: PathSegment } }
  | { type: "POP_SEGMENT" }
  | { type: "TRUNCATE_PATH"; payload: { index: number } }
  | { type: "CLEAR_PATH" }

  // ========== Search & Selection ==========
  | { type: "SET_SEARCH_QUERY"; payload: { query: string } }
  | { type: "SET_SELECTED_INDEX"; payload: { index: number } }

  // ========== Stage Transitions ==========
  | { type: "START_CONFIRMING" } // Move to confirmation stage
  | { type: "START_EXECUTING" } // Move to executing stage
  | { type: "BACK_FROM_CONFIRMING" } // Return to selecting from confirmation
  | { type: "RESET_TO_IDLE" } // Reset to idle stage

  // ========== Full Reset ==========
  | { type: "RESET" };

// ============================================
// Hook Options & Returns
// ============================================

/**
 * Options for branches hook
 */
export interface UseBranchesOptions {
  /** Repo ID to fetch branches for */
  repoId: string | null;
  /** Whether branch fetching is enabled */
  enabled?: boolean;
}

/**
 * Return type for confirmation page hook
 */
export interface UseConfirmationPageReturn {
  /** Whether confirmation page should be shown */
  showConfirmation: boolean;
  /** Formatted confirmation data */
  confirmationData: {
    actionLabel: string;
    actionIcon:
      | string
      | IconSvgElement
      | ComponentType<Record<string, unknown>>;
    parameters: Array<{
      label: string;
      value: string;
      icon?: string | IconSvgElement | ComponentType<Record<string, unknown>>;
    }>;
  } | null;
  /** Confirm and execute the action */
  confirm: () => void;
  /** Go back to parameter selection */
  back: () => void;
}

/**
 * Return type for items hook
 */
export interface UseSpotlightItemsReturn {
  /** Items to display in spotlight */
  items: SpotlightItem[];
  /** Whether items are loading */
  isLoading: boolean;
}
