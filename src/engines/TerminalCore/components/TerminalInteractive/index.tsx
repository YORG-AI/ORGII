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
  activeSkinIdAtom,
  primaryColorPresetAtom,
  terminalFontSizeAtom,
  terminalLetterSpacingAtom,
  terminalThemeAtom,
  themesAtom,
} from "@src/store/ui/uiAtom";

import "./index.scss";
import { registerTerminalEventHandlers } from "./terminalHandlers";
import { cleanupPtyListeners } from "./terminalLifecycle";
import { flushBacklog, setPaneForeground } from "./terminalOutputScheduler";
import { initPtyConnection } from "./terminalPty";
import { cancelRenderSettle } from "./terminalRenderSettle";
import {
  createTerminalInstance,
  initializeWhenContainerVisible,
} from "./terminalSetup";
import {
  createFitTerminal,
  createRedrawTerminalAfterLayoutChange,
} from "./terminalSizing";
import {
  type TerminalWebglController,
  createTerminalWebglController,
} from "./terminalWebglLifecycle";
import type { TerminalViewHandle, TerminalViewProps } from "./types";
import { useTerminalAppearance } from "./useTerminalAppearance";
import { useTerminalResizeListeners } from "./useTerminalResizeListeners";

// Re-export types for consumers
export type { TerminalFileLinkTarget, TerminalViewHandle } from "./types";

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
      fontSize,
      shellIntegration,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const webglControllerRef = useRef<TerminalWebglController | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const serializeAddonRef = useRef<SerializeAddon | null>(null);
    const sessionIdRef = useRef<string | null>(null);
    const unlistenOutputRef = useRef<(() => void) | null>(null);
    const unlistenExitRef = useRef<(() => void) | null>(null);
    const repoPathRef = useRef(repoPath);
    const workingDirectoryRef = useRef(workingDirectory);
    const onOpenFileLinkRef = useRef(onOpenFileLink);
    const onSessionInfoReadyRef = useRef(onSessionInfoReady);
    const eventCallbacksRef = useRef({
      onOutput,
      onUserInput,
      onSelectionChange,
      onTitleChange,
    });
    const shellIntegrationRef = useRef(shellIntegration);

    const [_isConnecting, setIsConnecting] = useState(true);
    const [_isBrowserMode, setIsBrowserMode] = useState(false);
    const [isReady, setIsReady] = useState(false);
    const terminalTheme = useAtomValue(terminalThemeAtom);
    const configuredFontSize = useAtomValue(terminalFontSizeAtom);
    const terminalFontSize = fontSize ?? configuredFontSize;
    const terminalLetterSpacing = useAtomValue(terminalLetterSpacingAtom);
    const codeFontFamily = useAtomValue(resolvedTerminalFontFamilyAtom);
    const shellType = useAtomValue(shellTypeAtom);
    const customShellPath = useAtomValue(customShellPathAtom);
    const appTheme = useAtomValue(themesAtom);
    const isDarkTheme = isThemeCssPathDark(appTheme);
    // The cursor color comes from --terminal-caret (an alias of
    // --color-primary-6); tracking the preset re-resolves it on accent change.
    const primaryColorPreset = useAtomValue(primaryColorPresetAtom);
    const activeSkinId = useAtomValue(activeSkinIdAtom);

    const initialAppearanceRef = useRef({
      terminalTheme,
      terminalFontSize,
      terminalLetterSpacing,
      codeFontFamily,
      backgroundColor,
    });
    const shellIntegrationEnabled = shellIntegration !== undefined;

    useEffect(() => {
      repoPathRef.current = repoPath;
      workingDirectoryRef.current = workingDirectory;
      onOpenFileLinkRef.current = onOpenFileLink;
      onSessionInfoReadyRef.current = onSessionInfoReady;
      eventCallbacksRef.current = {
        onOutput,
        onUserInput,
        onSelectionChange,
        onTitleChange,
      };
      shellIntegrationRef.current = shellIntegration;
    }, [
      repoPath,
      workingDirectory,
      onOpenFileLink,
      onSessionInfoReady,
      onOutput,
      onUserInput,
      onSelectionChange,
      onTitleChange,
      shellIntegration,
    ]);

    const redrawTerminalAfterLayoutChange = useCallback(() => {
      createRedrawTerminalAfterLayoutChange({
        containerRef,
        terminalRef,
        fitAddonRef,
      })();
    }, []);

    const fitTerminal = useCallback(() => {
      createFitTerminal({
        containerRef,
        terminalRef,
        fitAddonRef,
      })();
    }, []);

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
          onSessionInfoReady: (info) => onSessionInfoReadyRef.current?.(info),
          setIsBrowserMode,
          setIsConnecting,
          abortSignal,
        });
      },
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
      const initialAppearance = initialAppearanceRef.current;
      const { terminal, fitAddon, searchAddon, serializeAddon } =
        createTerminalInstance({
          terminalTheme: initialAppearance.terminalTheme,
          terminalFontSize: initialAppearance.terminalFontSize,
          terminalLetterSpacing: initialAppearance.terminalLetterSpacing,
          codeFontFamily: initialAppearance.codeFontFamily,
          backgroundColor: initialAppearance.backgroundColor,
          shellIntegration: shellIntegrationEnabled
            ? {
                onPromptStart: () =>
                  shellIntegrationRef.current?.onPromptStart?.(),
                onCommandExecuted: (commandLine) =>
                  shellIntegrationRef.current?.onCommandExecuted?.(commandLine),
                onCommandFinished: (exitCode) =>
                  shellIntegrationRef.current?.onCommandFinished?.(exitCode),
                onCwdChanged: (cwd) =>
                  shellIntegrationRef.current?.onCwdChanged?.(cwd),
              }
            : undefined,
        });

      terminal.open(containerRef.current);

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;
      serializeAddonRef.current = serializeAddon;

      const webglController = createTerminalWebglController(
        terminal,
        webglAddonRef
      );
      webglControllerRef.current = webglController;

      const cleanupContainerVisibilityInit = initializeWhenContainerVisible({
        containerRef,
        terminal,
        fitTerminal,
        initPty: (cols, rows) => {
          void initPTY(cols, rows, ptyAbortController.signal);
        },
        loadWebGL: () => webglController.attach(),
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
        onOutput: () => eventCallbacksRef.current.onOutput?.(),
        onUserInput: () => eventCallbacksRef.current.onUserInput?.(),
        onSelectionChange: (selection) =>
          eventCallbacksRef.current.onSelectionChange?.(selection),
        onTitleChange: (title) =>
          eventCallbacksRef.current.onTitleChange?.(title),
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

        webglController.dispose();
        webglControllerRef.current = null;
        cancelRenderSettle(terminal);
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        serializeAddonRef.current = null;
      };
    }, [fitTerminal, initPTY, shellIntegrationEnabled]);

    // Scheduler foreground/background priority and tab-show backlog flush.
    // The sessionId is set during initPtyConnection which runs after mount;
    // we derive it the same way here rather than from the ref to keep this
    // effect's deps clean.
    const schedulerSessionId = `terminal-pty-${sessionKey}`;
    useEffect(() => {
      setPaneForeground(schedulerSessionId, isForeground);
      // A hidden pane paints nothing, so its GPU context is dead weight against
      // Chromium's small per-process budget; the controller hands it back after
      // a grace period and re-attaches on reveal.
      webglControllerRef.current?.setForeground(isForeground);

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
      appearanceRevision: `${activeSkinId}:${primaryColorPreset}`,
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
