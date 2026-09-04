import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ManagedPrItem } from "../../WorkManagement/githubManagedItemModel";
import TeamInboxList from "../components/TeamInboxList";
import type { AssignedWorkItem } from "../domain";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: string;
  }) => createElement("span", { "data-tooltip-label": label }, children),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { repository?: string }) =>
      key === "teamInbox.row.issueSource"
        ? `${options?.repository} issue`
        : key,
  }),
}));

function renderEmptyList(query: string, loading = false): string {
  return renderToStaticMarkup(
    createElement(TeamInboxList, {
      filter: "all",
      items: [],
      selectedItemId: null,
      unreadCounts: { all: 0, mentions: 0, assigned: 0 },
      query,
      loading,
      onQueryChange: vi.fn(),
      onSelectItem: vi.fn(),
      onRefresh: vi.fn(),
      hasMore: true,
      onLoadMore: vi.fn(),
    })
  );
}

function createPullRequest(
  overrides: Partial<ManagedPrItem> = {}
): ManagedPrItem {
  return {
    kind: "pr",
    id: 42,
    title: "Keep Team Inbox actionable",
    repo: "orgii/desktop-repository",
    repoId: "repo-1",
    repoPath: "/repos/orgii",
    remoteUrl: "https://github.com/orgii/desktop.git",
    viewerLogin: "viewer",
    rawPr: {
      number: 42,
      url: "https://github.com/orgii/desktop/pull/42",
      title: "Keep Team Inbox actionable",
      state: "open",
      author_login: "author",
      author_avatar_url: "https://example.com/author.png",
      requested_reviewer_logins: ["viewer"],
      head_branch: "feat/team-inbox",
      base_branch: "main",
      draft: false,
      ci_status: "success",
      created_at: "2026-07-28T00:00:00.000Z",
      updated_at: "2026-07-28T00:05:00.000Z",
    },
    author: "author",
    authoredByViewer: false,
    reviewRequestedFromViewer: true,
    timeAgo: "5h",
    state: "open",
    sourceBranch: "feat/team-inbox",
    targetBranch: "main",
    updatedAt: "2026-07-28T00:05:00.000Z",
    ...overrides,
  };
}

const assignedItem: AssignedWorkItem = {
  id: "assigned-1",
  kind: "assigned_work_item",
  occurredAt: "2026-07-28T00:00:00.000Z",
  readAt: "2026-07-28T00:01:00.000Z",
  actor: { id: "member-1", displayName: "Yuki" },
  target: {
    kind: "work_item",
    projectId: "orgii-issues-project",
    workItemId: "AAA-0001",
    repository: "https://github.com/org2AI/ORG2.git",
  },
  payload: {
    title: "Existing assigned work",
    status: "todo",
    priority: "medium",
    assigneeMemberId: "member-1",
    assigneeName: "Yuki",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
};

describe("TeamInboxList pagination", () => {
  it("removes the title header and keeps refresh in the search row", () => {
    const markup = renderEmptyList("");

    expect(markup).toContain('data-testid="team-inbox-refresh"');
    expect(markup).toContain('data-tooltip-label="common:actions.refresh"');
    expect(markup).toContain('data-icon="refresh-cw"');
    expect(markup).toContain("height:28px");
    expect(markup).toContain("width:28px");
    expect(markup).not.toContain("teamInbox.title");
    expect(markup).not.toContain("teamInbox.allRead");
    expect(markup.indexOf('placeholder="common:actions.search"')).toBeLessThan(
      markup.indexOf('data-testid="team-inbox-refresh"')
    );
  });

  it("does not render inbox filter controls", () => {
    const markup = renderEmptyList("");

    expect(markup).not.toContain('data-icon="inbox"');
    expect(markup).not.toContain('data-icon="message-square-more"');
    expect(markup).not.toContain('data-icon="list-checks"');
    expect(markup).not.toContain('data-testid="team-inbox-filter-');
    expect(markup).toContain('placeholder="common:actions.search"');
    expect(markup).toContain('aria-label="common:actions.search"');
    expect(markup).not.toContain("teamInbox.search.");
  });

  it("does not render unread count bubbles on inbox filters", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamInboxList, {
        filter: "all",
        items: [],
        selectedItemId: null,
        unreadCounts: { all: 6, mentions: 2, assigned: 4 },
        query: "",
        loading: false,
        onQueryChange: vi.fn(),
        onSelectItem: vi.fn(),
      })
    );

    expect(markup).not.toContain("rounded-full bg-primary-6");
    expect(markup).not.toContain(">6</span>");
    expect(markup).not.toContain(">2</span>");
    expect(markup).not.toContain(">4</span>");
  });

  it("shows one reusable progress line below search while loading", () => {
    const markup = renderEmptyList("", true);

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain("progress-bar--indeterminate");
    expect(markup).toContain("h-0.5");
    expect(markup).not.toContain("teamInbox.loading");
    expect(markup).not.toContain("placeholders.nothingHereYet");
  });

  it("temporarily hides pull-request refresh warnings", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamInboxList, {
        filter: "all",
        items: [],
        selectedItemId: null,
        unreadCounts: { all: 0, mentions: 0, assigned: 0 },
        query: "",
        loading: false,
        pullRequestsError: "GitHub request timed out",
        onQueryChange: vi.fn(),
        onSelectItem: vi.fn(),
      })
    );

    expect(markup).not.toContain("border-warning-3");
    expect(markup).not.toContain("GitHub request timed out");
    expect(markup).not.toContain('data-testid="team-inbox-partial-load-info"');
  });

  it("keeps Load more reachable when the current search has no visible rows", () => {
    const markup = renderEmptyList("missing");

    expect(markup).toContain("teamInbox.empty.noResults.title");
    expect(markup).toContain("teamInbox.loadMore");
  });

  it("does not point assistive technology at an unmounted active row", () => {
    expect(renderEmptyList("")).not.toContain("aria-activedescendant");
  });

  it("places actionable pull requests and assigned work under matching sections", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamInboxList, {
        filter: "all",
        items: [assignedItem],
        pullRequests: [
          createPullRequest(),
          createPullRequest({
            id: 43,
            title: "Authored PR",
            author: "viewer",
            authoredByViewer: true,
            reviewRequestedFromViewer: false,
          }),
          createPullRequest({
            id: 44,
            title: "Unrelated open PR",
            reviewRequestedFromViewer: false,
          }),
        ],
        selectedItemId: assignedItem.id,
        unreadCounts: { all: 0, mentions: 0, assigned: 0 },
        query: "",
        loading: false,
        onQueryChange: vi.fn(),
        onSelectItem: vi.fn(),
        onSelectPullRequest: vi.fn(),
      })
    );

    const reviewRequestedIndex = markup.indexOf(
      'data-testid="team-inbox-pr-review-requested"'
    );
    const authoredIndex = markup.indexOf(
      'data-testid="team-inbox-pr-authored"'
    );
    const assignedSectionIndex = markup.indexOf(
      'data-testid="team-inbox-assigned"'
    );
    const inboxRowIndex = markup.indexOf("Existing assigned work");

    expect(reviewRequestedIndex).toBeGreaterThanOrEqual(0);
    expect(authoredIndex).toBeGreaterThan(reviewRequestedIndex);
    expect(assignedSectionIndex).toBeGreaterThan(authoredIndex);
    expect(inboxRowIndex).toBeGreaterThan(assignedSectionIndex);
    expect(markup).not.toContain('data-testid="team-inbox-other-todos"');
    expect(markup).toContain("teamInbox.filters.assigned");
    expect(markup).toContain("Existing assigned work");
    expect(markup).not.toContain("Unrelated open PR");
    expect(markup).toContain("https://example.com/author.png");
    expect(markup).toContain(">#42</span>");
    expect(markup).toMatch(/class="[^"]*font-semibold[^"]*"[^>]*>#42<\/span>/);
    expect(markup).toContain("desktop-repository · feat/team-inbox");
    expect(markup).not.toContain("#42 · desktop-repository");
    expect(markup).not.toContain(">orgii/desktop-repository<");
    expect(markup).toContain("teamInbox.filters.assigned · ORG2 issue");
    expect(markup).not.toContain("orgii-issu");
    expect(markup).not.toContain("author · #42");
    expect(markup).toContain(">5h<");
    expect(markup).not.toContain("ago");
    expect(markup).not.toContain("teamInbox.groups.");
    expect(markup).toMatch(/class="[^"]*text-text-3[^"]*"[^>]*>5h<\/span>/);
    expect(markup).toContain("text-text-2");
    expect(markup.match(/data-team-inbox-list-item="true"/g)).toHaveLength(3);
    expect(markup.match(/class="mb-2 last:mb-0"/g)).toHaveLength(3);
    expect(markup).toContain("mb-px h-7");
    expect(markup).toContain(
      "text-left text-[11px] font-medium uppercase tracking-wide text-text-3"
    );
    expect(markup).toContain("rounded-lg");
    expect(markup).toContain("hover:bg-surface-hover");
    expect(markup).not.toContain("min-h-[72px]");
  });
});
