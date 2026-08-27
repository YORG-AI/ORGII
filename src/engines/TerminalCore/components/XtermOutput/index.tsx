/**
 * XtermOutput — xterm.js-backed terminal output renderer.
 *
 * Replaces ansi-to-react for terminal tool output in the chat pane.
 * Renders the full VT100/ANSI escape sequence set including:
 *   - SGR colors (16, 256, truecolor)
 *   - Bold, italic, underline, dim, strikethrough
 *   - Box-drawing and block characters (via Unicode 11 addon)
 *   - Cursor movement sequences that produce spinners / progress bars
 *   - Alternate screen output coalesced into the final visible state
 *
 * The terminal is opened into a real DOM node so xterm's canvas renderer
 * can measure character cells correctly. It is NOT connected to a PTY —
 * content is written once (or incrementally) from props.
 */
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useAtomValue } from "jotai";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { TERMINAL_LINE_HEIGHT } from "@src/config/terminalAppearance";
import { createLogger } from "@src/hooks/logger";
import {
  primaryColorPresetAtom,
  terminalFontSizeAtom,
  terminalLetterSpacingAtom,
  terminalThemeAtom,
} from "@src/store/ui/uiAtom";

import { shouldLoadTerminalWebgl } from "../TerminalInteractive/terminalRendererPolicy";
import { getXTermTheme } from "../TerminalInteractive/utils/theme";
import {
  acquireWebglSlot,
  releaseWebglSlot,
} from "../TerminalInteractive/webglContextManager";
import "./index.scss";

const logger = createLogger("XtermOutput");

export interface XtermOutputProps {
  /** Raw terminal output — may contain full VT100/ANSI escape sequences */
  content: string;
  /** Fixed height in px. Defaults to auto-fit based on line count (capped at 320px). */
  height?: number;
  /** Max height when auto-sizing. Defaults to 320. */
  maxHeight?: number;
  /** Number of terminal columns. Defaults to 120. */
  cols?: number;
  className?: string;
}

const MIN_HEIGHT = 20;
const DEFAULT_MAX_HEIGHT = 320;
const DEFAULT_COLS = 120;

const XtermOutput = memo(function XtermOutput({
  content,
  height,
  maxHeight = DEFAULT_MAX_HEIGHT,
  cols = DEFAULT_COLS,
  className = "",
}: XtermOutputProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  // Tracks whether this instance holds one of the shared WebGL context slots,
  // so it is released exactly once (context-loss / create-failure / unmount).
  const webglSlotHeldRef = useRef(false);
  const contentWrittenRef = useRef<string>("");
  const [computedHeight, setComputedHeight] = useState(MIN_HEIGHT);

  const terminalTheme = useAtomValue(terminalThemeAtom);
  // The cursor color resolves from --terminal-caret (an alias of
  // --color-primary-6); tracking the preset re-resolves it on accent change.
  const primaryColorPreset = useAtomValue(primaryColorPresetAtom);
  const fontSize = useAtomValue(terminalFontSizeAtom);
  const letterSpacing = useAtomValue(terminalLetterSpacingAtom);

  const measureHeight = useCallback(() => {
    const terminal = terminalRef.current;
    const container = containerRef.current;
    if (!terminal || !container) return;
    const cellHeight =
      terminal.rows > 0 ? container.clientHeight / terminal.rows : 16;
    const usedRows = Math.max(terminal.buffer.active.cursorY + 1, 1);
    const natural = usedRows * cellHeight;
    setComputedHeight(Math.min(Math.max(natural, MIN_HEIGHT), maxHeight));
  }, [maxHeight]);

  // Create the terminal once on mount
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || terminalRef.current) return;

    const terminal = new Terminal({
      theme: getXTermTheme(terminalTheme),
      fontSize,
      letterSpacing,
      lineHeight: TERMINAL_LINE_HEIGHT,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 0,
      disableStdin: true,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      allowProposedApi: true,
      cols,
      rows: 24,
    });

    const fitAddon = new FitAddon();
    const unicode11Addon = new Unicode11Addon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.unicode.activeVersion = "11";

    terminal.open(container);

    // Route through the shared WebGL context budget (macOS hard-caps live
    // contexts to ~16). Chat TUI blocks previously created uncounted contexts,
    // risking a context-loss cascade when combined with interactive terminals.
    const releaseWebglSlotIfHeld = () => {
      if (webglSlotHeldRef.current) {
        webglSlotHeldRef.current = false;
        releaseWebglSlot();
      }
    };
    if (shouldLoadTerminalWebgl() && acquireWebglSlot()) {
      webglSlotHeldRef.current = true;
      let webglAddon: WebglAddon | null = null;
      try {
        webglAddon = new WebglAddon();
        const addon = webglAddon;
        addon.onContextLoss(() => {
          addon.dispose();
          webglAddonRef.current = null;
          releaseWebglSlotIfHeld();
        });
        terminal.loadAddon(addon);
        webglAddonRef.current = addon;
      } catch (error) {
        logger.warn("WebGL unavailable for XtermOutput, using canvas:", error);
        // Dispose a partially activated addon so its GL context is not
        // orphaned while the budget slot is released.
        try {
          webglAddon?.dispose();
        } catch {
          // Best effort.
        }
        webglAddonRef.current = null;
        releaseWebglSlotIfHeld();
      }
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Initial fit + content write
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      if (content) {
        terminal.write(content);
        contentWrittenRef.current = content;
      }
      measureHeight();
    });

    return () => {
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      releaseWebglSlotIfHeld();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      contentWrittenRef.current = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- this effect owns one xterm instance; following effects patch content/theme/font changes without destroying its renderer or WebGL slot
  }, []);

  // Write new content when prop changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const previous = contentWrittenRef.current;
    if (content === previous) return;

    if (content.startsWith(previous)) {
      // Append-only delta — write the suffix
      const delta = content.slice(previous.length);
      terminal.write(delta);
    } else {
      // Content changed from scratch — reset and rewrite
      terminal.reset();
      terminal.write(content);
    }
    contentWrittenRef.current = content;
    requestAnimationFrame(measureHeight);
  }, [content, measureHeight]);

  // Sync theme changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const applied = getXTermTheme(terminalTheme);
    terminal.options.theme = applied;
    terminal.clearTextureAtlas?.();
    terminal.refresh(0, terminal.rows - 1);

    // The theme <link> swap and the primary-color preset (written to body's
    // inline style by a root-level effect) both land after this effect runs,
    // so re-resolve on the next frame and repaint only if a color moved.
    const frameId = requestAnimationFrame(() => {
      if (terminalRef.current !== terminal) return;
      const settled = getXTermTheme(terminalTheme);
      if (
        settled.cursor === applied.cursor &&
        settled.background === applied.background &&
        settled.selectionBackground === applied.selectionBackground
      ) {
        return;
      }
      terminal.options.theme = settled;
      terminal.clearTextureAtlas?.();
      terminal.refresh(0, terminal.rows - 1);
    });
    return () => cancelAnimationFrame(frameId);
  }, [terminalTheme, primaryColorPreset]);

  // Sync font changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    terminal.options.letterSpacing = letterSpacing;
    terminal.clearTextureAtlas?.();
    requestAnimationFrame(measureHeight);
  }, [fontSize, letterSpacing, measureHeight]);

  const resolvedHeight = height ?? computedHeight;

  return (
    <div
      className={`xterm-output ${className}`}
      style={{
        height: resolvedHeight,
        minHeight: MIN_HEIGHT,
        overflow: "hidden",
      }}
    >
      <div ref={containerRef} className="xterm-output__container" />
    </div>
  );
});

export default XtermOutput;
