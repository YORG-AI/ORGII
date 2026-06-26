import type { SerializeAddon } from "@xterm/addon-serialize";
import type { IDisposable, Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { createLogger } from "@src/hooks/logger";
import { getUiScaleFromCssVar } from "@src/lib/dndKit";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";

import { setTerminalBuffer } from "./bufferCache";
import type { TerminalViewProps } from "./types";
import { createTerminalFileLinks } from "./utils";

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
  if (!onOpenFileLinkRef.current) return null;

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
        onSelectionChange?.({
          text: selectedText.trim(),
          position: {
            x: lastMousePosition.x / getUiScaleFromCssVar() + 10,
            y: lastMousePosition.y / getUiScaleFromCssVar() + 10,
          },
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
  const fileLinkProvider: IDisposable | null = registerFileLinkProvider({
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

  const handleSnapshotRequest = () => {
    cacheSerializedTerminalBuffer(serializeAddonRef, sessionIdRef, false);
  };
  window.addEventListener("terminal-snapshot-request", handleSnapshotRequest);

  return () => {
    cleanupSelectionHandlers();
    clearResizeTimer();
    fileLinkProvider?.dispose();
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
