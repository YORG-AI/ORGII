import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { createLogger } from "@src/hooks/logger";
import type { ShellType } from "@src/store/ui/editorSettingsAtom";
import {
  invokeTauri,
  isTauriReady,
  listenTauri,
} from "@src/util/platform/tauri/init";

import { deleteTerminalBuffer, getTerminalBuffer } from "./bufferCache";
import {
  notifyUserInput,
  registerPane,
  scheduleWrite,
  setPaneForeground,
  unregisterPane,
} from "./terminalOutputScheduler";
import type { TerminalViewProps } from "./types";
import { writeBrowserModeMessage } from "./utils";

const log = createLogger("TerminalView");

/**
 * Estimate UTF-8 byte length of a string without a TextEncoder allocation.
 *
 * Terminal output is overwhelmingly ASCII (shell prompts, command output,
 * ANSI sequences). The rare non-ASCII cases (emoji, CJK) over-estimate by
 * at most 3 bytes per character, which is acceptable — byte_count is used
 * as a backpressure hint, not an exact invariant.
 *
 * Implementation: charCode > 0x7F catches all non-ASCII BMP code points; a
 * surrogate pair (charCode > 0x7FF in both high+low halves) is counted as
 * +3 each which approximates the 4-byte UTF-8 encoding of the astral plane.
 */
function estimateByteLength(s: string): number {
  let len = s.length; // start with 1 byte per char (ASCII baseline)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) {
      // Non-ASCII: add extra bytes beyond the already-counted baseline byte.
      // U+0080–U+07FF → 2-byte UTF-8 (+1)
      // U+0800–U+FFFF → 3-byte UTF-8 (+2)
      len += c > 0x7ff ? 2 : 1;
    }
  }
  return len;
}

interface PtyOutputPayload {
  bytes?: number[];
  byte_count?: number;
  // Backward-compatible fallback for older backends during hot reloads.
  data?: string;
}

interface InitPtyConnectionParams {
  cols: number;
  rows: number;
  sessionKey: string;
  isForeground: boolean;
  terminalRef: MutableRefObject<Terminal | null>;
  sessionIdRef: MutableRefObject<string | null>;
  unlistenOutputRef: MutableRefObject<(() => void) | null>;
  unlistenExitRef: MutableRefObject<(() => void) | null>;
  repoPathRef: MutableRefObject<string | undefined>;
  shellType: ShellType;
  customShellPath?: string;
  shellOverride?: string;
  argsOverride?: string[];
  envOverride?: Record<string, string>;
  nameOverride?: string;
  onSessionInfoReady?: TerminalViewProps["onSessionInfoReady"];
  setIsBrowserMode: (value: boolean) => void;
  setIsConnecting: (value: boolean) => void;
  abortSignal?: AbortSignal;
}

/**
 * Notify the output scheduler that the user typed into the given session.
 * Must be called from the terminal's onData handler to enable interactive bypass.
 */
export function notifyPtyUserInput(sessionId: string): void {
  notifyUserInput(sessionId);
}

function resolvePtyLaunchOptions({
  repoPath,
  shellType,
  customShellPath,
  shellOverride,
}: {
  repoPath?: string;
  shellType: ShellType;
  customShellPath?: string;
  shellOverride?: string;
}) {
  let cwd: string | null = null;
  let shell: string | null = shellOverride || null;

  if (shell) {
    cwd = repoPath || null;
  } else if (shellType === "repo" && repoPath) {
    cwd = repoPath;
  } else if (shellType === "default") {
    cwd = null;
  } else if (shellType === "custom") {
    if (customShellPath) shell = customShellPath;
    cwd = repoPath || null;
  }

  return { cwd, shell };
}

function formatLastLogin(sessionKey: string) {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return `Last login: ${timeStr} on ${sessionKey}`;
}

async function fetchPtyInfo(
  sessionId: string,
  sessionKey: string,
  onSessionInfoReady?: TerminalViewProps["onSessionInfoReady"]
) {
  try {
    const ptyInfo = await invokeTauri<{
      session_id: string;
      pid: number | null;
      shell: string;
      cwd: string | null;
    }>("get_pty_info", {
      sessionId,
    });

    onSessionInfoReady?.({
      sessionKey,
      pid: ptyInfo.pid || undefined,
      shell: ptyInfo.shell,
      cwd: ptyInfo.cwd || undefined,
    });
  } catch (error) {
    log.error("[TerminalView] Failed to get PTY info:", error);
  }
}

async function reconnectOrCreatePty({
  cols,
  rows,
  sessionId,
  sessionKey,
  terminal,
  repoPath,
  shellType,
  customShellPath,
  shellOverride,
  argsOverride,
  envOverride,
  nameOverride,
  onSessionInfoReady,
}: {
  cols: number;
  rows: number;
  sessionId: string;
  sessionKey: string;
  terminal: Terminal;
  repoPath?: string;
  shellType: ShellType;
  customShellPath?: string;
  shellOverride?: string;
  argsOverride?: string[];
  envOverride?: Record<string, string>;
  nameOverride?: string;
  onSessionInfoReady?: TerminalViewProps["onSessionInfoReady"];
}) {
  let ptyExists = false;
  try {
    await invokeTauri("resize_pty", {
      request: {
        session_id: sessionId,
        rows: rows || 20,
        cols: cols || 80,
      },
    });
    ptyExists = true;
  } catch {
    ptyExists = false;
  }

  if (!ptyExists) {
    terminal.writeln(formatLastLogin(sessionKey));

    const { cwd, shell } = resolvePtyLaunchOptions({
      repoPath,
      shellType,
      customShellPath,
      shellOverride,
    });

    await invokeTauri("create_pty", {
      request: {
        session_id: sessionId,
        rows: rows || 20,
        cols: cols || 80,
        cwd,
        shell,
        args: argsOverride || null,
        env: envOverride || null,
        name: nameOverride || null,
      },
    });

    await fetchPtyInfo(sessionId, sessionKey, onSessionInfoReady);
    return;
  }

  const cachedBuffer = getTerminalBuffer(sessionId);
  if (cachedBuffer) {
    terminal.write(cachedBuffer);
    deleteTerminalBuffer(sessionId);
    return;
  }

  try {
    const snapshot = await invokeTauri<{
      output: string;
      unacked_bytes?: number;
    }>("get_pty_output_snapshot", { sessionId });

    if (snapshot.output) {
      terminal.write(snapshot.output);
    }
    if (snapshot.unacked_bytes && snapshot.unacked_bytes > 0) {
      await invokeTauri("ack_pty_data", {
        sessionId,
        byteCount: snapshot.unacked_bytes,
      });
    }
  } catch (error) {
    log.error("[TerminalView] Failed to restore PTY output snapshot:", error);
  }
}

export async function initPtyConnection({
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
  nameOverride,
  onSessionInfoReady,
  setIsBrowserMode,
  setIsConnecting,
  abortSignal,
}: InitPtyConnectionParams) {
  const isAborted = () => abortSignal?.aborted === true;

  if (!isTauriReady()) {
    if (isAborted()) return;
    setIsBrowserMode(true);
    setIsConnecting(false);

    const terminal = terminalRef.current;
    if (terminal) {
      writeBrowserModeMessage(terminal);
    }
    return;
  }

  const sessionId = `terminal-pty-${sessionKey}`;
  sessionIdRef.current = sessionId;

  try {
    const terminal = terminalRef.current;
    if (!terminal || isAborted()) return;

    const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

    // Stable write callback — captured once per session so the hot IPC
    // handler never allocates a new closure per event.
    const terminalWrite = (d: string | Uint8Array) => terminal.write(d);

    // Register this pane with the output scheduler. ACK is handled by the
    // scheduler after it drains chunks — we no longer call ack directly here.
    registerPane(sessionId, terminalWrite);
    setPaneForeground(sessionId, isForeground);

    const unlistenOutput = await listenTauri<PtyOutputPayload>(
      `pty-output-${sessionId}`,
      (event) => {
        if (isAborted()) return;

        const { bytes, byte_count: byteCount, data } = event.payload;

        if (bytes && bytes.length > 0) {
          const decoded = utf8Decoder.decode(new Uint8Array(bytes), {
            stream: true,
          });
          if (decoded) {
            const resolvedByteCount = byteCount ?? bytes.length;
            scheduleWrite(sessionId, decoded, resolvedByteCount, terminalWrite);
          }
        } else if (data) {
          // Backward-compat branch (no byte_count from backend): estimate byte
          // length without a TextEncoder allocation. ASCII is 1 byte/char;
          // non-ASCII (rare in terminal hot path) inflates slightly — the
          // scheduler treats byte_count as a flow-control hint, not an exact
          // invariant, so a cheap over-estimate is correct.
          const encodedLen = estimateByteLength(data);
          scheduleWrite(sessionId, data, encodedLen, terminalWrite);
        }
      }
    );
    if (isAborted()) {
      unlistenOutput();
      unregisterPane(sessionId);
      return;
    }
    unlistenOutputRef.current = unlistenOutput;

    const unlistenExit = await listenTauri(`pty-exit-${sessionId}`, () => {
      if (isAborted()) return;

      const trailingOutput = utf8Decoder.decode();
      if (trailingOutput) {
        terminal.write(trailingOutput);
      }
      terminal.writeln("\r\n\x1b[33m[Session ended]\x1b[0m");
      unregisterPane(sessionId);
    });
    if (isAborted()) {
      unlistenExit();
      unlistenOutputRef.current?.();
      unlistenOutputRef.current = null;
      unregisterPane(sessionId);
      return;
    }
    unlistenExitRef.current = unlistenExit;

    if (isAborted()) return;
    await reconnectOrCreatePty({
      cols,
      rows,
      sessionId,
      sessionKey,
      terminal,
      repoPath: repoPathRef.current,
      shellType,
      customShellPath,
      shellOverride,
      argsOverride,
      envOverride,
      nameOverride,
      onSessionInfoReady,
    });

    if (isAborted()) return;
    setIsConnecting(false);
    terminal.focus();
  } catch (error) {
    if (isAborted()) return;
    log.error("Failed to create/connect PTY session:", error);
    setIsConnecting(false);
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.writeln("\x1b[31mFailed to connect to system terminal\x1b[0m");
      terminal.writeln(`\x1b[90mError: ${error}\x1b[0m`);
    }
  }
}
