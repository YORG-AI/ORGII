import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";

import { ChatPanelTabBar, PlusMenuContent } from "./ChatPanelTabBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: ({ type, size }: { type: string; size: number }) =>
    createElement("span", {
      "data-integration-icon": type,
      "data-icon-size": size,
    }),
}));

describe("ChatPanelTabBar", () => {
  it("renders the close control inside the shared tab surface", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "launchpad-test",
          type: "start-page",
          title: "Launchpad",
        },
      ],
      activeTabId: "launchpad-test",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toMatch(
      /<div[^>]*work-station-editor-tab[^>]*role="tab"[^>]*>.*<button type="button"/s
    );
    expect(markup.match(/<button type="button"/g)).toHaveLength(1);
  });

  it("uses the GitHub SVG for a GitHub-imported project tab", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "project-orgii-issues",
          type: "project",
          title: "ORGII issues",
          project: {
            project: { id: "project-1", name: "ORGII issues" },
            projectSlug: "orgii-issues",
            projectSyncAdapterId: "github",
            orgId: "personal-org",
          } as ChatPanelSelectedProject,
        },
      ],
      activeTabId: "project-orgii-issues",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain('data-integration-icon="github"');
    expect(markup).toContain('data-icon-size="16"');
  });

  it("uses the GitHub SVG for a GitHub issue tab", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "work-item-128",
          type: "work-item",
          title: "community issue",
          workItem: {
            workItem: {
              session_id: "issue-128",
              name: "community issue",
              status: "open",
              workItemStatus: "open",
            },
            shortId: "128",
            projectId: "project-1",
            projectName: "ORGII issues",
            projectSlug: "orgii-issues",
          } as ChatPanelSelectedWorkItem,
        },
      ],
      activeTabId: "work-item-128",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain('data-integration-icon="github"');
    expect(markup).toContain('data-icon-size="16"');
    expect(markup).toContain("max-w-[120px]");
    expect(markup).toContain("text-ellipsis");
    expect(markup).not.toContain("max-w-none");
  });

  it("offers Runtime and Changelog in the new-tab menu", () => {
    const markup = renderToStaticMarkup(
      createElement(PlusMenuContent, {
        onOpenChangelog: vi.fn(),
        onOpenLaunchpad: vi.fn(),
        onOpenKanban: vi.fn(),
        onOpenRuntime: vi.fn(),
        onNewWorkItem: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(markup).toContain("sessions:chat.startPage.tabs.runtime");
    expect(markup).toContain("navigation:routes.changelog");
    expect(markup).toContain("chat.startPage.newWorkItem.title");
  });
});
