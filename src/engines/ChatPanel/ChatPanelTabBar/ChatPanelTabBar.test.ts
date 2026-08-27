import { Provider, createStore } from "jotai";
import { type ReactNode, createElement } from "react";
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

import { ChatPanelTabBar, PlusMenuContent } from "./index";

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

vi.mock(
  "@src/modules/ProjectManager/WorkItems/components/WorkItemHoverCard",
  () => ({
    default: ({
      workItem,
      position,
      children,
    }: {
      workItem?: { id: string; title: string; status: string };
      position?: string;
      children: ReactNode;
    }) =>
      createElement(
        "div",
        {
          "data-work-item-hover-card-id": workItem?.id,
          "data-work-item-hover-card-title": workItem?.title,
          "data-work-item-hover-card-status": workItem?.status,
          "data-work-item-hover-card-position": position,
        },
        children
      ),
  })
);

vi.mock("@src/components/PrHoverCard", () => ({
  default: ({
    pr,
    position,
    children,
  }: {
    pr?: {
      number: number;
      title: string;
      additions?: number | null;
      deletions?: number | null;
      updated_at?: string;
    };
    position?: string;
    children: ReactNode;
  }) =>
    createElement(
      "div",
      {
        "data-pr-hover-card-number": pr?.number,
        "data-pr-hover-card-title": pr?.title,
        "data-pr-hover-card-additions": pr?.additions,
        "data-pr-hover-card-deletions": pr?.deletions,
        "data-pr-hover-card-updated-at": pr?.updated_at,
        "data-pr-hover-card-position": position,
      },
      children
    ),
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
    const activeSurface = markup.match(
      /<div[^>]*work-station-editor-tab--active[^>]*>/
    )?.[0];
    expect(activeSurface).toContain("text-text-1");
    expect(activeSurface).not.toContain("text-primary-6");
    expect(markup).toMatch(
      /<svg[^>]*class="[^"]*lucide-layout-grid[^"]*text-text-1[^"]*"/
    );
    expect(markup).toContain("sessions:chat.startPage.newSession.title");
    expect(markup).not.toContain("navigation:routes.launchpad");
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

  it("uses the localized project label in the Workstation-style tab", () => {
    const store = createStore();
    store.set(chatPanelCreateTargetAtom, CHAT_PANEL_CREATE_TARGET.PROJECT);

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain("sessions:creator.createTarget.project");
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

  it("reuses the sidebar hover cards for work-item and pull-request tabs", () => {
    const store = createStore();
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: "work-item-local",
          type: "work-item",
          title: "Local work item",
          workItem: {
            workItem: {
              session_id: "work-item-local",
              name: "Local work item",
              status: "in_progress",
              workItemStatus: "in_progress",
            },
            shortId: "LOCAL-1",
            projectId: "project-local",
            projectName: "Local project",
            projectSlug: "local-project",
          } as ChatPanelSelectedWorkItem,
        },
        {
          id: "github-pr-42",
          type: "github-pr",
          title: "#42 Reuse previews",
          githubPr: {
            prNumber: 42,
            prTitle: "Reuse previews",
            prUrl: "https://github.com/orgii/orgii/pull/42",
            prStatus: "open",
            headBranch: "feature/reuse-previews",
            baseBranch: "develop",
            additions: 42,
            deletions: 7,
            updatedAt: "2026-08-13T10:00:00Z",
            repoPath: "/workspace/orgii",
          },
        },
      ],
      activeTabId: "github-pr-42",
    });

    const markup = renderToStaticMarkup(
      createElement(Provider, { store }, createElement(ChatPanelTabBar))
    );

    expect(markup).toContain('data-work-item-hover-card-id="work-item-local"');
    expect(markup).toContain('data-work-item-hover-card-status="in_progress"');
    expect(markup).toContain(
      'data-work-item-hover-card-position="bottom-start"'
    );
    expect(markup).toContain('data-pr-hover-card-number="42"');
    expect(markup).toContain('data-pr-hover-card-additions="42"');
    expect(markup).toContain('data-pr-hover-card-deletions="7"');
    expect(markup).toContain(
      'data-pr-hover-card-updated-at="2026-08-13T10:00:00Z"'
    );
    expect(markup).toContain('data-pr-hover-card-position="bottom-start"');
  });

  it("offers the supported creation surfaces in the new-tab menu", () => {
    const markup = renderToStaticMarkup(
      createElement(PlusMenuContent, {
        onOpenLaunchpad: vi.fn(),
        onOpenKanban: vi.fn(),
        onOpenRuntime: vi.fn(),
        onNewProject: vi.fn(),
        onNewWorkItem: vi.fn(),
        onOpenSideChat: vi.fn(),
        onClose: vi.fn(),
      })
    );

    expect(markup).toContain("sessions:chat.startPage.tabs.runtime");
    expect(markup).toContain("sessions:chat.startPage.newSession.title");
    expect(markup).toContain("sessions:creator.createTarget.project");
    expect(markup).toContain("chat.startPage.newWorkItem.title");
    expect(markup).toContain("sessions:chat.sideChat.title");
  });
});
