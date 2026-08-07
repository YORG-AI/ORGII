/**
 * useSpotlightEffects Hook
 *
 * State-level side effects for GlobalSpotlight:
 * - Reset reducer state on close
 * - Apply initial action / initial query atoms on open
 *
 * Input focus + selected-index management are owned by the palette
 * selector kernel now (shared with every other palette). The add workspace
 * modal flow (including GitHub auto-fetch) lives inside `useAddWorkspaceFlow`.
 */
import { useAtom } from "jotai";
import { type Dispatch, useEffect, useLayoutEffect, useRef } from "react";

import {
  type SpotlightInitialEditorMode,
  spotlightInitialActionAtom,
  spotlightInitialQueryAtom,
} from "@src/store/ui/uiAtom";

import { getActionById } from "../../config";
import type { SpotlightAction } from "../core/types";

// ============================================
// Types
// ============================================

export interface UseSpotlightEffectsOptions {
  isOpen: boolean;
  dispatch: Dispatch<SpotlightAction>;
  closeModal: () => void;
  onOpenWorkspaceLayer?: (mode: "switch" | "open" | "add" | "create") => void;
  onOpenBranchLayer?: () => void;
  onOpenWorktreeLayer?: () => void;
  onOpenEditorLayer?: (
    query: string,
    mode?: SpotlightInitialEditorMode
  ) => void;
  onOpenAgentSessionSearchLayer?: () => void;
  onOpenAllSessionsSearchLayer?: () => void;
  onOpenAgentControlLayer?: () => void;
  onOpenSessionCreatorLayer?: () => void;
}

// ============================================
// Hook
// ============================================

export function useSpotlightEffects(options: UseSpotlightEffectsOptions): void {
  const {
    isOpen,
    dispatch,
    onOpenBranchLayer,
    onOpenWorktreeLayer,
    onOpenEditorLayer,
    onOpenWorkspaceLayer,
    onOpenAgentSessionSearchLayer,
    onOpenAllSessionsSearchLayer,
    onOpenAgentControlLayer,
    onOpenSessionCreatorLayer,
  } = options;

  // Reset state on close
  useEffect(() => {
    if (!isOpen) {
      dispatch({ type: "RESET" });
    }
  }, [isOpen, dispatch]);

  // Handle initial action from atom (for opening with specific action prefilled)
  // Use useLayoutEffect to dispatch BEFORE browser paint, preventing flash
  const [initialAction, setInitialAction] = useAtom(spotlightInitialActionAtom);
  const hasHandledInitialActionRef = useRef(false);

  useLayoutEffect(() => {
    // When spotlight opens with an initial action, dispatch it immediately
    if (isOpen && initialAction && !hasHandledInitialActionRef.current) {
      hasHandledInitialActionRef.current = true;

      // Look up the action by ID and dispatch immediately (no delay)
      const action = getActionById(initialAction);
      if (action) {
        dispatch({ type: "PUSH_ACTION", payload: { action } });
      }

      // Clear the initial action atom
      setInitialAction(null);
    }

    // Reset the ref when spotlight closes
    if (!isOpen) {
      hasHandledInitialActionRef.current = false;
    }
  }, [isOpen, initialAction, setInitialAction, dispatch]);

  // Handle initial query/layer requests. Runs whenever a new request lands
  // in the atom while the spotlight is open, so external openers can
  // re-target the visible layer. Atom is cleared after applying so stale
  // values don't leak into the next open.
  const [initialQuery, setInitialQuery] = useAtom(spotlightInitialQueryAtom);

  useLayoutEffect(() => {
    if (!isOpen || !initialQuery) return;

    if (initialQuery.layer?.kind === "workspace") {
      onOpenWorkspaceLayer?.(initialQuery.layer.mode);
    } else if (initialQuery.layer?.kind === "branch") {
      onOpenBranchLayer?.();
    } else if (initialQuery.layer?.kind === "worktree") {
      onOpenWorktreeLayer?.();
    } else if (initialQuery.layer?.kind === "editor") {
      onOpenEditorLayer?.(initialQuery.query, initialQuery.layer.mode);
    } else if (initialQuery.layer?.kind === "agentSessionSearch") {
      onOpenAgentSessionSearchLayer?.();
    } else if (initialQuery.layer?.kind === "allSessionsSearch") {
      onOpenAllSessionsSearchLayer?.();
    } else if (initialQuery.layer?.kind === "agentControl") {
      onOpenAgentControlLayer?.();
    } else if (initialQuery.layer?.kind === "sessionCreator") {
      onOpenSessionCreatorLayer?.();
    } else if (initialQuery.query) {
      dispatch({
        type: "SET_SEARCH_QUERY",
        payload: { query: initialQuery.query },
      });
    }

    setInitialQuery(null);
  }, [
    isOpen,
    initialQuery,
    onOpenAgentControlLayer,
    onOpenAgentSessionSearchLayer,
    onOpenAllSessionsSearchLayer,
    onOpenBranchLayer,
    onOpenWorktreeLayer,
    onOpenEditorLayer,
    onOpenWorkspaceLayer,
    onOpenSessionCreatorLayer,
    setInitialQuery,
    dispatch,
  ]);
}

export default useSpotlightEffects;
