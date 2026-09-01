/**
 * useEditorPalette Hook
 *
 * Main orchestration hook for EditorPalette - combines all mode-specific hooks
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystem } from "@src/ActionSystem";
import { ROUTES } from "@src/config/routes";
import { FileOperationsService } from "@src/services/file";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { activeWorkStationFilePathAtom } from "@src/store/workstation/tabs";

import type { SpotlightItem } from "../../../shared";
import type { EditorPaletteMode, EditorPaletteState } from "../types";
import { useCommandMode } from "./useCommandMode";
import { useFileMode } from "./useFileMode";
import { useSpotlightMode } from "./useSpotlightMode";
import { useSymbolMode } from "./useSymbolMode";

interface UseEditorPaletteOptions {
  repoPath: string;
  initialMode?: EditorPaletteMode;
  initialQuery?: string;
  isOpen: boolean;
  /** Callback when spotlight should close */
  onClose?: () => void;
}

interface UseEditorPaletteReturn {
  state: EditorPaletteState;
  handleQueryChange: (query: string) => void;
  handleItemSelect: (item: SpotlightItem) => void;
}

/**
 * Main hook to orchestrate EditorPalette functionality
 */
export function useEditorPalette({
  repoPath,
  initialMode = "file",
  initialQuery = "",
  isOpen,
  onClose,
}: UseEditorPaletteOptions): UseEditorPaletteReturn {
  const navigate = useNavigate();
  const [query, setQuery] = useState(initialQuery);
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  const [prevInitialQuery, setPrevInitialQuery] = useState(initialQuery);

  if (isOpen && !prevIsOpen) {
    setQuery(initialQuery);
    setPrevIsOpen(isOpen);
    setPrevInitialQuery(initialQuery);
  } else if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
  } else if (isOpen && initialQuery !== prevInitialQuery) {
    // Re-apply when caller pushes a new prefix while the palette is open
    // (e.g. Cmd+Shift+P while editor-spotlight is already visible).
    setQuery(initialQuery);
    setPrevInitialQuery(initialQuery);
  }

  const currentFile = useAtomValue(activeWorkStationFilePathAtom);
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const currentRepo = useMemo(
    () =>
      activeWorkspaceRoot
        ? {
            name: activeWorkspaceRoot.name,
            path: activeWorkspaceRoot.path,
          }
        : null,
    [activeWorkspaceRoot]
  );

  // Get dispatch for actions
  const { dispatch, isValidAction } = useActionSystem();

  const navigateToCodeEditor = useCallback(() => {
    if (window.location.pathname === ROUTES.workStation.code.path) return;
    navigate(ROUTES.workStation.code.path);
  }, [navigate]);

  const handleFileOpen = useCallback(
    async (path: string) => {
      onClose?.();

      if (isValidAction(ACTION_ID.FILE_OPEN_DIRECT)) {
        const result = await dispatch(
          ACTION_ID.FILE_OPEN_DIRECT,
          { path },
          "user"
        );
        if (result.success) {
          navigateToCodeEditor();
          return;
        }
      }

      const result = await FileOperationsService.open(path);
      if (result.success) {
        navigateToCodeEditor();
      }
    },
    [dispatch, isValidAction, navigateToCodeEditor, onClose]
  );

  // Callback for symbol selection (navigate to line in current file)
  const handleSymbolSelect = useCallback(
    (line: number) => {
      dispatch(ACTION_ID.EDITOR_GO_TO_LINE, { line }, "user");
      onClose?.();
    },
    [dispatch, onClose]
  );

  // Detect mode from query
  const { mode, searchTerm } = useSpotlightMode(query, initialMode);

  // Mode-specific hooks
  const fileMode = useFileMode({
    repoPath,
    searchTerm,
    enabled: isOpen && mode === "file",
    currentRepo,
    workspaceFolders,
    onFileOpen: handleFileOpen,
  });

  const commandMode = useCommandMode({
    enabled: isOpen && mode === "command",
  });

  const symbolMode = useSymbolMode({
    searchTerm,
    enabled: isOpen && mode === "symbol",
    currentFile,
    onSymbolSelect: handleSymbolSelect,
  });

  // Select items based on current mode
  let items: SpotlightItem[] = [];
  let isLoading = false;

  switch (mode) {
    case "file":
      items = fileMode.items;
      isLoading = fileMode.isLoading;
      break;
    case "command":
      items = commandMode.items;
      isLoading = commandMode.isLoading;
      break;
    case "symbol":
      items = symbolMode.items;
      isLoading = symbolMode.isLoading;
      break;
  }

  const state: EditorPaletteState = {
    isOpen,
    mode,
    query,
    searchTerm,
    items,
    isLoading,
  };

  const handleQueryChange = useCallback((newQuery: string) => {
    setQuery(newQuery);
  }, []);

  const handleItemSelect = useCallback((item: SpotlightItem) => {
    if (item.action) {
      item.action();
    }
  }, []);

  return {
    state,
    handleQueryChange,
    handleItemSelect,
  };
}

export default useEditorPalette;
