/**
 * useSpotlightOverlayLayers Hook
 *
 * Owns the "which overlay layer is active" state for `GlobalSpotlightInner`
 * — the workspace/branch/worktree pickers, agent session search, all-sessions
 * search, agent control, session creator, and the embedded editor palette —
 * plus their open/close handlers and the reset-on-close effect. Extracted
 * verbatim from `GlobalSpotlight/index.tsx`; no behavior changes.
 */
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type EmbeddedEditorPaletteState,
  type WorkspacePickerMode,
  getEditorPaletteMode,
} from "../../globalSpotlight.helpers";
import type {
  BranchPaletteMode,
  WorktreePaletteMode,
} from "../../palettes/BranchPalette";
import type { EditorPaletteMode } from "../../palettes/EditorPalette/types";

// ============================================
// Types
// ============================================

interface UseSpotlightOverlayLayersResult {
  workspacePickerMode: WorkspacePickerMode | null;
  setWorkspacePickerMode: Dispatch<SetStateAction<WorkspacePickerMode | null>>;
  embeddedBranchMode: BranchPaletteMode;
  setEmbeddedBranchMode: Dispatch<SetStateAction<BranchPaletteMode>>;
  embeddedWorktreeMode: WorktreePaletteMode;
  setEmbeddedWorktreeMode: Dispatch<SetStateAction<WorktreePaletteMode>>;
  branchPickerOpen: boolean;
  setBranchPickerOpen: Dispatch<SetStateAction<boolean>>;
  worktreePickerOpen: boolean;
  setWorktreePickerOpen: Dispatch<SetStateAction<boolean>>;
  agentSessionSearchOpen: boolean;
  allSessionsSearchOpen: boolean;
  agentControlOpen: boolean;
  sessionCreatorOpen: boolean;
  embeddedEditorPalette: EmbeddedEditorPaletteState | null;
  lastActivatedItemIdRef: RefObject<string | null>;
  pendingRestoreItemId: string | null;
  setPendingRestoreItemId: Dispatch<SetStateAction<string | null>>;
  restoreLastActivatedItem: () => void;
  handleOpenWorkspacePicker: (mode: WorkspacePickerMode) => void;
  handleOpenBranchPicker: () => void;
  handleOpenWorktreePicker: () => void;
  handleOpenAgentSessionSearch: () => void;
  handleOpenAllSessionsSearch: () => void;
  handleOpenAgentControl: () => void;
  handleOpenSessionCreator: () => void;
  handleOpenEditorPalette: (query: string, mode?: EditorPaletteMode) => void;
  handleCloseWorkspacePicker: () => void;
  handleCloseBranchPicker: () => void;
  handleCloseWorktreePicker: () => void;
  handleCloseAgentSessionSearch: () => void;
  handleCloseAllSessionsSearch: () => void;
  handleCloseAgentControl: () => void;
  handleCloseSessionCreator: () => void;
  handleCloseEditorPalette: () => void;
}

// ============================================
// Hook
// ============================================

export function useSpotlightOverlayLayers(
  isOpen: boolean
): UseSpotlightOverlayLayersResult {
  const [workspacePickerMode, setWorkspacePickerMode] =
    useState<WorkspacePickerMode | null>(null);
  const [embeddedBranchMode, setEmbeddedBranchMode] =
    useState<BranchPaletteMode>("checkout");
  const [embeddedWorktreeMode, setEmbeddedWorktreeMode] =
    useState<WorktreePaletteMode>("switch");
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  const [agentSessionSearchOpen, setAgentSessionSearchOpen] = useState(false);
  const [allSessionsSearchOpen, setAllSessionsSearchOpen] = useState(false);
  const [agentControlOpen, setAgentControlOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpen] = useState(false);
  const [embeddedEditorPalette, setEmbeddedEditorPalette] =
    useState<EmbeddedEditorPaletteState | null>(null);
  const lastActivatedItemIdRef = useRef<string | null>(null);
  const [pendingRestoreItemId, setPendingRestoreItemId] = useState<
    string | null
  >(null);

  const handleOpenWorkspacePicker = useCallback((mode: WorkspacePickerMode) => {
    setWorkspacePickerMode(mode);
  }, []);

  const handleOpenBranchPicker = useCallback(() => {
    setBranchPickerOpen(true);
  }, []);

  const handleOpenWorktreePicker = useCallback(() => {
    setEmbeddedWorktreeMode("switch");
    setWorktreePickerOpen(true);
  }, []);

  const handleOpenAgentSessionSearch = useCallback(() => {
    setAgentSessionSearchOpen(true);
  }, []);

  const handleOpenAllSessionsSearch = useCallback(() => {
    setAllSessionsSearchOpen(true);
  }, []);

  const handleOpenAgentControl = useCallback(() => {
    setAgentControlOpen(true);
  }, []);

  const handleOpenSessionCreator = useCallback(() => {
    setSessionCreatorOpen(true);
  }, []);

  const handleOpenEditorPalette = useCallback(
    (query: string, mode?: EditorPaletteMode) => {
      setEmbeddedEditorPalette({
        mode: mode ?? getEditorPaletteMode(query),
        query,
      });
    },
    []
  );

  const restoreLastActivatedItem = useCallback(() => {
    setPendingRestoreItemId(lastActivatedItemIdRef.current);
  }, []);

  const handleCloseWorkspacePicker = useCallback(() => {
    setWorkspacePickerMode(null);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseBranchPicker = useCallback(() => {
    setBranchPickerOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseWorktreePicker = useCallback(() => {
    setWorktreePickerOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseAgentSessionSearch = useCallback(() => {
    setAgentSessionSearchOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseAllSessionsSearch = useCallback(() => {
    setAllSessionsSearchOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseAgentControl = useCallback(() => {
    setAgentControlOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseSessionCreator = useCallback(() => {
    setSessionCreatorOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseEditorPalette = useCallback(() => {
    setEmbeddedEditorPalette(null);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  useEffect(() => {
    if (isOpen) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setWorkspacePickerMode(null);
      setBranchPickerOpen(false);
      setWorktreePickerOpen(false);
      setAgentSessionSearchOpen(false);
      setAllSessionsSearchOpen(false);
      setAgentControlOpen(false);
      setSessionCreatorOpen(false);
      setEmbeddedEditorPalette(null);
      lastActivatedItemIdRef.current = null;
      setPendingRestoreItemId(null);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  return {
    workspacePickerMode,
    setWorkspacePickerMode,
    embeddedBranchMode,
    setEmbeddedBranchMode,
    embeddedWorktreeMode,
    setEmbeddedWorktreeMode,
    branchPickerOpen,
    setBranchPickerOpen,
    worktreePickerOpen,
    setWorktreePickerOpen,
    agentSessionSearchOpen,
    allSessionsSearchOpen,
    agentControlOpen,
    sessionCreatorOpen,
    embeddedEditorPalette,
    lastActivatedItemIdRef,
    pendingRestoreItemId,
    setPendingRestoreItemId,
    restoreLastActivatedItem,
    handleOpenWorkspacePicker,
    handleOpenBranchPicker,
    handleOpenWorktreePicker,
    handleOpenAgentSessionSearch,
    handleOpenAllSessionsSearch,
    handleOpenAgentControl,
    handleOpenSessionCreator,
    handleOpenEditorPalette,
    handleCloseWorkspacePicker,
    handleCloseBranchPicker,
    handleCloseWorktreePicker,
    handleCloseAgentSessionSearch,
    handleCloseAllSessionsSearch,
    handleCloseAgentControl,
    handleCloseSessionCreator,
    handleCloseEditorPalette,
  };
}
