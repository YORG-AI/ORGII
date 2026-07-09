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
import type { TerminalViewProps } from "./types";
import { writeBrowserModeMessage } from "./utils";

const log = createLogger("TerminalView");

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
}: InitPtyConnectionParams) {
  if (!isTauriReady()) {
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
    if (!terminal) return;

    // Tear down any listener left over from a previous init before registering
    // new ones. Without this, a re-init (e.g. the xterm instance is recreated
    // because an initPTY dependency such as shellOverride changed) stacks a
    // second `pty-output` listener on top of the first, so every PTY chunk is
    // written to xterm twice — the whole session renders duplicated line-by-line.
    unlistenOutputRef.current?.();
    unlistenOutputRef.current = null;
    unlistenExitRef.current?.();
    unlistenExitRef.current = null;

    const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
    let ackPendingBytes = 0;
    let ackScheduled = false;
    const flushAck = () => {
      if (ackPendingBytes > 0 && isTauriReady()) {
        invokeTauri("ack_pty_data", {
          sessionId,
          byteCount: ackPendingBytes,
        }).catch(() => undefined);
        ackPendingBytes = 0;
      }
      ackScheduled = false;
    };

    const unlistenOutput = await listenTauri<PtyOutputPayload>(
      `pty-output-${sessionId}`,
      (event) => {
        const { bytes, byte_count: byteCount, data } = event.payload;

        if (bytes && bytes.length > 0) {
          const decoded = utf8Decoder.decode(new Uint8Array(bytes), {
            stream: true,
          });
          if (decoded) {
            terminal.write(decoded);
          }
          ackPendingBytes += byteCount ?? bytes.length;
        } else if (data) {
          terminal.write(data);
          ackPendingBytes += new TextEncoder().encode(data).length;
        } else {
          return;
        }

        if (!ackScheduled) {
          ackScheduled = true;
          requestAnimationFrame(flushAck);
        }
      }
    );
    // The `await` above yields to the event loop; the terminal may have been
    // disposed/recreated in the meantime (React effect cleanup nulls the ref).
    // Binding a listener to a stale terminal would leak it and double output on
    // the live instance, so drop it immediately if we lost the race.
    if (terminalRef.current !== terminal) {
      unlistenOutput();
      return;
    }
    unlistenOutputRef.current = unlistenOutput;

    const unlistenExit = await listenTauri(`pty-exit-${sessionId}`, () => {
      const trailingOutput = utf8Decoder.decode();
      if (trailingOutput) {
        terminal.write(trailingOutput);
      }
      terminal.writeln("\r\n\x1b[33m[Session ended]\x1b[0m");
    });
    if (terminalRef.current !== terminal) {
      unlistenOutput();
      unlistenExit();
      unlistenOutputRef.current = null;
      return;
    }
    unlistenExitRef.current = unlistenExit;

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

    setIsConnecting(false);
    terminal.focus();
  } catch (error) {
    log.error("Failed to create/connect PTY session:", error);
    setIsConnecting(false);
    const terminal = terminalRef.current;
    if (terminal) {
      terminal.writeln("\x1b[31mFailed to connect to system terminal\x1b[0m");
      terminal.writeln(`\x1b[90mError: ${error}\x1b[0m`);
    }
  }
}
