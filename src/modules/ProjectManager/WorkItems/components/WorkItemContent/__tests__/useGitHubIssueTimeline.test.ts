// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";

import {
  parseGitHubIssueNumber,
  useGitHubIssueTimeline,
} from "../hooks/useGitHubIssueTimeline";

const mocks = vi.hoisted(() => ({
  getGitRemotes: vi.fn(),
  fetchIssueTimeline: vi.fn(),
}));

vi.mock("@src/api/http/git/remotes", () => ({
  getGitRemotes: mocks.getGitRemotes,
}));

vi.mock("@src/services/git/operations/githubIssues", () => ({
  fetchIssueTimeline: mocks.fetchIssueTimeline,
}));

const commentItem: GitHubIssueTimelineItem = {
  id: 7,
  event: "commented",
  created_at: "2026-07-21T12:00:00Z",
  actor: { login: "ada", avatar_url: "https://example.com/ada.png" },
  body: "Timeline comment",
  html_url: null,
  assignee: null,
  label: null,
  milestone: null,
  rename: null,
  source: null,
  commit_id: null,
  lock_reason: null,
};

function TimelineProbe({
  repoPath,
  shortId,
}: {
  repoPath: string;
  shortId: string;
}) {
  const { timeline, timelineLoading } = useGitHubIssueTimeline({
    enabled: true,
    repoPath,
    shortId,
  });
  return createElement("div", {
    "data-testid": "probe",
    "data-loading": String(timelineLoading),
    "data-count": String(timeline.length),
  });
}

describe("useGitHubIssueTimeline", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.getGitRemotes.mockReset();
    mocks.fetchIssueTimeline.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("normalizes GitHub issue short IDs", () => {
    expect(parseGitHubIssueNumber("#42")).toBe(42);
    expect(parseGitHubIssueNumber("42")).toBe(42);
    expect(parseGitHubIssueNumber("ABC-42")).toBeNull();
    expect(parseGitHubIssueNumber("0")).toBeNull();
  });

  it("loads the canonical GitHub timeline from a linked checkout", async () => {
    mocks.getGitRemotes.mockResolvedValue({
      remotes: [
        {
          name: "origin",
          url: "git@github.com:openai/orgii.git",
          fetch_url: "git@github.com:openai/orgii.git",
          push_url: "git@github.com:openai/orgii.git",
        },
      ],
    });
    mocks.fetchIssueTimeline.mockResolvedValue({ data: [commentItem] });

    await act(async () => {
      root.render(
        createElement(TimelineProbe, {
          repoPath: "/workspace/orgii",
          shortId: "#42",
        })
      );
    });

    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    expect(mocks.getGitRemotes).toHaveBeenCalledWith({
      repo_id: "default",
      repo_path: "/workspace/orgii",
    });
    expect(mocks.fetchIssueTimeline).toHaveBeenCalledWith({
      remoteUrl: "git@github.com:openai/orgii.git",
      issueNumber: 42,
    });
    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-count")
    ).toBe("1");
  });
});
