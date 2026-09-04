import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RemoteSessionChatPanelSurface } from "./RemoteSessionChatPanelSurface";

vi.mock("@src/components/SelectorPill", () => ({
  default: ({ label, disabled }: { label: string; disabled?: boolean }) =>
    React.createElement("span", {
      "data-selector-pill": label,
      "data-disabled": disabled,
    }),
}));

const capturedShellProps = vi.fn();

vi.mock("../ChatPanelShell", () => ({
  ChatPanelShell: (props: {
    headerSection: ReactNode;
    chatColumn: ReactNode;
    terminalTabs: unknown[];
    activeTab: null;
    isTerminalTabActive: boolean;
  }) => {
    capturedShellProps(props);
    return React.createElement(
      "div",
      { "data-shared-chat-panel-shell": true },
      props.headerSection,
      props.chatColumn
    );
  },
}));

vi.mock("../InputArea/components/SessionReadOnlyBar", () => ({
  default: ({
    label,
    placeholder,
    showContextInfo,
    pills,
  }: {
    label: string;
    placeholder: string;
    showContextInfo: boolean;
    pills: ReactNode;
  }) =>
    React.createElement(
      "div",
      {
        "data-shared-read-only-composer": true,
        "data-label": label,
        "data-placeholder": placeholder,
        "data-show-context": showContextInfo,
      },
      pills
    ),
}));

vi.mock("../header", () => ({
  ChatPanelPublishedHeader: ({
    slots,
  }: {
    slots: { content: ReactNode; trailing: ReactNode };
  }) =>
    React.createElement(
      "header",
      { "data-shared-published-header": true },
      slots.content,
      slots.trailing
    ),
}));

vi.mock("./SessionTranscriptSurface", () => ({
  SessionTranscriptSurface: () =>
    React.createElement("div", { "data-shared-transcript": true }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => {
      const labels: Record<string, string> = {
        "web.readOnly.headerTrailing": "Cloud · Read only",
        "web.readOnly.barLabel": "Read only",
        "web.readOnly.barPlaceholder": "Cloud session is read-only",
      };
      return labels[key] ?? defaultValue ?? key;
    },
  }),
}));

describe("RemoteSessionChatPanelSurface", () => {
  it("passes terminal-safe shell props for read-only remote sessions", () => {
    capturedShellProps.mockClear();
    renderToStaticMarkup(
      React.createElement(RemoteSessionChatPanelSurface, {
        sessionId: "session-1",
        events: [],
        runtime: {
          loadStatus: "loaded",
          loadError: null,
          isAgentWorking: false,
          onReload: vi.fn(),
        },
      })
    );

    expect(capturedShellProps).toHaveBeenCalledWith(
      expect.objectContaining({
        activeTab: null,
        terminalTabs: [],
        isTerminalTabActive: false,
      })
    );
  });

  it("composes the remote transcript without a tab row or replay controls", () => {
    capturedShellProps.mockClear();
    const markup = renderToStaticMarkup(
      React.createElement(RemoteSessionChatPanelSurface, {
        sessionId: "session-1",
        agentDisplayName: "SDE Agent",
        events: [],
        runtime: {
          loadStatus: "loaded",
          loadError: null,
          isAgentWorking: false,
          onReload: vi.fn(),
        },
      })
    );

    expect(markup).toContain("data-remote-session-chat-panel");
    expect(markup).toContain("data-shared-chat-panel-shell");
    expect(markup).toContain("data-shared-published-header");
    expect(markup).toContain("data-shared-transcript");
    expect(markup).toContain("data-shared-read-only-composer");
    expect(markup).toContain('data-placeholder="Cloud session is read-only"');
    expect(markup).toContain('data-show-context="false"');
    expect(markup).toContain('data-selector-pill="SDE Agent"');
    expect(markup).toContain("Cloud · Read only");
    expect(markup).not.toContain("data-shared-tab-pill");
    expect(markup).not.toContain("data-shared-replay-controls");
    expect(markup).not.toContain("Cloud replay");
  });
});
