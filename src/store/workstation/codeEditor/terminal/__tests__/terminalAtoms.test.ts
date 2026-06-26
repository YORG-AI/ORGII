/**
 * Tests for terminal session management atoms.
 *
 * These tests verify the core terminal state management logic including
 * session creation, deletion, switching, and special agent session handling.
 */
import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeTerminalIdAtom,
  closeTerminalSessionAtom,
  createAgentSessionTerminalAtom,
  editorActiveTerminalSessionAtom,
  editorAddTerminalSessionAtom,
  initializedTerminalIdsAtom,
  markTerminalInitializedAtom,
  removeAgentSessionTerminalAtom,
  renameTerminalSessionAtom,
  setActiveTerminalAtom,
  terminalSessionCountAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "../index";

// Mock Tauri and external dependencies
vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn().mockResolvedValue(undefined),
  isTauriReady: vi.fn().mockReturnValue(false), // Disable PTY calls in tests
}));

vi.mock("@src/util/ui/terminal/creationThrottle", () => ({
  tryBeginTerminalCreation: vi.fn().mockReturnValue(true),
  notifyTerminalCreationCooldown: vi.fn(),
}));

vi.mock("@src/config/settingsSchema", () => ({
  getSettingsDefaults: vi.fn().mockReturnValue({
    "terminal.shellType": "default",
    "terminal.customShellPath": "",
  }),
}));

describe("terminal atoms", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createStore();
    // Initialize with a clean state
    store.set(terminalSessionsAtom, [
      { id: "initial-1", name: "Terminal", isActive: true },
    ]);
    store.set(activeTerminalIdAtom, "initial-1");
    store.set(initializedTerminalIdsAtom, new Set(["initial-1"]));
  });

  describe("editorAddTerminalSessionAtom", () => {
    it("creates a new terminal session with unique ID", () => {
      const newId = store.set(editorAddTerminalSessionAtom, undefined);

      expect(newId).toBeDefined();
      expect(typeof newId).toBe("string");

      const sessions = store.get(terminalSessionsAtom);
      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.id === newId)).toBeDefined();
    });

    it("marks new session as active and others as inactive", () => {
      const newId = store.set(editorAddTerminalSessionAtom, undefined);

      const sessions = store.get(terminalSessionsAtom);
      const newSession = sessions.find((s) => s.id === newId);
      const oldSession = sessions.find((s) => s.id === "initial-1");

      expect(newSession?.isActive).toBe(true);
      expect(oldSession?.isActive).toBe(false);
      expect(store.get(activeTerminalIdAtom)).toBe(newId);
    });

    it("accepts custom session options", () => {
      const newId = store.set(editorAddTerminalSessionAtom, {
        name: "Custom Terminal",
        shell: "/bin/fish",
        profileId: "fish-profile",
        cwd: "/repo/project",
      });

      const sessions = store.get(terminalSessionsAtom);
      const newSession = sessions.find((s) => s.id === newId);

      expect(newSession?.name).toBe("Custom Terminal");
      expect(newSession?.shell).toBe("/bin/fish");
      expect(newSession?.profileId).toBe("fish-profile");
      expect(newSession?.cwd).toBe("/repo/project");
    });
  });

  describe("closeTerminalSessionAtom", () => {
    it("removes the specified session", async () => {
      // Add a second session first
      const secondId = store.set(editorAddTerminalSessionAtom, undefined);

      await store.set(closeTerminalSessionAtom, secondId);

      const sessions = store.get(terminalSessionsAtom);
      expect(sessions.find((s) => s.id === secondId)).toBeUndefined();
    });

    it("creates a new default session when closing the last one", async () => {
      const initialId = "initial-1";
      await store.set(closeTerminalSessionAtom, initialId);

      const sessions = store.get(terminalSessionsAtom);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).not.toBe(initialId);
      expect(sessions[0].isActive).toBe(true);
    });

    it("switches to first remaining session when closing active", async () => {
      // Add second and third sessions
      store.set(editorAddTerminalSessionAtom, { name: "Second" });
      const thirdId = store.set(editorAddTerminalSessionAtom, {
        name: "Third",
      });

      // Third is now active, close it
      await store.set(closeTerminalSessionAtom, thirdId);

      const activeId = store.get(activeTerminalIdAtom);
      const sessions = store.get(terminalSessionsAtom);

      // Should switch to first remaining
      expect(activeId).toBe(sessions[0].id);
      expect(sessions[0].isActive).toBe(true);
    });
  });

  describe("setActiveTerminalAtom", () => {
    it("switches the active session", () => {
      const secondId = store.set(editorAddTerminalSessionAtom, undefined);

      // Switch back to first
      store.set(setActiveTerminalAtom, "initial-1");

      expect(store.get(activeTerminalIdAtom)).toBe("initial-1");

      const sessions = store.get(terminalSessionsAtom);
      expect(sessions.find((s) => s.id === "initial-1")?.isActive).toBe(true);
      expect(sessions.find((s) => s.id === secondId)?.isActive).toBe(false);
    });
  });

  describe("markTerminalInitializedAtom", () => {
    it("adds session to initialized set", () => {
      const newId = store.set(editorAddTerminalSessionAtom, undefined);

      // New session is not initialized yet
      let initialized = store.get(initializedTerminalIdsAtom);
      expect(initialized.has(newId)).toBe(false);

      // Mark as initialized
      store.set(markTerminalInitializedAtom, newId);

      initialized = store.get(initializedTerminalIdsAtom);
      expect(initialized.has(newId)).toBe(true);
    });
  });

  describe("renameTerminalSessionAtom", () => {
    it("updates session name and userTitle", () => {
      store.set(renameTerminalSessionAtom, {
        sessionId: "initial-1",
        title: "My Custom Name",
      });

      const sessions = store.get(terminalSessionsAtom);
      const session = sessions.find((s) => s.id === "initial-1");

      expect(session?.name).toBe("My Custom Name");
      expect(session?.userTitle).toBe("My Custom Name");
    });

    it("clears userTitle when empty string provided", () => {
      // First set a custom name
      store.set(renameTerminalSessionAtom, {
        sessionId: "initial-1",
        title: "Custom",
      });

      // Then clear it
      store.set(renameTerminalSessionAtom, {
        sessionId: "initial-1",
        title: "",
      });

      const sessions = store.get(terminalSessionsAtom);
      const session = sessions.find((s) => s.id === "initial-1");

      expect(session?.userTitle).toBeUndefined();
    });
  });

  describe("updateTerminalSessionInfoAtom", () => {
    it("updates session metadata", () => {
      store.set(updateTerminalSessionInfoAtom, {
        sessionId: "initial-1",
        info: {
          pid: 12345,
          shell: "/bin/zsh",
          shellKind: "zsh",
          cwd: "/home/user",
          liveCwd: "/home/user/project",
        },
      });

      const sessions = store.get(terminalSessionsAtom);
      const session = sessions.find((s) => s.id === "initial-1");

      expect(session?.pid).toBe(12345);
      expect(session?.shell).toBe("/bin/zsh");
      expect(session?.shellKind).toBe("zsh");
      expect(session?.cwd).toBe("/home/user");
      expect(session?.liveCwd).toBe("/home/user/project");
    });
  });

  describe("editorActiveTerminalSessionAtom", () => {
    it("returns the active session object", () => {
      const activeSession = store.get(editorActiveTerminalSessionAtom);

      expect(activeSession?.id).toBe("initial-1");
      expect(activeSession?.isActive).toBe(true);
    });

    it("returns undefined when no active session", () => {
      store.set(activeTerminalIdAtom, "non-existent");

      const activeSession = store.get(editorActiveTerminalSessionAtom);
      expect(activeSession).toBeUndefined();
    });
  });

  describe("terminalSessionCountAtom", () => {
    it("returns correct count", () => {
      expect(store.get(terminalSessionCountAtom)).toBe(1);

      store.set(editorAddTerminalSessionAtom, undefined);
      expect(store.get(terminalSessionCountAtom)).toBe(2);

      store.set(editorAddTerminalSessionAtom, undefined);
      expect(store.get(terminalSessionCountAtom)).toBe(3);
    });
  });

  describe("createAgentSessionTerminalAtom", () => {
    it("creates read-only agent session terminal", () => {
      const agentSessionId = "agent-123";

      store.set(createAgentSessionTerminalAtom, {
        agentSessionId,
        label: "Agent",
      });

      const sessions = store.get(terminalSessionsAtom);
      const agentSession = sessions.find(
        (s) => s.id === `agent-session-${agentSessionId}`
      );

      expect(agentSession).toBeDefined();
      expect(agentSession?.readOnly).toBe(true);
      expect(agentSession?.agentSessionId).toBe(agentSessionId);
    });
  });

  describe("removeAgentSessionTerminalAtom", () => {
    it("removes agent session terminal", () => {
      const agentSessionId = "agent-to-remove";

      // Create agent session
      store.set(createAgentSessionTerminalAtom, { agentSessionId });

      // Remove it
      store.set(removeAgentSessionTerminalAtom, agentSessionId);

      const sessions = store.get(terminalSessionsAtom);
      const agentSession = sessions.find(
        (s) => s.id === `agent-session-${agentSessionId}`
      );

      expect(agentSession).toBeUndefined();
    });

    it("creates default session when removing last session", () => {
      // Close all existing sessions first
      store.set(terminalSessionsAtom, []);
      store.set(activeTerminalIdAtom, "");

      // Create only an agent session
      const agentSessionId = "only-agent";
      store.set(createAgentSessionTerminalAtom, { agentSessionId });

      // Remove it (should create default)
      store.set(removeAgentSessionTerminalAtom, agentSessionId);

      const sessions = store.get(terminalSessionsAtom);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].isActive).toBe(true);
    });
  });
});
