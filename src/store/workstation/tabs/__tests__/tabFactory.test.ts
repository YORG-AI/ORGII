/**
 * Tab Factory Tests
 *
 * Tests for defineTabFactory and all tab factory implementations.
 */
import { describe, expect, it } from "vitest";

import {
  STORY_ORG_SCOPE,
  STORY_PERSONAL_ORG_FILTER_ID,
  STORY_PERSONAL_ORG_NAME,
  createBrowserSessionTab,
  createChatSessionTab,
  createFileTab,
  createGitDiffTab,
  createGitHubIssueDetailTab,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  createProjectWorkItemsTab,
  createSearchTab,
  createSettingsTab,
  createSourceControlTab,
  createSubagentDetailTab,
  createTerminalTab,
  createWorkItemDetailTab,
  fileTabFactory,
  settingsTabFactory,
} from "../factories";
import { defineTabFactory, getFileExtension, getFileName } from "../tabFactory";

// ============================================
// defineTabFactory Tests
// ============================================

describe("defineTabFactory", () => {
  describe("singleton ID strategy", () => {
    it("creates factory that always returns same ID", () => {
      const factory = defineTabFactory<Record<string, never>>({
        tabType: "settings",
        idStrategy: { type: "singleton", id: "settings:main" },
        getTitle: () => "Settings",
      });

      const tab1 = factory({});
      const tab2 = factory({});

      expect(tab1.id).toBe("settings:main");
      expect(tab2.id).toBe("settings:main");
    });
  });

  describe("keyed ID strategy", () => {
    it("creates factory that generates ID from data", () => {
      interface FileData {
        filePath: string;
      }

      const factory = defineTabFactory<FileData>({
        tabType: "file",
        idStrategy: {
          type: "keyed",
          prefix: "file",
          getKey: (data) => data.filePath,
        },
        getTitle: (data) => data.filePath.split("/").pop() || "",
      });

      const tab1 = factory({ filePath: "/src/index.ts" });
      const tab2 = factory({ filePath: "/src/app.tsx" });
      const tab3 = factory({ filePath: "/src/index.ts" });

      expect(tab1.id).toBe("file:/src/index.ts");
      expect(tab2.id).toBe("file:/src/app.tsx");
      expect(tab3.id).toBe("file:/src/index.ts"); // Same as tab1
    });
  });

  describe("unique ID strategy", () => {
    it("creates factory that generates unique IDs", () => {
      const factory = defineTabFactory<Record<string, never>>({
        tabType: "search",
        idStrategy: { type: "unique", prefix: "search" },
        getTitle: () => "Search",
      });

      const tab1 = factory({});
      const tab2 = factory({});

      expect(tab1.id).toMatch(/^search:\d+-[a-z0-9]+$/);
      expect(tab2.id).toMatch(/^search:\d+-[a-z0-9]+$/);
      expect(tab1.id).not.toBe(tab2.id);
    });
  });

  describe("tab properties", () => {
    it("sets icon from config", () => {
      const factory = defineTabFactory<Record<string, never>>({
        tabType: "settings",
        idStrategy: { type: "singleton", id: "settings:main" },
        getTitle: () => "Settings",
        icon: "Settings",
      });

      const tab = factory({});
      expect(tab.icon).toBe("Settings");
    });

    it("defaults closable to true", () => {
      const factory = defineTabFactory<Record<string, never>>({
        tabType: "settings",
        idStrategy: { type: "singleton", id: "settings:main" },
        getTitle: () => "Settings",
      });

      const tab = factory({});
      expect(tab.closable).toBe(true);
    });

    it("respects closable=false", () => {
      const factory = defineTabFactory<Record<string, never>>({
        tabType: "settings",
        idStrategy: { type: "singleton", id: "settings:main" },
        getTitle: () => "Settings",
        closable: false,
      });

      const tab = factory({});
      expect(tab.closable).toBe(false);
    });

    it("includes data in tab", () => {
      interface MyData {
        foo: string;
        bar: number;
      }

      const factory = defineTabFactory<MyData>({
        tabType: "file",
        idStrategy: { type: "singleton", id: "test" },
        getTitle: (data) => data.foo,
      });

      const tab = factory({ foo: "hello", bar: 42 });
      expect(tab.data).toEqual({ foo: "hello", bar: 42 });
    });
  });
});

// ============================================
// Helper Tests
// ============================================

describe("getFileName", () => {
  it("extracts file name from path", () => {
    expect(getFileName("/src/index.ts")).toBe("index.ts");
    expect(getFileName("/path/to/file.tsx")).toBe("file.tsx");
  });

  it("handles paths without directories", () => {
    expect(getFileName("file.ts")).toBe("file.ts");
  });

  it("handles empty path", () => {
    expect(getFileName("")).toBe("");
  });
});

describe("getFileExtension", () => {
  it("extracts extension from file name", () => {
    expect(getFileExtension("index.ts")).toBe("ts");
    expect(getFileExtension("app.tsx")).toBe("tsx");
    expect(getFileExtension("style.css")).toBe("css");
  });

  it("handles multiple dots", () => {
    expect(getFileExtension("file.test.ts")).toBe("ts");
    expect(getFileExtension("jquery.min.js")).toBe("js");
  });

  it("handles files without extension", () => {
    expect(getFileExtension("Makefile")).toBe("");
    // Note: .gitignore is treated as having extension "gitignore" by the current impl
    expect(getFileExtension(".gitignore")).toBe("gitignore");
  });
});

// ============================================
// Pre-defined Factory Tests
// ============================================

describe("Code Editor Factories", () => {
  describe("createFileTab", () => {
    it("creates file tab with correct structure", () => {
      const tab = createFileTab("/src/index.ts");

      expect(tab.id).toBe("file:/src/index.ts");
      expect(tab.type).toBe("file");
      expect(tab.title).toBe("index.ts");
      expect(tab.data.filePath).toBe("/src/index.ts");
      expect(tab.data.extension).toBe("ts");
    });

    it("includes targetLine when provided", () => {
      const tab = createFileTab("/src/index.ts", 42);
      expect(tab.data.targetLine).toBe(42);
    });

    it("includes defaultPreviewMode when provided", () => {
      const tab = createFileTab("/rules/rule.md", { defaultPreviewMode: true });
      expect(tab.data.defaultPreviewMode).toBe(true);
    });
  });

  describe("createGitDiffTab", () => {
    it("creates git diff tab", () => {
      const tab = createGitDiffTab("/src/index.ts", "M");

      expect(tab.id).toBe("git-diff:/src/index.ts");
      expect(tab.type).toBe("git-diff");
      expect(tab.data.gitStatusLetter).toBe("M");
    });
  });

  describe("createSourceControlTab", () => {
    it("creates the unified Source Control tab in Focus mode by default", () => {
      const tab = createSourceControlTab(5);

      expect(tab.id).toBe("source-control:changes");
      expect(tab.type).toBe("source-control");
      expect(tab.title).toBe("Review");
      // Unified surface: Source Control is a regular closable, unpinned tab.
      expect(tab.closable).toBe(true);
      expect(tab.pinned).toBe(false);
      expect(tab.data.mode).toBe("focus");
      expect(tab.data.staged).toBe(false);
      expect(tab.data.fileCount).toBe(5);
      expect(tab.data.focusPath).toBeNull();
    });

    it("creates a staged Source Control tab with focus path override", () => {
      const tab = createSourceControlTab(3, {
        mode: "all-changes",
        staged: true,
        focusPath: "/repo/src/foo.ts",
      });

      expect(tab.id).toBe("source-control:staged-changes");
      expect(tab.title).toBe("Review");
      expect(tab.data.mode).toBe("all-changes");
      expect(tab.data.staged).toBe(true);
      expect(tab.data.focusPath).toBe("/repo/src/foo.ts");
    });
  });

  describe("createTerminalTab", () => {
    it("creates terminal tab", () => {
      const tab = createTerminalTab("session-123", "bash");

      expect(tab.id).toBe("terminal:session-123");
      expect(tab.type).toBe("terminal");
      expect(tab.title).toBe("bash");
    });
  });

  describe("createSettingsTab", () => {
    it("creates singleton settings tab", () => {
      const tab1 = createSettingsTab();
      const tab2 = createSettingsTab();

      expect(tab1.id).toBe("settings:main");
      expect(tab2.id).toBe("settings:main");
      expect(tab1.icon).toBe("Settings");
    });
  });

  describe("createSearchTab", () => {
    it("creates unique search tabs", () => {
      const tab1 = createSearchTab();
      const tab2 = createSearchTab();

      expect(tab1.id).not.toBe(tab2.id);
      expect(tab1.type).toBe("search");
      expect(tab1.icon).toBe("Search");
    });

    it("includes initial state", () => {
      const tab = createSearchTab("/repo", {
        query: "test",
      });

      expect(tab.data.repoPath).toBe("/repo");
      expect(tab.data.initialQuery).toBe("test");
    });
  });
});

describe("Browser Factories", () => {
  describe("createBrowserSessionTab", () => {
    it("creates browser session tab", () => {
      const tab = createBrowserSessionTab("session-1", "https://example.com");

      expect(tab.id).toBe("browser-session:session-1");
      expect(tab.type).toBe("browser-session");
      expect(tab.title).toBe("example.com");
    });

    it("handles blank URLs", () => {
      const tab = createBrowserSessionTab("session-1", "about:blank");
      expect(tab.title).toBe("New Tab");
    });
  });
});

describe("Chat Factories", () => {
  describe("createChatSessionTab", () => {
    it("creates chat session tab", () => {
      const tab = createChatSessionTab("session-1", "Chat Title", "work-1");

      expect(tab.id).toBe("chat-session:session-1");
      expect(tab.type).toBe("chat-session");
      expect(tab.title).toBe("Chat Title");
      expect(tab.icon).toBeUndefined();
      expect(tab.data.workItemId).toBe("work-1");
    });
  });
});

describe("Project Manager Factories", () => {
  describe("createProjectDashboardTab", () => {
    it("creates workspace projects tab", () => {
      const tab = createProjectDashboardTab();

      expect(tab.id).toBe("project-dashboard:main");
      expect(tab.data.orgScope).toBe(STORY_ORG_SCOPE.ALL);
      expect(tab.icon).toBe("Box");
    });

    it("creates org-filtered projects tab", () => {
      const tab = createProjectDashboardTab({
        orgScope: STORY_ORG_SCOPE.PERSONAL_ORG,
        orgId: STORY_PERSONAL_ORG_FILTER_ID,
        orgName: STORY_PERSONAL_ORG_NAME,
      });

      expect(tab.id).toBe("project-dashboard:org:personal-org");
      expect(tab.title).toBe("Personal Org Projects");
    });
  });

  describe("createProjectWorkItemsIndexTab", () => {
    it("creates workspace work items tab", () => {
      const tab = createProjectWorkItemsIndexTab();

      expect(tab.id).toBe("project-work-items:main");
      expect(tab.data.orgScope).toBe(STORY_ORG_SCOPE.ALL);
      expect(tab.title).toBe("Work Items");
      expect(tab.icon).toBe("ListChecks");
    });

    it("creates org-filtered work items tab", () => {
      const tab = createProjectWorkItemsIndexTab({
        orgScope: STORY_ORG_SCOPE.PERSONAL_ORG,
        orgId: STORY_PERSONAL_ORG_FILTER_ID,
        orgName: STORY_PERSONAL_ORG_NAME,
      });

      expect(tab.id).toBe("project-work-items:org:personal-org");
      expect(tab.title).toBe("Personal Org Work Items");
    });
  });

  describe("createProjectWorkItemsTab", () => {
    it("creates project work items tab", () => {
      const tab = createProjectWorkItemsTab(
        "project-1",
        "My Project",
        "my-project"
      );

      expect(tab.id).toBe("project-workitems:project-1");
      expect(tab.title).toBe("My Project");
      expect(tab.icon).toBe("ChartNoAxesGantt");
    });
  });

  describe("createWorkItemDetailTab", () => {
    it("preserves GitHub issue status for tab icon selection", () => {
      const tab = createWorkItemDetailTab(
        "project-1",
        "ORGII issues",
        "issue-128",
        "community issue",
        "orgii-issues",
        undefined,
        undefined,
        "open"
      );

      expect(tab.data.workItemStatus).toBe("open");
    });

    it("isolates identical standalone short IDs by organization", () => {
      const personal = createWorkItemDetailTab(
        undefined,
        "Standalone Work Items",
        "WI-0001",
        "Personal item"
      );
      const cloud = createWorkItemDetailTab(
        undefined,
        "Cloud",
        "WI-0001",
        "Cloud item",
        undefined,
        undefined,
        undefined,
        undefined,
        "cloud-org"
      );

      expect(personal.id).not.toBe(cloud.id);
      expect(cloud.data.orgId).toBe("cloud-org");
    });
  });

  describe("createGitHubIssueDetailTab", () => {
    it("keeps independent state scope for each dedicated issue tab", () => {
      const tab = createGitHubIssueDetailTab(
        42,
        "Ship dedicated tabs",
        "/workspace/ORGII",
        "https://github.com/orgii/ORGII.git",
        "repo:/workspace/ORGII:issue:42"
      );

      expect(tab.id).toBe("github-issue-detail:/workspace/ORGII:42");
      expect(tab.data.stateScopeKey).toBe("repo:/workspace/ORGII:issue:42");
    });
  });
});

describe("Subagent Factories", () => {
  describe("createSubagentDetailTab", () => {
    it("creates unique subagent detail tabs", () => {
      const tab1 = createSubagentDetailTab("Task 1");
      const tab2 = createSubagentDetailTab("Task 2");

      expect(tab1.id).not.toBe(tab2.id);
      expect(tab1.title).toBe("Task 1");
      expect(tab1.icon).toBe("MessageSquare");
    });
  });
});

// ============================================
// Factory vs Creator Function Parity
// ============================================

describe("Factory and Creator Function Parity", () => {
  it("fileTabFactory produces same structure as createFileTab", () => {
    const viaCreator = createFileTab("/src/index.ts");
    const viaFactory = fileTabFactory({
      filePath: "/src/index.ts",
      extension: "ts",
      status: null,
    });

    expect(viaCreator.id).toBe(viaFactory.id);
    expect(viaCreator.type).toBe(viaFactory.type);
    expect(viaCreator.data.filePath).toBe(viaFactory.data.filePath);
  });

  it("settingsTabFactory produces same structure as createSettingsTab", () => {
    const viaCreator = createSettingsTab();
    const viaFactory = settingsTabFactory({});

    expect(viaCreator.id).toBe(viaFactory.id);
    expect(viaCreator.type).toBe(viaFactory.type);
    expect(viaCreator.icon).toBe(viaFactory.icon);
  });
});
