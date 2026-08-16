import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  commandDetectionMapAtom,
  commandExecutedAtom,
  commandPromptStartAtom,
} from "../commandDetection";
import {
  activeTerminalIdAtom,
  closeTerminalSessionAtom,
  createAgentSessionTerminalAtom,
  removeAgentSessionTerminalAtom,
  terminalSessionsAtom,
} from "../index";

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn().mockResolvedValue(undefined),
  isTauriReady: vi.fn().mockReturnValue(false),
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

/**
 * Regression: OSC-633 command-detection state (up to 200 command entries per
 * terminal) was only ever added to; `removeCommandDetectionAtom` had no
 * caller, so the map grew with every terminal session ever opened.
 */
describe("command detection lifecycle", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
    store.set(terminalSessionsAtom, [
      { id: "t-1", name: "Terminal 1", isActive: true },
      { id: "t-2", name: "Terminal 2", isActive: false },
    ]);
    store.set(activeTerminalIdAtom, "t-1");
  });

  it("drops a terminal's command history when the terminal is closed", async () => {
    store.set(commandPromptStartAtom, "t-2");
    store.set(commandExecutedAtom, { sessionId: "t-2", commandLine: "ls -la" });
    expect(store.get(commandDetectionMapAtom).has("t-2")).toBe(true);

    await store.set(closeTerminalSessionAtom, "t-2");

    expect(store.get(commandDetectionMapAtom).has("t-2")).toBe(false);
    // Other sessions untouched.
    store.set(commandPromptStartAtom, "t-1");
    expect(store.get(commandDetectionMapAtom).has("t-1")).toBe(true);
  });

  it("drops the history of a removed agent-session terminal tab", () => {
    const tabId = store.set(createAgentSessionTerminalAtom, {
      agentSessionId: "agent-1",
      label: "Agent",
    });
    store.set(commandPromptStartAtom, tabId);
    expect(store.get(commandDetectionMapAtom).has(tabId)).toBe(true);

    // Takes the agent session id (the tab id is derived from it).
    store.set(removeAgentSessionTerminalAtom, "agent-1");
    expect(store.get(commandDetectionMapAtom).has(tabId)).toBe(false);
  });
});
