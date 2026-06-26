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
import { cleanupPtyListeners, clearInitTimeout } from "./terminalLifecycle";
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
      nameOverride,
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
    const initTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
      async (cols: number, rows: number) => {
        await initPtyConnection({
          cols,
          rows,
          sessionKey,
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
          nameOverride,
          onSessionInfoReady,
          setIsBrowserMode,
          setIsConnecting,
        });
      },
      // repoPath and onSessionInfoReady use refs / mount-time semantics; avoid
      // reinitializing xterm for parent callback identity changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [
        sessionKey,
        customShellPath,
        shellType,
        shellOverride,
        argsOverride,
        envOverride,
        nameOverride,
      ]
    );

    useEffect(() => {
      if (!containerRef.current || terminalRef.current) return;

      const { terminal, fitAddon, searchAddon, serializeAddon } =
        createTerminalInstance({
          terminalTheme: initialThemeRef.current || terminalTheme,
          terminalFontSize,
          terminalLetterSpacing,
          codeFontFamily,
          shellIntegration,
        });

      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      serializeAddonRef.current = serializeAddon;

      initializeWhenContainerVisible({
        containerRef,
        initTimeoutRef,
        terminal,
        fitTerminal,
        initPty: initPTY,
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
        clearInitTimeout(initTimeoutRef);
        cleanupTerminalHandlers();

        if (webglAddonRef.current) {
          webglAddonRef.current.dispose();
          webglAddonRef.current = null;
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

    useEffect(() => {
      return () => {
        cleanupPtyListeners({
          unlistenOutputRef,
          unlistenExitRef,
        });
      };
    }, []);

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
    });

    return (
      <div className="xterm-terminal-view">
        <div ref={containerRef} className="xterm-terminal-container" />
      </div>
    );
  }
);
