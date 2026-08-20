/**
 * useCodeEditorLocalState — Local UI state and status-bar sync for CodeEditor.
 *
 * Extracted to keep CodeEditor/index.tsx under the 600-line limit.
 * Owns: cursor position, total-line count, repo/branch click handlers,
 * diagnostics callbacks, terminal helpers, and both status-bar effects.
 */
import { useTerminalState } from "@/src/engines/TerminalCore/hooks/useTerminalState";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createBranchSpotlightRequest,
  createWorkspaceSpotlightRequest,
  createWorktreeSpotlightRequest,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import {
  spotlightInitialQueryAtom,
  spotlightOpenAtom,
} from "@src/store/ui/uiAtom";
import {
  codeStatusBarCallbacksAtom,
  codeStatusBarStateAtom,
  editorPanelPositionAtom,
  editorPanelPositionPersistAtom,
} from "@src/store/ui/workStationAtom";
import {
  activeWorkStationFilePathAtom,
  activeWorkStationTabAtom,
  createFileTab,
  openTab as openTabHelper,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { PanelState } from "@src/store/workstation/tabs";
import { isPreviewOnlyFile } from "@src/util/file/previewTypes";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type { CommitInfo, CursorPosition, LspStatus } from "../shared";
import { useDiagnostics } from "./hooks/diagnostics/useDiagnostics";
import { useCodeEditor } from "./hooks/useCodeEditor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UseCodeEditorLocalStateOptions {
  repoName: string;
  isActive: boolean;
  currentBranch: string | null | undefined;
  codeEditorState: ReturnType<typeof useCodeEditor>;
  terminalState: ReturnType<typeof useTerminalState>;
  diagnosticsState: ReturnType<typeof useDiagnostics>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCodeEditorLocalState({
  repoName,
  isActive,
  currentBranch,
  codeEditorState,
  terminalState,
  diagnosticsState,
}: UseCodeEditorLocalStateOptions) {
  // ── UI state ──────────────────────────────────────────────────────────────

  const [searchPanelVisible, setSearchPanelVisible] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<CursorPosition | null>(
    null
  );
  const [lspConnected] = useState(true);

  // ── Layout: single main pane ─────────────────────────────────────────────

  const setLayout = useSetAtom(workstationLayoutAtom);

  const setPrimaryPanel = useCallback(
    (updater: unknown) => {
      setLayout((prev) => ({
        ...prev,
        mainPane: (updater as (prev: PanelState) => PanelState)(
          prev?.mainPane ?? { tabs: [], activeTabId: null }
        ),
      }));
    },
    [setLayout]
  );

  // ── Active tab info ───────────────────────────────────────────────────────

  const focusedActiveTab = useAtomValue(activeWorkStationTabAtom);
  const focusedActiveFilePath = useAtomValue(activeWorkStationFilePathAtom);

  const activeCommitSha =
    focusedActiveTab?.type === "git-diff" && focusedActiveTab.data.isTimeline
      ? (focusedActiveTab.data.commitSha as string)
      : null;

  const statusBarCommitInfo: CommitInfo | null = useMemo(() => {
    if (
      focusedActiveTab?.type === "git-diff" &&
      focusedActiveTab.data.isTimeline
    ) {
      const { commitMessage, commitAuthor, commitTimestamp } =
        focusedActiveTab.data;
      if (commitMessage && commitAuthor && commitTimestamp) {
        return {
          message: String(commitMessage),
          author: String(commitAuthor),
          time: formatRelativeTime(String(commitTimestamp), "compact"),
          shortSha: String(focusedActiveTab.data.headShortSha || ""),
        };
      }
    }
    return null;
  }, [focusedActiveTab]);

  const lspStatus = useMemo((): LspStatus | undefined => {
    const file = focusedActiveFilePath;
    if (!file) return undefined;
    const ext = file.split(".").pop()?.toLowerCase();
    const lspLanguages: Record<string, string> = {
      ts: "TS",
      tsx: "TS",
      js: "JS",
      jsx: "JS",
      py: "Python",
      rs: "Rust",
      go: "Go",
    };
    const language = lspLanguages[ext || ""];
    if (!language) return undefined;
    return { connected: lspConnected, language };
  }, [focusedActiveFilePath, lspConnected]);

  // ── Editor position atom ─────────────────────────────────────────────────

  const editorPanelPosition = useAtomValue(editorPanelPositionAtom);
  const setEditorPanelPosition = useSetAtom(editorPanelPositionPersistAtom);

  // ── Repo/branch selector ─────────────────────────────────────────────────

  const setSpotlightInitialQuery = useSetAtom(spotlightInitialQueryAtom);
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);

  const handleRepoClick = useCallback(() => {
    setSpotlightInitialQuery(createWorkspaceSpotlightRequest("switch"));
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  const handleBranchClick = useCallback(() => {
    setSpotlightInitialQuery(createBranchSpotlightRequest());
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  const handleWorktreeClick = useCallback(() => {
    setSpotlightInitialQuery(createWorktreeSpotlightRequest());
    setSpotlightOpen(true);
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  // ── Cursor + total-line tracking ─────────────────────────────────────────

  const handleCursorPositionChange = useCallback(
    (position: CursorPosition | null) => {
      setCursorPosition(position);
    },
    []
  );

  const totalLines = useMemo(
    () =>
      codeEditorState.fileContent
        ? codeEditorState.fileContent.split("\n").length
        : undefined,
    [codeEditorState.fileContent]
  );

  // ── Panel toggle ─────────────────────────────────────────────────────────

  const handleToggleEditorPanelPosition = useCallback(() => {
    setEditorPanelPosition("toggle");
  }, [setEditorPanelPosition]);

  // ── Diagnostics callbacks ────────────────────────────────────────────────

  const lastDiagnosticFileRef = useRef<string | null>(null);

  const handleDiagnosticsChange = useCallback(
    (fileDiagnostics: unknown[]) => {
      const typedDiagnostics = fileDiagnostics as Array<{ filePath?: string }>;
      const filePath = typedDiagnostics[0]?.filePath;

      if (filePath) {
        lastDiagnosticFileRef.current = filePath;
        diagnosticsState.setDiagnosticsForFile(
          filePath,
          fileDiagnostics as never[]
        );
      } else if (fileDiagnostics.length === 0) {
        const fileToClean =
          lastDiagnosticFileRef.current ?? codeEditorState.selectedFile;
        if (fileToClean) {
          diagnosticsState.clearDiagnosticsForFile(fileToClean);
        }
      }
    },
    [diagnosticsState, codeEditorState.selectedFile]
  );

  const handleDiagnosticClick = useCallback(
    (diagnostic: unknown) => {
      const diag = diagnostic as {
        filePath: string;
        line: number;
        column: number;
      };
      if (diag.filePath !== codeEditorState.selectedFile) {
        codeEditorState.selectFile(diag.filePath);
        const tab = createFileTab(diag.filePath);
        setPrimaryPanel((prev: PanelState) => openTabHelper(prev, tab));
      }
    },
    [codeEditorState, setPrimaryPanel]
  );

  const handleSymbolClick = useCallback((line: number) => {
    window.dispatchEvent(
      new CustomEvent("editor-go-to-line", { detail: { line } })
    );
  }, []);

  const handleAllChangesClick = useCallback(() => {
    // TODO: Implement show all changes
  }, []);

  // ── Terminal helpers ──────────────────────────────────────────────────────

  const handleKillTerminal = useCallback(() => {
    if (terminalState.activeSession) {
      terminalState.closeSession(terminalState.activeSession.id);
    }
  }, [terminalState]);

  const handleAddTerminal = useCallback(
    (options?: {
      shell?: string;
      args?: string[];
      name?: string;
      profileId?: string;
    }) => {
      terminalState.addSession(options);
    },
    [terminalState]
  );

  // ── Status bar sync effects ───────────────────────────────────────────────

  const setGlobalStatusBarState = useSetAtom(codeStatusBarStateAtom);
  const setStatusBarCallbacks = useSetAtom(codeStatusBarCallbacksAtom);

  const isPreviewOnly =
    !!focusedActiveFilePath && isPreviewOnlyFile(focusedActiveFilePath);

  useEffect(() => {
    if (!isActive) return;
    setGlobalStatusBarState((prev) => ({
      ...prev,
      appType: "code" as const,
      cursor: focusedActiveFilePath && !isPreviewOnly ? cursorPosition : null,
      filePath: isPreviewOnly ? null : focusedActiveFilePath,
      totalLines:
        focusedActiveFilePath && !isPreviewOnly ? totalLines : undefined,
      repoName,
      branchName: currentBranch || undefined,
      commitInfo: statusBarCommitInfo,
      lspStatus: isPreviewOnly ? undefined : lspStatus,
    }));
  }, [
    cursorPosition,
    focusedActiveFilePath,
    isPreviewOnly,
    totalLines,
    repoName,
    currentBranch,
    statusBarCommitInfo,
    lspStatus,
    isActive,
    setGlobalStatusBarState,
  ]);

  useEffect(() => {
    if (!isActive) return;
    setStatusBarCallbacks((prev) => ({
      ...prev,
      onRepoClick: handleRepoClick,
      onBranchClick: handleBranchClick,
      onWorktreeClick: handleWorktreeClick,
    }));
    return () => {
      setStatusBarCallbacks((prev) => ({
        ...prev,
        onRepoClick: undefined,
        onBranchClick: undefined,
        onWorktreeClick: undefined,
      }));
    };
  }, [
    handleRepoClick,
    handleBranchClick,
    handleWorktreeClick,
    isActive,
    setStatusBarCallbacks,
  ]);

  return {
    // State
    searchPanelVisible,
    setSearchPanelVisible,
    cursorPosition,
    // Layout
    setPrimaryPanel,
    // Tab info
    activeCommitSha,
    focusedActiveFilePath,
    focusedActiveTab,
    // Panel
    editorPanelPosition,
    // Handlers
    handleRepoClick,
    handleBranchClick,
    handleWorktreeClick,
    handleCursorPositionChange,
    handleToggleEditorPanelPosition,
    handleDiagnosticsChange,
    handleDiagnosticClick,
    handleSymbolClick,
    handleAllChangesClick,
    handleKillTerminal,
    handleAddTerminal,
  };
}
