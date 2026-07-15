/**
 * Chat Panel Terminal Atoms
 *
 * Chat panel terminals share the global terminal atom store (TerminalInteractive
 * + PTY) but are isolated from Workstation terminals via an ID prefix
 * "chatpanel-". This means:
 *
 *   - The existing PTY infrastructure (init, resize, kill) works unchanged.
 *   - The Workstation's active-terminal selection is NOT affected.
 *   - `loadPersistedState()` already strips "agent"-prefixed sessions; we rely
 *     on the same mechanism — chat-panel sessions are transient and are cleaned
 *     up when the tab is closed.
 *
 * Performance: atoms only write when a terminal tab is opened or closed,
 * which happens at most once per user action. No polling is added.
 */
import { atom } from "jotai";

import { clearTerminalBufferCache } from "@src/components/TerminalInteractive/bufferCache";
import {
  TERMINAL_AGENT_STATUS,
  type TerminalSession,
} from "@src/engines/TerminalCore/types";
import {
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  terminalPersistAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { invokeTauri, isTauriReady } from "@src/util/platform/tauri/init";
import { isChatPanelTerminalId } from "@src/util/ui/terminal/chatPanelSessionId";
import { toBackendPtySessionId } from "@src/util/ui/terminal/ptySessionId";

// ────────────────────────────────────────────────────────────────────────────
// Prefix helpers — kept in a leaf util to avoid circular imports
// ────────────────────────────────────────────────────────────────────────────

export const CHAT_PANEL_TERMINAL_PREFIX = "chatpanel-";

export { isChatPanelTerminalId } from "@src/util/ui/terminal/chatPanelSessionId";

// ────────────────────────────────────────────────────────────────────────────
// Create a chat panel terminal session
// Adds a session to the shared pool without changing the Workstation's
// activeTerminalIdAtom.
// Returns the new session ID.
// ────────────────────────────────────────────────────────────────────────────

interface CreateChatPanelTerminalOptions {
  name?: string;
  /** Initial working directory forwarded to create_pty */
  cwd?: string;
  cliAgentType?: TerminalSession["cliAgentType"];
  agentCommand?: string;
  expectedProcess?: string;
  env?: Record<string, string>;
}

export const createChatPanelTerminalAtom = atom(
  null,
  (
    _get,
    set,
    options: CreateChatPanelTerminalOptions | string = {}
  ): string => {
    const {
      name = "Terminal",
      cwd,
      cliAgentType,
      agentCommand,
      expectedProcess,
      env,
    } = typeof options === "string" ? { name: options } : options;
    const newId = `${CHAT_PANEL_TERMINAL_PREFIX}${crypto.randomUUID()}`;
    const newSession: TerminalSession = {
      id: newId,
      name,
      isActive: false, // does not affect Workstation active state
      cwd,
      cliAgentType,
      agentCommand,
      expectedProcess,
      env,
      agentStatus: agentCommand ? TERMINAL_AGENT_STATUS.STARTING : undefined,
    };
    set(terminalSessionsAtom, (prev) => [...prev, newSession]);
    set(terminalPersistAtom);
    return newId;
  }
);
createChatPanelTerminalAtom.debugLabel = "createChatPanelTerminal";

// ────────────────────────────────────────────────────────────────────────────
// Close / destroy a chat panel terminal session
// ────────────────────────────────────────────────────────────────────────────

export const destroyChatPanelTerminalAtom = atom(
  null,
  async (_get, set, sessionId: string): Promise<void> => {
    if (!isChatPanelTerminalId(sessionId)) return;

    // Kill PTY
    if (isTauriReady()) {
      try {
        await invokeTauri("close_pty", {
          sessionId: toBackendPtySessionId(sessionId),
        });
      } catch {
        // PTY may already be gone
      }
    }

    // Clear the buffer cache slot so the LRU is not wasted on a closed terminal
    clearTerminalBufferCache(sessionId);

    set(terminalSessionsAtom, (prev) =>
      prev.filter((session) => session.id !== sessionId)
    );
    set(initializedTerminalIdsAtom, (prev) => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
    set(terminalPersistAtom);
  }
);
destroyChatPanelTerminalAtom.debugLabel = "destroyChatPanelTerminal";

// ────────────────────────────────────────────────────────────────────────────
// Re-export atoms needed by ChatPanelTerminalContent
// ────────────────────────────────────────────────────────────────────────────

export {
  markTerminalInitializedAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
  initializedTerminalIdsAtom,
};
