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
  onAddApiKey: vi.fn(),
  onInstallLatestUpdate: vi.fn(),
};

describe("ChatPanelStartPage", () => {
  it("renders no utility actions for other More targets", () => {
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
        createTarget: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
        moreLauncher: (_manualMiddleContent, modeControl) =>
          createElement(
            "div",
            { "data-testid": "embedded-more-creator" },
            "Embedded creator",
            modeControl
          ),
        t,
      })
    );

    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-utility-actions"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
    expect(markup).not.toContain("Install latest update");
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-import-session"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-add-api-key"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-show-runtime"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-create-target-select"'
    );
    expect(markup).toContain("select-size-large");
    expect(markup).toContain("select-bare");
    expect(markup).toContain("select-title-row");
    expect(markup).not.toContain("select-ghost");
    expect(markup).toContain("GitHub Issues project");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-trailing-control"'
    );
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-trailing-separator"'
    );
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
    expect(
      markup.match(/data-testid="chat-panel-start-page-trailing-separator"/g)
    ).toHaveLength(1);
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-project-mode-separator"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-project-mode-toggle"'
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
        createTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        sessionLauncher: (heroFooterSlot) =>
          createElement("div", null, "Session launcher", heroFooterSlot),
        t,
      })
    );

    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
  });

  it("does not render suggestion cards for a new Project", () => {
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
        t,
      })
    );

    expect(markup).toContain(
      'data-testid="chat-panel-start-page-project-mode-toggle"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-import-session"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-add-api-key"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-show-runtime"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );
  });

  it("renders install, import session, add API key then runtime on Session", () => {
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
        createTarget: CHAT_PANEL_CREATE_TARGET.AGENT_SESSION,
        sessionLauncher: (heroFooterSlot) =>
          createElement("div", null, "Session launcher", heroFooterSlot),
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

    const updateIndex = markup.indexOf(
      'data-testid="chat-panel-start-page-install-latest-update"'
    );

    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(importSessionIndex).toBeGreaterThan(updateIndex);
    expect(addApiKeyIndex).toBeGreaterThan(importSessionIndex);
    expect(showRuntimeIndex).toBeGreaterThan(addApiKeyIndex);
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
        t,
        workItemAgentMode: false,
        workItemLauncher: (manualMiddleContent, modeControl) =>
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
    expect(markup).toContain("creator.manualPlanLaunchpadQuestion");
    expect(markup).toContain(
      'data-testid="chat-panel-start-page-manual-middle-content"'
    );
    expect(markup).toContain('aria-pressed="false"');
    expect(markup.indexOf('data-testid="full-work-item-creator"')).toBeLessThan(
      markup.indexOf(
        'data-testid="chat-panel-start-page-work-item-mode-toggle"'
      )
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-utility-actions"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-add-api-key"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-show-runtime"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-import-session"'
    );
    expect(markup).not.toContain(
      'data-testid="chat-panel-start-page-install-latest-update"'
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
        createTarget: CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT,
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
