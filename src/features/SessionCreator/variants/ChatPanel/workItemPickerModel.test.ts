import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EnrichedWorkItem,
  WorkspaceWorkItemsData,
} from "@src/api/http/project";
import type { OpenPRItem } from "@src/api/tauri/github";

import {
  type WorkItemPickerOption,
  filterWorkItemPickerOptions,
  githubWorkItemsToPickerOptions,
  loadWorkspaceWorkItemOptions,
  workspaceWorkItemsToPickerOptions,
} from "./workItemPickerModel";

const projectApiMocks = vi.hoisted(() => ({
  readWorkspaceWorkItemsData: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: projectApiMocks,
}));

function enrichedWorkItem(
  index: number,
  shortId: string = `WI-${index}`
): EnrichedWorkItem {
  return {
    shortId,
    title: `Work item ${index}`,
    status: "planned",
    priority: "medium",
    body: "",
    labels: [],
    todos: [],
  } as unknown as EnrichedWorkItem;
}

function pickerOption(
  index: number,
  kind: WorkItemPickerOption["kind"] = "workitem"
): WorkItemPickerOption {
  return {
    key: `${kind}:${index}`,
    kind,
    title: index === 2 ? "Fix login" : `Item ${index}`,
    identifier: `#${index}`,
    detail: "open",
    searchableText: index === 2 ? "fix login open" : `item ${index} open`,
    pillPath: `${kind}/${index}`,
    pillName: `Item ${index}`,
  };
}

describe("work item picker model", () => {
  beforeEach(() => {
    projectApiMocks.readWorkspaceWorkItemsData.mockReset();
  });

  it("bounds the retained workspace snapshot", () => {
    const data = {
      projectEntries: [
        {
          project: {
            slug: "project",
            meta: { id: "project-id", name: "Project", org_id: "org-id" },
          },
          workItems: Array.from({ length: 501 }, (_, index) =>
            enrichedWorkItem(index)
          ),
        },
      ],
      standaloneWorkItems: [],
      orgs: [],
    } as unknown as WorkspaceWorkItemsData;

    expect(workspaceWorkItemsToPickerOptions(data)).toHaveLength(500);
  });

  it("prefixes every numeric identifier with a hash", () => {
    const data = {
      projectEntries: [
        {
          project: {
            slug: "project",
            meta: { id: "project-id", name: "Project", org_id: "org-id" },
          },
          workItems: [
            enrichedWorkItem(1, "123"),
            enrichedWorkItem(2, "ABC-12"),
          ],
        },
      ],
      standaloneWorkItems: [],
      orgs: [],
    } as unknown as WorkspaceWorkItemsData;

    expect(
      workspaceWorkItemsToPickerOptions(data).map((option) => ({
        identifier: option.identifier,
        pillName: option.pillName,
      }))
    ).toEqual([
      { identifier: "#123", pillName: "#123 Work item 1" },
      { identifier: "ABC-12", pillName: "ABC-12 Work item 2" },
    ]);
  });

  it("preserves the owning org for standalone Work Items", () => {
    const data = {
      projectEntries: [],
      standaloneWorkItems: [
        {
          orgId: "cloud:org-1",
          workItem: {
            body: "Standalone body",
            filename: "WI-42",
            frontmatter: {
              id: "row-42",
              short_id: "WI-42",
              title: "Standalone item",
              status: "backlog",
              priority: "none",
              labels: [],
              todos: [],
              starred: false,
              created_at: "2026-08-09T00:00:00Z",
              updated_at: "2026-08-09T00:00:00Z",
            },
          },
        },
      ],
      orgs: [],
    } satisfies WorkspaceWorkItemsData;

    expect(workspaceWorkItemsToPickerOptions(data)).toEqual([
      expect.objectContaining({
        identifier: "WI-42",
        workItemContext: {
          orgId: "cloud:org-1",
          workItemId: "WI-42",
          agentRole: "custom",
        },
      }),
    ]);
  });

  it("filters by source and query before applying the render cap", () => {
    const options = [
      ...Array.from({ length: 25 }, (_, index) => pickerOption(index)),
      pickerOption(2, "github_issue"),
    ];

    expect(filterWorkItemPickerOptions(options, "all", "")).toHaveLength(20);
    expect(
      filterWorkItemPickerOptions(options, "github_issue", "login").map(
        (option) => option.key
      )
    ).toEqual(["github_issue:2"]);
  });

  it("preserves GitHub PR type and check status for presentation", () => {
    const [option] = githubWorkItemsToPickerOptions({
      issues: [],
      prs: [
        {
          number: 42,
          title: "Draft fix",
          state: "open",
          draft: true,
          ci_status: "failure",
          author_login: "octocat",
          url: "https://github.com/acme/repo/pull/42",
          head_branch: "fix",
          base_branch: "main",
        } as OpenPRItem,
      ],
      repoFullName: "acme/repo",
    });

    expect(option).toMatchObject({
      kind: "github_pr",
      prStatus: "draft",
      ciStatus: "failure",
      detail: "acme/repo",
      openedBy: "octocat",
      statusLabel: "draft",
    });
  });

  it("ranks GitHub issues and pull requests by descending number", () => {
    const options = githubWorkItemsToPickerOptions({
      issues: [
        {
          id: 41,
          number: 41,
          title: "Older issue",
          body: null,
          state: "open",
          state_reason: null,
          html_url: "https://github.com/acme/repo/issues/41",
          created_at: "2026-08-10T00:00:00Z",
          updated_at: "2026-08-10T00:00:00Z",
          closed_at: null,
          user: { login: "issue-author", avatar_url: "" },
          labels: [],
          assignees: [],
          comments: 0,
          milestone: null,
        },
      ],
      prs: [
        {
          number: 43,
          title: "Newer PR",
          state: "open",
          draft: false,
          ci_status: "success",
          author_login: "pr-author",
          author_avatar_url: null,
          requested_reviewer_logins: [],
          url: "https://github.com/acme/repo/pull/43",
          head_branch: "newer",
          base_branch: "main",
          created_at: "2026-08-10T00:00:00Z",
          updated_at: "2026-08-10T00:00:00Z",
        } satisfies OpenPRItem,
      ],
      repoFullName: "acme/repo",
    });

    expect(options.map((option) => option.identifier)).toEqual(["#43", "#41"]);
  });

  it("shares concurrent workspace reads", async () => {
    let resolveRead: ((data: WorkspaceWorkItemsData) => void) | undefined;
    projectApiMocks.readWorkspaceWorkItemsData.mockReturnValue(
      new Promise<WorkspaceWorkItemsData>((resolve) => {
        resolveRead = resolve;
      })
    );

    const first = loadWorkspaceWorkItemOptions();
    const second = loadWorkspaceWorkItemOptions();
    expect(projectApiMocks.readWorkspaceWorkItemsData).toHaveBeenCalledOnce();

    resolveRead?.({
      projectEntries: [],
      standaloneWorkItems: [],
      orgs: [],
    });
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });
});
