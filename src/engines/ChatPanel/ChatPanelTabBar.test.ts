import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type {
  ChatPanelSelectedProject,
  ChatPanelSelectedWorkItem,
} from "@src/store/ui/chatPanelAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
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
    expect(markup).toMatch(
      /bg-gradient-to-l[^"<]*transition-opacity[^"<]*duration-150[^"<]*opacity-0/
    );
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

  it("formats project creation as a Workstation-style project tab", () => {
    const store = createStore();
    store.set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.PROJECT);

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain("creator.createTarget.project");
    expect(markup).toContain("lucide-box");
    expect(markup).toContain("work-station-editor-tab");
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

  it("uses entity icons for local project and work-item tabs", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "project-local",
          type: "project",
          title: "Local project",
          project: {
            project: { id: "project-local", name: "Local project" },
            projectSlug: "local-project",
            orgId: "personal-org",
          } as ChatPanelSelectedProject,
        },
        {
          id: "work-item-local",
          type: "work-item",
          title: "Local work item",
          workItem: {
            workItem: {
              session_id: "work-item-local",
              name: "Local work item",
              status: "backlog",
              workItemStatus: "backlog",
            },
            shortId: "LOCAL-1",
            projectId: "project-local",
            projectName: "Local project",
            projectSlug: "local-project",
          } as ChatPanelSelectedWorkItem,
        },
      ],
      activeTabId: "project-local",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain("lucide-box");
    expect(markup).toContain("lucide-list-checks");
  });

  it("offers the supported creation surfaces in the new-tab menu", () => {
    const markup = renderToStaticMarkup(
      createElement(PlusMenuContent, {
        onOpenLaunchpad: vi.fn(),
        onOpenKanban: vi.fn(),
        onOpenRuntime: vi.fn(),
        onNewProject: vi.fn(),
        onNewWorkItem: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(markup).toContain("sessions:chat.startPage.tabs.runtime");
    expect(markup).toContain("creator.createTarget.project");
    expect(markup).toContain("chat.startPage.newWorkItem.title");
  });
});
