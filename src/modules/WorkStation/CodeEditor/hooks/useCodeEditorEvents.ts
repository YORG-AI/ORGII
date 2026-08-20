/**
 * useCodeEditorEvents Hook
 *
 * Consolidates all document-level event listeners for CodeEditor into a single hook.
 * This reduces memory overhead and cleanup complexity from having 5+ separate useEffects.
 *
 * Events handled:
 * - Keyboard shortcuts (Cmd+P, Cmd+Shift+P, Cmd+Shift+F, Cmd+B)
 *   → Search shortcut opens the Search sidebar; sidebar shortcut toggles the primary sidebar.
 * - file-pill-click - Navigate to file from pills in chat
 * - terminal-pill-click - Open terminal content tab from clicking terminal pill
 * - open-file-in-editor - Open file from markdown code blocks
 * - open-source-control - Drive the unified Source Control tab into All Changes mode
 * - workstation-open-code-tab - Focus a pinned Code Editor tab from global shortcuts
 * - close-all-tabs - Close all editor tabs
 */
import { exists } from "@tauri-apps/plugin-fs";
import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import { listSessionWorkspace } from "@src/api/tauri/agent/sessionWorkspace";
import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import { createEditorSpotlightRequest } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { FileOperationsService } from "@src/services/file/FileOperationsService";
import { PanelService } from "@src/services/panel";
import { TerminalService } from "@src/services/terminal";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  spotlightInitialQueryAtom,
  spotlightOpenAtom,
} from "@src/store/ui/uiAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import {
  type PanelState,
  consumePendingCodeEditorTab,
  consumePendingFileOpens,
  createDirectoryTab,
  createDomComponentPreviewTab,
  createFileTab,
  createTerminalContentTab,
  openTab,
  presentedWorkstationWorkspaceKeyAtom,
  switchTab,
} from "@src/store/workstation/tabs";
import type { GitFile } from "@src/types/git/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  buildCandidateRoots,
  isUnderAnyRoot,
  resolveFileAgainstRoots,
} from "./resolveFileAgainstRoots";

// ============================================
// Types
// ============================================

export interface CodeEditorEventsOptions {
  /** Repository path for file resolution */
  repoPath: string;
  /** Setter for primary panel state */
  setPrimaryPanel: (updater: (prev: PanelState) => PanelState) => void;
  /** Current selected file path */
  selectedFile: string | null;
  /** Select file in file tree */
  selectFile: (path: string) => void;
  /** Whether Code Editor is the active Workstation app */
  isActive?: boolean;
  /** Git diff state handlers */
  gitDiffState: {
    setFiles: (files: Map<string, GitFile>, scopeRepoRoot?: string) => void;
    addTab: (tabId: string) => void;
  };
}

// ============================================
// Hook Implementation
// ============================================

export function useCodeEditorEvents(options: CodeEditorEventsOptions): void {
  const {
    repoPath,
    setPrimaryPanel,
    selectedFile,
    selectFile,
    gitDiffState,
    isActive = true,
  } = options;

  // Create stable references for options that might change
  const optionsRef = useRef(options);

  // Update ref in effect to avoid "cannot access refs during render" error
  useEffect(() => {
    optionsRef.current = options;
  });

  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);
  const setSpotlightInitialQuery = useSetAtom(spotlightInitialQueryAtom);

  const openEditorSpotlightRef = useRef((initialQuery = "") => {
    setSpotlightInitialQuery(createEditorSpotlightRequest(initialQuery));
    setSpotlightOpen(true);
  });
  const openRegularSpotlightRef = useRef(() => {
    setSpotlightInitialQuery(null);
    setSpotlightOpen(true);
  });

  useEffect(() => {
    openEditorSpotlightRef.current = (initialQuery = "") => {
      setSpotlightInitialQuery(createEditorSpotlightRequest(initialQuery));
      setSpotlightOpen(true);
    };
    openRegularSpotlightRef.current = () => {
      setSpotlightInitialQuery(null);
      setSpotlightOpen(true);
    };
  }, [setSpotlightInitialQuery, setSpotlightOpen]);

  // Consolidated event listener
  useEffect(() => {
    const opts = optionsRef.current;

    const focusCodeEditor = () => {
      const store = getInstrumentedStore();
      store.set(stationModeAtom, "my-station");
      window.dispatchEvent(
        new CustomEvent("action-system-navigate", {
          detail: { path: ROUTES.workStation.code.path },
        })
      );
    };

    const switchPrimaryTab = (tabId: string) => {
      opts.setPrimaryPanel((prev) => switchTab(prev, tabId));
    };

    // ============================================
    // Multi-root file resolution for chat references
    // ============================================
    // Relative paths in agent messages are relative to the SESSION's
    // workspace, not necessarily the folder the file tree shows. Build
    // the ordered candidate roots at click time (session root →
    // session additional dirs → active WorkStation root → other IDE
    // folders) and probe for existence. See resolveFileAgainstRoots.ts.
    const gatherCandidateRoots = async (): Promise<string[]> => {
      const store = getInstrumentedStore();
      const activeSessionId = store.get(workstationActiveSessionIdAtom);
      const session = activeSessionId
        ? store.get(sessionsAtom).find((s) => s.session_id === activeSessionId)
        : undefined;

      // Additional directories live in the session runtime; the lookup
      // fails for historical/idle sessions — that's fine, the session
      // root + IDE folders still cover the common cases.
      let additionalDirs: string[] = [];
      if (activeSessionId) {
        try {
          const workspace = await listSessionWorkspace(activeSessionId);
          additionalDirs = workspace.additionalDirectories.map(
            (dir) => dir.path
          );
        } catch {
          additionalDirs = [];
        }
      }

      return buildCandidateRoots({
        sessionRepoPath: session?.repoPath,
        sessionAdditionalDirs: additionalDirs,
        activeRootPath: optionsRef.current.repoPath,
        workspaceFolderPaths: store
          .get(workspaceFoldersAtom)
          .map((folder) => folder.path),
      });
    };

    const resolveChatFilePath = async (
      rawPath: string
    ): Promise<{ absolutePath: string; roots: string[] }> => {
      const roots = await gatherCandidateRoots();
      if (rawPath.startsWith("/")) {
        return { absolutePath: rawPath, roots };
      }
      const resolved = await resolveFileAgainstRoots(rawPath, roots, exists);
      // No root contains the file: fall back to the legacy join so the
      // editor surfaces its normal "Unable to locate the file" view
      // instead of silently doing nothing.
      return {
        absolutePath:
          resolved ??
          `${optionsRef.current.repoPath}/${rawPath.replace(/^\.\//, "")}`,
        roots,
      };
    };

    // ============================================
    // Keyboard Shortcuts
    // ============================================
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!optionsRef.current.isActive) return;

      const isModKey = event.metaKey || event.ctrlKey;

      if (isModKey && event.key === "p" && !event.shiftKey) {
        event.preventDefault();
        openEditorSpotlightRef.current("");
        return;
      }

      if (isModKey && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        openRegularSpotlightRef.current();
        return;
      }

      if (isModKey && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        void WorkStationViewService.openSearchSidebar();
        return;
      }

      if (isModKey && event.key === "b") {
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        PanelService.togglePrimarySidebar();
      }
    };

    // ============================================
    // File Pill Click (from chat pills)
    // ============================================
    const handleFilePillClick = (event: Event) => {
      const customEvent = event as CustomEvent<{
        filePath: string;
        fileName: string;
        lineStart?: number;
        lineEnd?: number;
        isFolder?: boolean;
      }>;
      const { filePath, lineStart, isFolder } = customEvent.detail;

      if (isFolder) return;

      void (async () => {
        const { absolutePath, roots } = await resolveChatFilePath(filePath);

        // Absolute paths outside every known root belong to another
        // checkout entirely — hand off to VS Code like before.
        if (!isUnderAnyRoot(absolutePath, roots)) {
          const lineParam = lineStart ? `:${lineStart}` : "";
          window.location.href = `vscode://file${absolutePath}${lineParam}`;
          return;
        }

        focusCodeEditor();

        if (optionsRef.current.selectedFile === absolutePath) return;

        optionsRef.current.selectFile(absolutePath);

        const tab = createFileTab(absolutePath);
        optionsRef.current.setPrimaryPanel((prev) => openTab(prev, tab));
      })();
    };

    // ============================================
    // Terminal Pill Click (open terminal content tab)
    // ============================================
    const handleTerminalPillClick = (event: Event) => {
      const customEvent = event as CustomEvent<{
        sessionId: string;
        fileName: string;
        terminalText?: string;
      }>;
      const { sessionId, fileName, terminalText } = customEvent.detail;

      if (!terminalText) {
        const sessions = TerminalService.getSessions();
        const sessionExists = sessions.some((s) => s.id === sessionId);
        if (sessionExists) {
          TerminalService.setActive(sessionId);
          // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
          // PanelService.showBottomPanel("terminal");
          void WorkStationViewService.openTerminalTab();
        } else {
          const nameOnly = fileName.replace(/\s*\(\d+(?:-\d+)?\)\s*$/, "");
          const matchByName = sessions.find((s) => s.name === nameOnly);
          if (matchByName) {
            TerminalService.setActive(matchByName.id);
            // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
            // PanelService.showBottomPanel("terminal");
            void WorkStationViewService.openTerminalTab();
          } else if (sessions.length > 0) {
            // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
            // PanelService.showBottomPanel("terminal");
            void WorkStationViewService.openTerminalTab();
          } else {
            Message.info("Terminal session is no longer available");
          }
        }
        return;
      }

      const tab = createTerminalContentTab(fileName, terminalText, sessionId);
      opts.setPrimaryPanel((prev) => openTab(prev, tab));
    };

    // ============================================
    // DOM Component Preview Pill Click (paste pill → Raw / Preview viewer)
    // ============================================
    const handleDomComponentPreviewClick = (event: Event) => {
      const customEvent = event as CustomEvent<{
        pasteId: string;
        fileName: string;
        jsonText: string;
      }>;
      const { pasteId, fileName, jsonText } = customEvent.detail;
      if (!pasteId) return;

      focusCodeEditor();

      const tab = createDomComponentPreviewTab(
        pasteId,
        fileName || "Pasted JSON",
        jsonText ?? ""
      );
      opts.setPrimaryPanel((prev) => openTab(prev, tab));
    };

    // ============================================
    // Open File in Editor (from markdown code blocks or cross-window Tauri events)
    // ============================================
    const openFileTab = (
      path: string,
      isDirectory?: boolean,
      line?: number
    ) => {
      if (!path) return;

      void (async () => {
        const absolutePath = path.startsWith("/")
          ? path
          : (await resolveChatFilePath(path)).absolutePath;

        focusCodeEditor();

        if (isDirectory || path.endsWith("/")) {
          PanelService.showPrimarySidebar("files");
          void FileOperationsService.reveal(absolutePath, {
            expandTargetDirectory: true,
          });
          const tab = createDirectoryTab(absolutePath.replace(/\/+$/, ""));
          optionsRef.current.setPrimaryPanel((prev) => openTab(prev, tab));
          return;
        }

        const tab = createFileTab(absolutePath, line);
        optionsRef.current.setPrimaryPanel((prev) => openTab(prev, tab));
        optionsRef.current.selectFile(absolutePath);
      })();
    };

    const handleOpenFileInEditor = (event: Event) => {
      const customEvent = event as CustomEvent<{
        path: string;
        isDirectory?: boolean;
        line?: number;
      }>;
      const { path, isDirectory, line } = customEvent.detail || {};
      openFileTab(path, isDirectory, line);
    };

    // ============================================
    // Open Source Control (All Changes mode)
    // ============================================
    // Drives the pinned `source-control` tab into All Changes mode — never
    // spawns a new tab, since the Source Control tab is non-closable and
    // always present.
    const handleOpenSourceControl = (event: Event) => {
      const customEvent = event as CustomEvent<{
        staged: boolean;
        files: Array<{
          id: string;
          path: string;
          status: string;
          staged: boolean;
          oldContent?: string;
          newContent?: string;
          additions?: number;
          deletions?: number;
        }>;
      }>;
      const { staged, files } = customEvent.detail || {};

      if (!files || files.length === 0) return;

      opts.setPrimaryPanel((prev) => {
        const tabIndex = prev.tabs.findIndex(
          (item) => item.type === "source-control"
        );
        if (tabIndex === -1) return prev;
        const existing = prev.tabs[tabIndex];
        const nextTabs = [...prev.tabs];
        nextTabs[tabIndex] = {
          ...existing,
          data: {
            ...existing.data,
            mode: "all-changes",
            staged,
            fileCount: files.length,
          },
        };
        return { tabs: nextTabs, activeTabId: existing.id };
      });

      const filesMap = new Map(
        files.map((file) => {
          const absolutePath = file.path.startsWith("/")
            ? file.path
            : `${opts.repoPath}/${file.path}`;
          return [absolutePath, { ...file, path: absolutePath } as never];
        })
      );
      // Scope to host repo so worktree-injected entries are not wiped.
      opts.gitDiffState.setFiles(filesMap, opts.repoPath);

      const tabId = staged ? "source-control:staged" : "source-control:changes";
      opts.gitDiffState.addTab(tabId);
    };

    const handleOpenCodeTab = (event: Event) => {
      const customEvent = event as CustomEvent<{ tabId?: string }>;
      const tabId = customEvent.detail?.tabId;
      if (!tabId) return;
      const workspace = getInstrumentedStore().get(
        presentedWorkstationWorkspaceKeyAtom
      );
      consumePendingCodeEditorTab(workspace);
      switchPrimaryTab(tabId);
    };

    // ============================================
    // Close All Tabs
    // ============================================
    const handleCloseAllTabs = () => {
      opts.setPrimaryPanel(() => ({ tabs: [], activeTabId: null }));
    };

    // ============================================
    // Register All Listeners
    // ============================================
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("file-pill-click", handleFilePillClick);
    document.addEventListener("terminal-pill-click", handleTerminalPillClick);
    document.addEventListener(
      "dom-component-preview-click",
      handleDomComponentPreviewClick
    );
    document.addEventListener("open-file-in-editor", handleOpenFileInEditor);
    document.addEventListener("open-source-control", handleOpenSourceControl);
    window.addEventListener("workstation-open-code-tab", handleOpenCodeTab);
    window.addEventListener("close-all-tabs", handleCloseAllTabs);

    // Consume only the files queued for the workspace captured by the producer.
    const workspace = getInstrumentedStore().get(
      presentedWorkstationWorkspaceKeyAtom
    );
    const pendingFiles = consumePendingFileOpens(workspace);
    if (pendingFiles.length > 0) {
      for (const { path, line } of pendingFiles) {
        const tab = createFileTab(path, line);
        opts.setPrimaryPanel((prev) => openTab(prev, tab));
      }
      opts.selectFile(pendingFiles[pendingFiles.length - 1].path);
    }

    const pendingCodeTabId = consumePendingCodeEditorTab(workspace);
    if (pendingCodeTabId) {
      switchPrimaryTab(pendingCodeTabId);
    }

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("file-pill-click", handleFilePillClick);
      document.removeEventListener(
        "terminal-pill-click",
        handleTerminalPillClick
      );
      document.removeEventListener(
        "dom-component-preview-click",
        handleDomComponentPreviewClick
      );
      document.removeEventListener(
        "open-file-in-editor",
        handleOpenFileInEditor
      );
      document.removeEventListener(
        "open-source-control",
        handleOpenSourceControl
      );
      window.removeEventListener(
        "workstation-open-code-tab",
        handleOpenCodeTab
      );
      window.removeEventListener("close-all-tabs", handleCloseAllTabs);
    };
  }, [
    repoPath,
    setPrimaryPanel,
    selectedFile,
    selectFile,
    gitDiffState,
    isActive,
  ]);
}
