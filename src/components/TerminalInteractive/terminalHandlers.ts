import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { createLogger } from "@src/hooks/logger";
import { getUiScaleFromCssVar } from "@src/lib/dndKit";
import { isMacOS } from "@src/util/platform/tauri";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import { setTerminalBuffer } from "./bufferCache";
import { notifyPtyUserInput } from "./terminalPty";
import type { TerminalViewProps } from "./types";
import { createTerminalFileLinks } from "./utils";

// ============================================
// macOS Cmd+Arrow key forwarding
// ============================================

/**
 * ANSI escape sequences for macOS Cmd+Arrow keys.
 *
 * xterm.js intentionally skips Meta (Cmd) for arrow keys so the browser can
 * handle them for text-cursor navigation in its own UI.  Inside a terminal
 * emulator the Meta modifier should produce the xterm modifier-key sequence
 * (modifier byte = mod_bits + 1 = Meta(8) + 1 = 9).
 *
 * Cmd+Up / Cmd+Down are intentionally excluded: macOS uses them for scroll
 * actions and they are not standard readline/shell bindings.
 */
const MAC_CMD_ARROW_SEQUENCES: Record<string, string> = {
  ArrowLeft: "\x1b[1;9D",
  ArrowRight: "\x1b[1;9C",
};

/**
 * Registers a customKeyEventHandler on the xterm Terminal so that macOS
 * Cmd+Arrow combinations are forwarded as ANSI escape sequences to the PTY.
 *
 * Returns a cleanup function that removes the handler.
 */
function registerMacCmdArrowHandler(terminal: Terminal): () => void {
  if (!isMacOS()) return () => undefined;

  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      return true;
    }
    const sequence = MAC_CMD_ARROW_SEQUENCES[event.key];
    if (!sequence) return true;

    if (event.type === "keydown") {
      terminal.input(sequence, true);
    }
    return false;
  });

  return () => {
    // xterm does not expose a way to remove a custom key handler, so we
    // replace it with a pass-through handler that always returns true.
    terminal.attachCustomKeyEventHandler(() => true);
  };
}

const log = createLogger("Terminal");

interface RegisterTerminalEventHandlersParams {
  terminal: Terminal;
  serializeAddonRef: MutableRefObject<SerializeAddon | null>;
  sessionIdRef: MutableRefObject<string | null>;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  repoPathRef: MutableRefObject<string | undefined>;
  workingDirectoryRef: MutableRefObject<string | undefined>;
  onOpenFileLinkRef: MutableRefObject<TerminalViewProps["onOpenFileLink"]>;
  onOutput?: TerminalViewProps["onOutput"];
  onUserInput?: TerminalViewProps["onUserInput"];
  onSelectionChange?: TerminalViewProps["onSelectionChange"];
  onTitleChange?: TerminalViewProps["onTitleChange"];
}

function cacheSerializedTerminalBuffer(
  serializeAddonRef: MutableRefObject<SerializeAddon | null>,
  sessionIdRef: MutableRefObject<string | null>,
  warnOnError: boolean
) {
  if (serializeAddonRef.current && sessionIdRef.current) {
    try {
      const serialized = serializeAddonRef.current.serialize();
      if (serialized) {
        setTerminalBuffer(sessionIdRef.current, serialized);
      }
    } catch (error) {
      if (warnOnError) {
        log.warn("[Terminal] Failed to serialize buffer:", error);
      }
    }
  }
}

function registerInputHandler({
  terminal,
  sessionIdRef,
  onOutput,
  onUserInput,
}: Pick<
  RegisterTerminalEventHandlersParams,
  "terminal" | "sessionIdRef" | "onOutput" | "onUserInput"
>) {
  let pendingInput = "";
  let inputBatchScheduled = false;

  const flushInput = () => {
    const batch = pendingInput;
    pendingInput = "";
    inputBatchScheduled = false;
    if (batch && isTauriReady() && sessionIdRef.current) {
      invokeTauri("write_pty", {
        sessionId: sessionIdRef.current,
        data: batch,
      }).catch((error) => {
        log.error("Failed to write to PTY:", error);
      });
    }
  };

  return terminal.onData((data) => {
    if (isTauriReady() && sessionIdRef.current) {
      onOutput?.();
      onUserInput?.();
      // Mark user input so the output scheduler can grant interactive bypass
      notifyPtyUserInput(sessionIdRef.current);
      pendingInput += data;
      if (!inputBatchScheduled) {
        inputBatchScheduled = true;
        queueMicrotask(flushInput);
      }
    }
  });
}

function registerFileLinkProvider({
  terminal,
  repoPathRef,
  workingDirectoryRef,
  onOpenFileLinkRef,
}: Pick<
  RegisterTerminalEventHandlersParams,
  "terminal" | "repoPathRef" | "workingDirectoryRef" | "onOpenFileLinkRef"
>) {
  // Always register the provider so it picks up `onOpenFileLink` even when the
  // prop is set after mount. The ref is updated on every render in index.tsx;
  // the inner check against `openFileLink` already handles the null case.
  return terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      const lineText = line?.translateToString(true) ?? "";
      const openFileLink = onOpenFileLinkRef.current;
      if (!openFileLink || !lineText) {
        callback(undefined);
        return;
      }

      const links = createTerminalFileLinks(lineText, bufferLineNumber, {
        repoPath: repoPathRef.current,
        workingDirectory: workingDirectoryRef.current,
        onOpenFileLink: openFileLink,
      });
      callback(links.length > 0 ? links : undefined);
    },
  });
}

function registerResizeHandler(
  terminal: Terminal,
  sessionIdRef: MutableRefObject<string | null>
) {
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;

  const resizeHandler = terminal.onResize(({ cols, rows }) => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (isTauriReady() && sessionIdRef.current) {
        invokeTauri("resize_pty", {
          request: {
            session_id: sessionIdRef.current,
            rows,
            cols,
          },
        }).catch((error) => {
          log.error("Failed to resize PTY:", error);
        });
      }
    }, 50);
  });

  return {
    resizeHandler,
    clearResizeTimer: () => {
      if (resizeTimer !== null) clearTimeout(resizeTimer);
    },
  };
}

function registerSelectionHandlers({
  terminal,
  containerRef,
  onSelectionChange,
}: Pick<
  RegisterTerminalEventHandlersParams,
  "terminal" | "containerRef" | "onSelectionChange"
>) {
  let lastMousePosition = { x: 0, y: 0 };
  const handleMouseMove = (event: MouseEvent) => {
    lastMousePosition = { x: event.clientX, y: event.clientY };
  };
  const handleMouseUp = (event: MouseEvent) => {
    lastMousePosition = { x: event.clientX, y: event.clientY };
  };

  const container = containerRef.current;
  if (container) {
    container.addEventListener("mousemove", handleMouseMove);
    container.addEventListener("mouseup", handleMouseUp);
  }

  let selectionDebounce: NodeJS.Timeout | null = null;
  const selectionHandler = terminal.onSelectionChange(() => {
    if (selectionDebounce) {
      clearTimeout(selectionDebounce);
    }

    selectionDebounce = setTimeout(() => {
      const selectedText = terminal.getSelection();
      if (selectedText && selectedText.trim().length > 0) {
        const selectionPos = terminal.getSelectionPosition();
        onSelectionChange?.({
          text: selectedText.trim(),
          position: {
            x: lastMousePosition.x / getUiScaleFromCssVar() + 10,
            y: lastMousePosition.y / getUiScaleFromCssVar() + 10,
          },
          // xterm buffer rows are 0-based; convert to 1-based for display
          lineStart: selectionPos ? selectionPos.start.y + 1 : undefined,
          lineEnd: selectionPos ? selectionPos.end.y + 1 : undefined,
        });
      } else {
        onSelectionChange?.(null);
      }
    }, 150);
  });

  return {
    selectionHandler,
    cleanupSelectionHandlers: () => {
      if (selectionDebounce) {
        clearTimeout(selectionDebounce);
      }
      if (container) {
        container.removeEventListener("mousemove", handleMouseMove);
        container.removeEventListener("mouseup", handleMouseUp);
      }
    },
  };
}

export function registerTerminalEventHandlers({
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
}: RegisterTerminalEventHandlersParams) {
  const inputHandler = registerInputHandler({
    terminal,
    sessionIdRef,
    onOutput,
    onUserInput,
  });
  const fileLinkProvider: IDisposable = registerFileLinkProvider({
    terminal,
    repoPathRef,
    workingDirectoryRef,
    onOpenFileLinkRef,
  });
  const { resizeHandler, clearResizeTimer } = registerResizeHandler(
    terminal,
    sessionIdRef
  );
  const { selectionHandler, cleanupSelectionHandlers } =
    registerSelectionHandlers({
      terminal,
      containerRef,
      onSelectionChange,
    });
  const titleHandler = terminal.onTitleChange((title) => {
    onTitleChange?.(title);
  });

  const cleanupCmdArrowHandler = registerMacCmdArrowHandler(terminal);

  const handleSnapshotRequest = () => {
    cacheSerializedTerminalBuffer(serializeAddonRef, sessionIdRef, false);
  };
  window.addEventListener("terminal-snapshot-request", handleSnapshotRequest);

  return () => {
    cleanupSelectionHandlers();
    clearResizeTimer();
    cleanupCmdArrowHandler();
    fileLinkProvider.dispose();
    inputHandler.dispose();
    resizeHandler.dispose();
    selectionHandler.dispose();
    titleHandler.dispose();
    window.removeEventListener(
      "terminal-snapshot-request",
      handleSnapshotRequest
    );
    cacheSerializedTerminalBuffer(serializeAddonRef, sessionIdRef, true);
  };
}
