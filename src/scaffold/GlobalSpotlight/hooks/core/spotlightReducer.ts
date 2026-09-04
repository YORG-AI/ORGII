/**
 * Spotlight Reducer - Core State Machine
 *
 * Centralized reducer managing all spotlight state.
 * Eliminates cascading re-renders by using a single state tree.
 */
import { type LanguagePreference } from "@src/i18n";
import { FolderClosedIcon, WorkflowCircle05Icon } from "@src/icons";
import { REPO_KIND } from "@src/store/repo/types";

import { ICONS, TAG_COLORS, getActionById } from "../../config";
import type {
  ActionDefinition,
  ParamType,
  PathSegment,
  RepoItem,
} from "../../types";
import type { SpotlightAction, SpotlightStage, SpotlightState } from "./types";

// ============================================
// Initial State
// ============================================

export const initialSpotlightState: SpotlightState = {
  // Stage
  stage: "idle",

  // Navigation
  path: [],
  searchQuery: "",
  selectedIndex: 0,

  // Derived (computed on every action)
  currentAction: null,
  currentRepo: null,
  currentBranch: null,
  currentLanguage: null,
  missingParam: null,
  isComplete: false,
};

// ============================================
// Helper Functions
// ============================================

/**
 * Compute derived state from path
 */
function computeDerivedState(path: PathSegment[]): {
  currentAction: ActionDefinition | null;
  currentRepo: RepoItem | null;
  currentBranch: string | null;
  currentLanguage: LanguagePreference | null;
  missingParam: ParamType | null;
  isComplete: boolean;
} {
  // Find current action (last action in path)
  const actionSegments = path.filter((segment) => segment.type === "action");
  const currentAction =
    actionSegments.length > 0
      ? getActionById(actionSegments[actionSegments.length - 1].id) || null
      : null;

  // Find current repo
  const repoSegment = path.find((segment) => segment.type === "repo");
  const currentRepo = (repoSegment?.data as RepoItem | undefined) ?? null;

  // Find current branch
  const branchSegment = path.find((segment) => segment.type === "branch");
  const currentBranch = branchSegment?.label || null;

  const languageSegment = path.find((segment) => segment.type === "language");
  const currentLanguage =
    (languageSegment?.data as LanguagePreference | undefined) ?? null;

  // Determine missing param
  let missingParam: ParamType | null = null;
  if (currentAction) {
    for (const paramType of currentAction.requiredParams) {
      const hasParam = path.some((segment) => segment.type === paramType);
      if (!hasParam) {
        if (paramType === "branch" && currentRepo?.kind === REPO_KIND.FOLDER) {
          continue;
        }
        missingParam = paramType;
        break;
      }
    }
  }

  const isComplete = currentAction !== null && missingParam === null;

  return {
    currentAction,
    currentRepo,
    currentBranch,
    currentLanguage,
    missingParam,
    isComplete,
  };
}

/**
 * Determine the appropriate stage based on state
 */
function determineStage(
  currentStage: SpotlightStage,
  isComplete: boolean,
  pathLength: number
): SpotlightStage {
  // If we're executing, stay executing until explicit reset
  if (currentStage === "executing") return "executing";

  // If we're confirming and path becomes incomplete, go back to selecting
  if (currentStage === "confirming" && !isComplete) return "selecting";

  // If complete and not already confirming, move to confirming
  if (isComplete && currentStage !== "confirming") return "confirming";

  // If there's a path, we're selecting
  if (pathLength > 0) return "selecting";

  // Otherwise, idle
  return "idle";
}

// ============================================
// Reducer
// ============================================

export function spotlightReducer(
  state: SpotlightState,
  action: SpotlightAction
): SpotlightState {
  switch (action.type) {
    // ========== Path Management ==========

    case "PUSH_ACTION": {
      const selectedAction = action.payload.action;

      const newPath: PathSegment[] = [
        ...state.path,
        {
          type: "action" as const,
          id: selectedAction.id,
          label: selectedAction.label,
          icon: selectedAction.icon,
          color: selectedAction.color,
          data: selectedAction,
        },
      ];

      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "", // Clear search after selection
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "PUSH_REPO": {
      const repo = action.payload.repo;
      const newPath = [
        ...state.path,
        {
          type: "repo" as const,
          id: repo.id,
          label: repo.name,
          icon: FolderClosedIcon,
          color: TAG_COLORS.repo,
          data: repo,
        },
      ];

      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "PUSH_BRANCH": {
      const { branchName, branchData } = action.payload;
      const newPath = [
        ...state.path,
        {
          type: "branch" as const,
          id: branchName,
          label: branchName,
          icon: WorkflowCircle05Icon,
          color: TAG_COLORS.branch,
          data: branchData,
        },
      ];

      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "PUSH_LANGUAGE": {
      const { language, label } = action.payload;
      const newPath = [
        ...state.path,
        {
          type: "language" as const,
          id: language,
          label,
          // The language glyph, matching the set-language action definition.
          // (This used to copy the human-readable language NAME into `icon`,
          // the only non-empty-string icon producer left after the hugeicons
          // migration — never rendered, but a landmine for the pill bar.)
          icon: ICONS.language,
          color: TAG_COLORS.language,
          data: language,
        },
      ];

      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "PUSH_SEGMENT": {
      const newPath = [...state.path, action.payload.segment];
      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "POP_SEGMENT": {
      if (state.path.length === 0) return state;

      const newPath = state.path.slice(0, -1);
      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "TRUNCATE_PATH": {
      const { index } = action.payload;
      const newPath = state.path.slice(0, index);
      const derived = computeDerivedState(newPath);
      const stage = determineStage(
        state.stage,
        derived.isComplete,
        newPath.length
      );

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    case "CLEAR_PATH":
    case "RESET_TO_IDLE": {
      return {
        ...state,
        path: [],
        searchQuery: "",
        selectedIndex: 0,
        stage: "idle",
        currentAction: null,
        currentRepo: null,
        currentBranch: null,
        currentLanguage: null,
        missingParam: null,
        isComplete: false,
      };
    }

    // ========== Search & Selection ==========

    case "SET_SEARCH_QUERY": {
      return {
        ...state,
        searchQuery: action.payload.query,
        selectedIndex: 0, // Reset selection on search
      };
    }

    case "SET_SELECTED_INDEX": {
      return {
        ...state,
        selectedIndex: action.payload.index,
      };
    }

    // ========== Stage Transitions ==========

    case "START_CONFIRMING": {
      // Only transition if complete
      if (!state.isComplete) return state;

      return {
        ...state,
        stage: "confirming",
      };
    }

    case "START_EXECUTING": {
      return {
        ...state,
        stage: "executing",
      };
    }

    case "BACK_FROM_CONFIRMING": {
      // Go back to selecting and pop last segment
      if (state.path.length === 0) {
        return {
          ...state,
          stage: "idle",
        };
      }

      const newPath = state.path.slice(0, -1);
      const derived = computeDerivedState(newPath);
      const stage = newPath.length > 0 ? "selecting" : "idle";

      return {
        ...state,
        path: newPath,
        searchQuery: "",
        selectedIndex: 0,
        stage,
        ...derived,
      };
    }

    // ========== Full Reset ==========

    case "RESET": {
      return initialSpotlightState;
    }

    default:
      return state;
  }
}
