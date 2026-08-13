import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";

import { ChatPanelStartPage } from "./ChatPanelStartPage";

const mocks = vi.hoisted(() => ({
  useAvailableAppUpdate: vi.fn(),
}));

vi.mock("@src/scaffold/AppUpdater", () => ({
  useAvailableAppUpdate: mocks.useAvailableAppUpdate,
}));

const createTargetProps = {
  createTarget: CHAT_PANEL_CREATE_TARGET.PROJECT,
  createTargetOptions: [
    { value: CHAT_PANEL_CREATE_TARGET.PROJECT, label: "Create project" },
    {
      value: CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS,
      label: "Manage Agents / Skills",
    },
    {
      value: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
      label: "GitHub Issues project",
    },
    { value: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG, label: "Add ORG" },
  ],
  onCreateTarget: vi.fn(),
  onProjectAgentModeChange: vi.fn(),
  onShowRuntime: vi.fn(),
  onWorkItemAgentModeChange: vi.fn(),
  projectAgentMode: true,
  workItemAgentMode: true,
  moreLauncher: (...content: React.ReactNode[]) =>
    createElement("div", null, ...content),
};

describe("ChatPanelStartPage", () => {
  it("renders the install-latest-update action in More", () => {
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
        ...createTargetProps,
        moreLauncher: (middleContent, _manualMiddleContent, modeControl) =>
          createElement(
            "div",
            { "data-testid": "embedded-more-creator" },
            "Embedded creator",
            middleContent,
            modeControl
          ),
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
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
    expect(markup).toContain("rounded-lg");
    expect(markup).toContain("mx-auto w-full");
    expect(markup).toContain("min-h-[68px]");
    expect(markup).toContain("px-2.5 py-2");
    expect(markup).toContain("border-warning-6/20");
    expect(markup).toContain("text-warning-6");
    expect(markup).toContain("hidden @[640px]/focusedchat:block");
    expect(markup).toContain("@[560px]/startactions:grid-cols-4");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-create-target-select"'
    );
    expect(markup).toContain("select-size-large");
    expect(markup).toContain("select-ghost");
    expect(markup).toContain("Create project");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-trailing-control"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-trailing-separator"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-project-mode-toggle"'
    );
    expect(markup).toContain("common:terminology.agent");
    expect(markup).toContain('aria-pressed="true"');
    expect(
      markup.indexOf('data-testid="chat-panel-start-page-tab-more"')
    ).toBeLessThan(
      markup.indexOf('data-testid="chat-panel-start-page-trailing-control"')
    );
    expect(
      markup.indexOf('data-testid="chat-panel-start-page-trailing-control"')
    ).toBeLessThan(
      markup.indexOf('data-testid="chat-panel-start-page-create-target-select"')
    );
    expect(markup).toContain("inline-flex h-[28px]");
    expect(markup.indexOf('data-testid="embedded-more-creator"')).toBeLessThan(
      markup.indexOf('data-testid="chat-panel-start-page-project-mode-toggle"')
    );
    expect(
      markup.match(/data-testid="chat-panel-start-page-trailing-separator"/g)
    ).toHaveLength(1);
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-project-mode-separator"'
    );
    expect(markup).not.toContain("Agent session");
    expect(markup).not.toContain("Create Work Item");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-more-launcher"'
    );
    expect(markup).toContain('data-testid="embedded-more-creator"');
    expect(markup).toContain(
      'class="flex h-full min-h-0 w-full flex-col overflow-hidden" data-testid="chat-panel-start-page-more-launcher"><div data-testid="embedded-more-creator"'
    );

    const updateIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
    const importSessionIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-import-session"'
    );
    const addApiKeyIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-add-api-key"'
    );
    const showRuntimeIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-show-runtime"'
    );

    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(importSessionIndex).toBeGreaterThan(updateIndex);
    expect(addApiKeyIndex).toBeGreaterThan(importSessionIndex);
    expect(showRuntimeIndex).toBeGreaterThan(addApiKeyIndex);
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-new-work-item"'
    );
  });

  it("hides the install action when no update has been detected", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        ...createTargetProps,
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        t,
      })
    );

    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
  });

  it("renders import session before add API key in More", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        ...createTargetProps,
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        t,
      })
    );

    const importSessionIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-import-session"'
    );
    const addApiKeyIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-add-api-key"'
    );
    const showRuntimeIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-show-runtime"'
    );

    expect(importSessionIndex).toBeGreaterThanOrEqual(0);
    expect(addApiKeyIndex).toBeGreaterThan(importSessionIndex);
    expect(showRuntimeIndex).toBeGreaterThan(addApiKeyIndex);
    expect(markup).toContain("@[440px]/startactions:grid-cols-3");
    expect(markup).toContain("navigation:cloud.share.importEntry");
    expect(markup).toContain("border-border-2");
    expect(markup).toContain("hover:border-border-3");
    expect(markup).toContain("bg-transparent");
    expect(markup).not.toContain("bg-bg-1");
    expect(markup).toContain("hover:bg-surface-hover");
    expect(markup).not.toContain("group-hover:bg-fill-3");
  });

  it("renders the full work-item creator inside the Work Item tab", () => {
    mocks.useAvailableAppUpdate.mockReturnValue({
      available: true,
      version: "1.1.20",
    });
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        ...createTargetProps,
        createTarget: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        t,
        workItemAgentMode: false,
        workItemLauncher: (
          _suggestionPills,
          manualMiddleContent,
          modeControl
        ) =>
          createElement(
            "div",
            { "data-testid": "full-work-item-creator" },
            "Full work item creator",
            manualMiddleContent,
            modeControl
          ),
      })
    );

    expect(markup).toContain(
      'data-testid="chat-panel-start-page-work-item-launcher"'
    );
    expect(markup).toContain('data-testid="full-work-item-creator"');
    expect(markup).toContain("Full work item creator");
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-trailing-control"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-work-item-mode-toggle"'
    );
    expect(markup).toContain("common:tooltips.manual");
    expect(markup).toContain("creator.manualLaunchpadQuestion");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-manual-middle-content"'
    );
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("inline-flex h-[28px]");
    expect(markup.indexOf('data-testid="full-work-item-creator"')).toBeLessThan(
      markup.indexOf(
        'data-testid="chat-panel-start-page-work-item-mode-toggle"'
      )
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-utility-actions"'
    );
    expect(markup).toContain('data-testid="chat-panel-start-page-add-api-key"');
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-show-runtime"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-import-session"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
    expect(markup.indexOf("creator.manualLaunchpadQuestion")).toBeLessThan(
      markup.indexOf('data-testid="chat-panel-start-page-import-session"')
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-new-work-item"'
    );
  });

  it("only shows the Project mode toggle for the Project target", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        ...createTargetProps,
        createTarget: CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS,
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        t,
      })
    );

    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-project-mode-toggle"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-project-mode-separator"'
    );
  });

  it("fills the Session launchpad beneath the tabs", () => {
    mocks.useAvailableAppUpdate.mockReturnValue(null);
    const t = ((key: string) => key) as TFunction<
      ["sessions", "common", "projects", "navigation"]
    >;

    const markup = renderToStaticMarkup(
      createElement(ChatPanelStartPage, {
        ...createTargetProps,
        createTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        onAddApiKey: vi.fn(),
        onInstallLatestUpdate: vi.fn(),
        sessionLauncher: (heroFooterSlot) =>
          createElement("div", null, "Session launcher", heroFooterSlot),
        t,
      })
    );

    expect(markup).toContain(
      'data-testid="chat-panel-start-page-session-launcher"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-session-content"'
    );
    expect(markup).toContain("flex h-full min-h-0 w-full");
    expect(markup).toContain('class="h-full w-full"');
    expect(markup).toContain('data-testid="chat-panel-start-page-tabs"');
    expect(markup).toContain('data-testid="chat-panel-start-page-tab-session"');
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-tab-work-item"'
    );
    expect(markup).toContain('data-testid="chat-panel-start-page-tab-more"');
    expect(markup).toContain("chat.startPage.tabs.session");
    expect(markup).toContain("chat.startPage.tabs.workItem");
    expect(markup).toContain("chat.startPage.tabs.more");
    expect(markup).not.toContain("chat.startPage.tabs.manage");
    expect(markup).not.toContain("chat.startPage.tabs.runtime");
    expect(markup).not.toContain('data-testid="chat-panel-start-page-hints"');
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-utility-actions"'
    );
    expect(markup).toContain('data-testid="chat-panel-start-page-add-api-key"');
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-show-runtime"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-import-session"'
    );
    expect(markup).toContain("Session launcher");
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-new-session"'
    );
  });
});
