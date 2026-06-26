/**
 * TerminalService - Singleton Terminal Management Service
 *
 * Provides terminal capabilities shared by both AI and UI.
 * Uses the same Jotai atoms as useTerminalState hook.
 *
 * Supports two execution modes:
 *   1. PTY execution (execute) — runs in visible terminal, no output capture
 *   2. Subprocess execution (exec) — runs headless, captures stdout/stderr
 *
 * Usage:
 *   import { TerminalService } from "@src/services/terminal";
 *   await TerminalService.execute("npm install");        // PTY (visible)
 *   const result = await TerminalService.exec("ls -la"); // Subprocess (captured)
 */
import { Command } from "@tauri-apps/plugin-shell";

import { createLogger } from "@src/hooks/logger";
import { WorkStationViewService } from "@src/services/workStation";
import {
  activeTerminalIdAtom,
  closeTerminalSessionAtom,
  editorActiveTerminalSessionAtom,
  editorAddTerminalSessionAtom,
  initializedTerminalIdsAtom,
  renameTerminalSessionAtom,
  setActiveTerminalAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

const log = createLogger("TerminalService");

// ============================================
// Subprocess Execution Result
// ============================================

export interface SubprocessResult {
  /** Process exit code (0 = success) */
  exitCode: number;
  /** Combined stdout output */
  stdout: string;
  /** Combined stderr output */
  stderr: string;
}

// ============================================
// Jotai Store Access (uses app's instrumented store)
// ============================================

const getStore = () => getInstrumentedStore();

// ============================================
// Helper Functions
// ============================================

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute a command in a terminal session via PTY
 */
async function writeToPty(command: string, sessionId: string): Promise<void> {
  if (!isTauriReady()) {
    throw new Error("Tauri not ready");
  }

  const ptySessionId = toBackendPtySessionId(sessionId);
  getStore().set(updateTerminalSessionInfoAtom, {
    sessionId,
    info: { hasUserInput: true },
  });

  // Write command
  await invokeTauri("write_pty", {
    sessionId: ptySessionId,
    data: command,
  });

  // Small delay
  await delay(50);

  // Send Enter
  await invokeTauri("write_pty", {
    sessionId: ptySessionId,
    data: "\r",
  });
}

/**
 * Ensure terminal is ready and return session ID
 */
async function ensureTerminalReady(): Promise<string> {
  // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
  // PanelService.showBottomPanel("terminal");
  await WorkStationViewService.openTerminalTab();

  const store = getStore();
  const activeId = store.get(activeTerminalIdAtom);
  const initialized = store.get(initializedTerminalIdsAtom);
  const sessions = store.get(terminalSessionsAtom);

  // Check if we have an active initialized session
  const hasValidSession =
    sessions.length > 0 && activeId && initialized.has(activeId);

  if (hasValidSession) {
    await delay(100); // Small delay to ensure PTY is ready
    return activeId;
  }

  // No valid session - wait for one to be available
  // (UI creates session on mount, or we can create one)
  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(200);
    const currentActiveId = store.get(activeTerminalIdAtom);
    const currentInitialized = store.get(initializedTerminalIdsAtom);

    if (currentActiveId && currentInitialized.has(currentActiveId)) {
      return currentActiveId;
    }
  }

  throw new Error("Terminal session not available");
}

// ============================================
// TerminalService - Singleton API
// ============================================

export const TerminalService = {
  /**
   * Execute a command in the terminal
   * Automatically opens terminal and creates session if needed
   */
  async execute(command: string): Promise<void> {
    const sessionId = await ensureTerminalReady();
    await writeToPty(command, sessionId);
  },

  /**
   * Focus/show the terminal panel
   */
  focus(): void {
    // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
    // PanelService.showBottomPanel("terminal");
    void WorkStationViewService.openTerminalTab();
  },

  /**
   * Create a new terminal session, optionally with a shell profile.
   */
  createSession(options?: {
    shell?: string;
    args?: string[];
    name?: string;
    profileId?: string;
    env?: Record<string, string>;
  }): string {
    // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
    // PanelService.showBottomPanel("terminal");
    void WorkStationViewService.openTerminalTab();
    const store = getStore();
    const newId = store.set(editorAddTerminalSessionAtom, options);
    return newId;
  },

  /**
   * Close a terminal session
   */
  async closeSession(sessionId: string): Promise<void> {
    const store = getStore();
    await store.set(closeTerminalSessionAtom, sessionId);
  },

  /**
   * Clear the terminal (sends clear command)
   */
  async clear(): Promise<void> {
    const sessionId = await ensureTerminalReady();
    await writeToPty("clear", sessionId);
  },

  /**
   * Kill the current terminal process (Ctrl+C)
   */
  async kill(): Promise<void> {
    const store = getStore();
    const activeId = store.get(activeTerminalIdAtom);
    if (!activeId) return;

    const ptySessionId = toBackendPtySessionId(activeId);

    try {
      // Send Ctrl+C (ASCII code 3)
      await invokeTauri("write_pty", {
        sessionId: ptySessionId,
        data: "\x03",
      });
    } catch (error) {
      throw new Error(
        `[TerminalService] Failed to kill process in ${ptySessionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },

  /**
   * Get current session info
   */
  getActiveSession() {
    const store = getStore();
    return store.get(editorActiveTerminalSessionAtom);
  },

  /**
   * Get all sessions
   */
  getSessions() {
    const store = getStore();
    return store.get(terminalSessionsAtom);
  },

  /**
   * Get active session ID
   */
  getActiveSessionId(): string {
    const store = getStore();
    return store.get(activeTerminalIdAtom);
  },

  /**
   * Rename a terminal session (sets userTitle).
   */
  renameSession(sessionId: string, title: string): void {
    const store = getStore();
    store.set(renameTerminalSessionAtom, { sessionId, title });
  },

  /**
   * Set the active terminal session
   */
  setActive(sessionId: string): void {
    const store = getStore();
    store.set(setActiveTerminalAtom, sessionId);
  },

  /**
   * Execute a command as a non-PTY subprocess and capture output.
   *
   * Unlike execute() which runs in a visible PTY terminal, exec() runs
   * the command headlessly and returns stdout/stderr. This is useful for
   * programmatic execution where the output needs to be processed (e.g., by LLM).
   *
   * Uses the Tauri Shell plugin's Command API.
   *
   * @param command - The full shell command to run (passed to sh -c)
   * @param cwd - Optional working directory
   * @returns SubprocessResult with exitCode, stdout, stderr
   */
  async exec(command: string, cwd?: string): Promise<SubprocessResult> {
    try {
      // Use Tauri Shell plugin to spawn a subprocess
      // The shell plugin's sidecar/command approach:
      // We use sh -c to run arbitrary commands
      const shellCmd = Command.create("sh", ["-c", command], {
        cwd: cwd || undefined,
      });

      const output = await shellCmd.execute();

      return {
        exitCode: output.code ?? -1,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    } catch (error) {
      // If the Shell plugin fails (e.g., not in allowlist), fall back to PTY
      log.warn(
        "[TerminalService] Subprocess exec failed, falling back to PTY:",
        error
      );

      // Fallback: run via PTY (no output capture)
      await this.execute(command);
      return {
        exitCode: 0,
        stdout: "(Output displayed in terminal panel)",
        stderr: "",
      };
    }
  },
};
