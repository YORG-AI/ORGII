/** @vitest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplayPhase } from "@src/engines/SessionCore/replay/replayController";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { WebSessionPage } from "./WebSessionPage";

const testState = vi.hoisted(() => ({
  viewportWidth: 1440,
  replayState: {
    phase: "follow" as ReplayPhase,
    index: 0,
    speed: 1,
    isPlaying: false,
  },
  cloudEvents: [] as Array<{ id: string }>,
  lastChatPanelEvents: null as readonly { id: string }[] | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => {
      const labels: Record<string, string> = {
        "web.sessionPage.chatTab": "Chat",
        "web.sessionPage.workstationTab": "WorkStation",
        "web.sessionPage.notFound": "Session not found",
        "web.sessionPage.notFoundHint": "Missing",
        "web.sessionPage.loading": "Loading session…",
      };
      return labels[key] ?? defaultValue ?? key;
    },
  }),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ orgId: "org-1", sessionId: "session-1" }),
}));

vi.mock("@src/components/TabPill", () => ({
  default: ({
    tabs,
    onChange,
  }: {
    tabs: Array<{ key: string; label: string }>;
    onChange: (key: string) => void;
  }) =>
    React.createElement(
      "div",
      null,
      tabs.map((tab) =>
        React.createElement(
          "button",
          { key: tab.key, onClick: () => onChange(tab.key) },
          tab.label
        )
      )
    ),
}));

vi.mock(
  "@src/engines/ChatPanel/components/RemoteSessionChatPanelSurface",
  () => ({
    RemoteSessionChatPanelSurface: ({
      events,
    }: {
      events: readonly { id: string }[];
    }) => {
      testState.lastChatPanelEvents = events;
      return React.createElement("div", { "data-remote-chat-panel": true });
    },
  })
);

vi.mock(
  "@src/engines/Simulator/components/RemoteSessionReplayControls",
  () => ({
    RemoteSessionReplayControls: () =>
      React.createElement("div", { "data-replay-controls": true }),
  })
);

vi.mock("@src/engines/ChatPanel/hooks/useViewportWidth", () => ({
  useViewportWidth: () => testState.viewportWidth,
}));

vi.mock("@src/engines/SessionCore/replay/useReplayController", () => ({
  useReplayController: () => ({
    state: testState.replayState,
    seek: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    browse: vi.fn(),
    follow: vi.fn(),
    setSpeed: vi.fn(),
  }),
}));

vi.mock(
  "@src/engines/Simulator/components/RemoteSessionWorkstationSurface",
  () => ({
    RemoteSessionWorkstationSurface: () =>
      React.createElement("div", { "data-workstation-content": true }),
  })
);

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => null,
}));

vi.mock("./WebSessionCommentsHeaderExtras", () => ({
  default: () => React.createElement("div", { "data-web-notes": true }),
}));

vi.mock("./WebSessionHeaderViewControls", () => ({
  WebSessionHeaderViewControls: () =>
    React.createElement("div", { "data-web-session-header": true }),
}));

vi.mock("./WebSessionAlternateSurface", () => ({
  WebSessionAlternateSurface: () =>
    React.createElement("div", { "data-web-alternate-view": true }),
}));

vi.mock("./useWebSessionViewMode", () => ({
  useWebSessionViewMode: () => ({
    mode: "gui",
    isRaw: false,
    switchable: true,
    options: [],
    onChange: vi.fn(),
    showRaw: vi.fn(),
    transcript: {
      copyTranscript: vi.fn(),
      entries: [],
      error: null,
      loadTranscript: vi.fn(),
      loading: false,
      snapshot: null,
      sourceLabel: "",
      transcriptJson: "",
    },
  }),
}));

vi.mock("@src/engines/ChatPanel/components/SessionViewSwitcher", () => ({
  SessionRawToolbarActions: () => null,
}));

vi.mock("./WebSessionsContext", () => ({
  useWebSessions: () => ({
    status: "success",
    sessions: [
      {
        id: "session-1",
        orgId: "org-1",
        orgName: "ORG2",
        title: "Session",
        sourceSessionId: "source-session-1",
        status: "stopped",
        agentDisplayName: "Codex",
      },
    ],
  }),
}));

vi.mock("./useCloudSessionEvents", () => ({
  useCloudSessionEvents: () => ({
    events: testState.cloudEvents,
    status: "success",
    error: null,
    refresh: vi.fn(),
  }),
}));

describe("WebSessionPage pane composition", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  beforeEach(() => {
    testState.viewportWidth = 1440;
    testState.replayState = {
      phase: "follow",
      index: 0,
      speed: 1,
      isPlaying: false,
    };
    testState.cloudEvents = [];
    testState.lastChatPanelEvents = null;
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
  });

  it("renders ChatPanel on the left and WorkStation on the right", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(React.createElement(WebSessionPage));

    const paneOrder = Array.from(
      root.container.querySelectorAll<HTMLElement>("[data-session-pane]")
    ).map((element) => element.dataset.sessionPane);

    expect(paneOrder).toEqual(["chat", "workstation"]);
    expect(root.container.querySelector("main > header")).toBeNull();
    expect(
      root.container.querySelector(
        "[data-testid='web-session-workstation-context']"
      )
    ).toBeNull();
    expect(
      root.container.querySelector("[data-remote-chat-panel]")
    ).not.toBeNull();
    const chatPane = root.container.querySelector('[data-session-pane="chat"]');
    const workstationPane = root.container.querySelector(
      '[data-session-pane="workstation"]'
    );
    expect(chatPane?.querySelector("[data-replay-controls]")).toBeNull();
    expect(
      workstationPane?.querySelector("[data-session-replay-host]")
    ).not.toBeNull();
    expect(
      workstationPane?.querySelector("[data-replay-controls]")
    ).not.toBeNull();
  });

  it("defaults to Chat on narrow screens and can switch to WorkStation", async () => {
    testState.viewportWidth = 800;
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(React.createElement(WebSessionPage));

    expect(
      root.container.querySelector<HTMLElement>("[data-session-pane]")?.dataset
        .sessionPane
    ).toBe("chat");

    const workstationButton = Array.from(
      root.container.querySelectorAll("button")
    ).find((button) => button.textContent === "WorkStation");
    expect(workstationButton).toBeDefined();

    await dispatch(() => workstationButton?.click());

    expect(
      root.container.querySelector<HTMLElement>("[data-session-pane]")?.dataset
        .sessionPane
    ).toBe("workstation");
  });

  it("passes full transcript events to chat while replay scrubs workstation only", async () => {
    testState.cloudEvents = [
      { id: "event-1" },
      { id: "event-2" },
      { id: "event-3" },
    ];
    testState.replayState = {
      phase: "paused",
      index: 1,
      speed: 1,
      isPlaying: false,
    };

    const root = createSmokeRoot();
    roots.push(root);
    await root.render(React.createElement(WebSessionPage));

    expect(testState.lastChatPanelEvents?.map((event) => event.id)).toEqual([
      "event-1",
      "event-2",
      "event-3",
    ]);
  });
});
