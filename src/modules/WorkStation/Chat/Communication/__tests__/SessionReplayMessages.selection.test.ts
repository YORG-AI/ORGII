import { Provider } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionReplayMessages } from "..";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "simulator.replay.channelsSidebar.messages" ? "Messages" : key,
  }),
}));

vi.mock(
  "@src/engines/ChatPanel/InputArea/components/useAgentOrgRunView",
  () => ({
    useAgentOrgRunView: () => ({ view: null }),
  })
);

vi.mock("@src/engines/ChatPanel/adapters/EventWrapper", () => ({
  default: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  FileHeader: () => React.createElement("header"),
  SimulatorReplayChrome: ({ children }: { children?: React.ReactNode }) =>
    children,
  WorkStationShell: ({ content }: { content?: React.ReactNode }) => content,
  buildPrimarySidebarConfig: (config: unknown) => config,
}));

vi.mock("@src/modules/WorkStation/shared/SelectedTextAddToChat", () => ({
  SelectedTextAddToChat: ({
    children,
    displayName,
    enabled,
    scopeKey,
  }: {
    children?: React.ReactNode;
    displayName: string;
    enabled?: boolean;
    scopeKey?: string | number;
  }) =>
    React.createElement(
      "div",
      {
        "data-selected-text-owner": displayName,
        "data-selection-enabled": enabled,
        "data-selection-scope": scopeKey,
      },
      children
    ),
}));

vi.mock("../components/CommunicationMessageContent", () => ({
  CommunicationMessageContent: () =>
    React.createElement("div", { "data-testid": "message-content" }),
}));

vi.mock("../hooks/usePlanReplayIntent", () => ({
  usePlanReplayIntent: () => ({
    effectiveViewMode: "chat",
    effectivePreviewMode: false,
    handleViewModeChange: vi.fn(),
    handlePreviewModeChange: vi.fn(),
  }),
}));

vi.mock("../messageViewModel", () => ({
  buildCommunicationMessageViewModel: () => ({ previewMessages: [] }),
  selectCommunicationMessages: () => [],
}));

vi.mock("../useMessages", () => ({
  useMessages: () => ({
    viewMode: "chat",
    setViewMode: vi.fn(),
    chatMessages: [],
    interactionMessages: [],
    state: {
      thinkMessages: [],
      todoMessages: [],
      selectedMessage: null,
      currentEventId: "event-1",
    },
    hasLocalSelection: false,
    jumpToMessage: vi.fn(),
  }),
}));

vi.mock("../usePlanApproval", () => ({
  usePlanApproval: () => ({
    activePlanMessage: null,
    pendingPlanId: null,
    planPath: null,
    isPlanDoc: false,
    isPlanPending: false,
    isEditing: false,
    editedContent: "",
    submitting: false,
    buildDisabled: false,
    setEditedContent: vi.fn(),
    handleEditToggle: vi.fn(),
    handleSave: vi.fn(),
  }),
}));

vi.mock("../useReplayTabs", () => ({
  useReplayTabs: () => ({
    replayTabs: [],
    activeTabId: null,
    handleTabClick: vi.fn(),
  }),
}));

function renderMessages(mode: "interactive" | "simulation"): string {
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      null,
      React.createElement(SessionReplayMessages, {
        mode,
        sessionId: "session-a",
      })
    )
  );
}

describe("SessionReplayMessages selected-text ownership", () => {
  it("mounts the shared Add to Chat owner for simulation replay", () => {
    const markup = renderMessages("simulation");

    expect(markup).toContain('data-selected-text-owner="Messages"');
    expect(markup).toContain('data-selection-enabled="true"');
    expect(markup).toContain('data-selection-scope="session-a:chat"');
    expect(markup).toContain('data-testid="message-content"');
  });

  it("keeps selection disabled in interactive mode", () => {
    const markup = renderMessages("interactive");

    expect(markup).toContain('data-selection-enabled="false"');
  });
});
