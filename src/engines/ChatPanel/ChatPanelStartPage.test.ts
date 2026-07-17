import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatPanelStartPage } from "./ChatPanelStartPage";

const mocks = vi.hoisted(() => ({
  useAvailableAppUpdate: vi.fn(),
}));

vi.mock("@src/scaffold/AppUpdater", () => ({
  useAvailableAppUpdate: mocks.useAvailableAppUpdate,
}));

describe("ChatPanelStartPage", () => {
  it("renders the install-latest-update work action", () => {
    mocks.useAvailableAppUpdate.mockReturnValue({
      available: true,
      version: "1.1.20",
    });
    const t = ((key: string) => {
      if (key === "chat.startPage.installLatestUpdate.title") {
        return "Install latest update";
      }
      return key;
    }) as TFunction<["sessions", "common", "projects", "navigation"]>;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        onNewWorkItem: vi.fn(),
        t,
      })
    );

    expect(markup).toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
    expect(markup).toContain("Install latest update");
    expect(markup).toContain("text-text-2");
    expect(markup).not.toContain("group-hover:text-warning-6");
    expect(markup).toContain("gap-2");
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("p-2");
    expect(markup).toContain("bg-warning-6/5");
    expect(markup).toContain("@[800px]/startactions:grid-cols-4");

    const updateIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
    const importSessionIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-import-session"'
    );
    const newWorkItemIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-new-work-item"'
    );

    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(importSessionIndex).toBeGreaterThan(updateIndex);
    expect(newWorkItemIndex).toBeGreaterThan(importSessionIndex);
  });

  it("hides the install action when no update has been detected", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        onNewWorkItem: vi.fn(),
        t,
      })
    );

    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
  });

  it("renders import session before the matching work actions", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        onNewWorkItem: vi.fn(),
        t,
      })
    );

    const newWorkItemIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-new-work-item"'
    );
    const importSessionIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-import-session"'
    );
    const addApiKeyIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-add-api-key"'
    );

    expect(importSessionIndex).toBeGreaterThanOrEqual(0);
    expect(newWorkItemIndex).toBeGreaterThan(importSessionIndex);
    expect(addApiKeyIndex).toBeGreaterThan(newWorkItemIndex);
    expect(markup).toContain("navigation:cloud.share.importEntry");
    expect(markup.match(/border-border-2/g)).toHaveLength(3);
    expect(markup.match(/hover:border-border-3/g)).toHaveLength(3);
    expect(markup).not.toContain("group-hover:bg-fill-3");
  });

  it("centers the session launcher and keeps Work actions at the bottom", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        onNewWorkItem: vi.fn(),
        sessionLauncher: createElement("div", null, "Session launcher"),
        t,
      })
    );

    expect(markup).toContain(
      'data-testid="chat-panel-start-page-session-launcher"'
    );
    expect(markup).toContain('data-testid="chat-panel-start-page-tabs"');
    expect(markup).toContain('data-testid="chat-panel-start-page-tab-runtime"');
    expect(markup).toContain("chat.startPage.tabs.manage");
    expect(markup).not.toContain("chat.startPage.tabs.explore");
    expect(markup).toContain('data-testid="chat-panel-start-page-actions"');
    expect(markup).toContain("Session launcher");
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-new-session"'
    );
  });
});
