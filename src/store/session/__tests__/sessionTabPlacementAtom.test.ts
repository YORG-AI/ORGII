import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openSessionWindow } from "@src/api/tauri/sessionWindow";
import {
  type ChatPanelTabsState,
  chatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  createChatSessionTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  moveSessionTabAtom,
  openSessionInNewWindowAtom,
  openSessionInWorkstationAtom,
  retargetChatPanelSessionTabAtom,
  retargetWorkstationSessionTabAtom,
} from "../sessionTabPlacementAtom";

vi.mock("@src/api/tauri/sessionWindow", () => ({
  openSessionWindow: vi.fn(() =>
    Promise.resolve("app-window-session-session-1")
  ),
}));

function session(sessionId: string, name: string): Session {
  return {
    session_id: sessionId,
    name,
    status: "completed",
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    repoPath: "/repo",
  };
}

function chatState(sessionId: string): ChatPanelTabsState {
  return {
    tabs: [
      {
        id: "chat-source",
        type: "session",
        title: "Fallback title",
        sessionId,
      },
      { id: "launchpad", type: "start-page", title: "Launchpad" },
    ],
    activeTabId: "chat-source",
  };
}

describe("session tab placement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    vi.mocked(openSessionWindow).mockClear();
    // `createInstrumentedStore()` is a process-wide singleton; without a
    // reset, atom state (e.g. the remembered workstation session) leaks
    // between cases through the shared store.
    resetInstrumentedStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves a Chat Panel session into Workstation without copying the tab", () => {
    const store = createInstrumentedStore();
    store.set(sessionsAtom, [session("session-1", "Live session")]);
    store.set(chatPanelTabsAtom, chatState("session-1"));
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [], activeTabId: null },
    });
    store.set(chatPanelMaximizedAtom, true);
    store.set(stationModeAtom, STATION_MODE.AGENT_STATION);

    const moved = store.set(moveSessionTabAtom, {
      source: "chat-panel",
      sourceTabId: "chat-source",
      sessionId: "session-1",
      title: "Fallback title",
    });

    expect(moved).toBe(true);
    expect(
      store.get(chatPanelTabsAtom).tabs.some((tab) => tab.id === "chat-source")
    ).toBe(false);
    expect(store.get(workstationLayoutAtom).mainPane).toMatchObject({
      activeTabId: "chat-session:session-1",
      tabs: [
        expect.objectContaining({
          id: "chat-session:session-1",
          type: "chat-session",
          title: "Live session",
          data: expect.objectContaining({ sessionId: "session-1" }),
        }),
      ],
    });
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(store.get(stationModeAtom)).toBe(STATION_MODE.MY_STATION);
    expect(store.get(activeSessionIdAtom)).toBe("session-1");
  });

  it("moves a Workstation session back into the Chat Panel", () => {
    const store = createInstrumentedStore();
    store.set(sessionsAtom, [session("session-2", "Remote session")]);
    store.set(chatPanelTabsAtom, {
      tabs: [{ id: "launchpad", type: "start-page", title: "Launchpad" }],
      activeTabId: "launchpad",
    });
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [createChatSessionTab("session-2", "Remote session")],
        activeTabId: "chat-session:session-2",
      },
    });

    const moved = store.set(moveSessionTabAtom, {
      source: "workstation",
      sourceTabId: "chat-session:session-2",
      sessionId: "session-2",
      title: "Remote session",
    });

    expect(moved).toBe(true);
    expect(store.get(workstationLayoutAtom).mainPane.tabs).toEqual([]);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: expect.stringMatching(/^chat-/),
      tabs: expect.arrayContaining([
        expect.objectContaining({
          type: "session",
          sessionId: "session-2",
        }),
      ]),
    });
    expect(store.get(workstationActiveSessionIdAtom)).toBe("session-2");
    expect(store.get(activeSessionIdAtom)).toBe("session-2");
  });

  it("opens a sidebar session in Workstation with one visible owner", () => {
    const store = createInstrumentedStore();
    store.set(sessionsAtom, [session("codexapp-source", "Imported history")]);
    store.set(chatPanelTabsAtom, chatState("codexapp-source"));
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [createChatSessionTab("codexapp-source", "Stale title")],
        activeTabId: null,
      },
    });

    const opened = store.set(openSessionInWorkstationAtom, {
      sessionId: "codexapp-source",
      title: "Sidebar label",
    });

    expect(opened).toBe(true);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some(
          (tab) => tab.type === "session" && tab.sessionId === "codexapp-source"
        )
    ).toBe(false);
    const matchingTabs = store
      .get(workstationLayoutAtom)
      .mainPane.tabs.filter(
        (tab) =>
          tab.type === "chat-session" &&
          tab.data.sessionId === "codexapp-source"
      );
    expect(matchingTabs).toHaveLength(1);
    expect(matchingTabs[0]).toMatchObject({
      id: "chat-session:codexapp-source",
      title: "Imported history",
    });
    expect(store.get(workstationLayoutAtom).mainPane.activeTabId).toBe(
      "chat-session:codexapp-source"
    );
    expect(store.get(activeSessionIdAtom)).toBe("codexapp-source");
  });

  it("retargets a Workstation tab to the writable continuation in place", () => {
    const store = createInstrumentedStore();
    const sourceTab = createChatSessionTab(
      "codexapp-source",
      "Imported history",
      "work-item-1"
    );
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [sourceTab], activeTabId: sourceTab.id },
    });

    const retargeted = store.set(retargetWorkstationSessionTabAtom, {
      sourceSessionId: "codexapp-source",
      tabId: sourceTab.id,
      sessionId: "agentsession-continuation",
      sessionName: "Continue imported history",
      repoPath: "/repo",
    });

    expect(retargeted).toBe(true);
    expect(store.get(workstationLayoutAtom).mainPane).toMatchObject({
      activeTabId: "chat-session:agentsession-continuation",
      tabs: [
        expect.objectContaining({
          id: "chat-session:agentsession-continuation",
          title: "Continue imported history",
          data: expect.objectContaining({
            sessionId: "agentsession-continuation",
            workItemId: "work-item-1",
          }),
        }),
      ],
    });
    expect(store.get(activeSessionIdAtom)).toBe("agentsession-continuation");
  });

  it("retargets the active Chat Panel pill to the continuation", () => {
    const store = createInstrumentedStore();
    store.set(chatPanelTabsAtom, chatState("codexapp-source"));

    const retargeted = store.set(retargetChatPanelSessionTabAtom, {
      sourceSessionId: "codexapp-source",
      tabId: "chat-source",
      sessionId: "agentsession-continuation",
      sessionName: "Continue imported history",
      repoPath: "/repo",
    });

    expect(retargeted).toBe(true);
    expect(store.get(chatPanelTabsAtom).tabs[0]).toMatchObject({
      id: "chat-source",
      sessionId: "agentsession-continuation",
      title: "Continue imported history",
    });
    expect(store.get(workstationActiveSessionIdAtom)).toBe(
      "agentsession-continuation"
    );
    expect(store.get(activeSessionIdAtom)).toBe("agentsession-continuation");
  });

  it("detaches a session into its own window and closes both owners' tabs", async () => {
    const store = createInstrumentedStore();
    store.set(sessionsAtom, [session("session-1", "Live session")]);
    store.set(chatPanelTabsAtom, chatState("session-1"));
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [
          createChatSessionTab("session-1", "Live session"),
          createChatSessionTab("session-9", "Unrelated session"),
        ],
        activeTabId: "chat-session:session-1",
      },
    });

    const opened = await store.set(openSessionInNewWindowAtom, {
      sessionId: "session-1",
    });

    expect(opened).toBe(true);
    expect(vi.mocked(openSessionWindow)).toHaveBeenCalledWith(
      "session-1",
      "Live session"
    );
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some(
          (tab) => tab.type === "session" && tab.sessionId === "session-1"
        )
    ).toBe(false);
    const workstationTabs = store.get(workstationLayoutAtom).mainPane.tabs;
    expect(
      workstationTabs.some(
        (tab) =>
          tab.type === "chat-session" && tab.data.sessionId === "session-1"
      )
    ).toBe(false);
    expect(
      workstationTabs.some(
        (tab) =>
          tab.type === "chat-session" && tab.data.sessionId === "session-9"
      )
    ).toBe(true);
  });

  it("keeps every tab when the window command fails", async () => {
    vi.mocked(openSessionWindow).mockRejectedValueOnce(
      new Error("window build failed")
    );
    const store = createInstrumentedStore();
    store.set(sessionsAtom, [session("session-1", "Live session")]);
    store.set(chatPanelTabsAtom, chatState("session-1"));
    store.set(workstationLayoutAtom, {
      mainPane: {
        tabs: [createChatSessionTab("session-1", "Live session")],
        activeTabId: "chat-session:session-1",
      },
    });

    await expect(
      store.set(openSessionInNewWindowAtom, { sessionId: "session-1" })
    ).rejects.toThrow("window build failed");

    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some(
          (tab) => tab.type === "session" && tab.sessionId === "session-1"
        )
    ).toBe(true);
    expect(
      store
        .get(workstationLayoutAtom)
        .mainPane.tabs.some(
          (tab) =>
            tab.type === "chat-session" && tab.data.sessionId === "session-1"
        )
    ).toBe(true);
  });

  it("ignores a blank session id without invoking the window command", async () => {
    const store = createInstrumentedStore();

    const opened = await store.set(openSessionInNewWindowAtom, {
      sessionId: "   ",
    });

    expect(opened).toBe(false);
    expect(vi.mocked(openSessionWindow)).not.toHaveBeenCalled();
  });
});
