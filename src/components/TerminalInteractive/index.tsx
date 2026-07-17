/**
 * Terminal View Component
 * Uses native XTerm.js with WebGL addon for better rendering in portal contexts
 * Integrates with Tauri PTY for real terminal functionality
 *
 * WARNING: Keep xterm mount lifecycle dependency stability in mind when editing.
 *
 * The initPTY logic, fit handling, and xterm mount lifecycle are intentionally
 * co-located in a single useEffect. Extracting them into separate useCallback
 * hooks exposes inline callback props (onSessionInfoReady, etc.) as unstable
 * deps, which causes useTerminalXtermMount to destroy and recreate the
 * terminal on every parent re-render — producing the xterm renderer crash
 * ("this._renderer.value.dimensions") and cascading WebGL context exhaustion
 * that breaks the glass toolbar.
 *
 * History: reverted extraction in 2eb32a6c7 (Mar 2026) after it broke
 * terminal rendering and glass styles within hours.
 */
import { type FitAddon } from "@xterm/addon-fit";
import { type SearchAddon } from "@xterm/addon-search";
import { type SerializeAddon } from "@xterm/addon-serialize";
import { type WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useAtomValue } from "jotai";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { isThemeCssPathDark } from "@src/config/appearance/globalThemes";
import {
  customShellPathAtom,
  resolvedTerminalFontFamilyAtom,
  shellTypeAtom,
} from "@src/store/ui/editorSettingsAtom";
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → this file.
import {
  TerminalThemeName,
  terminalFontSizeAtom,
  terminalLetterSpacingAtom,
  terminalThemeAtom,
  themesAtom,
} from "@src/store/ui/uiAtom";

import { clearTerminalBufferCache } from "./bufferCache";
import "./index.scss";
import { registerTerminalEventHandlers } from "./terminalHandlers";
import { cleanupPtyListeners } from "./terminalLifecycle";
import { flushBacklog, setPaneForeground } from "./terminalOutputScheduler";
import { initPtyConnection } from "./terminalPty";
import {
  createTerminalInstance,
  initializeWhenContainerVisible,
  loadTerminalWebgl,
} from "./terminalSetup";
import {
  createFitTerminal,
  createRedrawTerminalAfterLayoutChange,
} from "./terminalSizing";
import type { TerminalViewHandle, TerminalViewProps } from "./types";
import { useTerminalAppearance } from "./useTerminalAppearance";
import { useTerminalResizeListeners } from "./useTerminalResizeListeners";
import { releaseWebglSlot } from "./webglContextManager";

// Re-export types for consumers
export type {
  TerminalFileLinkTarget,
  TerminalViewHandle,
  TerminalViewProps,
} from "./types";

// Re-export buffer cache utilities for consumers
export { clearTerminalBufferCache };

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView(
    {
      sessionKey,
      isForeground = true,
      onSelectionChange,
      onOutput,
      onUserInput,
      repoPath,
      workingDirectory,
      onOpenFileLink,
      onSessionInfoReady,
      onTitleChange,
      shellOverride,
      argsOverride,
      envOverride,
      forceRepoCwd,
      nameOverride,
      backgroundColor,
      shellIntegration,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const unlistenOutputRef = useRef<(() => void) | null>(null);
    const unlistenExitRef = useRef<(() => void) | null>(null);
    const initialThemeRef = useRef<TerminalThemeName | null>(null);
    const repoPathRef = useRef(repoPath);
    repoPathRef.current = repoPath;
    const workingDirectoryRef = useRef(workingDirectory);
    workingDirectoryRef.current = workingDirectory;
    const onOpenFileLinkRef = useRef(onOpenFileLink);
    onOpenFileLinkRef.current = onOpenFileLink;

    const [_isConnecting, setIsConnecting] = useState(true);
    const [_isBrowserMode, setIsBrowserMode] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const terminalTheme = useAtomValue(terminalThemeAtom);
    const terminalFontSize = useAtomValue(terminalFontSizeAtom);
    const terminalLetterSpacing = useAtomValue(terminalLetterSpacingAtom);
    const codeFontFamily = useAtomValue(resolvedTerminalFontFamilyAtom);
    const shellType = useAtomValue(shellTypeAtom);
    const customShellPath = useAtomValue(customShellPathAtom);
    const appTheme = useAtomValue(themesAtom);
    const isDarkTheme = isThemeCssPathDark(appTheme);

    if (initialThemeRef.current === null) {
      initialThemeRef.current = terminalTheme;
    }

    const redrawTerminalAfterLayoutChange = useMemo(
      () =>
        createRedrawTerminalAfterLayoutChange({
          containerRef,
          terminalRef,
          fitAddonRef,
        }),
      []
    );

    const fitTerminal = useMemo(
      () =>
        createFitTerminal({
          containerRef,
          terminalRef,
          fitAddonRef,
        }),
      []
    );

    useImperativeHandle(
      ref,
      () => ({
        findNext: (query, options) => {
          if (!searchAddonRef.current || !query) return false;
          return searchAddonRef.current.findNext(query, {
            caseSensitive: options?.caseSensitive,
            regex: options?.regex,
            wholeWord: options?.wholeWord,
          });
        },
        findPrevious: (query, options) => {
          if (!searchAddonRef.current || !query) return false;
          return searchAddonRef.current.findPrevious(query, {
            caseSensitive: options?.caseSensitive,
            regex: options?.regex,
            wholeWord: options?.wholeWord,
          });
        },
        clearSearch: () => {
          searchAddonRef.current?.clearDecorations();
        },
        focus: () => {
          terminalRef.current?.focus();
        },
        selectAll: () => {
          terminalRef.current?.selectAll();
        },
        redrawAfterShow: redrawTerminalAfterLayoutChange,
      }),
      [redrawTerminalAfterLayoutChange]
    );

    const initPTY = useCallback(
      async (cols: number, rows: number, abortSignal?: AbortSignal) => {
        await initPtyConnection({
          cols,
          rows,
          sessionKey,
          isForeground,
          terminalRef,
          sessionIdRef,
          unlistenOutputRef,
          unlistenExitRef,
          repoPathRef,
          shellType,
          customShellPath,
          shellOverride,
          argsOverride,
          envOverride,
          forceRepoCwd,
          nameOverride,
          onSessionInfoReady,
          setIsBrowserMode,
          setIsConnecting,
          abortSignal,
        });
      },
      // repoPath and onSessionInfoReady use refs / mount-time semantics; avoid
      // reinitializing xterm for parent callback identity changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [
        sessionKey,
        isForeground,
        customShellPath,
        shellType,
        shellOverride,
        argsOverride,
        envOverride,
        forceRepoCwd,
        nameOverride,
      ]
    );

    useEffect(() => {
      if (!containerRef.current || terminalRef.current) return;

      const ptyAbortController = new AbortController();
      const { terminal, fitAddon, searchAddon, serializeAddon } =
        createTerminalInstance({
          terminalTheme: initialThemeRef.current || terminalTheme,
          terminalFontSize,
          terminalLetterSpacing,
          codeFontFamily,
          backgroundColor,
          shellIntegration,
        });

      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      serializeAddonRef.current = serializeAddon;

      const cleanupContainerVisibilityInit = initializeWhenContainerVisible({
        containerRef,
        terminal,
        fitTerminal,
        initPty: (cols, rows) => {
          void initPTY(cols, rows, ptyAbortController.signal);
        },
        loadWebGL: () => loadTerminalWebgl(terminal, webglAddonRef),
        setIsReady,
      });

      const cleanupTerminalHandlers = registerTerminalEventHandlers({
        terminal,
        serializeAddonRef,
        sessionIdRef,
        containerRef,
        repoPathRef,
        workingDirectoryRef,
        onOpenFileLinkRef,
        onOutput,
        onUserInput,
        onSelectionChange,
        onTitleChange,
      });

      return () => {
        ptyAbortController.abort();
        cleanupContainerVisibilityInit();
        cleanupTerminalHandlers();
        cleanupPtyListeners({
          unlistenOutputRef,
          unlistenExitRef,
          sessionIdRef,
        });

        if (webglAddonRef.current) {
          webglAddonRef.current.dispose();
          webglAddonRef.current = null;
          releaseWebglSlot();
        }
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        serializeAddonRef.current = null;
      };
      // Theme and callback props are intentionally omitted to preserve the
      // existing terminal lifetime semantics documented at the top of this file.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitTerminal, initPTY]);

    // Scheduler foreground/background priority and tab-show backlog flush.
    // The sessionId is set during initPtyConnection which runs after mount;
    // we derive it the same way here rather than from the ref to keep this
    // effect's deps clean.
    const schedulerSessionId = `terminal-pty-${sessionKey}`;
    useEffect(() => {
      setPaneForeground(schedulerSessionId, isForeground);

      if (isForeground) {
        // Flush up to 256 KB of queued backlog immediately on tab show
        flushBacklog(schedulerSessionId, 256 * 1024);
      }
    }, [isForeground, schedulerSessionId]);

    useTerminalResizeListeners({
      containerRef,
      fitTerminal,
      redrawTerminalAfterLayoutChange,
      isReady,
      terminalRef,
    });

    useTerminalAppearance({
      terminalRef,
      fitTerminal,
      isReady,
      terminalTheme,
      isDarkTheme,
      terminalFontSize,
      terminalLetterSpacing,
      codeFontFamily,
      backgroundColor,
    });

    const terminalViewStyle = backgroundColor
      ? ({ "--cm-editor-background": backgroundColor } as React.CSSProperties)
      : undefined;

    return (
      <div className="xterm-terminal-view" style={terminalViewStyle}>
        <div ref={containerRef} className="xterm-terminal-container" />
      </div>
    );
  }
);
