import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { TERMINAL_LINE_HEIGHT } from "@src/config/terminalAppearance";
import { ShellIntegrationAddon } from "@src/engines/TerminalCore/addons/ShellIntegrationAddon";
import { createLogger } from "@src/hooks/logger";
// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → this file.
import type { TerminalThemeName } from "@src/store/ui/uiAtom";

import { shouldLoadTerminalWebgl } from "./terminalRendererPolicy";
import type { TerminalViewProps } from "./types";
import { getXTermTheme } from "./utils";
import { acquireWebglSlot, releaseWebglSlot } from "./webglContextManager";

const log = createLogger("Terminal");

interface CreateTerminalInstanceParams {
  terminalTheme: TerminalThemeName;
  terminalFontSize: number;
  terminalLetterSpacing: number;
  codeFontFamily: string;
  backgroundColor?: string;
  shellIntegration?: TerminalViewProps["shellIntegration"];
}

interface InitializeWhenContainerVisibleParams {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  terminal: Terminal;
  fitTerminal: () => void;
  initPty: (cols: number, rows: number) => void;
  loadWebGL: () => void;
  setIsReady: (value: boolean) => void;
}

export function createTerminalInstance({
  terminalTheme,
  terminalFontSize,
  terminalLetterSpacing,
  codeFontFamily,
  backgroundColor,
  shellIntegration,
}: CreateTerminalInstanceParams) {
  const terminal = new Terminal({
    theme: getXTermTheme(terminalTheme, backgroundColor),
    fontSize: terminalFontSize,
    fontFamily: codeFontFamily,
    fontWeight: "400",
    fontWeightBold: "700",
    letterSpacing: terminalLetterSpacing,
    lineHeight: TERMINAL_LINE_HEIGHT,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    scrollback: 5000,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    customGlyphs: true,
    rescaleOverlappingGlyphs: true,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    allowProposedApi: true,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const serializeAddon = new SerializeAddon();
  const unicode11Addon = new Unicode11Addon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(unicode11Addon);
  terminal.loadAddon(new WebLinksAddon());

  if (shellIntegration) {
    terminal.loadAddon(
      new ShellIntegrationAddon({
        onPromptStart: shellIntegration.onPromptStart,
        onCommandExecuted: shellIntegration.onCommandExecuted,
        onCommandFinished: shellIntegration.onCommandFinished,
        onCwdChanged: shellIntegration.onCwdChanged,
      })
    );
  }

  terminal.unicode.activeVersion = "11";

  return {
    terminal,
    fitAddon,
    searchAddon,
    serializeAddon,
  };
}

export function loadTerminalWebgl(
  terminal: Terminal,
  webglAddonRef: MutableRefObject<WebglAddon | null>
) {
  if (!shouldLoadTerminalWebgl()) {
    log.info("[Terminal] WebGL renderer disabled on this platform");
    return;
  }

  if (!acquireWebglSlot()) {
    log.warn(
      "[Terminal] WebGL context budget exhausted, using canvas renderer"
    );
    return;
  }

  let webglAddon: WebglAddon | null = null;
  try {
    webglAddon = new WebglAddon();
    const addon = webglAddon;
    addon.onContextLoss(() => {
      log.warn("[Terminal] WebGL context lost, falling back to canvas");
      addon.dispose();
      webglAddonRef.current = null;
      releaseWebglSlot();
    });
    terminal.loadAddon(addon);
    webglAddonRef.current = addon;
  } catch (error) {
    log.warn(
      "[Terminal] WebGL addon failed to load, using canvas renderer:",
      error
    );
    // If `loadAddon`/`activate` threw after the GL context was created, the
    // addon still owns that context (10–30 MB GPU); dispose it before
    // handing the budget slot back so the live-context count stays honest.
    try {
      webglAddon?.dispose();
    } catch {
      // Best effort — the addon may not have activated at all.
    }
    releaseWebglSlot();
  }
}

export function initializeWhenContainerVisible({
  containerRef,
  terminal,
  fitTerminal,
  initPty,
  loadWebGL,
  setIsReady,
}: InitializeWhenContainerVisibleParams): () => void {
  let initialized = false;
  let cancelled = false;
  let frameId: number | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const doInit = () => {
    if (cancelled || initialized || !containerRef.current) return;
    initialized = true;
    resizeObserver?.disconnect();
    resizeObserver = null;

    fitTerminal();
    loadWebGL();

    setIsReady(true);
    initPty(terminal.cols, terminal.rows);
  };

  const tryInit = () => {
    if (cancelled || initialized || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    if (typeof document.fonts?.ready === "undefined") {
      doInit();
      return;
    }

    document.fonts.ready.then(doInit);
  };

  frameId = requestAnimationFrame(tryInit);

  if (containerRef.current) {
    resizeObserver = new ResizeObserver(tryInit);
    resizeObserver.observe(containerRef.current);
  }

  return () => {
    cancelled = true;
    if (frameId !== null) cancelAnimationFrame(frameId);
    resizeObserver?.disconnect();
  };
}
